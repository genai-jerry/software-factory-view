/**
 * Simulated system test cases (FACTORY.md §4b, Simulated cases), as the factory writes them on
 * GitHub, read back for the Compass.
 *
 * - A case's body carries `**Execution:** simulated` or `**Execution:** manual — <reason>`
 *   (the Test Planner, step 4b).
 * - A simulated run's verdict on a case is a factory comment carrying
 *   `<!-- sim-run: <run id> <sha> -->`, whose first line says whether the case passed or failed in
 *   the simulated environment and links the run, followed by the failing steps as `- ` lines.
 * - The epic's summary for that run carries `<!-- sim-run: <run id> -->` and names any regression
 *   on a line `- Also failing in this run (not this epic's cases): \`a\`, \`b\`.`
 * - A case whose fix is already filed carries `Blocked by #<fix>` in its body.
 */

export type CaseExecution = { kind: "simulated" } | { kind: "manual"; reason: string | null };

export interface SimulatedVerdict {
  run: number;
  sha: string;
  runUrl: string | null;
  result: "passed" | "failed";
  /** The failing steps, as the scenario runner wrote them. Empty on a pass. */
  failures: string[];
}

export interface SimulatedSummary {
  run: number;
  runUrl: string | null;
  /** Scenarios that failed in the run but cover none of this epic's cases. */
  regressions: string[];
}

const EXECUTION = /\*\*Execution:\*\*\s*(simulated|manual)\b(?:\s*[—–-]\s*([^\n]+))?/i;
const CASE_RUN = /<!--\s*sim-run:\s*(\d+)\s+([0-9a-f]{7,40})\s*-->/i;
const EPIC_RUN = /<!--\s*sim-run:\s*(\d+)\s*-->/i;
const RUN_LINK = /\[(\d+)\]\((https?:\/\/[^)\s]+)\)/;
const REGRESSIONS = /^- Also failing in this run[^:]*:\s*(.+?)\.?\s*$/m;
const FIX = /(?:^|\n)\s*blocked by\s*#(\d+)/i;

export function caseExecution(body: string | null | undefined): CaseExecution | null {
  const m = EXECUTION.exec(body ?? "");
  if (!m) return null;
  if (m[1]!.toLowerCase() === "simulated") return { kind: "simulated" };
  return { kind: "manual", reason: m[2]?.trim() || null };
}

/** The fix already filed for a case (`Blocked by #<n>`), or null. */
export function caseFix(body: string | null | undefined): number | null {
  const m = FIX.exec(body ?? "");
  return m ? Number(m[1]) : null;
}

export function simulatedVerdict(comment: string | null | undefined): SimulatedVerdict | null {
  const body = comment ?? "";
  const mark = CASE_RUN.exec(body);
  if (!mark) return null;
  const firstLine = body.split("\n", 1)[0] ?? "";
  const result = /passed in the simulated environment/i.test(firstLine) ? "passed" : "failed";
  const link = RUN_LINK.exec(firstLine);
  const failures =
    result === "failed"
      ? body
          .split("\n")
          .slice(1)
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).trim())
      : [];
  return { run: Number(mark[1]), sha: mark[2]!, runUrl: link ? link[2]! : null, result, failures };
}

export function simulatedSummary(comment: string | null | undefined): SimulatedSummary | null {
  const body = comment ?? "";
  const mark = EPIC_RUN.exec(body);
  if (!mark) return null;
  const link = RUN_LINK.exec(body.split("\n", 1)[0] ?? "");
  const r = REGRESSIONS.exec(body);
  const regressions = r ? Array.from(r[1]!.matchAll(/`([^`]+)`/g), (x) => x[1]!) : [];
  return { run: Number(mark[1]), runUrl: link ? link[2]! : null, regressions };
}

/** The newest simulated verdict among a case's comments (oldest first), or null. */
export function latestSimulatedVerdict(bodies: string[]): SimulatedVerdict | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const v = simulatedVerdict(bodies[i]);
    if (v) return v;
  }
  return null;
}

/** The newest simulated summary among an epic's comments (oldest first), or null. */
export function latestSimulatedSummary(bodies: string[]): SimulatedSummary | null {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const s = simulatedSummary(bodies[i]);
    if (s) return s;
  }
  return null;
}

/** The comment body that turns a failed case into a fix, optionally expedited (`Test Failed, expedite`). */
export const TEST_FAILED_EXPEDITE_BODY = "Test Failed, expedite";
