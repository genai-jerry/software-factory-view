/**
 * The repo's system-test policy — `.github/factory-testing.json`
 * (FACTORY.md §4b), read the same way every other factory config file is.
 *
 * Absent or unparseable means off, and off must be indistinguishable from a
 * repo that has never heard of system tests: no plan, no cases, no test
 * accounting on gate GS.
 */
export type TestMode = "gate" | "advisory";

export interface TestingPolicy {
  systemTests: boolean;
  /**
   * Bug reports (FACTORY.md §4c) ride on this file too. Absent, the key
   * follows `system_tests`: a repo that turned the cases on gets the bugs with
   * them. An explicit value wins either way — the cases without the bugs, or
   * exploratory testing with bugs and no written plan.
   */
  bugReports: boolean;
  /**
   * `gate` holds an epic short of `factory:epic-ready` until every open case
   * has passed; `advisory` flips it and reports the open cases instead.
   *
   * It decides nothing for a repo with no epic branch: there the code first
   * reaches a shared branch at gate GS itself, so the cases run on staging
   * afterwards and their verdicts are evidence for gate G3 — which is a
   * human's merge click, and not something the factory can hold.
   */
  mode: TestMode;
}

export const TESTING_POLICY_PATH = ".github/factory-testing.json";

export function parseTestingPolicy(json: unknown): TestingPolicy {
  const obj = (json ?? {}) as Record<string, unknown>;
  const systemTests = obj.system_tests === true;
  return {
    systemTests,
    bugReports: typeof obj.bug_reports === "boolean" ? obj.bug_reports : systemTests,
    mode: obj.mode === "advisory" ? "advisory" : "gate",
  };
}

/**
 * Whether open cases hold this epic short of gate GS. False wherever the
 * verdicts are evidence rather than a gate: policy off, advisory mode, or an
 * epic with no epic branch.
 */
export function testsHoldTheGate(policy: TestingPolicy, hasEpicBranch: boolean): boolean {
  return policy.systemTests && policy.mode === "gate" && hasEpicBranch;
}

/**
 * Whether an open bug report holds this epic short of gate GS (§4c). The same
 * three conditions, on the other key: an open bug is a defect nobody has
 * confirmed repaired, and under `gate` with an epic branch the factory refuses
 * the staging release while one exists.
 */
export function bugsHoldTheGate(policy: TestingPolicy, hasEpicBranch: boolean): boolean {
  return policy.bugReports && policy.mode === "gate" && hasEpicBranch;
}
