import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { FactoryHandoffPanel } from "./FactoryHandoffPanel.js";
import type { EpicWorkspace, FactoryHandoff } from "../types.js";

function handoff(over: Partial<FactoryHandoff> = {}): FactoryHandoff {
  return {
    engine: "software-factory",
    githubActionsEnabled: false,
    status: "waiting",
    headline: "Nothing has run on this issue — the fast lane has not been started.",
    detail: "GitHub delivers this repo's webhooks to the Console.",
    nextStep: "Start factory run — this runs the fast lane.",
    canStart: true,
    canClearMarker: false,
    startsRole: { label: "factory:fast-track", role: "fasttrack", human: "fast lane" },
    run: null,
    runsError: null,
    ...over,
  };
}

function workspace(h: FactoryHandoff): EpicWorkspace {
  return {
    epic: {
      id: "epic-1",
      number: 220,
      title: "Recent calls newest first",
      bodyHtml: "",
      state: "factory:fast-track",
      open: true,
      author: "genai-jerry",
      htmlUrl: "https://github.com/acme/api/issues/220",
      labels: ["factory:fast-track"],
    },
    repo: { id: "repo-1", fullName: "acme/api", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    tasks: [],
    rollup: { total: 0, ready: 0, inReview: 0, inTest: 0, done: 0, blocked: 0, waiting: 0 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [],
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: true, handoff: h },
  } as EpicWorkspace;
}

function renderPanel(h: FactoryHandoff) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FactoryHandoffPanel data={workspace(h)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FactoryHandoffPanel", () => {
  it("names the role the start button will run", () => {
    renderPanel(handoff());
    expect(screen.getByText(/the fast lane has not been started/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start the fast lane" })).toBeInTheDocument();
  });

  it("offers to clear a stuck marker instead of a start button", () => {
    renderPanel(
      handoff({
        status: "stalled",
        headline: "The intake run has been in progress for 4h — past the 50-minute role timeout.",
        canStart: false,
        canClearMarker: true,
        nextStep: "Clear the stuck marker, then start the run again.",
      }),
    );
    expect(screen.getByRole("button", { name: "Clear the stuck marker" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
    expect(screen.getByText(/4h/)).toBeInTheDocument();
  });

  it("explains a missing orchestrator instead of offering a button that cannot work", () => {
    renderPanel(
      handoff({
        status: "not-configured",
        headline: "The Console cannot reach the Software Factory orchestrator.",
        detail: "ORCHESTRATOR_URL is not set.",
        canStart: false,
      }),
    );
    expect(screen.getByText(/ORCHESTRATOR_URL is not set\./)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays out of the way while a run is genuinely live", () => {
    const { container } = renderPanel(handoff({ status: "running", canStart: false }));
    expect(container).toBeEmptyDOMElement();
  });
});
