import {
  factoryHandoff,
  IN_PROGRESS_LABEL,
  type FactoryHandoff,
  type HandoffRun,
} from "@console/core";
import type { ConsoleConfig } from "@console/core";
import { fetchOrchestratorRuns, orchestratorConfigured } from "./orchestrator-dispatch.js";

/**
 * The epic workspace's answer to "why is nothing happening?".
 *
 * Labels alone cannot tell a live run from a marker a dead run left behind, so
 * this asks the orchestrator what it has for the issue. That call is on a page
 * load, so it is short-fused and never fatal: an orchestrator that is down
 * produces a handoff that says so, not a 502 on the workspace.
 */
const RUNS_TIMEOUT_MS = 2_500;

/** GET /runs shape (snake_case, orchestrator side) → the pure module's shape. */
function toHandoffRun(raw: unknown): HandoffRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  if (!id) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    id,
    role: str(r.role),
    startedAt: str(r.started_at),
    finishedAt: str(r.finished_at),
    // /runs reports "running" as the outcome of a live run; keep it, the pure
    // module distinguishes by finishedAt rather than by this string.
    outcome: str(r.outcome),
    error: str(r.error),
  };
}

export async function epicFactoryHandoff(
  cfg: ConsoleConfig,
  input: { engine: string | null | undefined; open: boolean; labels: string[]; repoFullName: string; issueNumber: number },
): Promise<FactoryHandoff> {
  const { configured, detail } = orchestratorConfigured(cfg);
  const softwareFactory = input.engine === "software-factory";
  // Only issues the orchestrator could plausibly be working on are worth a
  // round trip: everything else is answered from labels alone.
  const worthAsking =
    softwareFactory && configured && input.open && (input.labels.some((l) => l.startsWith("factory:")) || false);

  let runs: HandoffRun[] | null = null;
  let runsError: string | null = null;
  if (worthAsking) {
    const got = await fetchOrchestratorRuns(
      cfg,
      { repo: input.repoFullName, issue: input.issueNumber },
      { timeoutMs: RUNS_TIMEOUT_MS },
    );
    if ("error" in got) runsError = got.error;
    else runs = got.runs.map(toHandoffRun).filter((r): r is HandoffRun => r !== null);
  }

  return factoryHandoff({
    engine: input.engine,
    open: input.open,
    labels: input.labels,
    configured,
    configuredDetail: detail,
    runs,
    runsError,
  });
}

export { IN_PROGRESS_LABEL };
