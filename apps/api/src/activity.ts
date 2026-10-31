/**
 * Activity — what people and the factory did, in one line each (redesign
 * board 3b). The lines are written from the state moves the projection
 * already records, so nothing is invented: a move the factory made is "The
 * factory …", a move a person made names them, and both say what happened
 * to the item in the reader's words rather than as a label change.
 */

export interface Move {
  toState: string | null;
  fromState: string | null;
  actor: string | null;
  /** The issue that moved. */
  kind: string;
  number: number;
  title: string;
  /** The epic it belongs to, when it is a child. */
  epicTitle: string | null;
  epicNumber: number | null;
}

export interface ActivityLine {
  who: string;
  /** True when a person, not the factory, did it. */
  person: boolean;
  text: string;
  stage: "clarify" | "design" | "build" | "test" | "release" | "new" | null;
}

const BOT = /\[bot\]$|^github-actions|-console\[bot\]$/;

function nameOf(actor: string | null): { who: string; person: boolean } {
  if (!actor || BOT.test(actor)) return { who: "The factory", person: false };
  return { who: actor, person: true };
}

function short(title: string): string {
  return title.replace(/^(?:task|test|bug)\(\d+\):\s*/i, "");
}

/** The one line for a move, or null when the move says nothing a reader needs. */
export function lineFor(m: Move): ActivityLine | null {
  const { who, person } = nameOf(m.actor);
  const item = m.epicTitle ?? m.title;
  const isEpic = m.kind === "epic" || m.epicTitle === null;
  const sub = m.kind === "task" ? `task #${m.number}` : m.kind === "test" ? `test ${short(m.title).match(/^(ST|TC)-\d+/)?.[0] ?? `#${m.number}`}` : m.kind === "bug" ? `bug #${m.number}` : null;
  const on = sub ? `${sub} of ${item}` : item;
  const s = m.toState ?? "";
  switch (s) {
    case "factory:intake":
      return { who, person, text: person ? `${who} added ${item}.` : `The factory took ${item} into intake.`, stage: "new" };
    case "factory:spec-ready":
      return { who: "The factory", person: false, text: `The factory finished the plan for ${item}. Waiting for approval.`, stage: "clarify" };
    case "factory:spec-approved":
      return { who, person, text: person ? `${who} approved the plan for ${item}.` : `The factory approved the plan for ${item}.`, stage: "clarify" };
    case "factory:planned":
      return { who: "The factory", person: false, text: `The factory broke ${item} into tasks.`, stage: "design" };
    case "factory:design-ready":
      return { who: "The factory", person: false, text: `The factory finished the design for ${item}. Waiting for approval.`, stage: "design" };
    case "factory:design-approved":
      return { who, person, text: person ? `${who} approved the design for ${item}.` : `The factory approved the design for ${item}.`, stage: "design" };
    case "factory:ready":
      return isEpic ? null : { who: "The factory", person: false, text: `The factory released ${on} to build.`, stage: "build" };
    case "factory:in-progress":
      return isEpic ? null : { who: "The factory", person: false, text: `The factory started building ${on}.`, stage: "build" };
    case "factory:in-review":
      return isEpic ? null : { who: "The factory", person: false, text: `The factory wrote ${on}. Review next.`, stage: "build" };
    case "factory:in-test":
      return isEpic ? null : { who: "The factory", person: false, text: `The factory reviewed ${on}. Tests next.`, stage: "build" };
    case "factory:on-epic":
    case "factory:ready-to-ship":
      return isEpic ? null : { who: "The factory", person: false, text: `The factory built ${on}.`, stage: "build" };
    case "factory:blocked":
      return { who: "The factory", person: false, text: `The factory stopped on ${on} and asked a question.`, stage: "build" };
    case "factory:manual-test":
      return { who: "The factory", person: false, text: `${sub ? `Test ${short(m.title).match(/^(ST|TC)-\d+/)?.[0] ?? `#${m.number}`}` : "A test"} of ${item} is ready to run.`, stage: "test" };
    case "factory:test-passed":
      return { who, person, text: `${who} ran ${on}: passed.`, stage: "test" };
    case "factory:test-failed":
      return { who, person, text: `${who} ran ${on}: failed. The fix is being built.`, stage: "test" };
    case "factory:bug-open":
      return { who, person, text: `${who} reported ${on}. The fix is being built.`, stage: "test" };
    case "factory:bug-retest":
      return { who: "The factory", person: false, text: `The fix for ${on} is ready to re-test.`, stage: "test" };
    case "factory:bug-verified":
      return { who, person, text: `${who} confirmed the fix for ${on}.`, stage: "test" };
    case "factory:epic-ready":
      return { who: "The factory", person: false, text: `The factory finished building ${item}. Waiting for the release to staging.`, stage: "release" };
    case "factory:in-staging":
      return { who, person, text: person ? `${who} released ${item} to staging.` : `${item} is on staging.`, stage: "release" };
    case "factory:deployed":
      return { who, person, text: person ? `${who} shipped ${item} to production.` : `${item} is in production.`, stage: "release" };
    default:
      return null;
  }
}
