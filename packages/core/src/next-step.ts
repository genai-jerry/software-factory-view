import { type EpicProgress, tasksInFlight } from "./epic-status.js";
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
  /**
   * The epic carries `factory:expedite` (a task inherits its epic's marker).
   * Every state whose move is a human *start* answers differently while it is
   * on — see `EXPEDITED` below.
   */
  expedited?: boolean;
  /**
   * A factory run is live on this issue right now (`factory:in-progress`).
   * Only read under `expedited`: "auto — Reviewer next" over a Reviewer that is
   * already running invites the second start the run marker exists to prevent.
   */
  running?: boolean;
}

/**
 * The slice of the task rollup that changes what an epic's next step is — the
 * same counts the badge reads (`epic-status.ts`), so the two lines beside each
 * other cannot tell different stories about the same epic.
 */
export type NextStepProgress = EpicProgress;

/** Roles a person starts by hand; the factory routes everything else itself. */
export const STARTABLE_ROLES = ["architect", "reviewer", "qa", "release", "ops"] as const;
export type StartableRole = (typeof STARTABLE_ROLES)[number];

export function isStartableRole(value: unknown): value is StartableRole {
  return typeof value === "string" && (STARTABLE_ROLES as readonly string[]).includes(value);
}

/** How each role is named at the head of a sentence. */
const ROLE_LABEL: Record<StartableRole, string> = {
  architect: "The Architect",
  reviewer: "The Reviewer",
  qa: "QA",
  release: "The Release Manager",
  ops: "Ops",
};

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
  /**
   * The factory takes this hop itself (expedite). `startRole` may still be
   * set: any human may take a stage over, so the Console demotes the start
   * button behind an explicit affordance rather than removing it.
   */
  automatic: boolean;
}

interface Entry {
  who: string;
  how: string;
  startRole?: StartableRole;
  startLabel?: string;
  waitsOnPerson?: boolean;
  automatic?: boolean;
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
    how: "Merged onto the epic branch and green there. It waits until every task is, then the Release Manager assembles the epic and puts it at gate GS.",
  },
  // System test cases (FACTORY.md §4b). These sit on a `test(<epic>)`
  // sub-issue and move on a human's verdict, never on a role — which is why
  // none of them carries a `startRole`.
  "factory:manual-test": {
    who: "the testers — {approvers}",
    how: "The code this case exercises is assembled, so it can be run. Its steps, data and expected result are in the epic's system test plan. Run it, then comment exactly `Test Passed` or exactly `Test Failed` with what you saw.",
    waitsOnPerson: true,
  },
  "factory:test-failed": {
    who: "the fix task, then the testers again",
    how: "This case failed and the factory filed a task to fix it. When that task is implemented, reviewed, tested and assembled, the Dispatcher returns this case for a re-run.",
  },
  "factory:test-passed": {
    who: "nobody — this case is done",
    how: "It passed and is closed. The epic reaches gate GS once its remaining cases and tasks are done too.",
  },
  "factory:epic-ready": {
    who: "gate GS — {approvers}",
    how: "The epic is assembled and green on its own branch. Read the assembly report, then Approve — that releases it to the integration branch, not to production; G3 still holds before anything ships.",
    waitsOnPerson: true,
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
 * What the same states mean while the epic carries `factory:expedite`.
 *
 * Expedite does not skip work, it removes the human *starts*: the factory
 * approves G1 and G2 itself and runs each task's implementer, reviewer, QA and
 * assembly as the previous one lands. So every line here answers "the factory"
 * where the base table answers "you" — while still naming the role, because a
 * human may take any stage over; `automatic` is what lets the Console demote
 * the start button rather than remove it.
 *
 * Deliberately absent — and this is the point of the mode, not an omission:
 * `factory:epic-ready` (GS) and `factory:in-staging` (G3) are the two
 * decisions expedite keeps, so they answer exactly as they do without it. So
 * does `factory:blocked`: an agent's question is not a start.
 */
const EXPEDITED: Record<string, Entry> = {
  "factory:spec-ready": {
    who: "the factory — expedited",
    how: "Expedite is on: the factory approves G1 itself and starts the Planner. Read the spec if you want to — nothing is waiting on you.",
    automatic: true,
  },
  "factory:design-ready": {
    who: "the factory — expedited",
    how: "Expedite is on: the factory approves G2 itself and releases the unblocked tasks. Nothing is waiting on you.",
    automatic: true,
  },
  "factory:in-review": {
    who: "the factory — expedited",
    how: "Expedite is on: the Reviewer runs on this task by itself. Start it by hand only if the automatic run did not fire.",
    startRole: "reviewer",
    startLabel: "Start the Reviewer",
    automatic: true,
  },
  "factory:in-test": {
    who: "the factory — expedited",
    how: "Expedite is on: QA runs on this task by itself. Start it by hand only if the automatic run did not fire.",
    startRole: "qa",
    startLabel: "Start QA",
    automatic: true,
  },
  "factory:ready-to-ship": {
    who: "the factory — expedited",
    how: "Expedite is on: the Release Manager merges this task onto the epic branch by itself. Start it by hand only if the automatic run did not fire.",
    startRole: "release",
    startLabel: "Start the Release Manager",
    automatic: true,
  },
  "factory:on-epic": {
    who: "the factory — expedited",
    how: "Merged onto the epic branch and green there. Expedite carries the epic to gate GS as soon as every task is here.",
    automatic: true,
  },
};

/** The one entry `factory:ready` has while expedite is on — there is no start gate. */
const EXPEDITED_READY: Entry = {
  who: "the factory — expedited",
  how: "Expedite is on: the factory starts the Implementer on this task itself. Nothing to approve.",
  automatic: true,
};

/**
 * What `factory:ready` means right now. `awaiting` (and an absent status, for
 * a caller that has not read the start gate) keeps the table's own entry:
 * there, asking for the approval is right.
 */
function readyEntry(status: TaskStartStatus | undefined, expedited: boolean | undefined): Entry | undefined {
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
      // Under expedite the factory retries the start itself, and a second
      // `Approved` landing beside its retry starts a second implementer — so
      // the expedited answer wins over the retry ask.
      if (!expedited) {
        return {
          who: "the implementation approvers — {approvers}",
          how: "Approved, but no implementer started — approve again to retry.",
          waitsOnPerson: true,
        };
      }
      break;
    default:
      break;
  }
  // `auto` is the status the start gate reports for an expedited task, but a
  // caller that only knows the marker gets the same answer.
  return status === "auto" || expedited ? EXPEDITED_READY : undefined;
}

/**
 * What `factory:design-approved` means once the Dispatcher has fanned the
 * epic out. Before that (no tasks yet) the table's entry is still true.
 */
function buildingEntry(tasks: NextStepProgress | undefined, expedited: boolean | undefined): Entry | undefined {
  if (!tasks || tasks.total === 0) return undefined;
  // A halted task is a question, not a start: expedite has no answer for it.
  if (tasks.blocked > 0) {
    return {
      who: "you — an agent halted",
      how: `${tasks.blocked} of this epic's ${tasks.total} tasks need a human reply before they continue. Answer on the task and the factory resumes.`,
      waitsOnPerson: true,
    };
  }
  if (tasks.done === tasks.total) {
    if (expedited) {
      return {
        who: "the factory — expedited",
        how: `All ${tasks.total} tasks are done; the Release Manager assembles the epic and puts it at gate GS by itself. Start it by hand only if the automatic run did not fire.`,
        startRole: "release",
        startLabel: "Start the Release Manager",
        automatic: true,
      };
    }
    return {
      who: "you, then the Release Manager",
      how: `All ${tasks.total} tasks are done. Start the Release Manager to carry the epic onward — this state starts nothing on its own.`,
      startRole: "release",
      startLabel: "Start the Release Manager",
      waitsOnPerson: true,
    };
  }
  // A task closes only at the end of the line (§6d), so "0 of 8 done" is the
  // whole truth about an epic whose every task is mid-chain and none of what
  // is actually happening on it. Say how many are moving.
  const moving = tasksInFlight(tasks);
  const inFlight = moving > 0 ? `, ${moving} in flight` : "";
  return {
    who: "its tasks",
    how: `Building — ${tasks.done} of ${tasks.total} tasks done${inFlight}. Each one moves on its own card; the tabs below have them.`,
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
    state === READY_STATE ? readyEntry(ctx.startStatus, ctx.expedited)
    : state === DESIGN_APPROVED_STATE ? buildingEntry(ctx.tasks, ctx.expedited)
    : undefined;
  // The expedited table only covers the states whose move expedite takes over;
  // everywhere else (the two gates it keeps, blocked, the fast lane) it falls
  // through to the base table, which is why a non-expedited caller reads
  // exactly as it did before.
  const expedited = ctx.expedited && state ? EXPEDITED[state] : undefined;
  // The automatic hop is happening right now: say so instead of naming the
  // role as "next", which reads as an invitation to start the run that is
  // already going (the router does not check the marker — a second start is a
  // second agent on the same issue).
  const runningNow: Entry | undefined =
    expedited?.startRole && ctx.running
      ? {
          who: "the factory — expedited",
          how: `${ROLE_LABEL[expedited.startRole]} is running on this now. Nothing to start.`,
          automatic: true,
        }
      : undefined;
  const entry = live ?? runningNow ?? expedited ?? (state ? TABLE[state] : undefined) ?? (state ? undefined : OFF_RAIL);
  const e = entry ?? { who: `whoever owns ${state}`, how: "No instruction on file for this state.", waitsOnPerson: true };
  const who = approvers.length > 0 ? approvers.map((a) => `@${a}`).join(", ") : "any collaborator";
  const fill = (text: string) => text.replace("{approvers}", who);
  return {
    who: fill(e.who),
    how: fill(e.how),
    startRole: e.startRole ?? null,
    startLabel: e.startLabel ?? null,
    waitsOnPerson: e.waitsOnPerson ?? false,
    automatic: e.automatic ?? false,
  };
}

/**
 * The gate whose approver list a state's `{approvers}` refers to. `staging` is
 * GS's own key; where an estate has not got one, `gateApproverChain` sends the
 * caller on to `release` (packages/core/src/factory.ts).
 */
export const GATE_FOR_APPROVERS: Record<string, string> = {
  "factory:release-ready": "release_scope",
  "factory:spec-ready": "spec",
  "factory:design-ready": "design",
  "factory:ready": "implementation",
  "factory:epic-ready": "staging",
  "factory:in-staging": "release",
};
