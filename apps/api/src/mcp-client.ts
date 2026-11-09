/**
 * Just enough of an MCP client to list a remote server's tools, for
 * Compass → Tools "Test". Claude Code does the real calls in the sessions;
 * Compass only needs to know the server answers and what it offers.
 *
 * Two transports: streamable HTTP (one POST per message; the reply is JSON
 * or a short SSE stream) and the older HTTP+SSE (a GET stream that names a
 * POST endpoint; replies arrive on the stream).
 */

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
}

export type ListResult = { ok: true; tools: ListedTool[]; serverName?: string } | { ok: false; error: string };

const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

interface RpcReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

const INIT = {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "compass", version: "1" },
};

function toTool(t: unknown): ListedTool | null {
  const x = t as { name?: unknown; title?: unknown; description?: unknown; annotations?: { title?: unknown; readOnlyHint?: unknown } };
  if (typeof x?.name !== "string" || !x.name) return null;
  const title = typeof x.annotations?.title === "string" ? x.annotations.title : typeof x.title === "string" ? x.title : undefined;
  return {
    name: x.name,
    ...(title ? { title } : {}),
    ...(typeof x.description === "string" ? { description: x.description.slice(0, 500) } : {}),
    readOnly: x.annotations?.readOnlyHint === true,
  };
}

/** The JSON-RPC messages in an SSE body (`data:` lines, joined per event). */
export function sseMessages(text: string): Array<{ event: string; data: string }> {
  const out: Array<{ event: string; data: string }> = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) out.push({ event, data: data.join("\n") });
  }
  return out;
}

function replyFor(id: number, bodies: string[]): RpcReply | null {
  for (const b of bodies) {
    try {
      const parsed = JSON.parse(b) as RpcReply | RpcReply[];
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) if (m?.id === id) return m;
    } catch {
      /* not JSON: skip */
    }
  }
  return null;
}

function failed(err: unknown): string {
  const e = err as Error;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "the server did not answer within 15 seconds";
  return `could not reach the server (${e?.message ?? String(err)})`;
}

async function listOverHttp(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<ListResult> {
  let session: string | null = null;
  let nextId = 1;
  const send = async (method: string, params?: unknown, notify = false): Promise<RpcReply | { error: string }> => {
    const id = nextId++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...(method !== "initialize" ? { "mcp-protocol-version": PROTOCOL } : {}),
      },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, ...(params ? { params } : {}) } : { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal,
    });
    session = res.headers.get("mcp-session-id") ?? session;
    if (notify) return {};
    if (res.status === 401 || res.status === 403) return { error: `the server refused the request (${res.status}) — check the headers` };
    if (!res.ok) return { error: `the server answered ${res.status}${res.status === 404 || res.status === 405 ? " — is this the MCP endpoint? If it is an SSE server, pick SSE" : ""}` };
    const text = await res.text();
    const type = res.headers.get("content-type") ?? "";
    const reply = replyFor(id, type.includes("text/event-stream") ? sseMessages(text).map((m) => m.data) : [text]);
    return reply ?? { error: "the server's reply was not MCP" };
  };

  const init = await send("initialize", INIT);
  if ("error" in init && typeof init.error === "string") return { ok: false, error: init.error };
  const initReply = init as RpcReply;
  if (initReply.error) return { ok: false, error: `the server refused to start: ${initReply.error.message ?? "unknown error"}` };
  await send("notifications/initialized", undefined, true);
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await send("tools/list", cursor ? { cursor } : undefined);
    if ("error" in got && typeof got.error === "string") return { ok: false, error: got.error };
    const r = got as RpcReply;
    if (r.error) return { ok: false, error: `the server would not list its tools: ${r.error.message ?? "unknown error"}` };
    for (const t of (r.result?.tools as unknown[]) ?? []) {
      const tool = toTool(t);
      if (tool) tools.push(tool);
    }
    cursor = typeof r.result?.nextCursor === "string" ? r.result.nextCursor : undefined;
    if (!cursor) break;
  }
  const info = initReply.result?.serverInfo as { name?: unknown } | undefined;
  return { ok: true, tools, ...(typeof info?.name === "string" ? { serverName: info.name } : {}) };
}

async function listOverSse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<ListResult> {
  const res = await fetch(url, { method: "GET", headers: { ...headers, accept: "text/event-stream" }, signal });
  if (res.status === 401 || res.status === 403) return { ok: false, error: `the server refused the request (${res.status}) — check the headers` };
  if (!res.ok || !res.body) return { ok: false, error: `the server answered ${res.status}` };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waiting: Array<{ event: string; data: string }> = [];
  const nextEvent = async (): Promise<{ event: string; data: string } | null> => {
    for (;;) {
      if (waiting.length) return waiting.shift()!;
      const cut = buffer.search(/\r?\n\r?\n/);
      if (cut >= 0) {
        waiting.push(...sseMessages(buffer.slice(0, cut)));
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  try {
    let endpoint: string | null = null;
    for (let ev = await nextEvent(); ev; ev = await nextEvent()) {
      if (ev.event === "endpoint") {
        endpoint = new URL(ev.data.trim(), url).toString();
        break;
      }
    }
    if (!endpoint) return { ok: false, error: "the SSE stream never named its message endpoint" };
    let nextId = 1;
    const call = async (method: string, params?: unknown): Promise<RpcReply> => {
      const id = nextId++;
      const post = await fetch(endpoint!, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        signal,
      });
      if (!post.ok && post.status !== 202) return { error: { message: `the server answered ${post.status}` } };
      for (let ev = await nextEvent(); ev; ev = await nextEvent()) {
        const reply = replyFor(id, [ev.data]);
        if (reply) return reply;
      }
      return { error: { message: "the stream closed before the reply" } };
    };
    const init = await call("initialize", INIT);
    if (init.error) return { ok: false, error: `the server refused to start: ${init.error.message ?? "unknown error"}` };
    await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal,
    });
    const tools: ListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await call("tools/list", cursor ? { cursor } : undefined);
      if (r.error) return { ok: false, error: `the server would not list its tools: ${r.error.message ?? "unknown error"}` };
      for (const t of (r.result?.tools as unknown[]) ?? []) {
        const tool = toTool(t);
        if (tool) tools.push(tool);
      }
      cursor = typeof r.result?.nextCursor === "string" ? r.result.nextCursor : undefined;
      if (!cursor) break;
    }
    const info = init.result?.serverInfo as { name?: unknown } | undefined;
    return { ok: true, tools, ...(typeof info?.name === "string" ? { serverName: info.name } : {}) };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Connect, list every tool, disconnect. Never throws: the error is the reason to show. */
export async function listMcpTools(url: string, transport: "http" | "sse", headers: Record<string, string>): Promise<ListResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return transport === "sse" ? await listOverSse(url, headers, signal) : await listOverHttp(url, headers, signal);
  } catch (err) {
    return { ok: false, error: failed(err) };
  }
}
