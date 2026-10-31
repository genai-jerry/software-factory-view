import { DESIGN_APPROVED_STATE } from "./factory.js";

/**
 * What an epic's badge says while its label cannot say it.
 *
 * `factory:design-approved` is the whole build (FACTORY.md §3 — "Released for
 * implementation"), and the label must stay put: it is the dispatcher's guard
 * for re-running on task close. So the epic reads "Design approved" — a gate
 * receipt, past tense — from G2 until the Release Manager takes it, with its
 * tasks visibly building underneath. The Console already knew better in two
 * places and used neither on the badge: `phaseOfState` maps this state to
 * `building`, and the task rollup ships on the same payload (Flow and Mission
 * Control have been rendering "2/4 tasks" from it all along).
 *
 * Returns null where the label is the honest answer — every other state (a
 * gate must keep reading as a call to action), and a design-approved epic the
 * Dispatcher has not fanned out yet. The caller falls back to its own label
 * vocabulary, so this adds a reading rather than replacing one.
 */
export interface EpicProgress {
  total: number;
  done: number;
  blocked: number;
  /** Draft PR under agent review (§5). */
  inReview: number;
  /** QA is verifying the scenarios (§5). */
  inTest: number;
  /** Merged onto the epic/integration branch, not yet closed (§6a, §6b). */
  shipping: number;
  /** Released to an implementer and not started (`factory:ready`). */
  ready?: number;
  /** Of `shipping`: green, waiting for the Release Manager. */
  readyToShip?: number;
  /** Of `shipping`: merged onto the epic branch. */
  onEpic?: number;
  /** The epic's system test cases, where the repo runs them. */
  tests?: EpicTests;
}

/**
 * An epic's system test cases (FACTORY.md §4b), counted apart from its code
 * tasks. They are a different kind of work — a human running the assembled
 * change — and folding them into the task counts would make an epic whose
 * code is finished read as still building, or one whose cases nobody has run
 * read as done. Absent where the repo does not run system tests.
 */
export interface EpicTests {
  total: number;
  passed: number;
  /** Released and waiting for a tester. */
  runnable: number;
  /** Failed; a fix task is in flight. */
  failed: number;
  /** Skipped by a staging approver: closed, not run, not passed. */
  skipped?: number;
}

/** Cases neither passed, skipped nor abandoned — what the epic is still waiting on. */
export function testsOutstanding(tests: EpicTests | undefined): number {
  return tests ? tests.total - tests.passed - (tests.skipped ?? 0) : 0;
}

/**
 * Tasks an agent has already carried past the start gate and that are not yet
 * closed: in review, in test, or green on a branch waiting for the epic.
 *
 * The done count alone cannot see them, and a task only closes at the very end
 * of the line (§6d), so an epic whose every task is mid-chain rolls up as
 * "0 done" — which reads as "nothing has happened" precisely when the most is
 * happening. Counted here once so the badge and the next-step line cannot
 * drift apart.
 */
export function tasksInFlight(tasks: EpicProgress): number {
  return tasks.inReview + tasks.inTest + tasks.shipping;
}

/**
 * Where an epic's work actually is, as a pipeline stage. The epic keeps
 * `factory:design-approved` for its whole build, so the stage rail drew it at
 * "Released to build" while every task was on the epic branch and the epic
 * was waiting on its testers. For an epic in that state this reads the
 * stage of its slowest task — ready, in review, in test, ready to ship, then
 * on the epic branch — and leaves every other state, and an epic with no
 * released task yet, where its label has it.
 */
export function effectiveStage(state: string | null | undefined, tasks: EpicProgress | undefined): string | null {
  if (state !== DESIGN_APPROVED_STATE) return state ?? null;
  if (!tasks || tasks.total === 0) return state;
  if ((tasks.ready ?? 0) > 0) return "factory:ready";
  if (tasks.inReview > 0) return "factory:in-review";
  if (tasks.inTest > 0) return "factory:in-test";
  if ((tasks.readyToShip ?? 0) > 0) return "factory:ready-to-ship";
  if ((tasks.onEpic ?? 0) > 0 || tasks.shipping > 0 || tasks.done === tasks.total) return "factory:on-epic";
  return state;
}

export function epicStatus(
  state: string | null | undefined,
  tasks: EpicProgress | undefined,
  tests?: EpicTests,
): string | null {
  if (state !== DESIGN_APPROVED_STATE) return null;
  if (!tasks || tasks.total === 0) return null;
  const open = testsOutstanding(tests);
  const codeDone = tasks.done + tasks.shipping === tasks.total || tasks.done === tasks.total;
  // The state system tests add: the code is built and the epic is held by
  // people, not by the factory. Reading "All tasks done" there would say the
  // epic is finished when what it is really doing is waiting for its testers.
  if (codeDone && open > 0) {
    return `Assembled · waiting on ${open} test${open === 1 ? "" : "s"}`;
  }
  if (tasks.done === tasks.total) return `All ${tasks.total} tasks done`;
  // Everything left is on a branch waiting to ship — no longer "building".
  if (tasks.shipping > 0 && tasks.done + tasks.shipping === tasks.total) {
    return `Shipping ${tasks.done}/${tasks.total}`;
  }
  const notes: string[] = [];
  const moving = tasksInFlight(tasks);
  if (moving > 0) notes.push(`${moving} in flight`);
  if (tasks.blocked > 0) notes.push(`${tasks.blocked} halted`);
  if (tests && tests.total > 0) notes.push(`Testing ${tests.passed}/${tests.total}`);
  return [`Building ${tasks.done}/${tasks.total}`, ...notes].join(" · ");
}
