import { describe, expect, it } from "vitest";
import { FACTORY_LABELS, GATE_FOR_APPROVERS, isStartableRole, nextStep } from "../src/index.js";

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
