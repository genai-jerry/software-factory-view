import { decryptSecret, encryptSecret } from "@console/core";
import { auditLog, mcpServers, type McpTool } from "@console/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireAuth, type AppDeps } from "../context.js";
import { listMcpTools, type ListedTool } from "../mcp-client.js";
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

/** Keep earlier choices; a tool not seen before starts allowed only when it is read-only. */
export function mergeTools(listed: ListedTool[], before: McpTool[]): McpTool[] {
  const was = new Map(before.map((t) => [t.name, t.allowed]));
  return listed.map((t) => ({ ...t, allowed: was.get(t.name) ?? t.readOnly }));
}

export function registerToolRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps.dbh;
  const production = deps.cfg.NODE_ENV === "production";

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

  app.post<{ Params: { id: string }; Body: { label?: unknown; url?: unknown; transport?: unknown; headers?: unknown } }>(
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

      // Nothing is saved until the server answers: a typo should not become a broken tool.
      const listed = await listMcpTools(url.url, transport, hdr.headers);
      if (!listed.ok) return reply.code(422).send({ error: `Compass could not list this server's tools: ${listed.error}.` });
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
    Body: { label?: unknown; enabled?: unknown; useShape?: unknown; useAsk?: unknown; useBuild?: unknown; tools?: unknown; headers?: unknown };
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
    if (b.tools && typeof b.tools === "object") {
      const want = b.tools as Record<string, unknown>;
      set.tools = row.tools.map((t) => (typeof want[t.name] === "boolean" ? { ...t, allowed: want[t.name] as boolean } : t));
    }
    if (b.headers !== undefined) {
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
    let headers: Record<string, string>;
    try {
      headers = openHeaders(row);
    } catch {
      return reply.code(409).send({ error: "The saved headers will not open with this Compass's master key. Enter them again." });
    }
    const listed = await listMcpTools(row.url, row.transport, headers);
    const set: Partial<typeof mcpServers.$inferInsert> = listed.ok
      ? { tools: mergeTools(listed.tools, row.tools), checkedAt: new Date(), checkError: null }
      : { checkedAt: new Date(), checkError: listed.error };
    const [next] = await db.update(mcpServers).set(set).where(eq(mcpServers.id, row.id)).returning();
    return view(next!);
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
