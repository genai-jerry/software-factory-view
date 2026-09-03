import { describe, expect, it } from "vitest";
import { planTestsAvailability, type PlanTestsInput } from "../src/index.js";

/**
 * Offering `Plan tests` (FACTORY.md §4b, adoption).
 *
 * Every refusal here has a counterpart in the factory's router. The test that
 * matters is not that the button appears — it is that it does not appear in
 * any shape where the click would post a comment the factory answers with
 * "nothing was started".
 */

const epic = (over: Partial<PlanTestsInput> = {}): PlanTestsInput => ({
  state: "factory:design-approved",
  open: true,
  kind: "epic",
  labels: ["factory:design-approved"],
  systemTests: true,
  hasPlan: false,
  ...over,
});

describe("when the button is offered", () => {
  it("offers it on an in-flight epic with no plan", () => {
    expect(planTestsAvailability(epic())).toEqual({ offered: true, reason: null });
  });

  it("offers it from every state the factory adopts from", () => {
    for (const state of [
      "factory:planned",
      "factory:design-ready",
      "factory:design-approved",
      "factory:epic-ready",
      "factory:in-staging",
    ]) {
      expect(planTestsAvailability(epic({ state, labels: [state] })).offered).toBe(true);
    }
  });

  it("offers it on a repo whose policy the Console has not read yet", () => {
    // Null is not "off": refusing here would hide the action on every repo
    // connected before the policy sync, and the factory's own refusal names
    // the file to add.
    expect(planTestsAvailability(epic({ systemTests: null })).offered).toBe(true);
  });
});

describe("when it is refused", () => {
  const refused = (over: Partial<PlanTestsInput>) => {
    const a = planTestsAvailability(epic(over));
    expect(a.offered).toBe(false);
    expect(a.reason).toBeTruthy();
    return a.reason!;
  };

  it("is refused where the repo runs no system tests", () => {
    expect(refused({ systemTests: false })).toMatch(/factory-testing\.json/);
  });

  it("is refused before the Planner has run", () => {
    // No task breakdown means no `Depends on:` for any case.
    expect(refused({ state: "factory:spec-approved", labels: ["factory:spec-approved"] })).toMatch(/Planner/);
    expect(refused({ state: "factory:intake", labels: ["factory:intake"] })).toMatch(/Planner/);
    expect(refused({ state: null, labels: [] })).toMatch(/Planner/);
  });

  it("is refused on an epic that has shipped", () => {
    expect(refused({ open: false })).toMatch(/shipped/);
    expect(refused({ state: "factory:deployed", labels: ["factory:deployed"] })).toMatch(/shipped/);
  });

  it("is refused on anything that is not an epic", () => {
    expect(refused({ kind: "task" })).toMatch(/epic/);
    expect(refused({ kind: "test" })).toMatch(/epic/);
    expect(refused({ kind: "epic", labels: ["factory:release"] })).toMatch(/epic/);
    expect(refused({ kind: "epic", labels: ["factory:profile"] })).toMatch(/epic/);
    expect(refused({ kind: "epic", labels: ["factory:fast-track"], state: "factory:fast-track" })).toMatch(/epic/);
  });

  it("is refused while a run is live on the epic", () => {
    expect(refused({ labels: ["factory:design-approved", "factory:in-progress"] })).toMatch(/run is live/);
  });

  it("is refused on an epic that already has a plan", () => {
    expect(refused({ hasPlan: true })).toMatch(/already has a test plan/);
  });

  it("names the policy before anything else", () => {
    // A policy-off repo cannot adopt tests from any state, so that is the
    // answer even when a second refusal would also apply.
    expect(refused({ systemTests: false, state: "factory:intake", labels: [] })).toMatch(/factory-testing\.json/);
  });
});
