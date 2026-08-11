import { AppAuth, buildAppManifest, encryptSecret, randomToken, toPkcs8 } from "@console/core";
import { githubAppConfig, memberships, orgs, users } from "@console/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { resolveSession, type AppDeps } from "./context.js";

/**
 * First-run setup: register the Console's own GitHub App via GitHub's manifest
 * flow. The operator clicks once here and once on GitHub; GitHub creates the
 * App and hands back the app id, private key, webhook secret and OAuth pair,
 * which are stored encrypted. No hand-copied credentials, no PKCS#1→PKCS#8
 * conversion step, no chance of a mistyped webhook secret.
 *
 * The flow is open only while the Console is unconfigured — once an App exists,
 * re-registration requires an authenticated owner.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;

  app.get("/api/setup/status", async () => {
    const creds = await deps.credentials.resolve();
    const hasMasterKey = Boolean(deps.cfg.CONSOLE_MASTER_KEY);
    // Nobody owns this Console yet. Sign-in alone grants no membership — that
    // comes from being able to read a repo in an estate, and on a fresh install
    // there are no estates — so the first user has to claim it to get in at all.
    const claimable = (await db.select({ id: memberships.id }).from(memberships).limit(1)).length === 0;
    return {
      configured: creds !== null,
      credentialError: deps.credentials.error,
      claimable,
      source: creds?.source ?? null,
      appSlug: creds?.slug ?? null,
      hasMasterKey,
      publicOrigin: deps.cfg.PUBLIC_ORIGIN,
      insightEnabled: Boolean(deps.cfg.ANTHROPIC_API_KEY),
      devLogin: deps.cfg.DEV_FAKE_LOGIN === "1",
    };
  });

  /**
   * Renders the form GitHub's manifest flow requires — the manifest must arrive
   * as a form POST to github.com, which a JSON API cannot do on the client's
   * behalf. Submitted by hand rather than by an inline script: this page is
   * served through nginx, whose CSP is `script-src 'self'`, so an auto-submit
   * would be blocked and leave the button apparently doing nothing.
   */
  app.get<{ Querystring: { org?: string; name?: string } }>("/setup/github-app", async (req, reply) => {
    const already = await deps.credentials.resolve();
    if (already) {
      const ctx = await resolveSession(db, deps.cfg, req);
      if (!ctx) {
        return reply
          .code(403)
          .type("text/html")
          .send(page("Already configured", "<p>This Console already has a GitHub App. Sign in as an owner to re-register.</p>"));
      }
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
        "Create your GitHub App",
        `<p>This sends GitHub a manifest for the <strong>${escapeHtml(name)}</strong> App.
           Review the permissions on GitHub and confirm there; it hands the
           credentials straight back to this Console.</p>
         <form method="post" action="${escapeHtml(action)}">
           <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
           <button type="submit">Continue to GitHub →</button>
         </form>`,
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
   * Register an App the operator created by hand, from the setup screen. Same
   * destination as the manifest flow — encrypted in github_app_config — so a
   * production install needs no credentials in the environment and no secrets
   * on the deployment host.
   *
   * The credentials are proved against GitHub before they are stored: an app id
   * that does not match the key, or a key from another App, fails here rather
   * than as an unexplained 401 during the first sync.
   */
  app.post<{
    Body: {
      appId?: string;
      privateKeyPem?: string;
      webhookSecret?: string;
      clientId?: string;
      clientSecret?: string;
    };
  }>("/api/setup/credentials", async (req, reply) => {
    if (req.headers["x-console-csrf"] !== "1") return reply.code(403).send({ error: "missing CSRF header" });
    if (!deps.cfg.CONSOLE_MASTER_KEY) {
      return reply.code(500).send({ error: "CONSOLE_MASTER_KEY is not set on the API — set it and restart" });
    }

    // Open only while unconfigured, exactly as the manifest flow is: replacing
    // an App that already exists takes an authenticated session.
    const already = await deps.credentials.resolve();
    let ctx = null as Awaited<ReturnType<typeof resolveSession>>;
    if (already) {
      ctx = await resolveSession(db, deps.cfg, req);
      if (!ctx) return reply.code(403).send({ error: "this Console already has a GitHub App — sign in to replace it" });
    }

    const appId = req.body?.appId?.trim() ?? "";
    const privateKeyPem = req.body?.privateKeyPem?.trim() ?? "";
    const webhookSecret = req.body?.webhookSecret?.trim() ?? "";
    const clientId = req.body?.clientId?.trim() ?? "";
    const clientSecret = req.body?.clientSecret?.trim() ?? "";

    const missing = Object.entries({ appId, privateKeyPem, clientId, clientSecret })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) return reply.code(400).send({ error: `missing: ${missing.join(", ")}` });
    if (!/^\d+$/.test(appId)) return reply.code(400).send({ error: "App ID is the numeric id from the App's settings page" });

    // GitHub hands out PKCS#1; do the conversion here so nobody has to know that.
    let pkcs8: string;
    try {
      pkcs8 = await toPkcs8(privateKeyPem);
    } catch {
      return reply.code(400).send({ error: "that does not parse as a private key — paste the whole .pem, BEGIN and END lines included" });
    }

    let verified: { id: number; slug: string; html_url: string };
    try {
      verified = await new AppAuth({
        apiUrl: deps.cfg.GITHUB_API_URL,
        appId,
        privateKeyPem: pkcs8,
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
      }).verifyApp();
    } catch (err) {
      return reply
        .code(400)
        .send({ error: `GitHub rejected these credentials: ${(err as Error).message}. Check the App ID matches the private key.` });
    }

    const key = deps.cfg.CONSOLE_MASTER_KEY;
    const values = {
      appId,
      slug: verified.slug,
      htmlUrl: verified.html_url,
      encryptedPrivateKey: encryptSecret(pkcs8, key),
      encryptedWebhookSecret: encryptSecret(webhookSecret, key),
      clientId,
      encryptedClientSecret: encryptSecret(clientSecret, key),
      configuredBy: ctx?.login ?? null,
      updatedAt: new Date(),
    };
    await db
      .insert(githubAppConfig)
      .values({ id: "default", ...values })
      .onConflictDoUpdate({ target: githubAppConfig.id, set: values });
    deps.credentials.invalidate();

    return { ok: true, slug: verified.slug, htmlUrl: verified.html_url, webhookSecretSet: Boolean(webhookSecret) };
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

const manifestStates = new Map<string, number>();

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
