import { describe, expect, it } from "vitest";
import {
  factoryRunIsPending,
  factoryStartLabel,
  githubActionsEnabled,
  isAgentSecretName,
  isConsoleOrchestrator,
  normalizeConsoleOrchestrator,
  parseRepoOrchestratorEngine,
  repoEngineName,
  repoHasFactoryEngine,
} from "../src/orchestrator.js";

describe("console orchestrator choice", () => {
  it("defaults to GitHub Actions", () => {
    expect(normalizeConsoleOrchestrator(undefined)).toBe("github-actions");
    expect(normalizeConsoleOrchestrator("nope")).toBe("github-actions");
    expect(githubActionsEnabled(null)).toBe(true);
    expect(githubActionsEnabled("software-factory")).toBe(false);
  });

  it("accepts only the two Console engines", () => {
    expect(isConsoleOrchestrator("github-actions")).toBe(true);
    expect(isConsoleOrchestrator("software-factory")).toBe(true);
    expect(isConsoleOrchestrator("langgraph")).toBe(false);
  });

  it("maps Console software-factory to the repo's langgraph claim", () => {
    expect(repoEngineName("software-factory")).toBe("langgraph");
    expect(repoEngineName("github-actions")).toBe("github-actions");
  });
});

describe("repo factory-orchestrator.json", () => {
  it("treats absent or unparseable files as GitHub Actions", () => {
    expect(parseRepoOrchestratorEngine(null)).toBe("github-actions");
    expect(parseRepoOrchestratorEngine("{not json")).toBe("github-actions");
    expect(parseRepoOrchestratorEngine(JSON.stringify({ engine: "github-actions" }))).toBe("github-actions");
  });

  it("claims the Software Factory orchestrator only when engine is langgraph", () => {
    expect(parseRepoOrchestratorEngine(JSON.stringify({ engine: "langgraph" }))).toBe("langgraph");
  });

  it("enables the factory with a workflow stub or a langgraph claim", () => {
    expect(repoHasFactoryEngine({ hasWorkflowStub: true, orchestratorFile: null })).toBe(true);
    expect(
      repoHasFactoryEngine({
        hasWorkflowStub: false,
        orchestratorFile: JSON.stringify({ engine: "langgraph" }),
      }),
    ).toBe(true);
    expect(repoHasFactoryEngine({ hasWorkflowStub: false, orchestratorFile: null })).toBe(false);
  });

  it("allow-lists agent secret names", () => {
    expect(isAgentSecretName("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isAgentSecretName("NOT_A_SECRET")).toBe(false);
  });

  it("treats idle fast-track and intake as waiting on the factory", () => {
    expect(factoryRunIsPending({ open: true, labels: ["factory:fast-track"] })).toBe(true);
    expect(factoryRunIsPending({ open: true, labels: ["factory:intake"] })).toBe(true);
    expect(factoryRunIsPending({ open: true, labels: ["factory:fast-track", "factory:in-progress"] })).toBe(false);
    expect(factoryRunIsPending({ open: false, labels: ["factory:fast-track"] })).toBe(false);
    expect(factoryStartLabel(["factory:intake", "factory:fast-track"])).toBe("factory:fast-track");
  });

  it("stops calling a design-approved epic un-started once its tasks are moving", () => {
    // The Dispatcher leaves factory:design-approved exactly where it is, so
    // the label says "waiting" for the epic's whole build. An epic with eight
    // tasks in flight is not waiting on the orchestrator to begin.
    const building = ["factory:design-approved"];
    expect(factoryRunIsPending({ open: true, labels: building })).toBe(true);
    expect(factoryRunIsPending({ open: true, labels: building, started: false })).toBe(true);
    expect(factoryRunIsPending({ open: true, labels: building, started: true })).toBe(false);
  });
});
