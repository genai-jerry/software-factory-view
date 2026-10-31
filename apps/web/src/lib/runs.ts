import type { OrchestratorRunLog } from "../components/OrchestratorRunView.js";
import { runEvents } from "../components/OrchestratorRunView.js";

/**
 * A run in plain words (redesign boards 9 and 10). The orchestrator records
 * phases — resolving the model, cloning, running Claude, waiting for tests,
 * fixing failing tests, pushing, finished — and this folds them into four
 * steps a reader follows: Prepare, Work, Tests, Hand over. Tool names, model
 * names and tokens stay behind the full log.
 */

export type Step = "prepare" | "work" | "tests" | "handover";
export const STEPS: Step[] = ["prepare", "work", "tests", "handover"];
export const STEP_LABEL: Record<Step, string> = { prepare: "Get ready", work: "Do the work", tests: "Run the tests", handover: "Hand over" };

export const ROLE_NAME: Record<string, string> = {
  implementer: "Builder",
  reviewer: "Reviewer",
  qa: "Tester",
  release: "Release manager",
  planner: "Planner",
  architect: "Designer",
  intake: "Analyst",
  dispatch: "Dispatcher",
  testplanner: "Test planner",
  ops: "Ops",
  profiler: "Profiler",
  scrum: "Release planner",
};

export function roleName(role: string | undefined | null): string {
  return role ? (ROLE_NAME[role] ?? role) : "The factory";
}

/** What the role does, said as the step the reader is watching. */
export function stepOf(phase: string): Step {
  const p = phase.toLowerCase();
  if (p.startsWith("resolving") || p.startsWith("cloning")) return "prepare";
  if (p.startsWith("running claude")) return "work";
  if (p.includes("tests")) return "tests";
  if (p.startsWith("pushing") || p === "finished" || p.startsWith("handing")) return "handover";
  return "work";
}

/** A phase message in the reader's words. */
export function phaseWords(phase: string, role?: string | null): string {
  const p = phase.toLowerCase();
  if (p.startsWith("resolving")) return "Choosing which model to use.";
  if (p === "starting" || p.startsWith("starting")) return "Starting.";
  if (p.startsWith("cloning")) return "Getting a copy of the code.";
  if (p.startsWith("running claude")) {
    switch (role) {
      case "implementer":
        return "Reading the design and changing the code.";
      case "reviewer":
        return "Reading the change and checking it against the design.";
      case "qa":
        return "Checking every scenario has a passing test.";
      case "release":
        return "Assembling the change and checking it is green.";
      case "planner":
        return "Breaking the plan into tasks.";
      case "architect":
        return "Writing the design.";
      case "intake":
        return "Reading the request and writing the plan.";
      case "testplanner":
        return "Writing the test plan and its cases.";
      case "dispatch":
        return "Releasing the tasks that can start.";
      default:
        return "Working on it.";
    }
  }
  if (p.startsWith("waiting for tests")) return "Running the tests.";
  if (p.startsWith("fixing failing tests")) return "Some tests failed. Fixing them and running again.";
  if (p.startsWith("pushing")) return "Handing the change over.";
  if (p === "finished") return "Finished.";
  return phase;
}

/** What happens after this role, so the reader knows whether to wait. */
export function afterRole(role: string | undefined | null): string {
  switch (role) {
    case "implementer":
      return "The reviewer checks the change, then the factory tests it. You are asked only if it gets stuck.";
    case "reviewer":
      return "If the change is clean, the factory tests it. If not, the builder fixes it and the reviewer looks again.";
    case "qa":
      return "If every scenario has a passing test, the change joins the item's branch. If not, the builder fixes it.";
    case "release":
      return "The item is assembled and you are asked to release it.";
    case "intake":
      return "You are asked to approve the plan.";
    case "planner":
      return "The designer writes the design, then you are asked to approve it.";
    case "architect":
      return "You are asked to approve the design.";
    case "testplanner":
      return "The test cases appear on the item for a tester to run.";
    case "dispatch":
      return "The builders start on the tasks that are ready.";
    default:
      return "The next stage follows on its own.";
  }
}

export interface RunStory {
  role: string;
  running: boolean;
  outcome: "success" | "error" | "timeout" | "no_op" | "running" | string;
  startedAt: Date | null;
  finishedAt: Date | null;
  minutes: number | null;
  /** The four steps and which are done or current. */
  steps: Array<{ step: Step; state: "done" | "now" | "todo" }>;
  /** Each phase so far, in words, with its own minutes. */
  soFar: Array<{ words: string; minutes: number | null; now: boolean }>;
  /** The current phase in words. */
  now: string;
  /** How many times it fixed failing tests. */
  fixAttempts: number;
}

export function storyOf(run: OrchestratorRunLog): RunStory {
  const role = run.role ?? "";
  const started = run.started_at ? new Date(run.started_at) : null;
  const finished = run.finished_at ? new Date(run.finished_at) : null;
  const running = !finished;
  const end = finished ?? new Date();
  const minutes = started ? Math.max(0, Math.round((end.getTime() - started.getTime()) / 60_000)) : null;
  const phases = runEvents(run).filter((e) => e.kind === "phase" || !e.kind);
  const last = phases[phases.length - 1];
  const nowStep: Step | null = running ? (last ? stepOf(last.message) : "prepare") : null;
  const reached = new Set<Step>();
  for (const p of phases) reached.add(stepOf(p.message));
  const steps = STEPS.map((step) => {
    const i = STEPS.indexOf(step);
    if (!running) return { step, state: "done" as const };
    if (nowStep && STEPS.indexOf(nowStep) > i) return { step, state: "done" as const };
    if (nowStep === step) return { step, state: "now" as const };
    return { step, state: reached.has(step) ? ("done" as const) : ("todo" as const) };
  });
  const soFar = phases.map((p, i) => {
    const t0 = p.ts ? new Date(p.ts) : null;
    const next = phases[i + 1]?.ts ? new Date(phases[i + 1]!.ts!) : finished ?? (running ? new Date() : null);
    return {
      words: phaseWords(p.message, role),
      minutes: t0 && next ? Math.max(0, Math.round((next.getTime() - t0.getTime()) / 60_000)) : null,
      now: running && i === phases.length - 1,
    };
  });
  const fixAttempts = phases.filter((p) => p.message.toLowerCase().startsWith("fixing failing tests")).length;
  const outcome = running ? "running" : (run.outcome ?? run.status ?? "finished");
  const now = running ? (last ? phaseWords(last.message, role) : "Starting.") : outcomeWords(outcome, run.error);
  return { role, running, outcome, startedAt: started, finishedAt: finished, minutes, steps, soFar, now, fixAttempts };
}

export function outcomeWords(outcome: string, error?: string | null): string {
  switch (outcome) {
    case "success":
      return "Finished and handed over.";
    case "no_op":
      return "Finished without changing anything. The factory will look again.";
    case "timeout":
      return "Ran out of time and stopped. The factory will try again.";
    case "error":
      return error ? `Stopped with a problem: ${error}` : "Stopped with a problem.";
    default:
      return `Finished (${outcome}).`;
  }
}
