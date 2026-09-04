import { describe, expect, it } from "vitest";
import {
  BUG_OPEN_STATE,
  BUG_RETEST_STATE,
  BUG_VERIFIED_STATE,
  bugCommentBody,
  bugReportAvailability,
  deriveFactoryState,
  deriveIssueKind,
  isBugState,
  isFactoryState,
  nextStep,
  offersVerdict,
  phaseOfState,
  PIPELINE_ORDER,
  testVerdictStatus,
} from "../src/index.js";

/**
 * Bug reports (FACTORY.md §4c) as the Console reads them.
 *
 * The three things that would quietly break something if they were wrong: a
 * report must be its own kind (a report counted as a task double-counts the
 * work, because the task that fixes it is already on the board), the kind
 * marker must never win state derivation, and the control must be offered in
 * exactly the shapes the factory would act on.
 */

describe("a bug report is its own kind", () => {
  it("reads bug(<epic>) as a bug, whatever else it carries", () => {
    expect(deriveIssueKind({ labels: ["factory:bug-open"], title: "bug(9): totals wrong", hasParent: true })).toBe("bug");
    // Before the Dispatcher has moved it, and with no parent projected yet.
    expect(deriveIssueKind({ labels: [], title: "bug(9): totals wrong", hasParent: false })).toBe("bug");
  });

  it("does not mistake the task that fixes one for the report", () => {
    expect(
      deriveIssueKind({ labels: ["factory:ready"], title: "task(9): fix bug #41 — totals wrong", hasParent: true }),
    ).toBe("task");
  });

  it("keeps the kind marker out of state derivation", () => {
    // `factory:bug` sits on the report for life, alongside one of the three
    // states. Reading it as the state would strand every report in a state no
    // renderer answers.
    expect(isFactoryState("factory:bug")).toBe(false);
    expect(deriveFactoryState(["factory:bug", BUG_OPEN_STATE])).toBe(BUG_OPEN_STATE);
  });

  it("keeps the three states off the pipeline rail", () => {
    // The rail is the path a change takes; a report hangs off one point of it.
    for (const s of [BUG_OPEN_STATE, BUG_RETEST_STATE, BUG_VERIFIED_STATE]) {
      expect(isBugState(s)).toBe(true);
      expect(PIPELINE_ORDER).not.toContain(s);
      // Every state still has to answer "what phase is this in?" and "what
      // now?" — an unanswered state renders as Held with no next mover.
      expect(phaseOfState(s)).toBeTruthy();
      expect(nextStep(s, []).who).toBeTruthy();
    }
  });
});

describe("the re-test verdict", () => {
  const at = (iso: string) => new Date(iso);

  it("is offered on a report whose fix is assembled", () => {
    const status = testVerdictStatus({ state: BUG_RETEST_STATE, verdictAt: null, runnableSince: at("2026-09-01T00:00:00Z") });
    expect(status).toBe("awaiting");
    expect(offersVerdict(status)).toBe(true);
  });

  it("is not offered while the fix is still in flight", () => {
    expect(testVerdictStatus({ state: BUG_OPEN_STATE, verdictAt: null, runnableSince: null })).toBe("failed");
    expect(offersVerdict("failed")).toBe(false);
  });

  it("is not offered on a report already confirmed", () => {
    expect(testVerdictStatus({ state: BUG_VERIFIED_STATE, verdictAt: null, runnableSince: null })).toBe("passed");
  });

  it("holds off while a posted verdict is still unrouted, and comes back if nothing happens", () => {
    const runnableSince = at("2026-09-01T00:00:00Z");
    const verdictAt = at("2026-09-01T00:05:00Z");
    expect(
      testVerdictStatus({ state: BUG_RETEST_STATE, verdictAt, runnableSince, now: at("2026-09-01T00:06:00Z") }),
    ).toBe("pending");
    expect(
      testVerdictStatus({ state: BUG_RETEST_STATE, verdictAt, runnableSince, now: at("2026-09-01T00:30:00Z") }),
    ).toBe("stalled");
  });

  it("ignores a verdict from the previous round", () => {
    // The report failed its re-test, another fix landed, and the Dispatcher
    // brought it back. The old comment is not a decision on this round.
    expect(
      testVerdictStatus({
        state: BUG_RETEST_STATE,
        verdictAt: at("2026-09-01T00:00:00Z"),
        runnableSince: at("2026-09-02T00:00:00Z"),
      }),
    ).toBe("awaiting");
  });
});

describe("whether a bug may be raised here", () => {
  const epic = {
    state: "factory:design-approved",
    open: true,
    kind: "epic",
    labels: [] as string[],
    bugReports: true as boolean | null,
  };

  it("is offered from the first task landing through the staging window", () => {
    for (const state of ["factory:design-approved", "factory:epic-ready", "factory:in-staging"]) {
      expect(bugReportAvailability({ ...epic, state }).offered).toBe(true);
    }
  });

  it("is refused before anything has been built", () => {
    const a = bugReportAvailability({ ...epic, state: "factory:planned" });
    expect(a.offered).toBe(false);
    expect(a.reason).toMatch(/has not built any yet/);
  });

  it("is refused on a shipped epic, closed or deployed", () => {
    expect(bugReportAvailability({ ...epic, open: false }).offered).toBe(false);
    expect(bugReportAvailability({ ...epic, state: "factory:deployed" }).reason).toMatch(/factory:incident/);
  });

  it("is refused on anything that is not an epic", () => {
    expect(bugReportAvailability({ ...epic, kind: "task" }).offered).toBe(false);
    expect(bugReportAvailability({ ...epic, kind: "test" }).offered).toBe(false);
    expect(bugReportAvailability({ ...epic, labels: ["factory:fast-track"] }).offered).toBe(false);
  });

  it("is refused where the repo has bug reports off — but not where the policy is merely unread", () => {
    expect(bugReportAvailability({ ...epic, bugReports: false }).offered).toBe(false);
    // Unread is not off: hiding the control on every repo connected before the
    // policy was mirrored would be worse than a refusal the factory explains.
    expect(bugReportAvailability({ ...epic, bugReports: null }).offered).toBe(true);
  });

  it("is refused while a factory run is live on the epic", () => {
    const a = bugReportAvailability({ ...epic, labels: ["factory:in-progress"] });
    expect(a.offered).toBe(false);
    expect(a.reason).toMatch(/run is live/);
  });
});

describe("the comment the Console posts", () => {
  it("puts the title on the control line and the report under it", () => {
    // `Bug` is the one factory control that reads past its first line, and
    // this shape is why: the observation has to travel in the same comment.
    expect(bugCommentBody("discount ignored", "Saw 100.00, expected 90.00")).toBe(
      "Bug: discount ignored\n\nSaw 100.00, expected 90.00",
    );
  });
});
