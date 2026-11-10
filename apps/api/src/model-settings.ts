import { modelSettings, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * Compass → Models: which Claude model each phase of the factory runs on.
 *
 * The phases follow Compass's rail (Clarify, Design, Build, Test, Release),
 * plus conversations, the fast lane and the roles behind the scenes. A phase
 * has one chain for everything in it, and each of its steps (the factory's
 * roles: Plan, Design, Test plan inside Design, say) may set its own.
 *
 * A chain is a preference order: the first model the factory's Claude
 * credential can reach wins. For a step, the first of these that is set is
 * used: the project's step, the project's phase, the org's step, the org's
 * phase; then the repo's `.github/factory-models.json`, then the factory's
 * default.
 *
 * Build steps reach the orchestrator through GET /api/orchestrator/models
 * (read before each run); Shape, Investigate and the questions on a thread
 * send their chain with the ask itself.
 */

export interface Step {
  /** The orchestrator's role name. */
  key: string;
  label: string;
  detail: string;
}

export interface Phase {
  /** Stored as `phase:<id>`. */
  id: string;
  label: string;
  detail: string;
  steps: Step[];
}

export const PHASES: Phase[] = [
  {
    id: "talk",
    label: "Conversations",
    detail: "Shape, Investigate and questions asked in Compass or on Telegram.",
    steps: [
      { key: "shape", label: "Shape", detail: "Talking an idea through and writing its requirement." },
      { key: "investigate", label: "Investigate", detail: "A production problem: logs, code and the fix plan." },
      { key: "ask", label: "Questions", detail: "Ask on a thread, Telegram discussions, drafted replies, QA questions." },
    ],
  },
  {
    id: "clarify",
    label: "Clarify",
    detail: "New work is read and made clear before anything is planned.",
    steps: [{ key: "intake", label: "Clarify", detail: "Reads the requirement, writes the spec and asks what is unclear." }],
  },
  {
    id: "design",
    label: "Design",
    detail: "The approved spec becomes a plan, a design and a test plan.",
    steps: [
      { key: "planner", label: "Plan", detail: "Splits the spec into tasks." },
      { key: "architect", label: "Design", detail: "Writes the design and chooses how to build it." },
      { key: "testplanner", label: "Test plan", detail: "Plans the tests the work must pass." },
    ],
  },
  {
    id: "build",
    label: "Build",
    detail: "Each task is written and reviewed.",
    steps: [
      { key: "implementer", label: "Build", detail: "Writes the code for each task." },
      { key: "reviewer", label: "Review", detail: "Reviews each pull request." },
    ],
  },
  {
    id: "test",
    label: "Test",
    detail: "The built work is tested on its environment.",
    steps: [{ key: "qa", label: "QA", detail: "Runs the test plan and files what fails." }],
  },
  {
    id: "release",
    label: "Release",
    detail: "Approved work goes to staging and on to production.",
    steps: [
      { key: "release", label: "Release", detail: "Merges the work onto staging and opens the promotion." },
      { key: "scrum", label: "Release planning", detail: "Keeps the release tracker up to date." },
    ],
  },
  {
    id: "fastlane",
    label: "Fast lane",
    detail: "Small fixes, from issue to pull request in one run.",
    steps: [{ key: "fasttrack", label: "Fast lane fix", detail: "Writes, tests and opens the fix." }],
  },
  {
    id: "support",
    label: "Behind the scenes",
    detail: "Routing and upkeep nobody watches.",
    steps: [
      { key: "dispatch", label: "Dispatch", detail: "Decides which step runs next." },
      { key: "profiler", label: "Repository profile", detail: "Reads a repository and writes its profile." },
      { key: "ops", label: "Operations", detail: "Watches deployed work." },
    ],
  },
];

const STEP_KEYS = new Set(PHASES.flatMap((p) => p.steps.map((s) => s.key)));
const PHASE_KEYS = new Set(PHASES.map((p) => `phase:${p.id}`));
const PHASE_OF = new Map(PHASES.flatMap((p) => p.steps.map((s) => [s.key, `phase:${p.id}`] as const)));

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;
export const MAX_CHAIN = 4;

/** A chains object from a request: phases (`phase:<id>`) and steps only, each a short list of plausible model ids. */
export function checkChains(raw: unknown): { chains: Record<string, string[]> } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "chains must be an object of phase to models." };
  const chains: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STEP_KEYS.has(key) && !PHASE_KEYS.has(key)) return { error: `There is no phase called "${key}".` };
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { error: `${key}: give a list of model ids.` };
    const list = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
    if (list.length > MAX_CHAIN) return { error: `${key}: at most ${MAX_CHAIN} models.` };
    const bad = list.find((m) => !MODEL_ID.test(m));
    if (bad) return { error: `"${bad}" is not a model id.` };
    if (list.length > 0) chains[key] = list;
  }
  return { chains };
}

/**
 * Each step's chain, by role name, from the org's and a project's settings:
 * project step, project phase, org step, org phase — the first that is set.
 * A step none of them sets is left out (the repo's file decides).
 */
export function expandChains(org: Record<string, string[]>, project: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const step of STEP_KEYS) {
    const phase = PHASE_OF.get(step)!;
    const chain = project[step] ?? project[phase] ?? org[step] ?? org[phase];
    if (chain?.length) out[step] = chain;
  }
  return out;
}

/** The chains for an org and (optionally) one of its projects, by role name. */
export async function chainsFor(deps: AppDeps, orgId: string, projectId: string | null): Promise<Record<string, string[]>> {
  const scopes = projectId ? ["org", projectId] : ["org"];
  const rows = await deps.dbh.db
    .select({ scope: modelSettings.scope, chains: modelSettings.chains })
    .from(modelSettings)
    .where(and(eq(modelSettings.orgId, orgId), inArray(modelSettings.scope, scopes)));
  const org = rows.find((r) => r.scope === "org")?.chains ?? {};
  const project = projectId ? (rows.find((r) => r.scope === projectId)?.chains ?? {}) : {};
  return expandChains(org, project);
}

/** The chains for a repository, by its full name — what the orchestrator asks for. Null when Compass does not know it. */
export async function chainsForRepo(deps: AppDeps, fullName: string): Promise<Record<string, string[]> | null> {
  const repo = (await deps.dbh.db.select({ orgId: repos.orgId, projectId: repos.projectId }).from(repos).where(eq(repos.fullName, fullName)).limit(1))[0];
  if (!repo) return null;
  return chainsFor(deps, repo.orgId, repo.projectId);
}

/** The chain an ask runs on, or undefined to leave it to the repo's file and the factory's default. */
export async function askModels(deps: AppDeps, orgId: string, projectId: string | null, step: "shape" | "investigate" | "ask"): Promise<string[] | undefined> {
  return (await chainsFor(deps, orgId, projectId))[step];
}

/** askModels for a repository by id: its project's chain, else the org's. */
export async function askModelsForRepo(deps: AppDeps, orgId: string, repoId: string | null, step: "ask"): Promise<string[] | undefined> {
  const projectId = repoId
    ? ((await deps.dbh.db.select({ projectId: repos.projectId }).from(repos).where(eq(repos.id, repoId)).limit(1))[0]?.projectId ?? null)
    : null;
  return askModels(deps, orgId, projectId, step);
}
