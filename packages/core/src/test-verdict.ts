import {
  BUG_OPEN_STATE,
  BUG_RETEST_STATE,
  BUG_VERIFIED_STATE,
  MANUAL_TEST_STATE,
  TEST_FAILED_STATE,
  TEST_PASSED_STATE,
} from "./factory.js";

/**
 * What a system test case — or a bug report at re-test (§4c) — is actually
 * waiting for (FACTORY.md §4b).
 *
 * `factory:manual-test` is not one moment either — the same problem
 * `start-gate.ts` solves for `factory:ready`. The state label stays put from
 * the Dispatcher releasing the case until the router routes the verdict
 * comment, which means it still reads "runnable" while a tester's
 * `Test Passed` is sitting on the issue unrouted. Offering the buttons again
 * there invites a second verdict on a case already decided.
 *
 * The facts that separate the moments are already projected: the state, and
 * the verdict comment itself.
 */

/** How long a posted verdict may sit unrouted before the buttons come back. */
export const VERDICT_GRACE_MS = 10 * 60_000;

export type TestVerdictStatus =
  /** Not a runnable case at all (any other state, or not a test sub-issue). */
  | "none"
  /** Released and undecided — the one moment that wants the buttons. */
  | "awaiting"
  /** A verdict is posted; the factory has not routed it yet. */
  | "pending"
  /** Posted long enough ago that nothing is coming; verdict again. */
  | "stalled"
  /** Passed and closed. */
  | "passed"
  /** Failed; the fix task named on the case (or on the bug) is in flight. */
  | "failed";

export interface TestVerdictInput {
  /** Derived factory state label. */
  state: string | null;
  /** Newest `Test Passed`/`Test Failed` comment on the case, or null. */
  verdictAt: Date | null;
  /**
   * When the case last entered `factory:manual-test` — or the bug
   * `factory:bug-retest`; null when unknown.
   */
  runnableSince: Date | null;
  now?: Date;
}

/**
 * A verdict older than the case's entry into `factory:manual-test` belongs to
 * a previous round — the case failed, the fix landed, and the Dispatcher put
 * it back. That old comment must not read as a decision on this round.
 */
export function testVerdictStatus(input: TestVerdictInput): TestVerdictStatus {
  if (input.state === TEST_PASSED_STATE || input.state === BUG_VERIFIED_STATE) return "passed";
  if (input.state === TEST_FAILED_STATE || input.state === BUG_OPEN_STATE) return "failed";
  // A bug at re-test takes the same two verdicts, from the same list, with the
  // same "a verdict is posted but not yet routed" problem — so it takes the
  // same reading. `runnableSince` is when the Dispatcher moved it here.
  if (input.state !== MANUAL_TEST_STATE && input.state !== BUG_RETEST_STATE) return "none";
  const { verdictAt, runnableSince } = input;
  if (!verdictAt) return "awaiting";
  if (runnableSince && verdictAt < runnableSince) return "awaiting";
  const now = input.now ?? new Date();
  return now.getTime() - verdictAt.getTime() > VERDICT_GRACE_MS ? "stalled" : "pending";
}

/** Whether the Pass/Fail controls should be offered at all. */
export function offersVerdict(status: TestVerdictStatus): boolean {
  return status === "awaiting" || status === "stalled";
}
