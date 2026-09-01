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
  { name: "factory:epic-ready", color: "46A06B", description: "Epic fully assembled and green on its own branch; awaiting gate GS, the release to staging" },
  { name: "factory:in-staging", color: "3D9970", description: "Merged to staging and verified there; awaiting gate G3 promotion to the default branch" },
  { name: "factory:deployed", color: "0B8043", description: "In production; soak in progress" },
  { name: "factory:fast-track", color: "8C8C8C", description: "Small fix bypassing OpenSpec ceremony" },
  { name: "factory:blocked", color: "A63D40", description: "Factory flow needs human attention" },
  { name: "factory:incident", color: "7A1F1F", description: "Post-deploy regression under investigation" },
] as const;

/**
 * Kind/marker labels the factory also creates. Deliberately NOT states:
 * `factory:release` marks a release tracker issue (which also carries one
 * `factory:release-*` state), `factory:in-progress` sits alongside the state
 * label for the duration of an agent run, and `factory:expedite` sits
 * alongside it for as long as a human wants the epic run without the per-stage
 * starts. They are provisioned during onboarding but must never win state
 * derivation.
 */
export const RELEASE_KIND_LABEL = "factory:release";

/** The run marker: a factory agent is working on this issue right now. */
export const IN_PROGRESS_LABEL = "factory:in-progress";

/**
 * The expedite marker: a human asked for this epic to be built without the
 * per-stage human starts (claude-software-factory: `add-expedite-mode`).
 *
 * Orthogonal, exactly like the run marker — it never replaces the state label,
 * and it is applied to the EPIC only: a task is expedited because its epic is,
 * so the factory never copies the label onto the sub-issues and neither does
 * the Console. While it is present the factory approves G1 and G2 itself and
 * starts each task's implementer, reviewer, QA and assembly as the previous
 * one lands. It waives starts, not decisions: gate GS (`factory:epic-ready`)
 * and gate G3 (`factory:in-staging`) stay human.
 */
export const EXPEDITE_LABEL = "factory:expedite";

/**
 * The epic's own assembled-but-not-released state, between `factory:on-epic`
 * (its last task landed on the epic branch) and `factory:in-staging` (the
 * integration branch has it). Universal: every epic passes through it,
 * expedited or not, because gate GS holds here.
 */
export const EPIC_READY_STATE = "factory:epic-ready";

/**
 * The state an epic holds for the whole of its build.
 *
 * FACTORY.md §3 reads it "Released for implementation", not "the design gate
 * passed": every state after it belongs to a *task*, so an epic sits here
 * from gate G2 until the Release Manager carries it onward. It is also the
 * dispatcher's guard for re-running on task close (FACTORY.md §2a), so it
 * must not be advanced to make a badge read better — a task freed by a later
 * merge would then strand with no factory state at all.
 */
export const DESIGN_APPROVED_STATE = "factory:design-approved";

export const FACTORY_KIND_LABELS = [
  { name: RELEASE_KIND_LABEL, color: "24597A", description: "Tracker issue for a release milestone (kind, not a state)" },
  { name: IN_PROGRESS_LABEL, color: "1F6FEB", description: "A factory agent run is live on this issue right now" },
  { name: EXPEDITE_LABEL, color: "D93F0B", description: "Run this epic without the per-stage human starts (marker, not a state); staging and production gates still hold" },
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
  EPIC_READY_STATE,
  "factory:in-staging",
  "factory:deployed",
];

export type Gate = "spec" | "design" | "implementation" | "staging" | "release";

/** States at which a gate holds, and which approver list owns it. */
export const GATE_STATES: Record<string, { gate: Gate; label: string }> = {
  "factory:spec-ready": { gate: "spec", label: "G1" },
  "factory:design-ready": { gate: "design", label: "G2" },
  "factory:ready": { gate: "implementation", label: "start" },
  // GS holds at epic-ready: the epic is assembled and green on its own branch
  // but nothing of it is on the integration branch yet, so releasing it there
  // is a decision — the last one before staging proves the change. Comment-
  // approvable like G1/G2, and universal: expedite waives the starts before
  // this point, never this gate. factory:on-epic still deliberately has NO
  // gate; it is the Release Manager's assembly step (FACTORY.md §6b).
  [EPIC_READY_STATE]: { gate: "staging", label: "GS" },
  // G3 holds at in-staging, not ready-to-ship or on-epic: the merges onto the
  // epic branch (FACTORY.md §6b) and the integration branch (§6a) are the
  // Release Manager's steps, and only once the change is proved on staging
  // does a human decide whether to promote it.
  "factory:in-staging": { gate: "release", label: "G3" },
};

/**
 * Gates that borrow another gate's approver list when their own is unset.
 *
 * GS is newer than most `.github/factory-approvers.json` files, so an estate
 * that has never heard of it has no `staging` key at all. The factory reads
 * `staging`, then `release`, then "any collaborator"; the Console must route
 * attention down the same chain or it would show the staging gate to nobody
 * on exactly the estates that have not upgraded their approver file.
 */
export const GATE_FALLBACK: Partial<Record<Gate, Gate>> = { staging: "release" };

/** A gate's approver lists in priority order — the first non-empty one owns it. */
export function gateApproverChain(gate: string): string[] {
  const next = GATE_FALLBACK[gate as Gate];
  return next ? [gate, next] : [gate];
}

/**
 * The list that actually owns a gate here, given a lookup into whatever the
 * caller has already loaded. An all-empty chain answers with the gate's own
 * (empty) list, which every caller already reads as "any collaborator".
 */
export function resolveGateApprovers(
  gate: string,
  listFor: (gate: string) => string[],
): { gate: string; approvers: string[]; fellBackFrom: string | null } {
  for (const candidate of gateApproverChain(gate)) {
    const approvers = listFor(candidate);
    if (approvers.length > 0) return { gate: candidate, approvers, fellBackFrom: candidate === gate ? null : gate };
  }
  return { gate, approvers: [], fellBackFrom: null };
}

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
  /** Gate GS. Absent in files written before GS existed — see `GATE_FALLBACK`. */
  staging: string[];
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
    staging: list("staging"),
    release: list("release"),
  };
}
