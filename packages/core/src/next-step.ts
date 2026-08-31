import { DESIGN_APPROVED_STATE } from "./factory.js";
import { READY_STATE, type TaskStartStatus } from "./start-gate.js";

/**
 * What is expected of the next actor, per factory state.
 *
 * The factory posts the long form of this on the issue at the end of every
 * run (claude-software-factory: `handbook/next-step.json`). The Console shows
 * the short form beside the thing itself, because "In review" on a card is a
 * state, not an instruction — and for the three states that start nothing on
 * their own it is the difference between "an agent has this" and "this is
 * waiting for you and nobody has told you".
 *
 * `startRole` is what makes it actionable here: where the move is starting a
 * role, the Console can start it (POST /api/issues/:id/start-role) rather
 * than telling someone to go and find Run workflow. Where the move is an
 * approval, `startRole` is null — the Approve button already owns that.
 */

/**
 * A factory label is a coarse phase marker, not progress, and two of them
 * cover a whole stage on their own: `factory:ready` stays on a task from the
 * dispatcher releasing it until the implementer finishes, and
 * `factory:design-approved` stays on an epic for the entire build (FACTORY.md
 * §3 — "Released for implementation"; the dispatcher's re-dispatch guard is
 * that label, so it deliberately does not advance). Answering "what now?"
 * from the label alone therefore freezes at the moment the stage opened: a
 * card asked for an approval an implementer was already running on, and an
 * epic three tasks into its build still said the Dispatcher was releasing
 * them.
 *
 * These are the facts that separate the moments the label runs together —
 * the same two the badges beside this line already read.
 */
export interface NextStepContext {
  /** For a task at `factory:ready`: what its start gate is actually waiting for. */
  startStatus?: TaskStartStatus;
  /** For an epic at `factory:design-approved`: how far its tasks have got. */
  tasks?: NextStepProgress;
}

/** The slice of the task rollup that changes what an epic's next step is. */
export interface NextStepProgress {
  total: number;
  done: number;
  blocked: number;
}

/** Roles a person starts by hand; the factory routes everything else itself. */
export const STARTABLE_ROLES = ["architect", "reviewer", "qa", "release", "ops"] as const;
export type StartableRole = (typeof STARTABLE_ROLES)[number];

export function isStartableRole(value: unknown): value is StartableRole {
  return typeof value === "string" && (STARTABLE_ROLES as readonly string[]).includes(value);
}

export interface NextStep {
  /** Who moves it from here. `{approvers}` already filled in. */
  who: string;
  /** The exact move, in one line. */
  how: string;
  /** The role this state needs a person to start, when that is the move. */
  startRole: StartableRole | null;
  /** What that button says. */
  startLabel: string | null;
  /** True when the wait is on a person rather than on the factory. */
  waitsOnPerson: boolean;
}

interface Entry {
  who: string;
  how: string;
  startRole?: StartableRole;
  startLabel?: string;
  waitsOnPerson?: boolean;
}

const TABLE: Record<string, Entry> = {
  "factory:backlog": {
    who: "gate G0, on this issue's release tracker",
    how: "Parked until its milestone is approved — `Approved` on the tracker releases it into intake.",
    waitsOnPerson: true,
  },
  "factory:release-planning": {
    who: "any collaborator",
    how: "Comment `Plan release` on this tracker to have the Scrum Master draft the plan.",
    waitsOnPerson: true,
  },
  "factory:release-ready": {
    who: "gate G0 — {approvers}",
    how: "Read the release plan, then comment `Approved` on the tracker to release the milestone.",
    waitsOnPerson: true,
  },
  "factory:release-approved": {
    who: "the factory",
    how: "The milestone's issues are moving into intake. Nothing to do.",
  },
  "factory:intake": {
    who: "the factory",
    how: "The Intake Analyst is drafting the spec and will open its PR. Nothing to do.",
  },
  "factory:spec-ready": {
    who: "gate G1 — {approvers}",
    how: "Read the spec, then Approve — the factory merges the PR and starts the Planner.",
    waitsOnPerson: true,
  },
  "factory:spec-approved": {
    who: "the factory",
    how: "The Planner is breaking the spec into tasks, then the Architect designs them. Nothing to do.",
  },
  "factory:planned": {
    who: "the factory",
    how: "The Architect writes the design — normally inside the Planner's own run. Start it if nothing is running.",
    startRole: "architect",
    startLabel: "Start the Architect",
  },
  "factory:design-ready": {
    who: "gate G2 — {approvers}",
    how: "Read the design, then Approve — the factory merges it and releases the unblocked tasks.",
    waitsOnPerson: true,
  },
  "factory:design-approved": {
    who: "the factory",
    how: "The Dispatcher is marking unblocked tasks ready to build. Nothing to do.",
  },
  "factory:ready": {
    who: "the implementation approvers — {approvers}",
    how: "Approve to start the Implementer on this task.",
    waitsOnPerson: true,
  },
  "factory:in-review": {
    who: "you, then the Reviewer",
    how: "This state starts nothing on its own. Start the Reviewer: it reads the draft PR and moves the task to In test, or back to Ready with changes requested. Reviewed it yourself? Mark Reviewed skips straight to In test — there's no changes-requested equivalent there, so review the draft PR on GitHub if it needs work. Don't merge the draft PR yourself either way.",
    startRole: "reviewer",
    startLabel: "Start the Reviewer",
    waitsOnPerson: true,
  },
  "factory:in-test": {
    who: "you, then QA",
    how: "This state starts nothing on its own. Start QA: it verifies the WHEN/THEN scenarios, posts the test report and moves the task to Staging.",
    startRole: "qa",
    startLabel: "Start QA",
    waitsOnPerson: true,
  },
  "factory:ready-to-ship": {
    who: "you, then the Release Manager",
    how: "This state starts nothing on its own. Start the Release Manager: it merges this task onto the epic branch (or the integration branch when the epic has none) and verifies it there.",
    startRole: "release",
    startLabel: "Start the Release Manager",
    waitsOnPerson: true,
  },
  "factory:on-epic": {
    who: "the rest of the epic",
    how: "Merged onto the epic branch and green there. It waits until every task is, then the Release Manager carries the whole epic to staging.",
  },
  "factory:in-staging": {
    who: "gate G3 — {approvers}",
    how: "Merge the promotion PR(s) on GitHub, in the order the integration report lists. G3 is deliberately not comment-approvable.",
    waitsOnPerson: true,
  },
  "factory:deployed": {
    who: "Ops",
    how: "In production and soaking. Ops verifies health, archives the change and closes the issue.",
    startRole: "ops",
    startLabel: "Start Ops",
  },
  "factory:fast-track": {
    who: "any collaborator",
    how: "The fast lane has no gate and no reviewer — read the PR this issue links and merge it.",
    waitsOnPerson: true,
  },
  "factory:blocked": {
    who: "any collaborator",
    how: "An agent stopped and asked a question. Answer it on the thread and the factory resumes the stage that halted.",
    waitsOnPerson: true,
  },
  "factory:incident": {
    who: "a human, with the Release Manager",
    how: "A post-deploy regression is open. Decide rollback or fix-forward and say which.",
    waitsOnPerson: true,
  },
  "factory:profile": {
    who: "the Profiler",
    how: "It is drafting the repo profile and clears the label when it finishes.",
  },
};

/**
 * What `factory:ready` means right now. `awaiting` (and an absent status, for
 * a caller that has not read the start gate) keeps the table's own entry:
 * there, asking for the approval is right.
 */
function readyEntry(status: TaskStartStatus | undefined): Entry | undefined {
  switch (status) {
    case "running":
      return {
        who: "the Implementer",
        how: "An implementer is working on this now — nothing to approve.",
      };
    case "approved":
      return {
        who: "the factory",
        how: "Approved. The factory is starting the implementer.",
      };
    case "stalled":
      return {
        who: "the implementation approvers — {approvers}",
        how: "Approved, but no implementer started — approve again to retry.",
        waitsOnPerson: true,
      };
    default:
      return undefined;
  }
}

/**
 * What `factory:design-approved` means once the Dispatcher has fanned the
 * epic out. Before that (no tasks yet) the table's entry is still true.
 */
function buildingEntry(tasks: NextStepProgress | undefined): Entry | undefined {
  if (!tasks || tasks.total === 0) return undefined;
  if (tasks.blocked > 0) {
    return {
      who: "you — an agent halted",
      how: `${tasks.blocked} of this epic's ${tasks.total} tasks need a human reply before they continue. Answer on the task and the factory resumes.`,
      waitsOnPerson: true,
    };
  }
  if (tasks.done === tasks.total) {
    return {
      who: "you, then the Release Manager",
      how: `All ${tasks.total} tasks are done. Start the Release Manager to carry the epic onward — this state starts nothing on its own.`,
      startRole: "release",
      startLabel: "Start the Release Manager",
      waitsOnPerson: true,
    };
  }
  return {
    who: "its tasks",
    how: `Building — ${tasks.done} of ${tasks.total} tasks done. Each one moves on its own card; the tabs below have them.`,
  };
}

const OFF_RAIL: Entry = {
  who: "nobody — this issue is off the rail",
  how: "It carries no factory state, so nothing routes it. Apply the state it belongs in to put it back.",
  waitsOnPerson: true,
};

/**
 * The one-line answer to "what now?" for a state. `approvers` fills the gate
 * lists; an empty list reads as "any collaborator", matching the router.
 *
 * `ctx` carries the facts the label cannot (see `NextStepContext`). Omit it
 * and every state answers exactly as it did — a caller that has not read the
 * start gate or the rollup gets the stage's opening move, which is right
 * until the stage has moved on.
 */
export function nextStep(state: string | null, approvers: string[] = [], ctx: NextStepContext = {}): NextStep {
  const live =
    state === READY_STATE ? readyEntry(ctx.startStatus)
    : state === DESIGN_APPROVED_STATE ? buildingEntry(ctx.tasks)
    : undefined;
  const entry = live ?? (state ? TABLE[state] : undefined) ?? (state ? undefined : OFF_RAIL);
  const e = entry ?? { who: `whoever owns ${state}`, how: "No instruction on file for this state.", waitsOnPerson: true };
  const who = approvers.length > 0 ? approvers.map((a) => `@${a}`).join(", ") : "any collaborator";
  const fill = (text: string) => text.replace("{approvers}", who);
  return {
    who: fill(e.who),
    how: fill(e.how),
    startRole: e.startRole ?? null,
    startLabel: e.startLabel ?? null,
    waitsOnPerson: e.waitsOnPerson ?? false,
  };
}

/** The gate whose approver list a state's `{approvers}` refers to. */
export const GATE_FOR_APPROVERS: Record<string, string> = {
  "factory:release-ready": "release_scope",
  "factory:spec-ready": "spec",
  "factory:design-ready": "design",
  "factory:ready": "implementation",
  "factory:in-staging": "release",
};
