import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { FactoryRunStatus } from "./FactoryRunStatus.js";
import type { EpicWorkspace } from "../types.js";

vi.mock("./OrchestratorRunView.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./OrchestratorRunView.js")>();
  return {
    ...actual,
    useLiveOrchestratorRun: vi.fn(() => ({
      data: {
        id: "run-abc",
        role: "intake",
        model: "claude-sonnet-4",
        outcome: "running",
        guards: { phase: "reading the repo" },
      },
      isLoading: false,
      isError: false,
    })),
    OrchestratorRunModal: () => null,
  };
});

function workspace(overrides: Partial<EpicWorkspace> = {}): EpicWorkspace {
  return {
    epic: {
      id: "epic-1",
      number: 42,
      title: "Test epic",
      bodyHtml: "",
      state: "factory:intake",
      open: true,
      author: "alice",
      htmlUrl: "https://github.com/acme/api/issues/42",
      labels: ["factory:in-progress"],
      status: null,
      nextStep: {
        who: "the factory",
        how: "The Intake Analyst is drafting the spec and will open its PR. Nothing to do.",
        startRole: null,
        startLabel: null,
        waitsOnPerson: false,
        automatic: false,
      },
    },
    repo: { id: "repo-1", fullName: "acme/api", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks: [],
    rollup: { total: 0, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [],
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
    ...overrides,
  };
}

function renderStatus(data: EpicWorkspace) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FactoryRunStatus data={data} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FactoryRunStatus", () => {
  it("renders nothing when the issue is not in progress", () => {
    const { container } = renderStatus(workspace({ epic: { ...workspace().epic, labels: ["factory:intake"] } }));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a GitHub Actions banner when the engine is github-actions", () => {
    renderStatus(
      workspace({
        orchestrator: { engine: "github-actions", githubActionsEnabled: true, canStart: false },
      }),
    );
    expect(screen.getByText(/Factory run in progress/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Watch on GitHub/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/issues/42",
    );
  });

  it("shows live orchestrator details for software-factory", () => {
    renderStatus(workspace());
    expect(screen.getByText(/intake running/i)).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4")).toBeInTheDocument();
    expect(screen.getByText(/reading the repo/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open run log/i })).toHaveAttribute("href", "/runs/run-abc");
  });
});
