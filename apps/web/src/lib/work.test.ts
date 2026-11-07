import { describe, expect, it } from "vitest";
import type { AttentionEntry, BoardCard, RunningItem, TaskRollup } from "../types.js";
import { buildWork, decisionCards, stageOf } from "./work.js";
import { byRepo } from "../pages/DecisionsQueue.js";

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

  it("stays Build while a task waits for its merge, or has not started", () => {
    // Beacon #193 on 5 Nov: three tasks green and waiting for the Release
    // Manager, six never released — and the page said Test.
    expect(stageOf("factory:design-approved", rollup({ total: 9, shipping: 3, readyToShip: 3, notStarted: 6, waiting: 6, tests: assembled.tests }))).toBe("build");
    expect(stageOf("factory:design-approved", { ...assembled, readyToShip: 1 })).toBe("build");
    expect(stageOf("factory:design-approved", { ...assembled, notStarted: 1 })).toBe("build");
  });

  it("ignores tasks counted as waiting on a blocker that is itself assembled", () => {
    // Beacon #35 on 31 Oct: five tasks on the epic branch, two still "waiting"
    // because their blockers stay open until the epic closes.
    expect(stageOf("factory:design-approved", { ...assembled, waiting: 2 })).toBe("test");
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
    expect(row.link).toBe("/work/e1");
    expect(lists.counts).toEqual({ you: 1, others: 0, working: 0 });
  });

  it("asks the reader to start a review when a written task waits for one", () => {
    const review = (i: number, state = "factory:in-review") => entry({ issueId: `r${i}`, title: `#${190 + i} task(35): written ${i}`, state, link: "/epics/e1?tab=tasks", expedited: false });
    const building = card({ expedited: false, tasks: rollup({ total: 5, done: 1, inReview: 2, inTest: 1, waiting: 1 }) });
    const lists = buildWork([building], [review(1), review(2), review(3, "factory:in-test")], []);
    expect(lists.needsDecision).toHaveLength(1);
    const row = lists.needsDecision[0]!;
    expect(row.ask).toBe("review");
    expect(row.pointer).toBe("Start: the review on 2 tasks and the test on 1 task. The factory does not start it by itself.");
    expect(row.who).toBe("You start the review and the test");
    expect(row.link).toBe("/work/e1");
  });

  it("asks the reader to start the merge when a green task waits for the Release Manager", () => {
    const merge = entry({ issueId: "m1", title: "#195 task(35): green", state: "factory:ready-to-ship", link: "/epics/e1?tab=tasks", expedited: false });
    const lists = buildWork([card({ expedited: false })], [merge], []);
    const row = lists.needsDecision[0]!;
    expect(row.ask).toBe("review");
    expect(row.pointer).toBe("Start: the merge on 1 task. The factory does not start it by itself.");
    expect(row.who).toBe("You start the merge");
  });

  it("counts only build starts in a Start row", () => {
    const start = entry({ issueId: "s1", title: "task(35): ready one", state: "factory:ready", link: "/epics/e1?tab=tasks" });
    const lists = buildWork([card()], [start], []);
    expect(lists.needsDecision[0]!.ask).toBe("start");
    expect(lists.needsDecision[0]!.pointer).toBe("Start: 1 task waits for a start.");
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
      { issueId: "t4", number: 64, title: "task(35): status column", repo: "genai-jerry/beacon-api", kind: "task", role: "reviewer", epicId: "e1", epicNumber: 35, epicTitle: "" },
    ];
    const building = card({ tasks: rollup({ total: 5, done: 3, inReview: 1, ready: 1, inFlight: 1 }) });
    const lists = buildWork([building], [], running);
    expect(lists.needsDecision).toHaveLength(0);
    expect(lists.working[0]!.pointer).toBe("3 of 5 tasks built. “status column” is being reviewed now.");
    expect(lists.working[0]!.who).toBe("running now");
    expect(lists.counts.working).toBe(1);
  });

  it("treats a run on the epic itself as the factory working, not as a decision still pending", () => {
    // Jerry approved GS; the Release Manager is live on the epic while the
    // label still reads epic-ready, so the gate entry still exists.
    const gate = entry({ kind: "gate", rank: 1, epicId: "e1", state: "factory:epic-ready", link: "/epics/e1?tab=gate" });
    const running: RunningItem[] = [
      { issueId: "e1", number: 36, title: "Bug : Check issue and find a fix", repo: "genai-jerry/beacon-api", kind: "epic", role: "release", epicId: "e1", epicNumber: 36, epicTitle: "Bug : Check issue and find a fix" },
    ];
    const lists = buildWork([card({ state: "factory:epic-ready" })], [gate], running);
    expect(lists.needsDecision).toHaveLength(0);
    expect(lists.working).toHaveLength(1);
    expect(lists.working[0]!.pointer).toBe("Being released to staging now.");
    expect(lists.working[0]!.who).toBe("running now");
    expect(lists.counts.working).toBe(1);
  });

  it("counts a gate that waits on someone else, not on me", () => {
    const lists = buildWork([card({ state: "factory:spec-ready" })], [], []);
    expect(lists.working[0]!.who).toBe("Someone else decides");
    expect(lists.counts).toEqual({ you: 0, others: 1, working: 0 });
  });

  it("says how many of the remaining tests can run now", () => {
    const partly = { ...assembled, tests: { total: 14, passed: 0, runnable: 6, failed: 0, outstanding: 14 } };
    const lists = buildWork([card({ tasks: partly })], [entry()], []);
    expect(lists.needsDecision[0]!.pointer).toBe("Run: 14 of 14 tests are left. 6 can run now.");
  });

  it("files a test case with no parent link under the epic its title names", () => {
    // Beacon #34's cases arrived without the sub-issue relation, so each
    // carries its own id as epicId. The row must not vanish.
    // The attention queue leads with the case's own number, as the live page showed.
    const orphan = entry({ epicId: "case-55", issueId: "case-55", title: "#55 test(34): ST-12 A status moved by a human" });
    const epic34 = card({ epicId: "e34", number: 34, title: "Booker status synced from the sheet", tasks: rollup({ total: 7, shipping: 7, inFlight: 7, waiting: 6 }) });
    const lists = buildWork([epic34], [orphan], []);
    expect(lists.needsDecision).toHaveLength(1);
    expect(lists.needsDecision[0]!.card.title).toBe("Booker status synced from the sheet");
    expect(lists.needsDecision[0]!.pointer).toBe("Run: 1 test to run.");
  });

  it("keeps an entry with no epic at all as its own row", () => {
    const lone = entry({ epicId: "x", issueId: "x", title: "Something odd", repo: "genai-jerry/other" });
    const lists = buildWork([], [lone], []);
    expect(lists.needsDecision.map((w) => w.card.title)).toEqual(["Something odd"]);
  });

  it("hides the factory's repo-profile housekeeping", () => {
    const lists = buildWork([card({ epicId: "p", title: "Factory: repo profile", state: "factory:blocked" })], [], []);
    expect(lists.working).toHaveLength(0);
    expect(lists.needsDecision).toHaveLength(0);
  });

  it("keeps closed items apart", () => {
    const lists = buildWork([card({ open: false, state: "factory:deployed" })], [], []);
    expect(lists.done).toHaveLength(1);
    expect(lists.working).toHaveLength(0);
  });
});

describe("the Decisions list", () => {
  it("keeps tests nobody recorded on an item that already shipped and closed", () => {
    const shipped = card({ epicId: "e9", number: 115, title: "Add support deployment to staging", state: "factory:deployed", open: false });
    const cases = [
      entry({ epicId: "c1", issueId: "c1", title: "#119 test(115): ST-1 A push deploys", ageDays: 5 }),
      entry({ epicId: "c2", issueId: "c2", title: "#120 test(115): ST-2 Production untouched", ageDays: 5 }),
    ];
    const got = decisionCards([shipped], cases);
    expect(got).toHaveLength(1);
    expect(got[0]!.ask).toBe("run");
    expect(buildWork([shipped], cases, []).done).toHaveLength(0);
  });

  it("shows a blocked repo set-up issue, which it otherwise leaves off the lists", () => {
    const setup = card({ epicId: "h1", title: "Factory: repo profile", repo: "o/view", state: "factory:blocked" });
    expect(decisionCards([setup], [])).toHaveLength(0);
    expect(decisionCards([setup], [entry({ kind: "blocked", epicId: "h1", repo: "o/view", state: "factory:blocked" })])).toHaveLength(1);
  });

  it("puts the newest decision first, then groups the cards by repo in that order", () => {
    const old = card({ epicId: "a", repo: "o/api", state: "factory:blocked" });
    const fresh = card({ epicId: "b", repo: "o/web", state: "factory:epic-ready" });
    const mid = card({ epicId: "c", repo: "o/api", state: "factory:spec-ready" });
    const got = decisionCards([old, fresh, mid], [
      entry({ kind: "blocked", epicId: "a", repo: "o/api", ageDays: 4 }),
      entry({ kind: "gate", epicId: "b", repo: "o/web", state: "factory:epic-ready", ageDays: 0 }),
      entry({ kind: "gate", epicId: "c", repo: "o/api", state: "factory:spec-ready", ageDays: 1 }),
    ]);
    expect(got.map((w) => w.card.epicId)).toEqual(["b", "c", "a"]);
    expect(byRepo(got).map((t) => [t.repo, t.items.map((w) => w.card.epicId)])).toEqual([
      ["o/web", ["b"]],
      ["o/api", ["c", "a"]],
    ]);
  });

  it("gives a cross-repo epic one card per repo, so a task waiting in the other repo is not hidden", () => {
    const epic = card({ epicId: "e193", number: 193, title: "Improvement to whatsapp coordination flow", repo: "o/api", state: "factory:epic-ready" });
    const got = decisionCards([epic], [
      entry({ kind: "gate", epicId: "e193", repo: "o/api", state: "factory:epic-ready", ageDays: 0 }),
      entry({ kind: "task-start", epicId: "e193", issueId: "w50", repo: "o/web", state: "factory:ready-to-ship", title: "#50 task(193): The builder screen", ageDays: 0 }),
    ]);
    expect(got.map((w) => [w.card.repo, w.ask])).toEqual([
      ["o/api", "release"],
      ["o/web", "review"],
    ]);
    expect(byRepo(got).map((t) => t.repo)).toEqual(["o/api", "o/web"]);
  });
});
