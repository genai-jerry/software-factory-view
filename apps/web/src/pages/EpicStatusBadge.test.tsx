import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicTree } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { DependencyTreeTab } = await import("./DependencyTree.js");

/**
 * An epic carries `factory:design-approved` for the whole of its build —
 * FACTORY.md §3 reads it "Released for implementation", and the dispatcher's
 * re-dispatch guard is that label, so it cannot advance. The header rendered
 * the label name and so announced "Design approved" over an epic with four
 * tasks visibly building underneath it.
 *
 * The badge now shows what the API derived from the same rollup the Flow page
 * has been rendering all along; the raw state stays in the tooltip.
 */

const epic: EpicTree["epic"] = {
  id: "epic-250",
  number: 250,
  title: "Reorganise the opportunities list",
  state: "factory:design-approved",
  open: true,
  htmlUrl: "https://github.com/acme/app/issues/250",
  repo: "acme/app",
  gate: null,
  rollup: { total: 4, ready: 1, inReview: 1, inTest: 0, shipping: 0, done: 1, blocked: 0, waiting: 1 },
  status: "Building 1/4",
  nextStep: {
    who: "its tasks",
    how: "Building — 1 of 4 tasks done. Each one moves on its own card; the tabs below have them.",
    startRole: null,
    startLabel: null,
    waitsOnPerson: false,
  },
};

const node: EpicTree["nodes"][number] = {
  id: "task-199",
  number: 199,
  title: "Single Appointment column",
  state: "factory:ready",
  open: true,
  htmlUrl: "https://github.com/acme/app/issues/199",
  repo: "acme/app",
  crossRepo: false,
  assignees: [],
  blockedBy: [],
  blocks: [],
  waiting: false,
  agentHalted: false,
  startStatus: "running",
  approvable: false,
  nextStep: {
    who: "the Implementer",
    how: "An implementer is working on this now — nothing to approve.",
    startRole: null,
    startLabel: null,
    waitsOnPerson: false,
  },
};

function renderTree(tree: EpicTree) {
  vi.mocked(api.get).mockImplementation((path: string) =>
    path.endsWith("/tree") ? Promise.resolve(tree as never) : Promise.resolve({} as never),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DependencyTreeTab epicId="epic-250" onOpenGate={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe("the epic header badge", () => {
  it("reports the build, not the gate that released it", async () => {
    renderTree({ epic, startGate: { approvers: [], amApprover: true }, nodes: [node] });
    expect(await screen.findByText("Building 1/4")).toBeTruthy();
    expect(screen.queryByText("Design approved")).toBeNull();
  });

  it("keeps the raw factory state reachable, as the tooltip", async () => {
    renderTree({ epic, startGate: { approvers: [], amApprover: true }, nodes: [node] });
    expect((await screen.findByText("Building 1/4")).getAttribute("title")).toBe("factory:design-approved");
  });

  it("falls back to the label before the dispatcher has fanned the epic out", async () => {
    renderTree({
      epic: { ...epic, status: null, rollup: { ...epic.rollup, total: 0, ready: 0, inReview: 0, done: 0, waiting: 0 } },
      startGate: { approvers: [], amApprover: true },
      nodes: [node],
    });
    expect(await screen.findByText("Released to build")).toBeTruthy();
  });

  it("does not ask for an approval on a task an implementer is already running", async () => {
    renderTree({ epic, startGate: { approvers: [], amApprover: true }, nodes: [node] });
    expect(await screen.findByText(/An implementer is working on this now/)).toBeTruthy();
    expect(screen.queryByText(/Approve to start the Implementer/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
