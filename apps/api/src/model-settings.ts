import { modelSettings, repos } from "@console/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AppDeps } from "./context.js";

/**
 * Compass → Models: which Claude model each phase of the factory runs on.
 *
 * Each phase has a preference chain: the first model the factory's Claude
 * credential can reach wins, the rest are fallbacks. The org sets a chain, a
 * project may set its own for any phase, and a phase neither names falls back
 * to the repo's `.github/factory-models.json`, then the factory's default.
 *
 * Build phases reach the orchestrator through GET /api/orchestrator/models
 * (read on every run, so a change applies to the next one); Shape, Investigate
 * and the questions on a thread send their chain with the ask itself.
 */

export interface Phase {
  key: string;
  label: string;
  detail: string;
  group: "talk" | "build" | "support";
}

/** The phases a person can set, in the order the work goes through them. Keys are the orchestrator's role names. */
export const PHASES: Phase[] = [
  { key: "shape", label: "Shape", detail: "Talking an idea through and writing its requirement.", group: "talk" },
  { key: "investigate", label: "Investigate", detail: "A production problem: reading logs and code, and planning the fix.", group: "talk" },
  { key: "ask", label: "Questions", detail: "Ask on a thread, Telegram discussions, drafting replies, QA questions.", group: "talk" },
  { key: "intake", label: "Clarify", detail: "Reads new work and asks what is unclear.", group: "build" },
  { key: "planner", label: "Plan", detail: "Writes the spec and splits it into tasks.", group: "build" },
  { key: "architect", label: "Design", detail: "Writes the design and chooses how to build it.", group: "build" },
  { key: "testplanner", label: "Test plan", detail: "Plans the tests the work must pass.", group: "build" },
  { key: "implementer", label: "Build", detail: "Writes the code for each task.", group: "build" },
  { key: "reviewer", label: "Review", detail: "Reviews each pull request.", group: "build" },
  { key: "qa", label: "QA", detail: "Tests the built work on its environment.", group: "build" },
  { key: "fasttrack", label: "Fast lane", detail: "Small fixes, from issue to pull request in one run.", group: "build" },
  { key: "release", label: "Release", detail: "Puts approved work on staging and plans the promotion.", group: "build" },
  { key: "dispatch", label: "Dispatch", detail: "Decides which phase runs next.", group: "support" },
  { key: "scrum", label: "Release planning", detail: "Keeps the release tracker up to date.", group: "support" },
  { key: "profiler", label: "Repository profile", detail: "Reads a repository and writes its profile.", group: "support" },
  { key: "ops", label: "Operations", detail: "Watches deployed work.", group: "support" },
];

const KEYS = new Set(PHASES.map((p) => p.key));

/** Suggestions in the picker. Any model id the Claude CLI accepts can be typed. */
export const MODEL_CHOICES = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;
export const MAX_CHAIN = 4;

/** A chains object from a request: known phases only, each a short list of plausible model ids. */
export function checkChains(raw: unknown): { chains: Record<string, string[]> } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "chains must be an object of phase to models." };
  const chains: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.has(key)) return { error: `There is no phase called "${key}".` };
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return { error: `${key}: give a list of model ids.` };
    const list = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
    if (list.length > MAX_CHAIN) return { error: `${key}: at most ${MAX_CHAIN} models.` };
    const bad = list.find((m) => !MODEL_ID.test(m));
    if (bad) return { error: `"${bad}" is not a model id.` };
    if (list.length > 0) chains[key] = list;
  }
  return { chains };
}

/** The org's chains and a project's, merged: the project wins phase by phase. */
export async function chainsFor(deps: AppDeps, orgId: string, projectId: string | null): Promise<Record<string, string[]>> {
  const scopes = projectId ? ["org", projectId] : ["org"];
  const rows = await deps.dbh.db
    .select({ scope: modelSettings.scope, chains: modelSettings.chains })
    .from(modelSettings)
    .where(and(eq(modelSettings.orgId, orgId), inArray(modelSettings.scope, scopes)));
  const org = rows.find((r) => r.scope === "org")?.chains ?? {};
  const project = projectId ? (rows.find((r) => r.scope === projectId)?.chains ?? {}) : {};
  return { ...org, ...project };
}

/** The chains for a repository, by its full name — what the orchestrator asks for. Null when Compass does not know it. */
export async function chainsForRepo(deps: AppDeps, fullName: string): Promise<Record<string, string[]> | null> {
  const repo = (await deps.dbh.db.select({ orgId: repos.orgId, projectId: repos.projectId }).from(repos).where(eq(repos.fullName, fullName)).limit(1))[0];
  if (!repo) return null;
  return chainsFor(deps, repo.orgId, repo.projectId);
}

/** The chain an ask runs on, or undefined to leave it to the repo's file and the factory's default. */
export async function askModels(deps: AppDeps, orgId: string, projectId: string | null, phase: "shape" | "investigate" | "ask"): Promise<string[] | undefined> {
  const chains = await chainsFor(deps, orgId, projectId);
  return chains[phase] ?? (phase === "ask" ? undefined : chains.ask);
}

/** askModels for a repository by id: its project's chain, else the org's. */
export async function askModelsForRepo(deps: AppDeps, orgId: string, repoId: string | null, phase: "ask"): Promise<string[] | undefined> {
  const projectId = repoId
    ? ((await deps.dbh.db.select({ projectId: repos.projectId }).from(repos).where(eq(repos.id, repoId)).limit(1))[0]?.projectId ?? null)
    : null;
  return askModels(deps, orgId, projectId, phase);
}
