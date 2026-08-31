/**
 * Constants describing the factory's label state machine. These mirror
 * claude-software-factory (FACTORY.md §3, scripts/setup-labels.sh) and must
 * stay in sync with it — the Console renders factory state, never invents it.
 */

export const FACTORY_LABELS = [
  { name: "factory:backlog", color: "8B949E", description: "Filed, waiting for its release milestone to be approved" },
  { name: "factory:release-planning", color: "3F5D8A", description: "Awaiting `Plan release` on the tracker (nothing running)" },
  { name: "factory:release-ready", color: "5C7CBF", description: "Release plan posted, awaiting gate G0 approval" },
  { name: "factory:release-approved", color: "246B4A", description: "Release approved (G0); its issues enter intake" },
  { name: "factory:intake", color: "0E5A8A", description: "New requirement awaiting intake analysis" },
  { name: "factory:spec-ready", color: "4A90D9", description: "Spec PR open, awaiting gate G1 approval" },
  { name: "factory:spec-approved", color: "2E7D4F", description: "Spec approved (G1); released for planning" },
  { name: "factory:planned", color: "5B4A8A", description: "tasks.md + sub-issues created, awaiting design" },
  { name: "factory:design-ready", color: "8E6BBF", description: "design.md PR(s) open, awaiting gate G2 approval" },
  { name: "factory:design-approved", color: "1E6B45", description: "Design approved (G2); released for implementation" },
  { name: "factory:ready", color: "B07D2B", description: "Task unblocked; implementer may start" },
  { name: "factory:in-review", color: "C98A1B", description: "Draft PR under agent review" },
  { name: "factory:in-test", color: "D4A017", description: "QA verifying WHEN/THEN scenarios" },
  { name: "factory:ready-to-ship", color: "6AA84F", description: "Green + approved; awaiting the merge onto the epic branch (or staging when the epic has none)" },
  { name: "factory:on-epic", color: "4F9E58", description: "Merged onto the epic branch and green there; awaiting the epic's integration merge" },
  { name: "factory:in-staging", color: "3D9970", description: "Merged to staging and verified there; awaiting gate G3 promotion to the default branch" },
  { name: "factory:deployed", color: "0B8043", description: "In production; soak in progress" },
  { name: "factory:fast-track", color: "8C8C8C", description: "Small fix bypassing OpenSpec ceremony" },
  { name: "factory:blocked", color: "A63D40", description: "Factory flow needs human attention" },
  { name: "factory:incident", color: "7A1F1F", description: "Post-deploy regression under investigation" },
] as const;

/**
 * Kind/marker labels the factory also creates. Deliberately NOT states:
 * `factory:release` marks a release tracker issue (which also carries one
 * `factory:release-*` state), and `factory:in-progress` sits alongside the
 * state label for the duration of an agent run. They are provisioned during
 * onboarding but must never win state derivation.
 */
export const RELEASE_KIND_LABEL = "factory:release";

/** The run marker: a factory agent is working on this issue right now. */
export const IN_PROGRESS_LABEL = "factory:in-progress";

export const FACTORY_KIND_LABELS = [
  { name: RELEASE_KIND_LABEL, color: "24597A", description: "Tracker issue for a release milestone (kind, not a state)" },
  { name: IN_PROGRESS_LABEL, color: "1F6FEB", description: "A factory agent run is live on this issue right now" },
] as const;

export type FactoryState = (typeof FACTORY_LABELS)[number]["name"];

export const FACTORY_STATE_NAMES: readonly FactoryState[] = FACTORY_LABELS.map((l) => l.name);

export function isFactoryState(label: string): label is FactoryState {
  return (FACTORY_STATE_NAMES as readonly string[]).includes(label);
}

/**
 * Pipeline order for the board columns / stage rail. Backlog, the release-*
 * tracker states, blocked, fast-track and incident are off-rail: fast-track
 * gets its own board column, the rest land in Held.
 */
export const PIPELINE_ORDER: readonly FactoryState[] = [
  "factory:intake",
  "factory:spec-ready",
  "factory:spec-approved",
  "factory:planned",
  "factory:design-ready",
  "factory:design-approved",
  "factory:ready",
  "factory:in-review",
  "factory:in-test",
  "factory:ready-to-ship",
  "factory:on-epic",
  "factory:in-staging",
  "factory:deployed",
];

export type Gate = "spec" | "design" | "implementation" | "release";

/** States at which a gate holds, and which approver list owns it. */
export const GATE_STATES: Record<string, { gate: Gate; label: string }> = {
  "factory:spec-ready": { gate: "spec", label: "G1" },
  "factory:design-ready": { gate: "design", label: "G2" },
  "factory:ready": { gate: "implementation", label: "start" },
  // G3 holds at in-staging, not ready-to-ship or on-epic: the merges onto the
  // epic branch (FACTORY.md §6b) and the integration branch (§6a) are the
  // Release Manager's steps — factory:on-epic deliberately has NO gate — and
  // only once the change is proved on staging does a human decide whether to
  // promote it.
  "factory:in-staging": { gate: "release", label: "G3" },
};

/** Exact comment body the factory router accepts for G1/G2/implementation starts. */
export const APPROVED_BODY = "Approved";

/** Exact comment body the factory router accepts to skip the Reviewer at `factory:in-review`. */
export const REVIEW_DONE_BODY = "Review Done";

/** The one state `REVIEW_DONE_BODY` has any effect on. */
export const IN_REVIEW_STATE = "factory:in-review";

export interface ApproverFile {
  spec: string[];
  design: string[];
  implementation: string[];
  release: string[];
}

export function parseApproverFile(json: unknown): ApproverFile {
  const obj = (json ?? {}) as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(obj[k]) ? (obj[k] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  return {
    spec: list("spec"),
    design: list("design"),
    implementation: list("implementation"),
    release: list("release"),
  };
}
