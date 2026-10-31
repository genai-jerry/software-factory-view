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

/** Every code task is written, reviewed and tested: nothing is ready, in flight or held. */
function buildFinished(tasks: TaskRollup | undefined): boolean {
  if (!tasks || tasks.total === 0) return false;
  return tasks.ready === 0 && tasks.inReview === 0 && tasks.inTest === 0 && tasks.blocked === 0 && tasks.waiting === 0;
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
      const line = testLine(tasks) || `${entries.filter((e) => e.kind === "task-start").length} tests to run.`;
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
      return now || (card.blocked ? "Held. Someone has to answer the factory." : peopleLabel(card.state));
  }
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

export function buildWork(cards: BoardCard[], needsYou: AttentionEntry[], running: RunningItem[]): WorkLists {
  const byEpic = new Map<string, AttentionEntry[]>();
  for (const e of needsYou) byEpic.set(e.epicId, [...(byEpic.get(e.epicId) ?? []), e]);
  const runningByEpic = new Map<string, RunningItem[]>();
  for (const r of running) runningByEpic.set(r.epicId, [...(runningByEpic.get(r.epicId) ?? []), r]);

  const needsDecision: WorkItem[] = [];
  const working: WorkItem[] = [];
  const done: WorkItem[] = [];
  let others = 0;

  for (const card of cards) {
    const entries = byEpic.get(card.epicId) ?? [];
    const live = runningByEpic.get(card.epicId) ?? [];
    const stage = stageOf(card.state, card.tasks);
    const picked = askOf(entries);
    const ask = picked?.ask ?? null;
    const pointer = picked ? pointerFor(picked.ask, picked.entry, card, entries) : workingLine(stage, card, live);
    const who = whoFor(ask, card, live);
    const item: WorkItem = { card, stage, entries, running: live, ask, pointer, who, link: picked?.entry.link ?? `/epics/${card.epicId}` };
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

/** The Decisions page: one card per work item that waits on me, newest first. */
export function decisionCards(cards: BoardCard[], needsYou: AttentionEntry[]): WorkItem[] {
  return buildWork(cards, needsYou, []).needsDecision;
}
