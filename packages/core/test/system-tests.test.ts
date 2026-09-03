import { describe, expect, it } from "vitest";
import {
  deriveIssueKind,
  epicStatus,
  parseChangePath,
  gateApproverChain,
  isTestState,
  MANUAL_TEST_STATE,
  nextStep,
  offersVerdict,
  parseApproverFile,
  parseTestingPolicy,
  phaseOfState,
  PIPELINE_ORDER,
  resolveGateApprovers,
  TEST_FAILED_STATE,
  TEST_PASSED_STATE,
  testsHoldTheGate,
  testsOutstanding,
  testVerdictStatus,
} from "../src/index.js";

const progress = (over: Partial<Parameters<typeof epicStatus>[1] & object> = {}) => ({
  total: 4, done: 0, blocked: 0, inReview: 0, inTest: 0, shipping: 0, ...over,
});

describe("the test issue kind", () => {
  it("reads a test( sub-issue as its own kind", () => {
    expect(deriveIssueKind({ labels: [MANUAL_TEST_STATE], title: "test(9): ST-4 Renewal fires", hasParent: true }))
      .toBe("test");
  });

  it("does not mistake a task for one", () => {
    expect(deriveIssueKind({ labels: ["factory:ready"], title: "task(9): Renewals", hasParent: true }))
      .toBe("task");
  });

  it("holds even before the Dispatcher has labelled the case", () => {
    // A pending case carries no state at all — the title is what identifies it.
    expect(deriveIssueKind({ labels: [], title: "test(9): ST-4 Renewal fires", hasParent: true }))
      .toBe("test");
  });
});

describe("the case states", () => {
  it("are states, but never rail columns", () => {
    for (const s of [MANUAL_TEST_STATE, TEST_PASSED_STATE, TEST_FAILED_STATE]) {
      expect(isTestState(s)).toBe(true);
      // The rail is the path a change takes; a case hangs off one point of it.
      expect(PIPELINE_ORDER).not.toContain(s);
    }
  });

  it("place a runnable case in the building phase", () => {
    expect(phaseOfState(MANUAL_TEST_STATE)).toBe("building");
    expect(phaseOfState(TEST_FAILED_STATE)).toBe("building");
  });
});

describe("the testers list", () => {
  it("falls back to the implementation approvers", () => {
    expect(gateApproverChain("testers")).toEqual(["testers", "implementation"]);
    const file = parseApproverFile({ implementation: ["dev"] });
    const r = resolveGateApprovers("testers", (g) => (file as Record<string, string[]>)[g] ?? []);
    expect(r).toEqual({ gate: "implementation", approvers: ["dev"], fellBackFrom: "testers" });
  });

  it("prefers its own list when the repo names one", () => {
    const file = parseApproverFile({ testers: ["tess"], implementation: ["dev"] });
    expect(resolveGateApprovers("testers", (g) => (file as Record<string, string[]>)[g] ?? []).approvers)
      .toEqual(["tess"]);
  });
});

describe("the testing policy", () => {
  it("is off unless the file says otherwise", () => {
    expect(parseTestingPolicy(undefined).systemTests).toBe(false);
    expect(parseTestingPolicy({}).systemTests).toBe(false);
    expect(parseTestingPolicy({ system_tests: "yes" }).systemTests).toBe(false);
  });

  it("defaults an enabled repo to gate mode", () => {
    expect(parseTestingPolicy({ system_tests: true })).toEqual({ systemTests: true, mode: "gate" });
    expect(parseTestingPolicy({ system_tests: true, mode: "advisory" }).mode).toBe("advisory");
  });

  it("only holds the gate with an epic branch and gate mode", () => {
    const on = parseTestingPolicy({ system_tests: true });
    expect(testsHoldTheGate(on, true)).toBe(true);
    // No epic branch: the code reaches a shared branch only at GS, so the
    // cases run afterwards and are evidence for G3, never a hold.
    expect(testsHoldTheGate(on, false)).toBe(false);
    expect(testsHoldTheGate(parseTestingPolicy({ system_tests: true, mode: "advisory" }), true)).toBe(false);
    expect(testsHoldTheGate(parseTestingPolicy({}), true)).toBe(false);
  });
});

describe("epic status with system tests", () => {
  const tests = { total: 5, passed: 2, runnable: 3, failed: 0 };

  it("says what an assembled epic is waiting on", () => {
    const s = epicStatus("factory:design-approved", progress({ done: 4 }), tests);
    expect(s).toBe("Assembled · waiting on 3 tests");
  });

  it("counts one remaining case in the singular", () => {
    expect(epicStatus("factory:design-approved", progress({ done: 4 }), { ...tests, passed: 4, runnable: 1 }))
      .toBe("Assembled · waiting on 1 test");
  });

  it("reads code and cases apart while both are moving", () => {
    expect(epicStatus("factory:design-approved", progress({ done: 1, inReview: 1 }), tests))
      .toBe("Building 1/4 · 1 in flight · Testing 2/5");
  });

  it("is unchanged for a repo with no system tests", () => {
    expect(epicStatus("factory:design-approved", progress({ done: 4 }))).toBe("All 4 tasks done");
    expect(epicStatus("factory:design-approved", progress({ done: 1 }))).toBe("Building 1/4");
  });

  it("does not hold an epic whose cases have all passed", () => {
    expect(epicStatus("factory:design-approved", progress({ done: 4 }), { total: 5, passed: 5, runnable: 0, failed: 0 }))
      .toBe("All 4 tasks done");
  });

  it("counts a failed case as outstanding — the fix has not landed", () => {
    expect(testsOutstanding({ total: 3, passed: 1, runnable: 1, failed: 1 })).toBe(2);
  });
});

describe("what a case is waiting for", () => {
  const base = { state: MANUAL_TEST_STATE, verdictAt: null, runnableSince: new Date("2026-09-01T10:00:00Z") };

  it("offers the buttons on an undecided case", () => {
    const s = testVerdictStatus(base);
    expect(s).toBe("awaiting");
    expect(offersVerdict(s)).toBe(true);
  });

  it("holds them while a posted verdict is unrouted", () => {
    const s = testVerdictStatus({ ...base,
      verdictAt: new Date("2026-09-01T10:05:00Z"), now: new Date("2026-09-01T10:06:00Z") });
    expect(s).toBe("pending");
    expect(offersVerdict(s)).toBe(false);
  });

  it("gives them back when nothing is coming", () => {
    const s = testVerdictStatus({ ...base,
      verdictAt: new Date("2026-09-01T10:05:00Z"), now: new Date("2026-09-01T10:30:00Z") });
    expect(s).toBe("stalled");
    expect(offersVerdict(s)).toBe(true);
  });

  it("ignores a verdict from a previous round", () => {
    // The case failed, the fix landed, the Dispatcher put it back: the old
    // Test Failed must not read as a decision on this round.
    expect(testVerdictStatus({ ...base, verdictAt: new Date("2026-08-30T09:00:00Z") })).toBe("awaiting");
  });

  it("reads the settled states straight off the label", () => {
    expect(testVerdictStatus({ ...base, state: TEST_PASSED_STATE })).toBe("passed");
    expect(testVerdictStatus({ ...base, state: TEST_FAILED_STATE })).toBe("failed");
    expect(testVerdictStatus({ ...base, state: "factory:ready" })).toBe("none");
  });
});

describe("the hand-off wording", () => {
  it("names the testers and both comments on a runnable case", () => {
    const e = nextStep(MANUAL_TEST_STATE, ["tess"]);
    expect(e.who).toContain("@tess");
    expect(e.how).toContain("Test Passed");
    expect(e.how).toContain("Test Failed");
  });

  it("tells a failed case's reader that nothing is asked of them", () => {
    expect(nextStep(TEST_FAILED_STATE, []).how).toContain("fix");
  });
});

describe("the change folder knows the two new artifacts", () => {
  it("classifies the plan and its data", () => {
    expect(parseChangePath("openspec/changes/9-renewals/system-tests/test-plan.md"))
      .toEqual({ slug: "9-renewals", epicNumber: 9, artifact: "test-plan" });
    expect(parseChangePath("openspec/changes/9-renewals/system-tests/test-data.md")?.artifact)
      .toBe("test-data");
  });

  it("leaves every other artifact reading as it did", () => {
    expect(parseChangePath("openspec/changes/9-renewals/proposal.md")?.artifact).toBe("proposal");
    expect(parseChangePath("openspec/changes/9-renewals/design.md")?.artifact).toBe("design");
    expect(parseChangePath("openspec/changes/9-renewals/tasks.md")?.artifact).toBe("tasks");
    expect(parseChangePath("openspec/changes/9-renewals/specs/billing/spec.md")?.artifact).toBe("spec");
  });

  it("does not classify a stray file under system-tests", () => {
    // Data files a plan references live under system-tests/data/; they are
    // content the plan links, not artifacts the reader lists on their own.
    expect(parseChangePath("openspec/changes/9-renewals/system-tests/data/customers.csv")?.artifact).toBeNull();
  });
});
