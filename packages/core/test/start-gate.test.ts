import { describe, expect, it } from "vitest";
import { START_APPROVAL_GRACE_MS, startStatusTakesApproval, taskStartStatus } from "../src/start-gate.js";

/**
 * `factory:ready` covers the whole of "waiting to start", "approved" and
 * "an implementer is running" — the button belongs to the first of those only.
 */

const now = new Date("2026-08-31T12:00:00Z");
const base = {
  open: true,
  state: "factory:ready",
  labels: ["factory:ready"],
  approvedAt: null as Date | null,
  readySince: new Date("2026-08-31T10:00:00Z"),
  now,
};
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

describe("taskStartStatus", () => {
  it("asks for approval on a ready task nobody has approved", () => {
    expect(taskStartStatus(base)).toBe("awaiting");
    expect(startStatusTakesApproval("awaiting")).toBe(true);
  });

  it("says a run is live rather than offering the button again", () => {
    const status = taskStartStatus({ ...base, labels: ["factory:ready", "factory:in-progress"] });
    expect(status).toBe("running");
    expect(startStatusTakesApproval(status)).toBe(false);
  });

  it("the run marker wins even when the approval that started it is fresh", () => {
    expect(
      taskStartStatus({ ...base, labels: ["factory:ready", "factory:in-progress"], approvedAt: minutesAgo(1) }),
    ).toBe("running");
  });

  it("waits quietly between the approval and the run starting", () => {
    const status = taskStartStatus({ ...base, approvedAt: minutesAgo(2) });
    expect(status).toBe("approved");
    expect(startStatusTakesApproval(status)).toBe(false);
  });

  it("offers the button again once an approval has gone unrouted", () => {
    const stale = new Date(now.getTime() - START_APPROVAL_GRACE_MS - 60_000);
    const status = taskStartStatus({ ...base, approvedAt: stale });
    expect(status).toBe("stalled");
    expect(startStatusTakesApproval(status)).toBe(true);
  });

  it("ignores the approval from a previous build round", () => {
    // Reviewer sent the task back: it re-entered factory:ready after the last
    // Approved, so the router needs a fresh one.
    expect(
      taskStartStatus({ ...base, approvedAt: minutesAgo(90), readySince: minutesAgo(30) }),
    ).toBe("awaiting");
  });

  it("trusts the newest approval when the issue has no label history", () => {
    expect(taskStartStatus({ ...base, approvedAt: minutesAgo(2), readySince: null })).toBe("approved");
  });

  it("is not a start gate at all off factory:ready or once closed", () => {
    expect(taskStartStatus({ ...base, state: "factory:in-review", labels: ["factory:in-review"] })).toBe("none");
    expect(taskStartStatus({ ...base, open: false })).toBe("none");
  });
});
