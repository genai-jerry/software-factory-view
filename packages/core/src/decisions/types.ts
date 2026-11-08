/**
 * The shapes the Decisions page is computed from — shared by the browser
 * (apps/web) and the API (Telegram notifications), so both read the same
 * decisions. Browser-safe: no Node imports anywhere under decisions/.
 */

export interface AttentionEntry {
  kind: "gate" | "blocked" | "task-start" | "merge";
  /** 1 = agent halted on you · 2 = gate awaits you · 3 = task start awaits you · 4 = unowned broadcast */
  rank: 1 | 2 | 3 | 4;
  whyYou: string;
  epicId: string;
  issueId: string;
  title: string;
  repo: string;
  state: string | null;
  ageDays: number;
  /** For blocked entries: the agent's actual stuck question, when it left one. */
  question: string | null;
  /** The row's epic carries `factory:expedite` — what it still surfaces for is narrower. */
  expedited: boolean;
  link: string;
}

export interface BoardCard {
  epicId: string;
  number: number;
  title: string;
  repo: string;
  estateId: string;
  state: string | null;
  open: boolean;
  daysInState: number;
  blocked: boolean;
  /** The epic carries `factory:expedite`. */
  expedited: boolean;
  tasks: TaskRollup;
}

/** An epic's system test cases (FACTORY.md §4b), counted apart from its code
 * tasks. Absent where the repo runs no system tests, or the epic has none. */
export interface TestRollup {
  total: number;
  passed: number;
  runnable: number;
  failed: number;
  skipped?: number;
  outstanding: number;
}

export interface TaskRollup {
  total: number;
  ready: number;
  inReview: number;
  inTest: number;
  /** Green and merged onto the epic/integration branch, not yet closed. */
  shipping: number;
  /** Of `shipping`: green and waiting for the Release Manager. */
  readyToShip?: number;
  /** Of `shipping`: merged onto the epic branch. */
  onEpic?: number;
  done: number;
  blocked: number;
  /** Open tasks that have at least one open blocker. */
  waiting: number;
  /** Open tasks the Dispatcher has not released yet: no factory state at all. */
  notStarted?: number;
  /** In review, in test or on a branch — the work the done count cannot see. */
  inFlight: number;
  tests?: TestRollup;
  bugs?: BugRollup;
}

/** An epic's bug reports (FACTORY.md §4c), counted apart from its code tasks. */
export interface BugRollup {
  total: number;
  /** Raised; the task fixing it is in flight. */
  fixing: number;
  /** The fix is assembled; a tester has to confirm it. */
  retest: number;
  verified: number;
  /** `fixing + retest` — what the epic still waits on. */
  open: number;
}

/** GET /api/running — one open task or epic with a factory run live on it. */
export interface RunningItem {
  issueId: string;
  number: number;
  title: string;
  repo: string;
  kind: "task" | "epic";
  role: string;
  /** The live orchestrator run: its log is what the card opens. Null when the orchestrator cannot say. */
  runId?: string | null;
  epicId: string;
  epicNumber: number;
  epicTitle: string;
}
