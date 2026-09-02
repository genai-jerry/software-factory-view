import { describe, expect, it } from "vitest";
import { FACTORY_LABELS, GATE_FOR_APPROVERS, isStartableRole, nextStep, type NextStepProgress } from "../src/index.js";

/**
 * A state is not an instruction. Every state the factory can leave an issue
 * in has to answer "what now?", and the three that route nothing on their own
 * have to say so — that silence is what made a merged PR at `in-review` look
 * like a finished task instead of a review nobody had started.
 */

describe("nextStep", () => {
  it("answers for every label the factory creates", () => {
    for (const label of FACTORY_LABELS) {
      const step = nextStep(label.name, []);
      expect(step.who, label.name).not.toBe("");
      expect(step.how, label.name).not.toMatch(/No instruction on file/);
    }
  });

  it("names the role a person has to start, and only where that is the move", () => {
    expect(nextStep("factory:in-review").startRole).toBe("reviewer");
    expect(nextStep("factory:in-test").startRole).toBe("qa");
    expect(nextStep("factory:ready-to-ship").startRole).toBe("release");
    // An approval is not a role start — the Approve button owns those.
    expect(nextStep("factory:ready").startRole).toBeNull();
    expect(nextStep("factory:spec-ready").startRole).toBeNull();
    // Nor is a state the factory drives itself.
    expect(nextStep("factory:intake").startRole).toBeNull();
    expect(nextStep("factory:design-approved").startRole).toBeNull();
  });

  it("says plainly that in-review starts nothing on its own", () => {
    const step = nextStep("factory:in-review");
    expect(step.how).toMatch(/starts nothing on its own/);
    expect(step.how).toMatch(/Don't merge the draft PR yourself/);
    expect(step.startLabel).toBe("Start the Reviewer");
    expect(step.waitsOnPerson).toBe(true);
  });

  it("separates a wait on a person from a wait on the factory", () => {
    expect(nextStep("factory:spec-ready").waitsOnPerson).toBe(true);
    expect(nextStep("factory:blocked").waitsOnPerson).toBe(true);
    expect(nextStep("factory:intake").waitsOnPerson).toBe(false);
    expect(nextStep("factory:spec-approved").waitsOnPerson).toBe(false);
  });

  it("fills a gate's approver list, and falls back to any collaborator", () => {
    expect(nextStep("factory:spec-ready", ["alice", "bob"]).who).toBe("gate G1 — @alice, @bob");
    expect(nextStep("factory:spec-ready", []).who).toBe("gate G1 — any collaborator");
  });

  it("still answers for an issue with no factory state", () => {
    const step = nextStep(null);
    expect(step.who).toMatch(/off the rail/);
    expect(step.startRole).toBeNull();
  });

  it("maps exactly the gate states to approver lists", () => {
    for (const state of Object.keys(GATE_FOR_APPROVERS)) {
      expect(nextStep(state, ["x"]).who, state).toContain("@x");
    }
  });

  it("guards the startable role list", () => {
    expect(isStartableRole("reviewer")).toBe(true);
    expect(isStartableRole("implementer")).toBe(false); // starts from an approval
    expect(isStartableRole("rm -rf")).toBe(false);
  });
});

/**
 * Two labels each cover a whole stage, so the label alone answers for the
 * moment the stage opened. `factory:ready` asked for an approval while an
 * implementer was already running on it — the exact double-approval the
 * badge beside it had just been fixed to stop offering.
 */
describe("nextStep with the facts the label cannot carry", () => {
  it("stops asking for an approval the factory already has", () => {
    const running = nextStep("factory:ready", ["jerry"], { startStatus: "running" });
    expect(running.how).not.toMatch(/Approve/);
    expect(running.who).toBe("the Implementer");
    expect(running.waitsOnPerson).toBe(false);

    const approved = nextStep("factory:ready", ["jerry"], { startStatus: "approved" });
    expect(approved.how).not.toMatch(/Approve to start/);
    expect(approved.waitsOnPerson).toBe(false);
  });

  it("asks again only when the approval went nowhere", () => {
    const stalled = nextStep("factory:ready", ["jerry"], { startStatus: "stalled" });
    expect(stalled.how).toMatch(/approve again/i);
    expect(stalled.who).toBe("the implementation approvers — @jerry");
    expect(stalled.waitsOnPerson).toBe(true);
  });

  it("keeps the plain ask where an approval really is the move", () => {
    for (const ctx of [{}, { startStatus: "awaiting" as const }]) {
      expect(nextStep("factory:ready", ["jerry"], ctx).how).toBe("Approve to start the Implementer on this task.");
    }
  });

  /** The rollup the API sends, with only the counts a case cares about set. */
  const rollup = (counts: Partial<NextStepProgress> & { total: number }): NextStepProgress => ({
    total: 0,
    done: 0,
    blocked: 0,
    inReview: 0,
    inTest: 0,
    shipping: 0,
    ...counts,
  });

  it("reports an epic's build instead of the dispatcher that started it", () => {
    const step = nextStep("factory:design-approved", [], { tasks: rollup({ total: 4, done: 1 }) });
    expect(step.how).toMatch(/1 of 4 tasks done/);
    expect(step.how).not.toMatch(/Dispatcher/);
  });

  it("counts the tasks an agent is on, which the done count cannot see", () => {
    // Every task mid-chain and none closed: "0 of 8 done" on its own reads as
    // an epic nothing has touched.
    const step = nextStep("factory:design-approved", [], {
      tasks: rollup({ total: 8, inReview: 3, inTest: 2, shipping: 1 }),
    });
    expect(step.how).toMatch(/0 of 8 tasks done, 6 in flight/);
  });

  it("names a halted task on the epic, and the release once every task is done", () => {
    expect(nextStep("factory:design-approved", [], { tasks: rollup({ total: 4, done: 1, blocked: 1 }) }).waitsOnPerson).toBe(true);
    const done = nextStep("factory:design-approved", [], { tasks: rollup({ total: 4, done: 4 }) });
    expect(done.startRole).toBe("release");
    expect(done.how).toMatch(/All 4 tasks are done/);
  });

  it("leaves a not-yet-dispatched epic on the table's own answer", () => {
    const step = nextStep("factory:design-approved", [], { tasks: rollup({ total: 0 }) });
    expect(step.how).toMatch(/Dispatcher/);
    expect(step.startRole).toBeNull();
  });
});
