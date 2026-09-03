import { EXPEDITE_LABEL, isFactoryState, RELEASE_KIND_LABEL, type FactoryState } from "./factory.js";

/**
 * Derivations pinned down in the plan (03 §3). These are pure functions of
 * GitHub facts — the Console computes classifications, never state.
 */

/**
 * `test` is a system test case sub-issue (FACTORY.md §4b) — a unit of human
 * verification, not of implementation. It is its own kind because everything
 * downstream treats it differently: it is excluded from code-task counts,
 * offers a verdict rather than a start, and never routes to a role.
 */
export type IssueKind = "epic" | "task" | "test" | "plain";
export type PrKind = "spec" | "design" | "task" | "promotion" | "other";

export function deriveFactoryState(labels: string[]): FactoryState | null {
  const states = labels.filter(isFactoryState);
  // Exactly one state label per issue is the factory invariant; if drift ever
  // produces more than one, prefer the last-applied and let the health strip
  // surface the anomaly rather than guessing here.
  return states.length > 0 ? states[states.length - 1]! : null;
}

/**
 * Is expedite on? The marker is orthogonal to the state (it never wins
 * `deriveFactoryState`), and it lives on the EPIC alone: a task is expedited
 * because its epic is, so a caller asking about a task passes its epic's
 * labels. An issue with no epic — a plain issue, or a task whose parent the
 * projection has not caught up with — is simply not expedited.
 */
export function deriveExpedited(labels: readonly string[] | null | undefined): boolean {
  return Boolean(labels?.includes(EXPEDITE_LABEL));
}

export function deriveIssueKind(input: {
  labels: string[];
  title: string;
  hasParent: boolean;
}): IssueKind {
  // Release trackers carry a factory:release-* state, but they are milestone
  // badges, not epics — the kind marker keeps them off the board and tree.
  if (input.labels.includes(RELEASE_KIND_LABEL)) return "plain";
  // A system test case (FACTORY.md §4b): `test(<epic>): ST-<n> <title>`. Kept
  // apart from `task` deliberately — a case is never dispatched to an
  // implementer, never counts among an epic's code tasks, and offers a
  // tester's verdict where a task offers a start.
  if (/^test\(\d+\)/i.test(input.title)) return "test";
  const state = deriveFactoryState(input.labels);
  if (input.hasParent) return state || /^task\(/i.test(input.title) ? "task" : "plain";
  if (/^task\(/i.test(input.title)) return "task";
  if (state) return "epic";
  return "plain";
}

/**
 * PR kind from the factory's branch naming convention (FACTORY.md §6):
 *   factory/<epic>-spec, factory/<epic>-design, factory/<task>-<slug>,
 *   and the integration -> default-branch promotion (FACTORY.md §6a).
 *
 * The integration branch is the org's, so its name is not fixed: it comes from
 * `.github/factory-branches.json` (or the repo profile's `branches.staging`
 * override), projected onto `repos.staging_branch`. The defaults keep the
 * pre-policy behaviour — `staging` -> `main` — for callers that have neither.
 */
export function derivePrKind(
  headRef: string,
  baseRef: string,
  branches: { integration?: string | null; default?: string | null } = {},
): { kind: PrKind; issueNumber: number | null } {
  const integration = branches.integration || "staging";
  const defaultBranch = branches.default || "main";
  if (headRef === integration && baseRef === defaultBranch) return { kind: "promotion", issueNumber: null };
  const m = headRef.match(/^factory\/(\d+)-(.+)$/);
  if (!m) return { kind: "other", issueNumber: null };
  const issueNumber = Number(m[1]);
  const rest = m[2]!;
  if (rest === "spec") return { kind: "spec", issueNumber };
  if (rest === "design") return { kind: "design", issueNumber };
  return { kind: "task", issueNumber };
}

/**
 * An issue reference from a body marker. `repo` is the `owner/name` the
 * marker qualified it with — null means "this repo". FACTORY.md §7 pins the
 * cross-repo forms: `Blocked by owner/repo#N` and `Part of owner/repo#N`;
 * full GitHub issue URLs are accepted as the equivalent.
 */
export interface IssueRef {
  repo: string | null;
  number: number;
}

const REF_SRC = String.raw`(?:https?://[^/\s]+/([\w.-]+)/([\w.-]+)/issues/(\d+)|([\w.-]+)/([\w.-]+)#(\d+)|#(\d+))`;

function parseRef(m: RegExpMatchArray): IssueRef {
  if (m[3]) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  if (m[6]) return { repo: `${m[4]}/${m[5]}`, number: Number(m[6]) };
  return { repo: null, number: Number(m[7]) };
}

/**
 * Blocker refs from dependency markers in an issue body — the fallback
 * dependency source when the native relations API is absent. One marker per
 * line, case-insensitive: "blocked by #12", "depends on #12, #13",
 * "after #12", "blocked by owner/repo#12". Deliberately line-anchored so
 * prose mentioning a dependency in passing ("this was blocked by #12 last
 * week") does not create an edge.
 */
export function blockerRefsFromBody(body: string | null): IssueRef[] {
  if (!body) return [];
  const out = new Map<string, IssueRef>();
  const line_re = new RegExp(String.raw`^\s*(?:[-*]\s*)?(?:blocked by|depends on|after)\s*:?\s*((?:${REF_SRC}[,\s]*)+)$`, "i");
  for (const line of body.split("\n")) {
    const m = line.match(line_re);
    if (!m) continue;
    for (const ref of m[1]!.matchAll(new RegExp(REF_SRC, "gi"))) {
      const parsed = parseRef(ref);
      out.set(`${parsed.repo ?? ""}#${parsed.number}`, parsed);
    }
  }
  return [...out.values()];
}

/** Same-repo blocker numbers — the pre-cross-repo view of blockerRefsFromBody. */
export function blockerNumbersFromBody(body: string | null): number[] {
  return blockerRefsFromBody(body)
    .filter((r) => r.repo === null)
    .map((r) => r.number);
}

/**
 * Heuristic parent link from an issue body. Same-repo forms are the factory's
 * long-standing markers ("parent: #7", "epic: #7", "part of #7", "sub-issue
 * of #7"); a sub-issue the planner opened in a sibling repo qualifies the
 * epic's repo ("Part of owner/repo#7", FACTORY.md §7).
 */
export function parentRefFromBody(body: string | null): IssueRef | null {
  if (!body) return null;
  const m =
    body.match(new RegExp(String.raw`(?:^|\n)\s*(?:parent|epic)\s*:?\s*${REF_SRC}`, "i")) ??
    body.match(new RegExp(String.raw`sub-issue of\s+${REF_SRC}`, "i")) ??
    body.match(new RegExp(String.raw`part of\s+${REF_SRC}`, "i"));
  return m ? parseRef(m) : null;
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
  // System tests (FACTORY.md §4b). They are change content like every other
  // artifact: written before gate G2, approved by its merge, read from the
  // branch that carries the change folder, archived with it.
  else if (rest === "system-tests/test-plan.md") artifact = "test-plan";
  else if (rest === "system-tests/test-data.md") artifact = "test-data";
  return { slug: m[1]!, epicNumber: Number(m[2]), artifact };
}

export type ArtifactKind = "proposal" | "spec" | "design" | "tasks" | "test-plan" | "test-data";

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
