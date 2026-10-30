import { describe, expect, it } from "vitest";
import type { BoardCard } from "../types.js";
import { stageChips, stageLine } from "./board.js";

const COLUMNS = ["factory:design-approved", "factory:ready", "factory:in-review", "factory:in-test",
  "factory:ready-to-ship", "factory:on-epic"];

function card(tasks: Partial<BoardCard["tasks"]>, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    epicId: "e1", number: 34, title: "Booker status", repo: "o/api", estateId: "s",
    state: "factory:design-approved", open: true, daysInState: 2, blocked: false, expedited: true,
    tasks: { total: 7, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0, ...tasks },
    ...overrides,
  };
}

describe("stageChips", () => {
  it("puts an epic's tasks in the columns they are in, though the epic sits at design-approved", () => {
    const c = card({ ready: 1, inReview: 2, inTest: 1, shipping: 3, readyToShip: 1, onEpic: 2 });
    const chips = stageChips(COLUMNS, [c]);
    expect([...chips.keys()]).toEqual([
      "factory:ready", "factory:in-review", "factory:in-test", "factory:ready-to-ship", "factory:on-epic",
    ]);
    expect(chips.get("factory:in-review")).toEqual([{ card: c, count: 2 }]);
    expect(chips.get("factory:on-epic")![0]!.count).toBe(2);
  });

  it("skips closed epics, empty stages and columns the board does not show", () => {
    expect(stageChips(COLUMNS, [card({ inTest: 2 }, { open: false })]).size).toBe(0);
    expect(stageChips(COLUMNS, [card({})]).size).toBe(0);
    expect(stageChips(["factory:ready"], [card({ inTest: 2 })]).size).toBe(0);
  });
});

describe("stageLine", () => {
  it("says where the tasks are and what the tests need, leaving zeros out", () => {
    expect(stageLine(card({ inReview: 1, inTest: 2, onEpic: 3, tests: { total: 6, passed: 0, runnable: 4, failed: 0, outstanding: 6 } }).tasks))
      .toEqual(["1 in review", "2 in test", "3 on the epic branch", "4 tests to run"]);
    expect(stageLine(card({ tests: { total: 3, passed: 3, runnable: 0, failed: 0, outstanding: 0 } }).tasks))
      .toEqual(["3/3 tests passed"]);
    expect(stageLine(card({}).tasks)).toEqual([]);
  });
});
