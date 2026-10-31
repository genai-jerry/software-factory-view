import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicWorkspace } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { ClarifyBoard, DesignBoard } = await import("./PlanBoards.js");

/**
 * Clarify (board 4) and Design (board 5) read the proposal and the design
 * and show them as items to agree on. Pinned: the items come from the
 * documents, a comment names its item, and Approve is the gate's route.
 */

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const nextStep: EpicWorkspace["epic"]["nextStep"] = { who: "", how: "", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false };

function epic(state: string): EpicWorkspace {
  return {
    epic: { id: "e1", number: 35, title: "Day-wise calling performance", bodyHtml: "", state, open: true, author: "jerry", htmlUrl: "", labels: [], status: null, nextStep },
    repo: { id: "r", fullName: "genai-jerry/beacon-api", defaultBranch: "main" },
    pipeline: [],
    gate: { gate: "spec", label: "G1", amApprover: true, approvers: ["jerry"] },
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks: [],
    rollup: { total: 0, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0 },
    blockedSubIssues: [],
    change: { id: "c", slug: "35-daywise", status: "open" },
    artifacts: [
      { id: "a1", kind: "proposal", path: "openspec/changes/35/proposal.md", latestSha: "x", mergedSha: null, diverged: false },
      { id: "a2", kind: "spec", path: "openspec/changes/35/specs/a/spec.md", latestSha: "x", mergedSha: null, diverged: false },
      { id: "a3", kind: "design", path: "openspec/changes/35/design.md", latestSha: "x", mergedSha: null, diverged: false },
    ],
    threads: [],
    bugs: { enabled: true, rows: [], report: { offered: false, reason: null } },
    systemTests: { enabled: true, mode: "gate", planned: false, plan: null, planTests: { offered: false, reason: null } },
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
  };
}

const PROPOSAL = `# Day-wise

## Problem

Setters add up each day's calls by hand.

## Interpretations taken (correct these at gate G1 if wrong)

- **"Day-wise"** groups appointments by the day the appointment falls on.
- **Window**: default the last 30 days.
`;
const SPEC = `# Spec

#### Scenario: A quiet day still appears
#### Scenario: Test calls excluded
`;
const DESIGN = `# Design

## Reuse

The funnel's day rule is reused.

## Task 1 — compute counts (#62)

Body.
`;

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.includes("proposal.md")) return { markdown: PROPOSAL };
    if (path.includes("spec.md")) return { markdown: SPEC };
    if (path.includes("design.md")) return { markdown: DESIGN };
    if (path.endsWith("/gate")) return { amApprover: true, approvers: ["jerry"], openQuestions: [] };
    return {};
  });
});

describe("ClarifyBoard", () => {
  it("shows the interpretations as items and the scenarios as checks", async () => {
    renderIn(<ClarifyBoard data={epic("factory:spec-ready")} />);
    expect(await screen.findByText('"Day-wise" groups appointments by the day the appointment falls on.')).toBeInTheDocument();
    expect(screen.getByText("Setters add up each day's calls by hand.")).toBeInTheDocument();
    expect(await screen.findByText("A quiet day still appears")).toBeInTheDocument();
  });

  it("posts a comment that names its item, and approves through the gate", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderIn(<ClarifyBoard data={epic("factory:spec-ready")} />);
    await screen.findByText(/Window.*default the last 30 days/);
    await userEvent.click(screen.getAllByRole("button", { name: "Comment" })[1]!);
    await userEvent.type(screen.getByLabelText("Your comment on item 2"), "Can we do 14 days first?");
    await userEvent.click(screen.getByRole("button", { name: "Post" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/issues/e1/reply", { body: expect.stringMatching(/^On item 2 \(Window: default the last 30 days\.\):\n\nCan we do 14 days first\?$/) }));
    await userEvent.click(screen.getByRole("button", { name: "Approve the plan" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/epics/e1/gate/approve", { acknowledgeOpenQuestions: false }));
  });
});

describe("DesignBoard", () => {
  it("numbers the decisions and lists the build order", async () => {
    renderIn(<DesignBoard data={epic("factory:design-ready")} />);
    expect(await screen.findByText("Reuse")).toBeInTheDocument();
    expect(screen.getByText("D1")).toBeInTheDocument();
    expect(screen.getByText("compute counts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve the design" })).toBeInTheDocument();
  });
});
