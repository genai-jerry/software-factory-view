import { and, desc, eq, gt, lt, sql as raw } from "drizzle-orm";
import { logEvents, runtimeSettings } from "./schema.js";
import type { Db } from "./index.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
export const LOG_LEVEL_SETTING = "log_level";

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === "string" && (LOG_LEVELS as string[]).includes(v);
}

/**
 * Secrets that must never reach the log table. Logs are readable in the UI, so
 * anything that would be a credential in someone else's hands is masked before
 * it is stored — not filtered at read time, where a missed case is permanent.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"],
  // The envelope format encryptSecret produces: v1.<iv>.<tag>.<ciphertext>
  [/\bv1\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]+/g, "[redacted ciphertext]"],
  [/\b(client_secret|clientSecret|password|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, "$1$2[redacted]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Field names whose value is a secret whatever it looks like. Pattern matching
 * on the value cannot catch these — a client secret is just a string — so the
 * key is what gives them away.
 */
const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|cookie|private[_-]?key|api[_-]?key|credential)/i;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

interface Pending {
  service: string;
  level: LogLevel;
  message: string;
  context: unknown;
  ts: Date;
}

export interface LogStoreOptions {
  /** Which process these lines came from: "api" or "worker". */
  service: string;
  level?: LogLevel;
  /** How long a line may sit in memory before being written. */
  flushMs?: number;
  /** Write immediately once this many lines are waiting. */
  maxBuffer?: number;
  /** Rows to keep. The table is a diagnostic window, not history. */
  retainRows?: number;
}

/**
 * Buffered writer for the log_events table.
 *
 * Logging must never be the reason a request fails, so every write is
 * best-effort: failures fall back to the real console and are dropped rather
 * than retried. Writes are batched because a per-line INSERT would put the
 * database in the hot path of every request.
 */
export class LogStore {
  private buffer: Pending[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private levelPoll: ReturnType<typeof setInterval> | undefined;
  private currentLevel: LogLevel;
  private flushing = false;
  private restoreConsole: (() => void) | undefined;
  private readonly service: string;
  private readonly flushMs: number;
  private readonly maxBuffer: number;
  private readonly retainRows: number;
  /** Bound before console is patched, so internal errors cannot recurse. */
  private readonly realError = console.error.bind(console);

  constructor(
    private readonly db: Db,
    opts: LogStoreOptions,
  ) {
    this.service = opts.service;
    this.currentLevel = opts.level ?? "info";
    this.flushMs = opts.flushMs ?? 1_000;
    this.maxBuffer = opts.maxBuffer ?? 50;
    this.retainRows = opts.retainRows ?? 5_000;
  }

  get level(): LogLevel {
    return this.currentLevel;
  }

  setLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  enabled(level: LogLevel): boolean {
    return RANK[level] >= RANK[this.currentLevel];
  }

  write(level: LogLevel, message: string, context?: unknown): void {
    if (!this.enabled(level)) return;
    this.buffer.push({
      service: this.service,
      level,
      message: redact(message).slice(0, 8_000),
      context: context === undefined ? null : redactValue(context),
      ts: new Date(),
    });
    if (this.buffer.length >= this.maxBuffer) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.db.insert(logEvents).values(batch);
    } catch (err) {
      this.realError("log store write failed:", (err as Error).message);
    } finally {
      this.flushing = false;
    }
  }

  /** Periodic flush, pruning, and — when asked — following the stored level. */
  start(opts: { followLevel?: boolean; levelPollMs?: number } = {}): void {
    this.timer ??= setInterval(() => {
      void this.flush().then(() => this.prune());
    }, this.flushMs);
    this.timer.unref?.();

    if (opts.followLevel) {
      const poll = async () => {
        const stored = await getRuntimeSetting(this.db, LOG_LEVEL_SETTING).catch(() => null);
        if (isLogLevel(stored) && stored !== this.currentLevel) this.setLevel(stored);
      };
      void poll();
      this.levelPoll ??= setInterval(() => void poll(), opts.levelPollMs ?? 15_000);
      this.levelPoll.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.levelPoll) clearInterval(this.levelPoll);
    this.timer = this.levelPoll = undefined;
    this.restoreConsole?.();
    await this.flush();
  }

  private pruneCounter = 0;
  private prune(): void {
    // Every ~30 flushes rather than every one: the cap is a ceiling, not a quota.
    if (++this.pruneCounter % 30 !== 0) return;
    void this.db
      .delete(logEvents)
      .where(lt(logEvents.id, raw<number>`(select coalesce(max(id), 0) - ${this.retainRows} from log_events)`))
      .catch((err: Error) => this.realError("log prune failed:", err.message));
  }

  /**
   * Mirror console output into the store. The worker logs this way, and so do
   * the startup lines of both processes; without this the UI would show only
   * what Fastify emits.
   */
  captureConsole(): void {
    if (this.restoreConsole) return;
    const original = {
      debug: console.debug.bind(console),
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    const bridge =
      (level: LogLevel, emit: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        emit(...args);
        try {
          this.write(level, args.map(stringify).join(" "));
        } catch {
          /* logging must not throw into the caller */
        }
      };
    console.debug = bridge("debug", original.debug);
    console.log = bridge("info", original.log);
    console.info = bridge("info", original.info);
    console.warn = bridge("warn", original.warn);
    console.error = bridge("error", original.error);
    this.restoreConsole = () => {
      Object.assign(console, original);
      this.restoreConsole = undefined;
    };
  }

  /**
   * A destination for pino, so Fastify's own request logging lands here too.
   * Pino writes one JSON object per line to whatever stream it is given.
   */
  pinoStream(): { write: (line: string) => void } {
    const fromPino: Record<number, LogLevel> = { 10: "debug", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "error" };
    return {
      write: (line: string) => {
        try {
          const { level, msg, time, ...rest } = JSON.parse(line) as Record<string, unknown>;
          const mapped = fromPino[Number(level)] ?? "info";
          delete rest.pid;
          delete rest.hostname;
          this.write(mapped, typeof msg === "string" ? msg : line.slice(0, 500), Object.keys(rest).length ? rest : undefined);
        } catch {
          this.write("info", line.trim().slice(0, 2_000));
        }
      },
    };
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface LogQuery {
  level?: LogLevel;
  service?: string;
  search?: string;
  limit?: number;
  /** Only rows newer than this id — how the UI tails without refetching all. */
  afterId?: number;
}

export interface LogRow {
  id: number;
  ts: Date;
  service: string;
  level: string;
  message: string;
  context: unknown;
}

export async function readLogs(db: Db, query: LogQuery = {}): Promise<LogRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1_000);
  const conditions = [];
  if (query.level) {
    const allowed = LOG_LEVELS.filter((l) => RANK[l] >= RANK[query.level!]);
    conditions.push(raw`${logEvents.level} in ${raw.raw(`(${allowed.map((l) => `'${l}'`).join(",")})`)}`);
  }
  if (query.service) conditions.push(eq(logEvents.service, query.service));
  if (query.search) conditions.push(raw`${logEvents.message} ilike ${"%" + query.search + "%"}`);
  if (query.afterId !== undefined) conditions.push(gt(logEvents.id, query.afterId));

  const rows = await db
    .select()
    .from(logEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(logEvents.id))
    .limit(limit);
  return rows as LogRow[];
}

export async function getRuntimeSetting(db: Db, key: string): Promise<string | null> {
  const row = (await db.select().from(runtimeSettings).where(eq(runtimeSettings.key, key)).limit(1))[0];
  return row?.value ?? null;
}

export async function setRuntimeSetting(db: Db, key: string, value: string, updatedBy?: string): Promise<void> {
  await db
    .insert(runtimeSettings)
    .values({ key, value, updatedBy: updatedBy ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: runtimeSettings.key,
      set: { value, updatedBy: updatedBy ?? null, updatedAt: new Date() },
    });
}
