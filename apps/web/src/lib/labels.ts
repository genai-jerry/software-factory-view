import type { Me, SetupStatus } from "../types.js";

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

export const PEOPLE_LABEL: Record<string, string> = {
  "factory:intake": "Filed",
  "factory:spec-ready": "Approve spec",
  "factory:spec-approved": "Planning",
  "factory:planned": "Designing",
  "factory:design-ready": "Approve design",
  "factory:design-approved": "Released to build",
  "factory:release-planning": "Planning release",
  "factory:release-ready": "Approve release",
  "factory:release-approved": "Release approved",
  "factory:ready": "Ready to build",
  "factory:in-review": "In review",
  "factory:in-test": "In test",
  "factory:ready-to-ship": "Staging",
  "factory:on-epic": "On epic branch",
  "factory:in-staging": "Merge to ship",
  "factory:deployed": "Shipped",
  "factory:blocked": "Agent halted",
  "factory:fast-track": "Fast track",
  "factory:incident": "Incident",
  "factory:backlog": "Backlog",
  "factory:profile": "Profiling",
};

export const GATE_SHORT: Record<string, string> = {
  "factory:spec-ready": "G1",
  "factory:design-ready": "G2",
  "factory:in-staging": "G3",
};

export const PHASE_LABELS = {
  specifying: "Being specified",
  planning: "Being planned",
  building: "Being built",
  shipping: "Shipping",
  held: "Held",
} as const;

export function peopleLabel(state: string | null | undefined): string {
  if (!state) return "No factory state";
  return PEOPLE_LABEL[state] ?? state.replace(/^factory:/, "");
}

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
    if (state === "factory:in-staging") return "Merge to ship";
    return "Approve at this gate";
  }
  if (kind === "task-start") return "Approve implementation start";
  if (kind === "merge") return "Merge to ship";
  return whyYou;
}

export function isOrgAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function canReachSettings(me: Me, setup: SetupStatus | undefined): boolean {
  return Boolean(setup?.canEditApp) || me.orgs.some((o) => isOrgAdminRole(o.role));
}
