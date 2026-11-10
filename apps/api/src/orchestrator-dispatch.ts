import type { McpServerPayload } from "./mcp-servers.js";
import type { ConsoleConfig } from "@console/core";
import { randomUUID } from "node:crypto";
import { Agent } from "undici";

/**
 * Ask the Software Factory orchestrator to run a role. GitHub App webhooks for
 * the Console land on PUBLIC_ORIGIN (ngrok → the Console), not on the
 * orchestrator, so labelling `factory:profile` never starts a LangGraph run by
 * itself. `/dispatch` is the Console's equivalent of "Run workflow".
 */
/** Header and body timeouts long enough for the waiting /ask (askAndHold). */
const longAnswer = new Agent({ headersTimeout: 1_300_000, bodyTimeout: 1_300_000 });

export type OrchestratorDispatch = {
  dispatched?: boolean;
  dispatchedAt?: string;
  dispatchId?: string;
  orchestratorUrl?: string;
  dispatchError?: string;
  run?: {
    id: string;
    htmlUrl: string;
    status: string;
    conclusion: null;
    createdAt: string;
    engine: "software-factory";
  };
};

export async function dispatchFactoryRole(
  cfg: ConsoleConfig,
  args: {
    owner: string;
    repo: string;
    role: string;
    issue: number;
    githubToken?: string;
    /** When the token above actually dies. Without it the orchestrator can
     *  only assume, and a role that outlives the assumption 401s mid-run. */
    githubTokenExpiresAt?: string;
    installationId?: number;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
  },
): Promise<OrchestratorDispatch> {
  const base = cfg.ORCHESTRATOR_URL.trim().replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!base) {
    return {
      dispatchError:
        "the Console filed the profile issue, but ORCHESTRATOR_URL is not set, so it never asked the Software Factory orchestrator to start. GitHub delivered the label event to the Console, not to :8080. Set ORCHESTRATOR_URL (from Docker: http://host.docker.internal:8080) and ORCHESTRATOR_DISPATCH_TOKEN to match the orchestrator's DISPATCH_TOKEN, then Re-run.",
    };
  }
  if (!token) {
    return {
      orchestratorUrl: base,
      dispatchError: `ORCHESTRATOR_DISPATCH_TOKEN is empty — the Console cannot call ${base}/dispatch. Set it to the orchestrator's DISPATCH_TOKEN, then Re-run.`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${base}/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        owner: args.owner,
        repo: args.repo,
        role: args.role,
        issue: args.issue,
        ...(args.githubToken ? { github_token: args.githubToken } : {}),
        ...(args.githubTokenExpiresAt ? { github_token_expires_at: args.githubTokenExpiresAt } : {}),
        ...(args.installationId ? { installation_id: args.installationId } : {}),
        ...(cfg.PUBLIC_ORIGIN ? { console_url: cfg.PUBLIC_ORIGIN.replace(/\/+$/, "") } : {}),
        ...(args.anthropicApiKey ? { anthropic_api_key: args.anthropicApiKey } : {}),
        ...(args.claudeCodeOauthToken ? { claude_code_oauth_token: args.claudeCodeOauthToken } : {}),
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return {
      orchestratorUrl: base,
      dispatchError: `could not reach the orchestrator at ${base} (${(err as Error).message}). Is it running on :8080?`,
    };
  }

  const body = (await res.json().catch(() => ({}))) as { queued?: boolean; dispatch_id?: string; detail?: string };
  if (!res.ok) {
    return {
      orchestratorUrl: base,
      dispatchError: `orchestrator ${base}/dispatch returned ${res.status}${body.detail ? `: ${body.detail}` : ""}`,
    };
  }
  const dispatchId = typeof body.dispatch_id === "string" ? body.dispatch_id : "";
  const createdAt = new Date().toISOString();
  return {
    dispatched: true,
    dispatchedAt: createdAt,
    dispatchId,
    orchestratorUrl: base,
    run: {
      id: dispatchId || "queued",
      htmlUrl: `${base}/runs`,
      status: "queued",
      conclusion: null,
      createdAt,
      engine: "software-factory",
    },
  };
}

export type DispatchSync = { status: "pending" | "failed"; detail: Record<string, unknown> };

/**
 * /dispatch returns 200 as soon as the job is queued. Failures (bad App key,
 * clone errors) land on GET /deliveries/{id}. The onboarding poll reads that
 * so the card can leave "the Profiler is reading the repo".
 */
export async function syncDispatchStatus(
  cfg: ConsoleConfig,
  detail: Record<string, unknown>,
): Promise<DispatchSync | null> {
  const dispatchId = typeof detail.dispatchId === "string" ? detail.dispatchId : "";
  const base = (typeof detail.orchestratorUrl === "string" ? detail.orchestratorUrl : cfg.ORCHESTRATOR_URL)
    .trim()
    .replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!dispatchId || !base || !token || detail.dispatchError) return null;
  const run = detail.run as { status?: string; conclusion?: string | null } | undefined;
  if (run?.status === "completed" || run?.conclusion === "failure") return null;

  let res: Response;
  try {
    res = await fetch(`${base}/deliveries/${encodeURIComponent(dispatchId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
  if (body.status !== "failed") return null;
  const error =
    typeof body.error === "string" && body.error
      ? body.error
      : "the Software Factory orchestrator failed before it started a run";
  const prev = (detail.run as Record<string, unknown> | undefined) ?? {};
  return {
    status: "failed",
    detail: {
      ...detail,
      dispatchError: error,
      error,
      run: {
        ...prev,
        id: prev.id ?? dispatchId,
        htmlUrl: typeof prev.htmlUrl === "string" ? prev.htmlUrl : `${base}/runs`,
        status: "completed",
        conclusion: "failure",
        engine: "software-factory",
      },
    },
  };
}

export type OrchestratorProxyError = { error: string; status: number };

/**
 * The orchestrator's clock as ISO 8601 in UTC. Its ledger stores an aware
 * time, but SQLite hands it back bare (`2026-11-05 06:01:48.213069`) and a
 * browser reads a bare timestamp as local time: a run four minutes old shows
 * as "running for 334 min" five and a half hours east of Greenwich. A value
 * that already names its zone passes through; anything unreadable is kept
 * as it came.
 */
export function orchestratorClock(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().replace(" ", "T");
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`;
  const at = new Date(zoned);
  return Number.isNaN(at.getTime()) ? value : at.toISOString();
}

/** A run as the orchestrator sent it, with its clock read as UTC. */
function withClock(run: Record<string, unknown>): Record<string, unknown> {
  const out = { ...run };
  for (const key of ["started_at", "finished_at"]) {
    if (out[key] != null) out[key] = orchestratorClock(out[key]) ?? out[key];
  }
  return out;
}

function orchestratorBase(cfg: ConsoleConfig): { base: string; token: string } | OrchestratorProxyError {
  const base = cfg.ORCHESTRATOR_URL.trim().replace(/\/+$/, "");
  const token = cfg.ORCHESTRATOR_DISPATCH_TOKEN.trim();
  if (!base) return { error: "ORCHESTRATOR_URL is not set", status: 502 };
  if (!token) return { error: "ORCHESTRATOR_DISPATCH_TOKEN is empty", status: 502 };
  return { base, token };
}

async function orchestratorGet(
  cfg: ConsoleConfig,
  path: string,
  opts: { asText?: boolean } = {},
): Promise<{ ok: true; status: number; body: unknown; text?: string } | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}${path}`, {
      headers: { authorization: `Bearer ${dest.token}` },
      signal: AbortSignal.timeout(6_000),
    });
  } catch (err) {
    return { error: `could not reach the orchestrator (${(err as Error).message})`, status: 502 };
  }
  if (res.status === 404) return { error: "no such run", status: 404 };
  if (!res.ok) return { error: `orchestrator returned ${res.status}`, status: 502 };
  if (opts.asText) {
    return { ok: true, status: res.status, body: null, text: await res.text() };
  }
  return { ok: true, status: res.status, body: await res.json().catch(() => ({})) };
}

/** Console-side stand-in for GET /runs/{id} — the browser must not open :8080 JSON. */
export async function fetchOrchestratorRun(
  cfg: ConsoleConfig,
  runId: string,
): Promise<{ ok: true; run: Record<string, unknown> } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, `/runs/${encodeURIComponent(runId)}`);
  if ("error" in got) return got;
  if (!got.body || typeof got.body !== "object" || Array.isArray(got.body)) {
    return { error: "orchestrator run was not an object", status: 502 };
  }
  return { ok: true, run: withClock(got.body as Record<string, unknown>) };
}

export async function fetchOrchestratorTranscript(
  cfg: ConsoleConfig,
  runId: string,
): Promise<{ ok: true; transcript: string } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, `/runs/${encodeURIComponent(runId)}/transcript`, { asText: true });
  if ("error" in got) return got;
  return { ok: true, transcript: got.text ?? "" };
}

export interface PastRun {
  id: string;
  repo: string;
  issue: number;
  role: string;
  outcome: string;
  startedAt: string;
  finishedAt: string;
  model: string | null;
  error: string | null;
  /** The transcript can still be served; false once a redeploy has cleared it. Absent on an older orchestrator. */
  hasLog: boolean | null;
}

/**
 * The orchestrator's recent runs (its newest 100), finished ones only. An
 * orchestrator that cannot be reached gives an empty list, and the page
 * simply has no history to show.
 */
export async function fetchPastRuns(cfg: ConsoleConfig): Promise<PastRun[]> {
  const got = await orchestratorGet(cfg, "/runs");
  if ("error" in got || !Array.isArray(got.body)) return [];
  const out: PastRun[] = [];
  for (const r of got.body as Array<Record<string, unknown>>) {
    if (typeof r.id !== "string" || typeof r.repo !== "string" || typeof r.issue !== "number") continue;
    if (!r.finished_at || !r.started_at) continue;
    out.push({
      id: r.id,
      repo: r.repo,
      issue: r.issue,
      role: typeof r.role === "string" ? r.role : "",
      outcome: typeof r.outcome === "string" ? r.outcome : "",
      startedAt: orchestratorClock(r.started_at) ?? String(r.started_at),
      finishedAt: orchestratorClock(r.finished_at) ?? String(r.finished_at),
      model: typeof r.model === "string" ? r.model : null,
      error: typeof r.error === "string" && r.error ? r.error : null,
      hasLog: typeof r.has_log === "boolean" ? r.has_log : null,
    });
  }
  return out;
}

export interface ActiveRun {
  id: string;
  /** The orchestrator's role name: implementer, reviewer, qa, release, … */
  role: string;
  startedAt: string;
  /** The model the run resolved to, once it has (the orchestrator records it as the run starts). */
  model: string | null;
}

/**
 * Every run live on the orchestrator right now, keyed `owner/repo#issue`
 * (the newest, where a restart left two). The run is what a "running" badge
 * should open: its log says what the agent is doing. An orchestrator that
 * cannot be reached, or is too old to list runs, gives an empty map — the
 * badge still shows, with the role guessed from the stage and no log link.
 */
export async function fetchActiveRuns(cfg: ConsoleConfig): Promise<Map<string, ActiveRun>> {
  const out = new Map<string, ActiveRun>();
  const got = await orchestratorGet(cfg, "/runs?active=true");
  if ("error" in got || !Array.isArray(got.body)) return out;
  for (const r of got.body as Array<{ id?: string; repo?: string; issue?: number; role?: string; started_at?: string; model?: string | null }>) {
    if (!r.id || !r.repo || typeof r.issue !== "number") continue;
    const key = `${r.repo}#${r.issue}`;
    const startedAt = orchestratorClock(r.started_at) ?? "";
    const prior = out.get(key);
    if (!prior || startedAt > prior.startedAt) out.set(key, { id: r.id, role: r.role ?? "", startedAt, model: typeof r.model === "string" && r.model ? r.model : null });
  }
  return out;
}

export type AskMode = "ask" | "shape" | "investigate";

/**
 * How long the orchestrator lets a session in each mode run, in ms (its
 * MODES), plus a minute for the queue for a slot and the checkout.
 */
const ASK_BUDGET_MS: Record<AskMode, number> = { ask: 360_000, shape: 540_000, investigate: 1_260_000 };

/** A question for the orchestrator's read-only Claude session (POST /asks, or /ask). */
export type AskBody = {
  /** Both, or neither for Shape about a new product (no repository yet). */
  owner?: string;
  repo?: string;
  question: string;
  context: string;
  branch?: string;
  /** How to answer, when the caller has its own rules (the epic panel's citations). */
  instructions?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  /** Images the session reads with its Read tool (Shape). */
  images?: Array<{ name: string; mime: string; dataB64: string }>;
  /** `"shape"` buys the longer budgets of a conversation that is shaping an idea; `"investigate"` the longest, for reading a product's repos and logs. */
  mode?: AskMode;
  /** Other repositories checked out beside the primary one, each on `branch` when it exists there, else its default. */
  repos?: Array<{ owner: string; repo: string; branch: string | null }>;
  /** A persistent workspace key (a Shape conversation id): the checkout is kept between messages and reset to the branch each time. */
  conversation?: string;
  /** A Claude session id from an earlier answer on the same conversation, to resume instead of starting cold. */
  session?: string;
  /** The org's Compass → Tools servers (mcpPayloadFor); the orchestrator picks the ones for this mode. */
  mcpServers?: McpServerPayload[];
  /** Compass → Models: the chain this ask runs on, first choice first. Absent: the repo's file and the factory default decide. */
  models?: string[];
};

/** A finished answer. */
export type AskAnswer = {
  ok: true;
  answer: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  session?: string;
  resumed?: boolean;
};

/** Where a background ask stands (GET /asks/{id}). `gone`: the orchestrator has no such ask. */
export type AskState =
  | { status: "running" }
  | { status: "done"; answer: AskAnswer }
  | { status: "failed"; error: OrchestratorProxyError }
  | { status: "gone" };

/** A verdict from the orchestrator, as opposed to not reaching it (whose error also has a numeric `status`). */
export function isAskState(got: AskState | OrchestratorProxyError): got is AskState {
  return typeof got.status === "string";
}

/** What the orchestrator says when an ask was cut off, or is not there at all. */
export const ASK_GONE = "The orchestrator lost the question, probably in a restart. Ask again.";

function askPayload(body: AskBody): Record<string, unknown> {
  return {
    ...(body.owner && body.repo ? { owner: body.owner, repo: body.repo } : {}),
    question: body.question,
    context: body.context,
    ...(body.branch ? { branch: body.branch } : {}),
    ...(body.instructions ? { instructions: body.instructions } : {}),
    ...(body.anthropicApiKey ? { anthropic_api_key: body.anthropicApiKey } : {}),
    ...(body.claudeCodeOauthToken ? { claude_code_oauth_token: body.claudeCodeOauthToken } : {}),
    ...(body.images && body.images.length > 0
      ? { images: body.images.map((i) => ({ name: i.name, mime: i.mime, data_b64: i.dataB64 })) }
      : {}),
    ...(body.mode && body.mode !== "ask" ? { mode: body.mode } : {}),
    ...(body.repos && body.repos.length > 0 ? { repos: body.repos } : {}),
    ...(body.conversation ? { conversation: body.conversation } : {}),
    ...(body.session ? { session: body.session } : {}),
    ...(body.mcpServers ? { mcp_servers: body.mcpServers } : {}),
    ...(body.models && body.models.length > 0 ? { models: body.models } : {}),
  };
}

type AnswerJson = {
  answer?: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  session?: string;
  resumed?: boolean;
};

function answerOf(json: AnswerJson & { answer: string }): AskAnswer {
  return {
    ok: true,
    answer: json.answer,
    model: json.model ?? "",
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    ...(typeof json.session === "string" && json.session ? { session: json.session } : {}),
    ...(typeof json.resumed === "boolean" ? { resumed: json.resumed } : {}),
  };
}

/**
 * Hand the orchestrator a question to answer in the background, under an id
 * the caller picks (POST /asks). Returns at once; the answer is collected
 * with fetchAsk. Sending an id again starts nothing. `legacy`: this
 * orchestrator predates /asks, so only the waiting /ask is there.
 */
export async function submitAsk(cfg: ConsoleConfig, id: string, body: AskBody): Promise<{ ok: true } | { legacy: true } | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}/asks`, {
      method: "POST",
      headers: { authorization: `Bearer ${dest.token}`, "content-type": "application/json" },
      body: JSON.stringify({ id, ...askPayload(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { error: `could not reach the orchestrator (${(err as Error).message})`, status: 502 };
  }
  if (res.status === 404 || res.status === 405) return { legacy: true };
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => ({}))) as { detail?: string };
  if (res.status === 501) return { error: "this orchestrator is too old to answer questions — redeploy it", status: 502 };
  return { error: json.detail || `orchestrator returned ${res.status}`, status: res.status === 429 ? 429 : 502 };
}

/** Where a background ask stands. An orchestrator that cannot be reached is an error, not a verdict: ask again later. */
export async function fetchAsk(cfg: ConsoleConfig, id: string): Promise<AskState | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, `/asks/${encodeURIComponent(id)}`);
  if ("error" in got) return got.status === 404 ? { status: "gone" } : got;
  const json = (got.body ?? {}) as AnswerJson & { status?: string; error?: string; error_status?: number };
  if (json.status === "running") return { status: "running" };
  if (json.status === "done" && json.answer) return { status: "done", answer: answerOf({ ...json, answer: json.answer }) };
  return {
    status: "failed",
    error: { error: json.error || (json.status === "done" ? "The orchestrator returned no answer." : "The answer failed."), status: json.error_status === 429 ? 429 : 502 },
  };
}

/**
 * The waiting /ask, for an orchestrator that predates /asks. It sends nothing
 * until the answer is written, and Node's fetch gives up on a reply whose
 * headers have not started in 300 s (undici's default), well inside the 480 s
 * a Shape answer may take; the agent leaves the call's own AbortSignal in charge.
 */
async function askAndHold(cfg: ConsoleConfig, body: AskBody): Promise<AskAnswer | OrchestratorProxyError> {
  const dest = orchestratorBase(cfg);
  if ("error" in dest) return dest;
  let res: Response;
  try {
    res = await fetch(`${dest.base}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${dest.token}`, "content-type": "application/json" },
      body: JSON.stringify(askPayload(body)),
      signal: AbortSignal.timeout(ASK_BUDGET_MS[body.mode ?? "ask"]),
      dispatcher: longAnswer,
    } as RequestInit);
  } catch (err) {
    return { error: `could not reach the orchestrator (${(err as Error).message})`, status: 502 };
  }
  const json = (await res.json().catch(() => ({}))) as AnswerJson & { detail?: string };
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { error: "this orchestrator is too old to answer questions — redeploy it", status: 502 };
  }
  if (!res.ok || !json.answer) {
    return { error: json.detail || `orchestrator returned ${res.status}`, status: res.status === 429 ? 429 : 502 };
  }
  return answerOf({ ...json, answer: json.answer });
}

/** Pauses between checks on a background ask: soon at first, then every 3 s. */
const ASK_POLL_MS = [0, 500, 1_000, 2_000, 3_000];

/**
 * A person's question about a thread, answered by the orchestrator's Claude
 * CLI — the subscription token works there, not on the API. The question is
 * handed over as a background ask and checked on until it is done, so no
 * request is held open while Claude reads; the error text is the reason to
 * show the asker. Callers that must outlive this process (Shape) use
 * submitAsk and fetchAsk themselves.
 */
export async function askOrchestrator(cfg: ConsoleConfig, body: AskBody): Promise<AskAnswer | OrchestratorProxyError> {
  const id = randomUUID();
  const sent = await submitAsk(cfg, id, body);
  if ("legacy" in sent) return askAndHold(cfg, body);
  if ("error" in sent) return sent;
  const deadline = Date.now() + ASK_BUDGET_MS[body.mode ?? "ask"];
  for (let i = 0; Date.now() < deadline; i++) {
    await new Promise((r) => setTimeout(r, ASK_POLL_MS[Math.min(i, ASK_POLL_MS.length - 1)]));
    const got = await fetchAsk(cfg, id);
    if (!isAskState(got) || got.status === "running") continue; // unreachable for a moment: check again
    if (got.status === "done") return got.answer;
    if (got.status === "failed") return got.error;
    return { error: ASK_GONE, status: 502 };
  }
  return { error: "The orchestrator took too long to answer. Ask again.", status: 504 };
}

/**
 * The orchestrator's GET /usage: the last five hours of Claude use and any
 * usage limit in force. An orchestrator older than that endpoint answers 404,
 * which reads as "nothing to show" rather than an error.
 */
export async function fetchOrchestratorUsage(
  cfg: ConsoleConfig,
): Promise<{ ok: true; usage: Record<string, unknown> | null } | OrchestratorProxyError> {
  const got = await orchestratorGet(cfg, "/usage");
  if ("error" in got) return got.status === 404 ? { ok: true, usage: null } : got;
  const body = got.body;
  return { ok: true, usage: body && typeof body === "object" ? (body as Record<string, unknown>) : null };
}

export async function fetchOrchestratorRuns(
  cfg: ConsoleConfig,
  query: { repo: string; issue: number },
): Promise<{ ok: true; runs: unknown[] } | OrchestratorProxyError> {
  const params = new URLSearchParams({ repo: query.repo, issue: String(query.issue) });
  const got = await orchestratorGet(cfg, `/runs?${params}`);
  if ("error" in got) return got;
  const runs = Array.isArray(got.body) ? got.body : [];
  return { ok: true, runs: runs.map((r) => (r && typeof r === "object" ? withClock(r as Record<string, unknown>) : r)) };
}

/** One turn on a build environment, as the orchestrator reports it. */
export interface OrchestratorTurn {
  run_id: string | null;
  role: string | null;
  issue: number | null;
  /** The issue's repo, when it is not the environment's (a cross-repo task waiting on its epic's home staging). */
  repo?: string | null;
  state: string;
  since: string | null;
}

export interface OrchestratorEnvironment {
  id: string;
  kind: "staging" | "epic" | "task" | "issue";
  repo: string;
  number: number | null;
  epic: string | null;
  last_used_at: string | null;
  active: OrchestratorTurn | null;
  queue: OrchestratorTurn[];
  notes: Array<{ at: string | null; role: string | null; issue: number | null; run_id: string | null; outcome: string | null; summary: string }>;
}

export interface OrchestratorSession {
  run_id: string | null;
  role: string | null;
  issue: number | null;
  repo: string | null;
  environment: string | null;
  since: string | null;
}

export interface OrchestratorEnvironments {
  sessions: { total: number; in_use: OrchestratorSession[]; waiting: OrchestratorSession[] } | null;
  environments: OrchestratorEnvironment[];
}

/**
 * The orchestrator's GET /environments: its build environments (staging, one
 * per epic, one per task), who holds each and who waits, plus the Claude
 * sessions in use. `null` when it cannot be reached or is older than that
 * endpoint: the page then says so instead of drawing an empty factory.
 */
export async function fetchOrchestratorEnvironments(cfg: ConsoleConfig): Promise<OrchestratorEnvironments | null> {
  const got = await orchestratorGet(cfg, "/environments");
  if ("error" in got || !got.body || typeof got.body !== "object") return null;
  const body = got.body as Partial<OrchestratorEnvironments>;
  if (!Array.isArray(body.environments)) return null;
  return { sessions: body.sessions ?? null, environments: body.environments };
}
