import { describe, expect, it } from "vitest";
import type { AttentionEntry, BoardCard, RunningItem, TaskRollup } from "../types.js";
import { buildWork, stageOf } from "./work.js";

/**
 * The Work list folds the factory's label machine into the five stages a
 * reader sees and says in one line who acts next. The fixtures are the three
 * live Beacon epics as they stood on 31 Oct 2026: every task on the epic
 * branch, every system test still to run.
 */

function rollup(over: Partial<TaskRollup> = {}): TaskRollup {
  return {
    total: 0,
    ready: 0,
    inReview: 0,
    inTest: 0,
    shipping: 0,
    done: 0,
    blocked: 0,
    waiting: 0,
    inFlight: 0,
    ...over,
  };
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    epicId: "e1",
    number: 35,
    title: "Show day-wise calling performance in the leads page",
    repo: "genai-jerry/beacon-api",
    estateId: "est",
    state: "factory:design-approved",
    open: true,
    daysInState: 1,
    blocked: false,
    expedited: true,
    tasks: rollup(),
    ...over,
  };
}

function entry(over: Partial<AttentionEntry> = {}): AttentionEntry {
  return {
    kind: "task-start",
    rank: 3,
    whyYou: "",
    epicId: "e1",
    issueId: "t1",
    title: "test(35): ST-1",
    repo: "genai-jerry/beacon-api",
    state: "factory:manual-test",
    ageDays: 0,
    question: null,
    expedited: true,
    link: "/epics/e1?tab=tests",
    ...over,
  };
}

const assembled = rollup({ total: 5, shipping: 5, onEpic: 5, inFlight: 5, tests: { total: 16, passed: 0, runnable: 16, failed: 0, outstanding: 16 } });

describe("stageOf", () => {
  it("folds the label machine into five stages", () => {
    expect(stageOf("factory:intake")).toBe("clarify");
    expect(stageOf("factory:spec-ready")).toBe("clarify");
    expect(stageOf("factory:planned")).toBe("design");
    expect(stageOf("factory:design-ready")).toBe("design");
    expect(stageOf("factory:design-approved", rollup({ total: 5, ready: 2, done: 3 }))).toBe("build");
    expect(stageOf("factory:epic-ready")).toBe("release");
    expect(stageOf("factory:in-staging")).toBe("release");
    expect(stageOf("factory:deployed")).toBe("release");
  });

  it("is Test once every task is assembled and system tests remain", () => {
    expect(stageOf("factory:design-approved", assembled)).toBe("test");
  });

  it("stays Build while a task is still ready, in flight or held", () => {
    expect(stageOf("factory:design-approved", { ...assembled, ready: 1 })).toBe("build");
    expect(stageOf("factory:design-approved", { ...assembled, blocked: 1 })).toBe("build");
  });

  it("has no stage for states off the rail", () => {
    expect(stageOf("factory:fast-track")).toBeNull();
    expect(stageOf("factory:blocked")).toBeNull();
    expect(stageOf("factory:backlog")).toBeNull();
    expect(stageOf(null)).toBeNull();
  });
});

describe("buildWork", () => {
  it("collapses sixteen test cases into one Run row for the tester", () => {
    const entries = Array.from({ length: 16 }, (_, i) => entry({ issueId: `t${i}`, title: `test(35): ST-${i + 1}` }));
    const lists = buildWork([card({ tasks: assembled })], entries, []);
    expect(lists.needsDecision).toHaveLength(1);
    const row = lists.needsDecision[0]!;
    expect(row.stage).toBe("test");
    expect(row.ask).toBe("run");
    expect(row.pointer).toBe("Run: 16 of 16 tests are left.");
    expect(row.who).toBe("You run the tests");
    expect(row.link).toBe("/epics/e1?tab=tests");
    expect(lists.counts).toEqual({ you: 1, others: 0, working: 0 });
  });

  it("puts a halted builder's question first", () => {
    const halted = entry({ kind: "blocked", rank: 1, state: "factory:blocked", question: "May the status column be the phone column?" });
    const gate = entry({ kind: "gate", rank: 2, epicId: "e2", state: "factory:design-ready", link: "/epics/e2?tab=gate" });
    const lists = buildWork([card({ epicId: "e2", number: 36, state: "factory:design-ready", daysInState: 3 }), card()], [gate, halted], []);
    expect(lists.needsDecision.map((w) => w.ask)).toEqual(["answer", "decide"]);
    expect(lists.needsDecision[0]!.pointer).toContain("May the status column be the phone column?");
    expect(lists.needsDecision[1]!.pointer).toBe("Decide: approve the design.");
  });

  it("says what the factory is doing when nothing waits on me", () => {
    const running: RunningItem[] = [
      { issueId: "t4", number: 64, title: "task(35)", repo: "genai-jerry/beacon-api", kind: "task", role: "reviewer", epicId: "e1", epicNumber: 35, epicTitle: "" },
    ];
    const building = card({ tasks: rollup({ total: 5, done: 3, inReview: 1, ready: 1, inFlight: 1 }) });
    const lists = buildWork([building], [], running);
    expect(lists.needsDecision).toHaveLength(0);
    expect(lists.working[0]!.pointer).toBe("3 of 5 tasks built. Task #64 is being reviewed now.");
    expect(lists.working[0]!.who).toBe("running now");
    expect(lists.counts.working).toBe(1);
  });

  it("counts a gate that waits on someone else, not on me", () => {
    const lists = buildWork([card({ state: "factory:spec-ready" })], [], []);
    expect(lists.working[0]!.who).toBe("Someone else decides");
    expect(lists.counts).toEqual({ you: 0, others: 1, working: 0 });
  });

  it("keeps closed items apart", () => {
    const lists = buildWork([card({ open: false, state: "factory:deployed" })], [], []);
    expect(lists.done).toHaveLength(1);
    expect(lists.working).toHaveLength(0);
  });
});
