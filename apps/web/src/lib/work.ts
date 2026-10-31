import type { AttentionEntry, BoardCard, RunningItem, TaskRollup } from "../types.js";
import { peopleLabel } from "./labels.js";

/**
 * The Work list (redesign board 1): one row per work item, grouped by whether
 * a person has to act, with a stage and a one-line pointer saying who does
 * what next. Everything here is derived from three reads the API already
 * serves — the board (epics), the attention queue (what waits on me) and the
 * running list — so the page changes nothing on the server.
 *
 * A work item's stage is the plain five-step rail of the redesign. The label
 * machine has more states than that; `stageOf` folds them. States that are
 * off the rail (held, fast track, incident, a milestone still being planned)
 * get no stage and keep their people-language label as the chip.
 */

export type Stage = "clarify" | "design" | "build" | "test" | "release";

export const STAGES: Stage[] = ["clarify", "design", "build", "test", "release"];

export const STAGE_LABEL: Record<Stage, string> = {
  clarify: "Clarify",
  design: "Design",
  build: "Build",
  test: "Test",
  release: "Release",
};

const CLARIFY = new Set(["factory:intake", "factory:spec-ready", "factory:spec-approved"]);
const DESIGN = new Set(["factory:planned", "factory:design-ready"]);
const BUILD = new Set(["factory:design-approved", "factory:ready", "factory:in-review", "factory:in-test", "factory:ready-to-ship"]);
const RELEASE = new Set(["factory:epic-ready", "factory:in-staging", "factory:deployed"]);

/**
 * Every code task is written, reviewed and tested: nothing is ready, in
 * flight or held. `waiting` is left out on purpose: the rollup counts a task
 * as waiting while its blocker is still open, and a blocker on the epic
 * branch stays open until the epic closes, so an assembled epic shows waiting
 * tasks that are in fact done.
 */
function buildFinished(tasks: TaskRollup | undefined): boolean {
  if (!tasks || tasks.total === 0) return false;
  return tasks.ready === 0 && tasks.inReview === 0 && tasks.inTest === 0 && tasks.blocked === 0;
}

export function stageOf(state: string | null | undefined, tasks?: TaskRollup): Stage | null {
  if (!state) return null;
  if (CLARIFY.has(state)) return "clarify";
  if (DESIGN.has(state)) return "design";
  if (RELEASE.has(state)) return "release";
  if (BUILD.has(state)) {
    const testsLeft = (tasks?.tests?.outstanding ?? 0) > 0 || (tasks?.bugs?.open ?? 0) > 0;
    if (testsLeft && buildFinished(tasks)) return "test";
    return "build";
  }
  return null;
}

export type Ask = "decide" | "answer" | "run" | "start" | "release" | "ship";

export interface WorkItem {
  card: BoardCard;
  stage: Stage | null;
  entries: AttentionEntry[];
  running: RunningItem[];
  /** What this row asks of a person, or null when the factory has it. */
  ask: Ask | null;
  /** The one line under the title: "Decide: approve the design. 4 decisions." */
  pointer: string;
  /** "You decide", "Someone else runs the tests", "started 09:40". */
  who: string;
  /** Where the row opens. */
  link: string;
}

export interface WorkLists {
  needsDecision: WorkItem[];
  working: WorkItem[];
  done: WorkItem[];
  counts: { you: number; others: number; working: number };
}

/** A gate or merge the epic sits at, whoever's turn it is. */
const DECISION_STATES = new Set(["factory:spec-ready", "factory:design-ready", "factory:epic-ready", "factory:in-staging"]);

const ROLE_VERB: Record<string, string> = {
  implementer: "being written",
  reviewer: "being reviewed",
  qa: "being tested",
  release: "being released",
  planner: "being planned",
  architect: "being designed",
  intake: "being analysed",
  dispatch: "being dispatched",
  testplanner: "getting its tests planned",
  ops: "being verified in production",
  profiler: "being profiled",
};

function roleVerb(role: string): string {
  return ROLE_VERB[role] ?? `with the ${role}`;
}

function testLine(tasks: TaskRollup): string {
  const t = tasks.tests;
  if (!t || t.total === 0) return "";
  const left = t.outstanding;
  let line = `${left} of ${t.total} tests ${left === 1 ? "is" : "are"} left.`;
  if (t.runnable > 0 && t.runnable < left) line += ` ${t.runnable} can run now.`;
  if (t.failed > 0) line += ` ${t.failed} failed; the fix is being built.`;
  return line;
}

function askOf(entries: AttentionEntry[]): { ask: Ask; entry: AttentionEntry } | null {
  const blocked = entries.find((e) => e.kind === "blocked");
  if (blocked) return { ask: "answer", entry: blocked };
  const merge = entries.find((e) => e.kind === "merge" || (e.kind === "gate" && e.state === "factory:in-staging"));
  if (merge) return { ask: "ship", entry: merge };
  const release = entries.find((e) => e.kind === "gate" && e.state === "factory:epic-ready");
  if (release) return { ask: "release", entry: release };
  const gate = entries.find((e) => e.kind === "gate");
  if (gate) return { ask: "decide", entry: gate };
  const run = entries.find((e) => e.kind === "task-start" && (e.state === "factory:manual-test" || e.state === "factory:bug-retest"));
  if (run) return { ask: "run", entry: run };
  const start = entries.find((e) => e.kind === "task-start");
  if (start) return { ask: "start", entry: start };
  return null;
}

function pointerFor(ask: Ask, entry: AttentionEntry, card: BoardCard, entries: AttentionEntry[]): string {
  const tasks = card.tasks;
  switch (ask) {
    case "answer":
      return entry.question
        ? `Answer: the builder stopped and asked: “${entry.question}”`
        : "Answer: the builder stopped and asked a question.";
    case "ship":
      return "Ship: on staging and green. Ship to production?";
    case "release":
      return `Release: ${tasks.total} task${tasks.total === 1 ? "" : "s"} built${tasks.tests ? ` and ${tasks.tests.passed} of ${tasks.tests.total} tests passed` : ""}. Release to staging?`;
    case "decide":
      if (entry.state === "factory:spec-ready") return "Decide: approve the plan.";
      if (entry.state === "factory:design-ready") return "Decide: approve the design.";
      return "Decide: approve at this gate.";
    case "run": {
      const retests = entries.filter((e) => e.state === "factory:bug-retest").length;
      const n = entries.filter((e) => e.kind === "task-start").length;
      const line = testLine(tasks) || `${n} test${n === 1 ? "" : "s"} to run.`;
      return `Run: ${line}${retests > 0 ? ` ${retests} bug fix${retests === 1 ? "" : "es"} to re-test.` : ""}`;
    }
    case "start": {
      const n = entries.filter((e) => e.kind === "task-start").length;
      return `Start: ${n} task${n === 1 ? " waits" : "s wait"} for a start.`;
    }
  }
}

function workingLine(stage: Stage | null, card: BoardCard, running: RunningItem[]): string {
  const tasks = card.tasks;
  const live = running[0];
  const now = live ? (live.kind === "task" ? `Task #${live.number} is ${roleVerb(live.role)} now.` : `It is ${roleVerb(live.role)} now.`) : "";
  switch (stage) {
    case "clarify":
      return now || "The plan is being written. You will be asked to approve it.";
    case "design":
      return now || "The design is being written. You will be asked to approve it.";
    case "build": {
      const built = tasks.done + tasks.shipping;
      const base = tasks.total > 0 ? `${built} of ${tasks.total} tasks built.` : "The tasks are being set up.";
      return now ? `${base} ${now}` : base;
    }
    case "test":
      return `Tests are waiting on someone else. ${testLine(tasks)}`.trim();
    case "release":
      if (card.state === "factory:deployed") return "In production and soaking.";
      return "Waiting on someone else to release it.";
    default:
      if (now) return now;
      if (card.state === "factory:fast-track") return "Fast lane: a pull request waits for someone to read and merge it.";
      if (card.blocked) return "Held. Someone has to answer the factory.";
      return peopleLabel(card.state);
  }
}

const EMPTY_ROLLUP: TaskRollup = { total: 0, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0 };

/**
 * `test(34): …`, `task(34): …`, `bug(34): …` — the factory's own naming names
 * the epic. The attention queue puts the issue's own number first (`#55
 * test(34): …`), so that prefix is allowed.
 */
const EPIC_IN_TITLE = /^(?:#\d+\s+)?(?:test|task|bug)\((\d+)\)/;

/**
 * An attention entry whose epic the board does not carry. Usually the issue
 * has no parent link yet (the sub-issue relation arrives by webhook and can
 * lag), so the factory's title prefix is the next best pointer; failing that
 * the entry stands as a row of its own rather than vanishing.
 */
function placeOrphan(e: AttentionEntry, byNumber: Map<string, BoardCard>): BoardCard {
  const m = EPIC_IN_TITLE.exec(e.title);
  const parent = m ? byNumber.get(`${e.repo}#${m[1]}`) : undefined;
  if (parent) return parent;
  return {
    epicId: e.epicId,
    number: 0,
    title: e.title,
    repo: e.repo,
    estateId: "",
    state: e.state,
    open: true,
    daysInState: e.ageDays,
    blocked: e.kind === "blocked",
    expedited: e.expedited,
    tasks: EMPTY_ROLLUP,
  };
}

/** Repo set-up issues are the factory's own housekeeping, not the team's work. */
function isHousekeeping(card: BoardCard): boolean {
  return card.title.startsWith("Factory: repo profile");
}

function whoFor(ask: Ask | null, card: BoardCard, running: RunningItem[]): string {
  if (ask) {
    const verb = { decide: "decide", answer: "answer", run: "run the tests", start: "start it", release: "release", ship: "ship" }[ask];
    return `You ${verb}`;
  }
  if (DECISION_STATES.has(card.state ?? "")) return "Someone else decides";
  if (stageOf(card.state, card.tasks) === "test") return "Someone else runs the tests";
  if (running.length > 0) return "running now";
  return card.daysInState === 0 ? "moved today" : `quiet ${card.daysInState}d`;
}

/**
 * Where a row opens: the work item page. An attention entry's own link points
 * at the engineers' workspace and its tab; the item page shows the stage
 * instead, so only the epic id is kept.
 */
export function workLink(epicId: string, entryLink?: string): string {
  const m = entryLink ? /^\/epics\/([^/?#]+)/.exec(entryLink) : null;
  return `/work/${m ? m[1] : epicId}`;
}

export function buildWork(cards: BoardCard[], needsYou: AttentionEntry[], running: RunningItem[]): WorkLists {
  const shown = cards.filter((c) => !isHousekeeping(c));
  const known = new Set(shown.map((c) => c.epicId));
  const byNumber = new Map(shown.map((c) => [`${c.repo}#${c.number}`, c]));
  const extra: BoardCard[] = [];
  const byEpic = new Map<string, AttentionEntry[]>();
  for (const e of needsYou) {
    let epicId = e.epicId;
    if (!known.has(epicId)) {
      const home = placeOrphan(e, byNumber);
      epicId = home.epicId;
      if (!known.has(epicId)) {
        known.add(epicId);
        extra.push(home);
      }
    }
    byEpic.set(epicId, [...(byEpic.get(epicId) ?? []), e]);
  }
  const runningByEpic = new Map<string, RunningItem[]>();
  for (const r of running) runningByEpic.set(r.epicId, [...(runningByEpic.get(r.epicId) ?? []), r]);

  const needsDecision: WorkItem[] = [];
  const working: WorkItem[] = [];
  const done: WorkItem[] = [];
  let others = 0;

  for (const card of [...shown, ...extra]) {
    const entries = byEpic.get(card.epicId) ?? [];
    const live = runningByEpic.get(card.epicId) ?? [];
    const stage = stageOf(card.state, card.tasks);
    const picked = askOf(entries);
    const ask = picked?.ask ?? null;
    const pointer = picked ? pointerFor(picked.ask, picked.entry, card, entries) : workingLine(stage, card, live);
    const who = whoFor(ask, card, live);
    const item: WorkItem = { card, stage, entries, running: live, ask, pointer, who, link: workLink(card.epicId, picked?.entry.link) };
    if (!card.open) {
      done.push(item);
      continue;
    }
    if (ask) {
      needsDecision.push(item);
    } else {
      if (who.startsWith("Someone else")) others += 1;
      working.push(item);
    }
  }

  const rank: Record<Ask, number> = { answer: 0, ship: 1, release: 2, decide: 3, run: 4, start: 5 };
  needsDecision.sort((a, b) => rank[a.ask!] - rank[b.ask!] || b.card.daysInState - a.card.daysInState);
  working.sort((a, b) => Number(b.running.length > 0) - Number(a.running.length > 0) || a.card.daysInState - b.card.daysInState);

  return {
    needsDecision,
    working,
    done,
    counts: { you: needsDecision.length, others, working: working.length - others },
  };
}

/**
 * The work item an attention entry belongs to, for counting without the
 * board: its epic, or the epic its factory title prefix names when the parent
 * link is missing.
 */
export function workKey(e: AttentionEntry): string {
  const m = EPIC_IN_TITLE.exec(e.title);
  return m ? `${e.repo}#${m[1]}` : e.epicId;
}

/** The Decisions page: one card per work item that waits on me, newest first. */
export function decisionCards(cards: BoardCard[], needsYou: AttentionEntry[]): WorkItem[] {
  return buildWork(cards, needsYou, []).needsDecision;
}
