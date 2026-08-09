/**
 * Constants describing the factory's label state machine. These mirror
 * claude-software-factory (FACTORY.md §3, scripts/setup-labels.sh) and must
 * stay in sync with it — the Console renders factory state, never invents it.
 */

export const FACTORY_LABELS = [
  { name: "factory:intake", color: "0E5A8A", description: "New requirement awaiting intake analysis" },
  { name: "factory:spec-ready", color: "4A90D9", description: "Spec PR open, awaiting gate G1 approval" },
  { name: "factory:spec-approved", color: "2E7D4F", description: "Spec approved (G1); released for planning" },
  { name: "factory:planned", color: "5B4A8A", description: "tasks.md + sub-issues created, awaiting design" },
  { name: "factory:design-ready", color: "8E6BBF", description: "design.md PR(s) open, awaiting gate G2 approval" },
  { name: "factory:design-approved", color: "1E6B45", description: "Design approved (G2); released for implementation" },
  { name: "factory:ready", color: "B07D2B", description: "Task unblocked; implementer may start" },
  { name: "factory:in-review", color: "C98A1B", description: "Draft PR under agent review" },
  { name: "factory:in-test", color: "D4A017", description: "QA verifying WHEN/THEN scenarios" },
  { name: "factory:ready-to-ship", color: "6AA84F", description: "Green + approved; awaiting merge order and gate G3" },
  { name: "factory:deployed", color: "0B8043", description: "In production; soak in progress" },
  { name: "factory:fast-track", color: "8C8C8C", description: "Small fix bypassing OpenSpec ceremony" },
  { name: "factory:blocked", color: "A63D40", description: "Factory flow needs human attention" },
  { name: "factory:incident", color: "7A1F1F", description: "Post-deploy regression under investigation" },
] as const;

export type FactoryState = (typeof FACTORY_LABELS)[number]["name"];

export const FACTORY_STATE_NAMES: readonly FactoryState[] = FACTORY_LABELS.map((l) => l.name);

export function isFactoryState(label: string): label is FactoryState {
  return (FACTORY_STATE_NAMES as readonly string[]).includes(label);
}

/** Pipeline order for the board columns / stage rail. Blocked, fast-track and incident are off-rail. */
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
  "factory:deployed",
];

export type Gate = "spec" | "design" | "implementation" | "release";

/** States at which a gate holds, and which approver list owns it. */
export const GATE_STATES: Record<string, { gate: Gate; label: string }> = {
  "factory:spec-ready": { gate: "spec", label: "G1" },
  "factory:design-ready": { gate: "design", label: "G2" },
  "factory:ready": { gate: "implementation", label: "start" },
  "factory:ready-to-ship": { gate: "release", label: "G3" },
};

/** Exact comment body the factory router accepts for G1/G2/implementation starts. */
export const APPROVED_BODY = "Approved";

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
