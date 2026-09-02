import { describe, expect, it } from "vitest";
import { epicStatus } from "../src/index.js";

/**
 * An epic holds `factory:design-approved` for its whole build — the label is
 * the dispatcher's re-dispatch guard, so it cannot advance to make the badge
 * read better. The badge has to say what is happening instead.
 */
describe("epicStatus", () => {
  const none = { total: 0, done: 0, blocked: 0, inReview: 0, inTest: 0, shipping: 0 };

  it("reports the build rather than the gate that released it", () => {
    expect(epicStatus("factory:design-approved", { ...none, total: 4, done: 1 })).toBe("Building 1/4");
  });

  it("surfaces a halted task in the badge itself", () => {
    expect(epicStatus("factory:design-approved", { ...none, total: 4, done: 1, blocked: 1 })).toBe(
      "Building 1/4 · 1 halted",
    );
  });

  it("counts the tasks an agent is on, which the done count cannot see", () => {
    // The reading this exists for: eight tasks, agents on six of them, and a
    // done count of zero because a task closes only at the end of the line.
    expect(
      epicStatus("factory:design-approved", { ...none, total: 8, inReview: 3, inTest: 2, shipping: 1 }),
    ).toBe("Building 0/8 · 6 in flight");
    // Halted still gets its say, after the count of what is still moving.
    expect(epicStatus("factory:design-approved", { ...none, total: 4, inReview: 1, blocked: 1 })).toBe(
      "Building 0/4 · 1 in flight · 1 halted",
    );
    // Nothing past the start gate yet: the count would be noise, so it stays off.
    expect(epicStatus("factory:design-approved", { ...none, total: 4 })).toBe("Building 0/4");
  });

  it("says shipping once everything left is on a branch", () => {
    expect(epicStatus("factory:design-approved", { ...none, total: 4, done: 2, shipping: 2 })).toBe("Shipping 2/4");
  });

  it("says so when every task is done", () => {
    expect(epicStatus("factory:design-approved", { ...none, total: 3, done: 3 })).toBe("All 3 tasks done");
  });

  it("defers to the label where the label is honest", () => {
    // Not yet fanned out: the Dispatcher really is the next thing to happen.
    expect(epicStatus("factory:design-approved", none)).toBeNull();
    expect(epicStatus("factory:design-approved", undefined)).toBeNull();
    // A gate must keep reading as a call to action, not as progress.
    expect(epicStatus("factory:design-ready", { ...none, total: 4 })).toBeNull();
    expect(epicStatus("factory:in-staging", { ...none, total: 4, done: 4 })).toBeNull();
    expect(epicStatus(null, { ...none, total: 4 })).toBeNull();
  });
});
