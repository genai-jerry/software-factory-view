import { GATE_STATES } from "./factory.js";

/**
 * The individual's five-phase compression of the label state machine
 * (plan 07 §4.2). Twelve columns is the factory's resolution; five phases is
 * the requester's. Pure data, shared by API and web so the grouping cannot
 * drift — the full `factory:*` label stays the state (F-R3), phases only
 * re-group it for display.
 */

export type Phase = "specifying" | "planning" | "building" | "shipping" | "held";

export const PHASE_LABELS: Record<Phase, string> = {
  specifying: "Being specified",
  planning: "Being planned",
  building: "Being built",
  shipping: "Shipping",
  held: "Held",
};

const PHASE_MAP: Record<string, Phase> = {
  "factory:backlog": "held",
  "factory:release-planning": "planning",
  "factory:release-ready": "planning",
  "factory:release-approved": "planning",
  "factory:intake": "specifying",
  "factory:spec-ready": "specifying",
  "factory:spec-approved": "planning",
  "factory:planned": "planning",
  "factory:design-ready": "planning",
  "factory:design-approved": "building",
  "factory:ready": "building",
  "factory:in-review": "building",
  "factory:in-test": "building",
  "factory:ready-to-ship": "shipping",
  "factory:on-epic": "shipping",
  "factory:epic-ready": "shipping",
  "factory:in-staging": "shipping",
  "factory:deployed": "shipping",
  "factory:blocked": "held",
  "factory:incident": "held",
  "factory:fast-track": "building",
};

/** Total: every state maps; unknown/null (off-rail drift, pre-factory) → held. */
export function phaseOfState(state: string | null): Phase {
  return (state && PHASE_MAP[state]) || "held";
}

/**
 * The peek panel's one-sentence state description (plan 07 §4.4). Templates,
 * not free text; slots are filled by the API from projections. `{approvers}`
 * renders as "@a, @b" or "any collaborator" when the list is empty.
 */
export const STATE_SENTENCE: Record<string, string> = {
  "factory:backlog": "Filed, waiting for its release to be approved (gate G0) before intake starts.",
  "factory:release-planning": "Release tracker open; nothing runs until someone asks for a release plan.",
  "factory:release-ready": "Release plan posted on the tracker, awaiting gate G0 approval.",
  "factory:release-approved": "Release approved (G0); its issues are entering intake.",
  "factory:intake": "An agent is analysing the requirement and drafting the spec.",
  "factory:spec-ready": "Spec PR open, awaiting gate G1 — approvers: {approvers}.",
  "factory:spec-approved": "Spec approved; the planner is breaking it into tasks.",
  "factory:planned": "Tasks created; the architect is writing the design.",
  "factory:design-ready": "Design PR open, awaiting gate G2 — approvers: {approvers}.",
  "factory:design-approved": "Design approved; unblocked tasks are being released to implementers.",
  "factory:ready": "Unblocked and waiting for an implementation start ({approvers} may approve it).",
  "factory:in-review": "Draft PR under agent review.",
  "factory:in-test": "QA is verifying the WHEN/THEN scenarios.",
  "factory:ready-to-ship": "Green; the release manager is merging it onto the epic branch (or staging when the epic has none) and checking it there.",
  "factory:on-epic": "Merged onto its epic branch and green there; waiting for the epic to complete and be carried to staging.",
  "factory:epic-ready":
    "Assembled and green on its epic branch, awaiting gate GS — the release to staging, not to production. Approvers: {approvers}.",
  "factory:in-staging": "On staging and verified there, awaiting gate G3 — the promotion to the default branch. Approvers: {approvers}.",
  "factory:deployed": "In production; soak in progress.",
  "factory:blocked": "Halted — an agent needs a human reply to continue.",
  "factory:incident": "A post-deploy regression is under investigation.",
  "factory:fast-track": "In the fast lane — a single run produces a ready-for-review PR.",
};

/** "What happens next, and who moves it" — FACTORY.md §3's Advanced-by column, one line per state. */
export const NEXT_MOVER: Record<string, string> = {
  "factory:backlog": "A release_scope approver comments Approved on the release tracker (G0).",
  "factory:release-planning": "A human comments Plan release on the tracker to draft the plan.",
  "factory:release-ready": "A release_scope approver comments Approved on the tracker (G0).",
  "factory:release-approved": "The factory moves the release's issues into intake.",
  "factory:intake": "The Intake agent opens the spec PR and moves it to spec-ready.",
  "factory:spec-ready": "A spec approver merges the PR or comments Approved (G1).",
  "factory:spec-approved": "The Planner writes tasks.md and opens the sub-issues.",
  "factory:planned": "The Architect opens the design PR(s) and moves it to design-ready.",
  "factory:design-ready": "A design approver merges the PR or comments Approved (G2).",
  "factory:design-approved": "The Dispatcher marks unblocked tasks ready.",
  "factory:ready": "An implementation approver comments Approved to start the implementer.",
  "factory:in-review": "The Reviewer approves (→ in-test) or requests changes (→ ready).",
  "factory:in-test": "QA posts the test report and moves it to ready-to-ship.",
  "factory:ready-to-ship": "The Release Manager merges it onto the epic branch (or staging when the epic has none) and verifies it there.",
  "factory:on-epic": "The Release Manager assembles the completed epic and moves it to epic-ready (gate GS).",
  "factory:epic-ready": "A staging approver comments Approved on the epic (GS); the Release Manager then merges it onto the integration branch.",
  "factory:in-staging": "A human merges the promotion PR(s) via the GitHub UI (G3).",
  "factory:deployed": "Ops verifies health, archives the change, and closes the issue.",
  "factory:blocked": "Any collaborator replies on the issue; the factory clears the label and resumes.",
  "factory:incident": "A human decides rollback or fix-forward with the Release Manager.",
  "factory:fast-track": "A human reviews and merges the fast-lane PR.",
};

/** Fill a STATE_SENTENCE template with its gate's approver list, when it has one. */
export function stateSentence(state: string | null, approvers: string[]): string {
  if (!state) return "No factory state — this issue is outside the pipeline.";
  const template = STATE_SENTENCE[state] ?? `In ${state}.`;
  if (!template.includes("{approvers}")) return template;
  const who = approvers.length > 0 ? approvers.map((a) => `@${a}`).join(", ") : "any collaborator";
  return template.replace("{approvers}", who);
}

/** The gate owning a state's approver list, if that state is a gate. */
export function gateOfState(state: string | null): { gate: string; label: string } | null {
  return state ? (GATE_STATES[state] ?? null) : null;
}
