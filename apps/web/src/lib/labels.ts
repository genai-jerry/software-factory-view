import type { Me, SetupStatus } from "../types.js";
import { PEOPLE_LABEL, peopleLabel, plainTitle } from "@console/decisions/labels";

export { PEOPLE_LABEL, peopleLabel, plainTitle };

/**
 * People-language labels for factory states (design D4). Factory names stay as
 * secondary chips.
 *
 * Say what is happening, not which gate last closed. The three `*-approved`
 * states are receipts in the factory's vocabulary but stages in a reader's:
 * an epic holds `design-approved` for its entire build, and while it read
 * "Design approved" the epic's own header said the design gate had just
 * passed with four tasks visibly building underneath it. Where a stage has
 * progress to report, the API sends it as `epic.status` (`epicStatus` in
 * `@console/core`, derived there because the browser bundle does not carry
 * core — the same reason `nextStep` is computed server-side). These are what
 * that falls back to.
 */


export const GATE_SHORT: Record<string, string> = {
  "factory:spec-ready": "G1",
  "factory:design-ready": "G2",
  // GS: the epic is assembled, and releasing it to the integration branch is
  // a human decision — the one expedite deliberately keeps.
  "factory:epic-ready": "GS",
  "factory:in-staging": "G3",
};

/** The one word for the marker, said the same way on every row it appears on. */
export const EXPEDITE_BADGE = "Expedited";

/** Its tooltip, so a reader who has not met the mode learns it from the badge. */
export const EXPEDITE_TITLE =
  "factory:expedite — the factory approves G1 and G2 itself and starts every task stage. " +
  "The staging (GS) and production (G3) gates still need a human.";

export const PHASE_LABELS = {
  specifying: "Being specified",
  planning: "Being planned",
  building: "Being built",
  shipping: "Shipping",
  held: "Held",
} as const;


export function factoryShort(state: string | null | undefined): string | null {
  if (!state) return null;
  return GATE_SHORT[state] ?? state.replace(/^factory:/, "");
}

export function attentionReason(kind: string, rank: number, whyYou: string, state: string | null): string {
  if (kind === "blocked") {
    return rank === 4 ? "Unowned — anyone may reply" : "Answer the agent";
  }
  if (kind === "gate") {
    if (state === "factory:spec-ready") return "Approve the spec";
    if (state === "factory:design-ready") return "Approve the design";
    if (state === "factory:epic-ready") return "Release to staging";
    if (state === "factory:in-staging") return "Merge to ship";
    return "Approve at this gate";
  }
  if (kind === "task-start") {
    // The queue files three things under this kind. Only a task at
    // factory:ready is an implementation start; a system test case and a bug
    // fix are a tester's to run, and said so rather than all reading alike.
    if (state === "factory:manual-test") return "Run the test case";
    if (state === "factory:bug-retest") return "Re-test the bug fix";
    return "Approve implementation start";
  }
  if (kind === "merge") return "Merge to ship";
  return whyYou;
}

export function isOrgAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canReachSettings(me: Me, setup: SetupStatus | undefined): boolean {
  return Boolean(setup?.canEditApp) || me.orgs.some((o) => isOrgAdminRole(o.role));
}


/** The names of the open items a task or case waits on, or a plain word for one without a title. */
export function namesOf(items: Array<{ title: string }>): string {
  return items.map((d) => plainTitle(d.title) || "another task").join(", ");
}
