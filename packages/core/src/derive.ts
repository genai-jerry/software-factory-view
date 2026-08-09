import { isFactoryState, type FactoryState } from "./factory.js";

/**
 * Derivations pinned down in the plan (03 §3). These are pure functions of
 * GitHub facts — the Console computes classifications, never state.
 */

export type IssueKind = "epic" | "task" | "plain";
export type PrKind = "spec" | "design" | "task" | "promotion" | "other";

export function deriveFactoryState(labels: string[]): FactoryState | null {
  const states = labels.filter(isFactoryState);
  // Exactly one state label per issue is the factory invariant; if drift ever
  // produces more than one, prefer the last-applied and let the health strip
  // surface the anomaly rather than guessing here.
  return states.length > 0 ? states[states.length - 1]! : null;
}

export function deriveIssueKind(input: {
  labels: string[];
  title: string;
  hasParent: boolean;
}): IssueKind {
  const state = deriveFactoryState(input.labels);
  if (input.hasParent) return state || /^task\(/i.test(input.title) ? "task" : "plain";
  if (/^task\(/i.test(input.title)) return "task";
  if (state) return "epic";
  return "plain";
}

/**
 * PR kind from the factory's branch naming convention (FACTORY.md §6):
 *   factory/<epic>-spec, factory/<epic>-design, factory/<task>-<slug>,
 *   staging -> main promotion.
 */
export function derivePrKind(headRef: string, baseRef: string): { kind: PrKind; issueNumber: number | null } {
  if (headRef === "staging" && baseRef === "main") return { kind: "promotion", issueNumber: null };
  const m = headRef.match(/^factory\/(\d+)-(.+)$/);
  if (!m) return { kind: "other", issueNumber: null };
  const issueNumber = Number(m[1]);
  const rest = m[2]!;
  if (rest === "spec") return { kind: "spec", issueNumber };
  if (rest === "design") return { kind: "design", issueNumber };
  return { kind: "task", issueNumber };
}

/** Change-folder slug from a spec-PR file path, e.g. openspec/changes/16-payment-reminders/proposal.md */
export function parseChangePath(path: string): { slug: string; epicNumber: number; artifact: ArtifactKind | null } | null {
  const m = path.match(/^openspec\/changes\/((\d+)-[a-z0-9-]+)\/(.+)$/i);
  if (!m) return null;
  const rest = m[3]!;
  let artifact: ArtifactKind | null = null;
  if (rest === "proposal.md") artifact = "proposal";
  else if (rest === "design.md") artifact = "design";
  else if (rest === "tasks.md") artifact = "tasks";
  else if (rest.startsWith("specs/")) artifact = "spec";
  return { slug: m[1]!, epicNumber: Number(m[2]), artifact };
}

export type ArtifactKind = "proposal" | "spec" | "design" | "tasks";

/** Thread topic refs are stable strings that survive projection rebuilds. */
export function artifactThreadRef(artifact: ArtifactKind, path?: string): string {
  return artifact === "spec" && path ? `artifact/${path.replace(/[^A-Za-z0-9_\-./]/g, "_")}` : `artifact/${artifact}`;
}

export function gateThreadRef(gate: string): string {
  return `gate/${gate}`;
}

export function taskThreadRef(taskIssueNumber: number): string {
  return `task/${taskIssueNumber}`;
}

export const INBOX_THREAD_REF = "inbox";
