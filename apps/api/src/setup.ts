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
    return {
      configured: creds !== null,
      source: creds?.source ?? null,
      appSlug: creds?.slug ?? null,
      hasMasterKey,
      credentialError: deps.credentials.credentialError,
      publicOrigin: deps.cfg.PUBLIC_ORIGIN,
      insightEnabled: Boolean(deps.cfg.ANTHROPIC_API_KEY),
      devLogin: deps.cfg.DEV_FAKE_LOGIN === "1",
    };
  });

  /**
   * Renders the auto-submitting form GitHub's manifest flow requires (the
   * manifest must arrive as a form POST to github.com, which a JSON API cannot
   * do on the client's behalf).
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
