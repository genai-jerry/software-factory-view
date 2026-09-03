import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicWorkspace } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { TasksTab } = await import("./EpicWorkspace.js");

/**
 * System test cases in the task board (FACTORY.md §4b).
 *
 * Two invariants: a case never appears among the code tasks (a case in a
 * task column reads as work the factory owes, and it inflates every count a
 * reader takes from the board), and the only control it offers is a verdict
 * — no start button, ever.
 */

const step = { who: "the testers", how: "Run it and record what you saw.", startRole: null, startLabel: null, waitsOnPerson: true, automatic: false };

const task = {
  id: "task-1", number: 1, title: "task(9): schema", kind: "task", caseId: null,
  state: "factory:on-epic", open: true, htmlUrl: "https://gh/1", blockedBy: [], blocks: [],
  startStatus: "none" as const, approvable: false,
  nextStep: { ...step, who: "the rest of the epic", waitsOnPerson: false },
};

const runnableCase = {
  id: "case-4", number: 30, title: "test(9): ST-4 Renewal reminder fires", kind: "test", caseId: "ST-4",
  state: "factory:manual-test", open: true, htmlUrl: "https://gh/30", blockedBy: [], blocks: [],
  startStatus: "none" as const, approvable: false, nextStep: step,
};

const pendingCase = { ...runnableCase, id: "case-5", number: 31, title: "test(9): ST-5 Refund path", caseId: "ST-5", state: null };
const failedCase = { ...runnableCase, id: "case-6", number: 32, title: "test(9): ST-6 Invalid card", caseId: "ST-6", state: "factory:test-failed" };
const passedCase = { ...runnableCase, id: "case-7", number: 33, title: "test(9): ST-7 Happy path", caseId: "ST-7", state: "factory:test-passed", open: false };

function workspace(tasks: EpicWorkspace["tasks"]): EpicWorkspace {
  return {
    epic: {
      id: "epic-9", number: 9, repo: "acme/app", title: "Renewals", bodyHtml: "", state: "factory:design-approved",
      open: true, author: "alice", htmlUrl: "https://gh/9", labels: [], status: "Assembled · waiting on 2 tests",
      nextStep: { who: "the factory", how: "Nothing to do.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
    },
    repo: { id: "repo-1", fullName: "acme/app", defaultBranch: "main" },
    pipeline: [], gate: null,
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks,
    rollup: { total: 1, ready: 0, inReview: 0, inTest: 0, shipping: 1, done: 0, blocked: 0, waiting: 0, inFlight: 1 },
    blockedSubIssues: [], change: null, artifacts: [], threads: [],
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "github-actions", githubActionsEnabled: true, canStart: false },
  } as unknown as EpicWorkspace;
}

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe("cases are grouped apart from code tasks", () => {
  it("gives them their own heading with the pass count", () => {
    renderIn(<TasksTab data={workspace([task, runnableCase, passedCase])} />);
    expect(screen.getByText(/System tests \(1\/2 passed\)/)).toBeTruthy();
  });

  it("never offers a start control on a case", () => {
    renderIn(<TasksTab data={workspace([runnableCase])} />);
    // The board's start vocabulary belongs to tasks. A case takes a verdict.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fail" })).toBeTruthy();
  });

  it("shows a case that is not runnable yet without buttons", () => {
    renderIn(<TasksTab data={workspace([pendingCase])} />);
    // The banner and the group heading both say it; either is enough.
    expect(screen.getAllByText(/not runnable yet/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
  });

  it("shows a failed case without offering a second verdict", () => {
    renderIn(<TasksTab data={workspace([failedCase])} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
  });

  it("renders nothing at all for an epic with no cases", () => {
    renderIn(<TasksTab data={workspace([task])} />);
    expect(screen.queryByText(/System tests/)).toBeNull();
  });
});

describe("recording a verdict", () => {
  it("confirms first, then posts the verdict with the evidence", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as never);
    renderIn(<TasksTab data={workspace([runnableCase])} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Evidence for ST-4"), "reminder arrived at 09:00");
    await user.click(screen.getByRole("button", { name: "Pass" }));
    // The consequence is spelled out before anything is posted.
    expect(screen.getByText(/Record ST-4 as passed\? It closes the case\./)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/issues/case-4/test-verdict", {
        verdict: "passed",
        evidence: "reminder arrived at 09:00",
      }),
    );
  });

  it("says what a failure will do before it does it", async () => {
    renderIn(<TasksTab data={workspace([runnableCase])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Fail" }));
    expect(screen.getByText(/files a task to fix it/)).toBeTruthy();
  });

  it("can be cancelled without posting", async () => {
    renderIn(<TasksTab data={workspace([runnableCase])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pass" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
  });
});
