/**
 * Which motor drives factory roles. The Console stores the choice per org;
 * repos materialise it as `.github/factory-orchestrator.json` (`engine`:
 * `github-actions` or `langgraph`). A missing or unparseable file means
 * GitHub Actions, matching FACTORY.md §2e.
 */

export const CONSOLE_ORCHESTRATORS = ["github-actions", "software-factory"] as const;
export type ConsoleOrchestrator = (typeof CONSOLE_ORCHESTRATORS)[number];

export function isConsoleOrchestrator(value: unknown): value is ConsoleOrchestrator {
  return value === "github-actions" || value === "software-factory";
}

export function normalizeConsoleOrchestrator(value: string | null | undefined): ConsoleOrchestrator {
  return value === "software-factory" ? "software-factory" : "github-actions";
}

/** False when the org chose the Software Factory orchestrator — Actions must not be used. */
export function githubActionsEnabled(engine: string | null | undefined): boolean {
  return normalizeConsoleOrchestrator(engine) === "github-actions";
}

/** Value written to `.github/factory-orchestrator.json` `engine`. */
export function repoEngineName(consoleEngine: string | null | undefined): "github-actions" | "langgraph" {
  return githubActionsEnabled(consoleEngine) ? "github-actions" : "langgraph";
}

export function parseRepoOrchestratorEngine(content: string | null | undefined): "github-actions" | "langgraph" {
  if (!content) return "github-actions";
  try {
    const parsed = JSON.parse(content) as { engine?: unknown };
    return parsed.engine === "langgraph" ? "langgraph" : "github-actions";
  } catch {
    return "github-actions";
  }
}

export function repoDrivenByFactoryOrchestrator(content: string | null | undefined): boolean {
  return parseRepoOrchestratorEngine(content) === "langgraph";
}

/**
 * Labels that start a factory role when applied (or, for intake, when the
 * issue is opened). An open issue carrying one of these, without
 * `factory:in-progress`, is waiting on the orchestrator.
 */
export const FACTORY_AUTO_START_LABELS = [
  "factory:fast-track",
  "factory:profile",
  "factory:spec-approved",
  "factory:design-approved",
  "factory:release-approved",
] as const;

export function factoryStartLabel(labels: readonly string[]): (typeof FACTORY_AUTO_START_LABELS)[number] | null {
  for (const name of FACTORY_AUTO_START_LABELS) {
    if (labels.includes(name)) return name;
  }
  return null;
}

export function factoryRunIsPending(opts: {
  open: boolean;
  labels: readonly string[];
  /**
   * Whether the run this label would start has visibly already happened.
   *
   * `factory:design-approved` is not a moment but a whole stage: it sits on
   * an epic from gate G2 until the day it ships. Without this the epic reads
   * as "the orchestrator has not started the factory yet" for that entire
   * build — under a task board showing eight of them in flight — and the
   * button offers to start a run that has long since run. The caller
   * supplies the fact that settles it (for an epic: the Dispatcher has
   * released tasks), because the label alone cannot.
   */
  started?: boolean;
}): boolean {
  if (!opts.open) return false;
  if (opts.labels.includes("factory:in-progress")) return false;
  if (opts.started) return false;
  if (factoryStartLabel(opts.labels)) return true;
  return opts.labels.includes("factory:intake");
}

/**
 * A repo can run factory roles when GitHub Actions has a caller stub, or when
 * it has claimed the Software Factory orchestrator. Profile-on-disk plus one
 * of those is what `factoryEnabled` means.
 */
export function repoHasFactoryEngine(opts: {
  hasWorkflowStub: boolean;
  orchestratorFile: string | null | undefined;
}): boolean {
  if (repoDrivenByFactoryOrchestrator(opts.orchestratorFile)) return true;
  return opts.hasWorkflowStub;
}

export const AGENT_SECRET_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_CROSS_REPO_TOKEN"] as const;
export type AgentSecretName = (typeof AGENT_SECRET_NAMES)[number];

export function isAgentSecretName(value: unknown): value is AgentSecretName {
  return typeof value === "string" && (AGENT_SECRET_NAMES as readonly string[]).includes(value);
}
