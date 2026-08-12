import { AppAuth, buildAppManifest, encryptSecret, randomToken, toPkcs8 } from "@console/core";
import { githubAppConfig, memberships, orgs, users } from "@console/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveSession, type AppDeps, type RequestCtx } from "./context.js";

/**
 * First-run setup: register the Console's own GitHub App via GitHub's manifest
 * flow. The operator clicks once here and once on GitHub; GitHub creates the
 * App and hands back the app id, private key, webhook secret and OAuth pair,
 * which are stored encrypted. No hand-copied credentials, no PKCS#1→PKCS#8
 * conversion step, no chance of a mistyped webhook secret.
 *
 * The same screen edits the registration afterwards (see setupAccess for who
 * may): rotating a secret or correcting the App ID is a patch over the stored
 * row, not a re-run of the whole handshake.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get("/api/setup/status", async (req) => {
    const creds = await deps.credentials.resolve();
    const hasMasterKey = Boolean(deps.cfg.CONSOLE_MASTER_KEY);
    return {
      configured: creds !== null,
      source: creds?.source ?? null,
      appSlug: creds?.slug ?? null,
      appId: creds?.appId ?? null,
      // The OAuth client id is public by construction — it travels in the
      // authorize URL on every sign-in — so it can prefill the edit form. The
      // key and the two secrets never leave the server; the form reports them
      // as "stored" and leaves them blank to keep.
      clientId: creds?.clientId ?? null,
      hasWebhookSecret: Boolean(creds?.webhookSecret),
      /** Whether this caller could save a change from the setup screen. */
      canEditApp: (await setupAccess(deps, req)).allowed,
      hasMasterKey,
      credentialError: deps.credentials.credentialError,
      publicOrigin: deps.cfg.PUBLIC_ORIGIN,
      insightEnabled: Boolean(deps.cfg.ANTHROPIC_API_KEY),
      devLogin: deps.cfg.DEV_FAKE_LOGIN === "1",
    };
  });

  /**
   * The edge routes /setup/* here (the manifest handshake is server-rendered)
   * and bare /setup to the SPA, which leaves the directory form of the same URL
   * — typed, autocompleted from a previous /setup/github-app visit, or added by
   * a proxy — landing on Fastify with nothing to serve. It answered a JSON 404
   * to an operator who was looking for the setup screen. Send it one segment up.
   */
  app.get("/setup/", async (_req, reply) => reply.redirect("/setup"));

  /**
   * Renders the auto-submitting form GitHub's manifest flow requires (the
   * manifest must arrive as a form POST to github.com, which a JSON API cannot
   * do on the client's behalf).
   */
  app.get<{ Querystring: { org?: string; name?: string } }>("/setup/github-app", async (req, reply) => {
    if (!(await setupAccess(deps, req)).allowed) {
      return reply
        .code(403)
        .type("text/html")
        .send(page("Already configured", "<p>This Console already has a GitHub App. Sign in to re-register it.</p>"));
    }

    const state = randomToken(16);
    manifestStates.set(state, Date.now() + 15 * 60_000);
    const name = req.query.name?.trim() || "Factory Console";
    const manifest = buildAppManifest(deps.cfg.PUBLIC_ORIGIN, name);
    const action = req.query.org
      ? `${deps.cfg.GITHUB_WEB_URL}/organizations/${encodeURIComponent(req.query.org)}/settings/apps/new?state=${state}`
      : `${deps.cfg.GITHUB_WEB_URL}/settings/apps/new?state=${state}`;

    return reply.type("text/html").send(
      page(
        "Creating your GitHub App…",
        `<p>Redirecting to GitHub to create the <strong>${escapeHtml(name)}</strong> App.
           Review the permissions there and confirm.</p>
         <form id="f" method="post" action="${escapeHtml(action)}">
           <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
           <button type="submit">Continue to GitHub</button>
         </form>
         <script>document.getElementById('f').submit()</script>`,
      ),
    );
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/setup/github-app/callback", async (req, reply) => {
    const { code, state } = req.query;
    const expiry = state ? manifestStates.get(state) : undefined;
    if (!code || !state || !expiry || expiry < Date.now()) {
      return reply.code(400).type("text/html").send(page("Setup failed", "<p>Invalid or expired setup state. Start again from the Console.</p>"));
    }
    manifestStates.delete(state);

    if (!deps.cfg.CONSOLE_MASTER_KEY) {
      return reply
        .code(500)
        .type("text/html")
        .send(page("Setup failed", "<p>CONSOLE_MASTER_KEY is not set on the API. Run <code>./scripts/setup.sh</code> and restart.</p>"));
    }

    try {
      // Manifest conversion needs no prior credentials.
      const bootstrap = new AppAuth({
        apiUrl: deps.cfg.GITHUB_API_URL,
        appId: "",
        privateKeyPem: "",
        oauthClientId: "",
        oauthClientSecret: "",
      });
      const created = await bootstrap.convertManifest(code);
      const pkcs8 = await toPkcs8(created.pem);
      const key = deps.cfg.CONSOLE_MASTER_KEY;

      const ctx = await resolveSession(db, deps.cfg, req);
      await db
        .insert(githubAppConfig)
        .values({
          id: "default",
          appId: String(created.id),
          slug: created.slug,
          htmlUrl: created.html_url,
          encryptedPrivateKey: encryptSecret(pkcs8, key),
          encryptedWebhookSecret: encryptSecret(created.webhook_secret, key),
          clientId: created.client_id,
          encryptedClientSecret: encryptSecret(created.client_secret, key),
          configuredBy: ctx?.login ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: githubAppConfig.id,
          set: {
            appId: String(created.id),
            slug: created.slug,
            htmlUrl: created.html_url,
            encryptedPrivateKey: encryptSecret(pkcs8, key),
            encryptedWebhookSecret: encryptSecret(created.webhook_secret, key),
            clientId: created.client_id,
            encryptedClientSecret: encryptSecret(created.client_secret, key),
            configuredBy: ctx?.login ?? null,
            updatedAt: new Date(),
          },
        });
      deps.credentials.invalidate();

      return reply.type("text/html").send(
        page(
          "GitHub App created",
          `<p>✅ <strong>${escapeHtml(created.slug)}</strong> is registered and its credentials are stored encrypted.</p>
           <p>Next: install it on the org whose repositories you want to see.</p>
           <p><a class="btn" href="${escapeHtml(created.html_url)}/installations/new">Install the App on your org →</a></p>
           <p><a href="/">Back to the Console</a></p>`,
        ),
      );
    } catch (err) {
      return reply
        .code(502)
        .type("text/html")
        .send(page("Setup failed", `<p>GitHub rejected the manifest conversion:</p><pre>${escapeHtml((err as Error).message)}</pre>`));
    }
  });

  /**
   * Manual registration, and the way to edit a registration afterwards: the
   * five credentials of a GitHub App you already have. The manifest flow above
   * is the easy path, but it needs the Console to be reachable from github.com
   * — a laptop behind NAT, an air-gapped install, or an App that predates this
   * Console all land here instead. Same storage, same encryption; the private
   * key is converted to PKCS#8 for you rather than left as a documented
   * openssl incantation.
   *
   * On a Console that already has a stored registration this is a patch: blank
   * fields keep what is stored, so rotating a client secret does not mean
   * re-pasting the private key.
   */
  app.post<{ Body: ManualCredentials }>("/api/setup/credentials", async (req, reply) => {
    if (req.headers["x-console-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });

    const { allowed, ctx } = await setupAccess(deps, req);
    if (!allowed) return reply.code(403).send({ error: "sign in to change the registered GitHub App" });

    const key = deps.cfg.CONSOLE_MASTER_KEY;
    if (!key) return reply.code(400).send({ error: "CONSOLE_MASTER_KEY is not set on the API — credentials cannot be stored" });

    // Only a stored row can be edited field by field. Credentials pinned in the
    // environment are not ours to half-copy into the database, and a row we
    // cannot decrypt resolves to null — so both of those need the full set,
    // which is also how you repair them.
    const current = await deps.credentials.resolve();
    const stored = current?.source === "database" ? current : null;

    const body = req.body ?? ({} as ManualCredentials);
    const field = (v: unknown) => String(v ?? "").trim();
    const appId = field(body.appId) || stored?.appId || "";
    const submittedKey = String(body.privateKeyPem ?? "").replace(/\\n/g, "\n").trim();
    const clientId = field(body.clientId) || stored?.clientId || "";
    const clientSecret = field(body.clientSecret) || stored?.clientSecret || "";
    const webhookSecret = field(body.webhookSecret) || stored?.webhookSecret || "";
    // The slug is optional and worth being able to remove, so an empty one that
    // was actually sent means "clear it" rather than "keep".
    const slug = body.slug === undefined ? (stored?.slug ?? "") : field(body.slug);

    const missing = [
      ["appId", appId],
      ["privateKeyPem", submittedKey || stored?.privateKeyPem || ""],
      ["clientId", clientId],
      ["clientSecret", clientSecret],
    ]
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      const hint =
        current?.source === "environment"
          ? " — this Console's credentials come from the environment, so there is no stored registration to edit; enter the full set to store one"
          : "";
      return reply.code(400).send({ error: `missing required field(s): ${missing.join(", ")}${hint}` });
    }
    if (!/^\d+$/.test(appId)) {
      return reply.code(400).send({ error: "App ID must be the numeric id from the App's settings page, not its name or slug" });
    }
    // Keeping a blank field means keeping the stored value — which is only ever
    // right for the same App. Pointing the Console at a different one and
    // inheriting the old key would store a pairing that authenticates as
    // nothing, and the failure would surface later as an opaque 401 from GitHub.
    if (stored && appId !== stored.appId && !submittedKey) {
      return reply.code(400).send({ error: "that is a different App ID — paste that App's own private key as well" });
    }
    if (stored && clientId !== stored.clientId && !field(body.clientSecret)) {
      return reply.code(400).send({ error: "that is a different OAuth client id — enter its client secret as well" });
    }

    let pkcs8: string;
    if (submittedKey) {
      try {
        pkcs8 = await toPkcs8(submittedKey);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: `that private key could not be read (${(err as Error).message}). Paste the whole .pem file, BEGIN/END lines included.` });
      }
    } else {
      pkcs8 = stored!.privateKeyPem; // already PKCS#8 — it was converted on the way in
    }

    const values = {
      appId,
      slug: slug || null,
      htmlUrl: slug ? `${deps.cfg.GITHUB_WEB_URL}/apps/${slug}` : null,
      encryptedPrivateKey: encryptSecret(pkcs8, key),
      encryptedWebhookSecret: encryptSecret(webhookSecret, key),
      clientId,
      encryptedClientSecret: encryptSecret(clientSecret, key),
      updatedAt: new Date(),
    };
    await db
      .insert(githubAppConfig)
      .values({ id: "default", ...values, configuredBy: ctx?.login ?? null })
      .onConflictDoUpdate({
        target: githubAppConfig.id,
        // configuredBy only when we know who: an unauthenticated first-run edit
        // must not wipe the name already on the row.
        set: ctx ? { ...values, configuredBy: ctx.login } : values,
      });
    deps.credentials.invalidate();

    return { ok: true, appId, slug: slug || null, webhookVerification: Boolean(webhookSecret) };
  });

  /** Bootstrap the very first user as an owner when no memberships exist yet. */
  app.post("/api/setup/claim-owner", async (req, reply) => {
    const ctx = await resolveSession(db, deps.cfg, req);
    if (!ctx) return reply.code(401).send({ error: "sign in first" });
    if (req.headers["x-console-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });
    const existing = await db.select().from(memberships).limit(1);
    if (existing.length > 0) return reply.code(409).send({ error: "this Console already has members" });
    const user = (await db.select().from(users).where(eq(users.id, ctx.userId)).limit(1))[0]!;
    const org = (await db.insert(orgs).values({ name: user.login }).returning())[0]!;
    await db.insert(memberships).values({ orgId: org.id, userId: user.id, role: "owner" });
    return { ok: true, orgId: org.id };
  });
}

/**
 * Who may register or edit the Console's GitHub App.
 *
 * Open while this Console has nothing to protect — no App registered, or no one
 * who owns it — and authenticated once both exist. The membership half matters
 * as much as the credential half: the App's own OAuth pair is what signs people
 * in, so on a Console where the App is registered but nobody has claimed
 * ownership yet, requiring a session would lock the fix behind the sign-in that
 * a wrong client secret breaks. That window is already unguarded — claim-owner
 * hands the first caller an org — so this protects exactly as much as before.
 * Once an owner exists, the environment variables and DEV_FAKE_LOGIN remain the
 * documented ways back in.
 */
async function setupAccess(deps: AppDeps, req: FastifyRequest): Promise<{ allowed: boolean; ctx: RequestCtx | null }> {
  const db = deps.dbh.db;
  const ctx = await resolveSession(db, deps.cfg, req);
  if (ctx) return { allowed: true, ctx };
  if (!(await deps.credentials.resolve())) return { allowed: true, ctx: null };
  const claimed = await db.select({ orgId: memberships.orgId }).from(memberships).limit(1);
  return { allowed: claimed.length === 0, ctx: null };
}

const manifestStates = new Map<string, number>();

/** The five values GitHub shows on an App's settings page, plus its slug. */
interface ManualCredentials {
  appId?: string;
  privateKeyPem?: string;
  webhookSecret?: string;
  clientId?: string;
  clientSecret?: string;
  slug?: string;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
 body{background:#0f1418;color:#d7dee5;font-family:-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;
      align-items:center;justify-content:center;min-height:100vh;margin:0}
 .card{background:#161d23;border:1px solid #2a3540;border-radius:10px;padding:2rem 2.5rem;max-width:34rem}
 a{color:#4a90d9} pre{background:#1d262e;padding:.75rem;border-radius:6px;overflow-x:auto;white-space:pre-wrap}
 button,.btn{display:inline-block;background:#4a90d9;color:#fff;border:0;border-radius:6px;padding:.5rem 1rem;
      font:inherit;cursor:pointer;text-decoration:none}
</style></head><body><div class="card"><h2>${escapeHtml(title)}</h2>${body}</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
