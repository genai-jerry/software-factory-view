import { decryptSecret, encryptSecret } from "@console/core";
import { auditLog, mcpServers, projects, type McpTool } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { randomBytes } from "node:crypto";
import { listMcpTools, type ListedTool } from "../mcp-client.js";
import { authorizeUrl, discover, exchangeCode, OAuthFailure, pkce, register } from "../mcp-oauth.js";
import { ensureFresh, expired, sealGrant } from "../mcp-oauth-store.js";
import { loadOrg } from "./settings.js";

/**
 * Compass → Tools: the MCP servers an org gives its Claude sessions.
 *
 * An admin pastes a server URL (and headers, when it needs a key); Compass
 * connects, lists its tools and saves it. Read-only tools start allowed,
 * others start off. Each server says where it is used: Shape, Ask (thread
 * questions and Telegram discussions) and builds (every factory role run).
 * The orchestrator reads `mcp_servers` itself on its next session, so a
 * change here needs no restart. Header values are sealed and never sent back.
 */

type Row = typeof mcpServers.$inferSelect;
type HeaderInput = Array<{ name?: unknown; value?: unknown }>;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

function view(r: Row) {
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    url: r.url,
    transport: r.transport,
    headerNames: r.headerNames,
    authKind: r.authKind,
    oauthBy: r.oauthBy,
    oauthExpiresAt: r.oauthExpiresAt?.toISOString() ?? null,
    projectIds: r.projectIds,
    tools: r.tools,
    useShape: r.useShape,
    useAsk: r.useAsk,
    useBuild: r.useBuild,
    enabled: r.enabled,
    checkedAt: r.checkedAt?.toISOString() ?? null,
    checkError: r.checkError,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** A short, stable id from the label: what Claude sees in mcp__<name>__<tool>. */
export function slugFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "s_$1")
      .slice(0, 32) || "server";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

function checkUrl(raw: unknown, production: boolean): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Paste the server's URL." };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "That is not a URL." };
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) return { error: "The URL must start with https://." };
  if (u.username || u.password) return { error: "Put credentials in a header, not in the URL." };
  return { url: u.toString() };
}

function checkHeaders(raw: unknown): { headers: Record<string, string> } | { error: string } {
  if (raw === undefined || raw === null) return { headers: {} };
  if (!Array.isArray(raw)) return { error: "headers must be a list of name and value." };
  const headers: Record<string, string> = {};
  for (const h of raw as HeaderInput) {
    const name = typeof h?.name === "string" ? h.name.trim() : "";
    const value = typeof h?.value === "string" ? h.value.trim() : "";
    if (!name && !value) continue;
    if (!HEADER_NAME.test(name)) return { error: `“${name}” is not a header name.` };
    if (!value || value.length > 4000) return { error: `Give a value for the ${name} header.` };
    headers[name] = value;
  }
  return { headers };
}

/**
 * Sign-ins under way: started by an admin, finished when the server sends
 * their browser back. Kept in memory for ten minutes, like GitHub sign-in's
 * state (auth.ts); a restart in between only means pressing Sign in again.
 */
interface PendingSignIn {
  orgId: string;
  userId: string;
  login: string;
  serverId: string | null;
  label: string;
  url: string;
  transport: "http" | "sse";
  projectIds: string[];
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  resource: string;
  scope: string | null;
  verifier: string;
  expiry: number;
}
const pendingSignIns = new Map<string, PendingSignIn>();
const SIGN_IN_TTL_MS = 10 * 60_000;

/** For tests. */
export function pendingSignIn(state: string): PendingSignIn | undefined {
  return pendingSignIns.get(state);
}

/** Keep earlier choices; a tool not seen before starts allowed only when it is read-only. */
export function mergeTools(listed: ListedTool[], before: McpTool[]): McpTool[] {
  const was = new Map(before.map((t) => [t.name, t.allowed]));
  return listed.map((t) => ({ ...t, allowed: was.get(t.name) ?? t.readOnly }));
}

export function registerToolRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;
  const production = deps.cfg.NODE_ENV === "production";

  /** The ids given, if every one is a project of this org; else an error to show. */
  const checkProjects = async (orgId: string, raw: unknown): Promise<{ ids: string[] } | { error: string }> => {
    if (raw === undefined || raw === null) return { ids: [] };
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) return { error: "projectIds must be a list of project ids." };
    const ids = [...new Set(raw as string[])];
    if (ids.length === 0) return { ids };
    const found = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), inArray(projects.id, ids)));
    if (found.length !== ids.length) return { error: "One of those projects is not in this organisation." };
    return { ids };
  };

  const sealHeaders = (headers: Record<string, string>): { sealed: string | null } | { error: string } => {
    if (Object.keys(headers).length === 0) return { sealed: null };
    if (!deps.cfg.CONSOLE_MASTER_KEY) return { error: "Headers are stored sealed, and this Compass has no CONSOLE_MASTER_KEY." };
    return { sealed: encryptSecret(JSON.stringify(headers), deps.cfg.CONSOLE_MASTER_KEY) };
  };
  const openHeaders = (r: Row): Record<string, string> => {
    if (!r.encryptedHeaders || !deps.cfg.CONSOLE_MASTER_KEY) return {};
    return JSON.parse(decryptSecret(r.encryptedHeaders, deps.cfg.CONSOLE_MASTER_KEY)) as Record<string, string>;
  };
  const audit = (orgId: string, userId: string, action: string, target: string, payload: Record<string, unknown> = {}) =>
    db.insert(auditLog).values({ orgId, actorUserId: userId, action, target, payload });

  app.get<{ Params: { id: string } }>("/api/orgs/:id/tools", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: false });
    if (!found) return;
    const rows = await db.select().from(mcpServers).where(eq(mcpServers.orgId, found.org.id)).orderBy(mcpServers.createdAt);
    return {
      orgId: found.org.id,
      orgName: found.org.name,
      canEdit: found.membership.role === "owner" || found.membership.role === "admin",
      servers: rows.map(view),
    };
  });

  app.post<{ Params: { id: string }; Body: { label?: unknown; url?: unknown; transport?: unknown; headers?: unknown; projectIds?: unknown } }>(
    "/api/orgs/:id/tools",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;
      const body = req.body ?? {};
      const url = checkUrl(body.url, production);
      if ("error" in url) return reply.code(400).send({ error: url.error });
      const transport = body.transport === "sse" ? "sse" : "http";
      const hdr = checkHeaders(body.headers);
      if ("error" in hdr) return reply.code(400).send({ error: hdr.error });
      const sealed = sealHeaders(hdr.headers);
      if ("error" in sealed) return reply.code(409).send({ error: sealed.error });
      const scope = await checkProjects(found.org.id, body.projectIds);
      if ("error" in scope) return reply.code(400).send({ error: scope.error });

      // Nothing is saved until the server answers: a typo should not become a broken tool.
      const listed = await listMcpTools(url.url, transport, hdr.headers, { allowLocal: !production });
      if (!listed.ok) {
        // A 401 with no headers given is a server that wants a sign-in, not a wrong key.
        const signIn = /\(401\)/.test(listed.error) && Object.keys(hdr.headers).length === 0;
        return reply.code(422).send({
          error: signIn
            ? "This server asks you to sign in rather than for an API key. Press Sign in instead."
            : `Compass could not list this server's tools: ${listed.error}.`,
          ...(signIn ? { signIn: true } : {}),
        });
      }
      if (listed.tools.length === 0) return reply.code(422).send({ error: "The server answered but offers no tools." });

      const typed = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
      // The host reads better than most servers' own names ("fern-docs-mcp-server").
      const label = typed || new URL(url.url).hostname;
      const taken = new Set((await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.orgId, found.org.id))).map((r) => r.name));
      const [row] = await db
        .insert(mcpServers)
        .values({
          orgId: found.org.id,
          name: slugFor(label, taken),
          label,
          transport,
          url: url.url,
          encryptedHeaders: sealed.sealed,
          headerNames: Object.keys(hdr.headers),
          projectIds: scope.ids,
          tools: mergeTools(listed.tools, []),
          checkedAt: new Date(),
          updatedBy: ctx.login,
        })
        .returning();
      await audit(found.org.id, ctx.userId, "tools.add", label, { url: url.url, tools: listed.tools.length });
      return view(row!);
    },
  );

  app.patch<{
    Params: { id: string; sid: string };
    Body: { label?: unknown; enabled?: unknown; useShape?: unknown; useAsk?: unknown; useBuild?: unknown; tools?: unknown; headers?: unknown; projectIds?: unknown };
  }>("/api/orgs/:id/tools/:sid", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
    if (!found) return;
    const row = (await db.select().from(mcpServers).where(and(eq(mcpServers.id, req.params.sid), eq(mcpServers.orgId, found.org.id))).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "tool server not found" });
    const b = req.body ?? {};
    const set: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date(), updatedBy: ctx.login };
    if (typeof b.label === "string" && b.label.trim()) set.label = b.label.trim().slice(0, 60);
    for (const k of ["enabled", "useShape", "useAsk", "useBuild"] as const) if (typeof b[k] === "boolean") set[k] = b[k];
    if (b.projectIds !== undefined) {
      const scope = await checkProjects(found.org.id, b.projectIds);
      if ("error" in scope) return reply.code(400).send({ error: scope.error });
      set.projectIds = scope.ids;
    }
    if (b.tools && typeof b.tools === "object") {
      const want = b.tools as Record<string, unknown>;
      set.tools = row.tools.map((t) => (typeof want[t.name] === "boolean" ? { ...t, allowed: want[t.name] as boolean } : t));
    }
    if (b.headers !== undefined) {
      if (row.authKind === "oauth") return reply.code(409).send({ error: "This server signs in. Press Sign in again instead of typing headers." });
      const hdr = checkHeaders(b.headers);
      if ("error" in hdr) return reply.code(400).send({ error: hdr.error });
      const sealed = sealHeaders(hdr.headers);
      if ("error" in sealed) return reply.code(409).send({ error: sealed.error });
      set.encryptedHeaders = sealed.sealed;
      set.headerNames = Object.keys(hdr.headers);
    }
    const [next] = await db.update(mcpServers).set(set).where(eq(mcpServers.id, row.id)).returning();
    const { updatedAt: _u, updatedBy: _b, encryptedHeaders, ...changed } = set;
    await audit(found.org.id, ctx.userId, "tools.change", row.label, {
      ...changed,
      ...(encryptedHeaders !== undefined ? { headers: set.headerNames } : {}),
      ...(set.tools ? { tools: set.tools.filter((t) => t.allowed).map((t) => t.name) } : {}),
    });
    return view(next!);
  });

  /** Connect again: refresh the tool list (keeping choices) and the server's health. */
  app.post<{ Params: { id: string; sid: string } }>("/api/orgs/:id/tools/:sid/test", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
    if (!found) return;
    const row = (await db.select().from(mcpServers).where(and(eq(mcpServers.id, req.params.sid), eq(mcpServers.orgId, found.org.id))).limit(1))[0];
    if (!row) return reply.code(404).send({ error: "tool server not found" });
    const fresh = await ensureFresh(deps, row);
    if (expired(fresh)) return view(fresh);
    let headers: Record<string, string>;
    try {
      headers = openHeaders(fresh);
    } catch {
      return reply.code(409).send({ error: "The saved headers will not open with this Compass's master key. Enter them again." });
    }
    const listed = await listMcpTools(row.url, row.transport, headers, { allowLocal: !production });
    const set: Partial<typeof mcpServers.$inferInsert> = listed.ok
      ? { tools: mergeTools(listed.tools, row.tools), checkedAt: new Date(), checkError: null }
      : { checkedAt: new Date(), checkError: listed.error };
    const [next] = await db.update(mcpServers).set(set).where(eq(mcpServers.id, row.id)).returning();
    return view(next!);
  });

  const redirectUri = `${deps.cfg.PUBLIC_ORIGIN}/api/tools/oauth/callback`;
  const reach = { allowLocal: !production };

  /**
   * Sign in to a server that uses OAuth: a new one (label, url, transport,
   * projectIds) or an existing one again (serverId). Answers the address to
   * send the browser to; the server sends it back to the callback below.
   */
  app.post<{ Params: { id: string }; Body: { serverId?: unknown; label?: unknown; url?: unknown; transport?: unknown; projectIds?: unknown } }>(
    "/api/orgs/:id/tools/sign-in",
    async (req, reply) => {
      const ctx = await requireAuth(deps, req, reply);
      if (!ctx) return;
      const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
      if (!found) return;
      if (!deps.cfg.CONSOLE_MASTER_KEY) return reply.code(409).send({ error: "Sign-ins are stored sealed, and this Compass has no CONSOLE_MASTER_KEY." });
      const body = req.body ?? {};
      let target: Pick<PendingSignIn, "serverId" | "label" | "url" | "transport" | "projectIds">;
      if (typeof body.serverId === "string") {
        const row = (await db.select().from(mcpServers).where(and(eq(mcpServers.id, body.serverId), eq(mcpServers.orgId, found.org.id))).limit(1))[0];
        if (!row) return reply.code(404).send({ error: "tool server not found" });
        target = { serverId: row.id, label: row.label, url: row.url, transport: row.transport, projectIds: row.projectIds };
      } else {
        const url = checkUrl(body.url, production);
        if ("error" in url) return reply.code(400).send({ error: url.error });
        const scope = await checkProjects(found.org.id, body.projectIds);
        if ("error" in scope) return reply.code(400).send({ error: scope.error });
        const typed = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
        target = { serverId: null, label: typed || new URL(url.url).hostname, url: url.url, transport: body.transport === "sse" ? "sse" : "http", projectIds: scope.ids };
      }
      try {
        const meta = await discover(target.url, target.transport, reach);
        const client = await register(meta, redirectUri, reach);
        const { verifier, challenge } = pkce();
        const state = randomBytes(24).toString("base64url");
        const now = Date.now();
        for (const [k, v] of pendingSignIns) if (v.expiry < now) pendingSignIns.delete(k);
        pendingSignIns.set(state, {
          ...target,
          orgId: found.org.id,
          userId: ctx.userId,
          login: ctx.login,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          tokenEndpoint: meta.tokenEndpoint,
          resource: meta.resource,
          scope: meta.scope,
          verifier,
          expiry: now + SIGN_IN_TTL_MS,
        });
        return { authorizeUrl: authorizeUrl(meta, client.clientId, redirectUri, state, challenge) };
      } catch (err) {
        const why = err instanceof OAuthFailure ? err.message : `could not reach the server (${(err as Error).message})`;
        return reply.code(422).send({ error: `Compass could not start the sign-in: ${why}.` });
      }
    },
  );

  /** Where the server sends the browser back. Ends on the Tools page, saying how it went. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/tools/oauth/callback", async (req, reply) => {
    const back = (q: Record<string, string>) => reply.redirect(`/tools?${new URLSearchParams(q).toString()}`);
    const { code, state } = req.query;
    const pending = state ? pendingSignIns.get(state) : undefined;
    if (state) pendingSignIns.delete(state);
    if (!pending || pending.expiry < Date.now()) return back({ sign_in_error: "That sign-in had expired. Press Sign in again." });
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    if (ctx.userId !== pending.userId) return back({ sign_in_error: "That sign-in was started by someone else." });
    if (req.query.error || !code) {
      return back({ sign_in_error: `${pending.label} did not sign in: ${req.query.error_description ?? req.query.error ?? "no code came back"}.` });
    }
    const key = deps.cfg.CONSOLE_MASTER_KEY;
    try {
      const grant = await exchangeCode(pending, code, pending.verifier, redirectUri, reach);
      const listed = await listMcpTools(pending.url, pending.transport, { Authorization: `Bearer ${grant.accessToken}` }, reach);
      if (!listed.ok) return back({ sign_in_error: `Signed in, but Compass could not list ${pending.label}'s tools: ${listed.error}.` });
      if (listed.tools.length === 0) return back({ sign_in_error: `Signed in, but ${pending.label} offers no tools.` });
      const sealed = sealGrant(grant, key);
      const signedIn = { ...sealed, authKind: "oauth" as const, oauthBy: pending.login, checkedAt: new Date(), checkError: null, updatedBy: pending.login, updatedAt: new Date() };
      const before = pending.serverId
        ? (await db.select().from(mcpServers).where(and(eq(mcpServers.id, pending.serverId), eq(mcpServers.orgId, pending.orgId))).limit(1))[0]
        : undefined;
      if (before) {
        await db.update(mcpServers).set({ ...signedIn, tools: mergeTools(listed.tools, before.tools) }).where(eq(mcpServers.id, before.id));
      } else {
        const taken = new Set((await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.orgId, pending.orgId))).map((r) => r.name));
        await db.insert(mcpServers).values({
          orgId: pending.orgId,
          name: slugFor(pending.label, taken),
          label: pending.label,
          transport: pending.transport,
          url: pending.url,
          projectIds: pending.projectIds,
          tools: mergeTools(listed.tools, []),
          ...signedIn,
        });
      }
      await audit(pending.orgId, ctx.userId, "tools.sign_in", pending.label, { url: pending.url, tools: listed.tools.length });
      return back({ signed_in: pending.label });
    } catch (err) {
      const why = err instanceof OAuthFailure ? err.message : (err as Error).message;
      return back({ sign_in_error: `${pending.label} did not sign in: ${why}.` });
    }
  });

  app.delete<{ Params: { id: string; sid: string } }>("/api/orgs/:id/tools/:sid", async (req, reply) => {
    const ctx = await requireAuth(deps, req, reply);
    if (!ctx) return;
    const found = await loadOrg(deps, ctx, req.params.id, reply, { admin: true });
    if (!found) return;
    const gone = await db
      .delete(mcpServers)
      .where(and(eq(mcpServers.id, req.params.sid), eq(mcpServers.orgId, found.org.id)))
      .returning();
    if (gone.length === 0) return reply.code(404).send({ error: "tool server not found" });
    await audit(found.org.id, ctx.userId, "tools.remove", gone[0]!.label, { url: gone[0]!.url });
    return reply.code(204).send();
  });
}
