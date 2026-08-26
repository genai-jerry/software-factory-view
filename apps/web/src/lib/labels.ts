import type { Me, SetupStatus } from "../types.js";

/** People-language labels for factory states (design D4). Factory names stay as secondary chips. */

export const PEOPLE_LABEL: Record<string, string> = {
  "factory:intake": "Filed",
  "factory:spec-ready": "Approve spec",
  "factory:spec-approved": "Spec approved",
  "factory:planned": "Planning",
  "factory:design-ready": "Approve design",
  "factory:design-approved": "Design approved",
  "factory:ready": "Ready to build",
  "factory:in-review": "In review",
  "factory:in-test": "In test",
  "factory:ready-to-ship": "Merge to ship",
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
  "factory:ready-to-ship": "G3",
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
    if (state === "factory:ready-to-ship") return "Merge to ship";
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
