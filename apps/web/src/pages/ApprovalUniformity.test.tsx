import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicTree, EpicWorkspace, ThreadDetail } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { TasksTab, ThreadsTab } = await import("./EpicWorkspace.js");
const { DependencyTreeTab } = await import("./DependencyTree.js");

/**
 * A task at the start gate shows up in three tabs at once. Before this, only
 * the Tree carried a button — and it was called something else than the gate
 * panel's. These tests pin the invariant the fix is about: same word, same
 * call, every tab.
 */

const readyTask = {
  id: "task-198",
  number: 198,
  title: "Contact column: email below the name as a mailto link",
  state: "factory:ready",
  open: true,
  htmlUrl: "https://github.com/acme/app/issues/198",
  blockedBy: [],
  blocks: [],
  approvable: true,
};

const waitingTask = {
  ...readyTask,
  id: "task-199",
  number: 199,
  title: "Single Appointment column",
  state: null,
  approvable: false,
};

function workspace(overrides: Partial<EpicWorkspace> = {}): EpicWorkspace {
  return {
    epic: {
      id: "epic-250",
      number: 250,
      title: "Reorganise the opportunities list",
      bodyHtml: "",
      state: "factory:design-approved",
      open: true,
      author: "alice",
      htmlUrl: "https://github.com/acme/app/issues/250",
      labels: [],
    },
    repo: { id: "repo-1", fullName: "acme/app", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    startGate: { approvers: [], amApprover: true },
    tasks: [readyTask, waitingTask],
    rollup: { total: 2, ready: 1, inReview: 0, inTest: 0, done: 0, blocked: 0, waiting: 1 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [
      { id: "thread-1", topicKind: "task", topicRef: "task/198", title: "Task #198", status: "open", entryCount: 1 },
      { id: "thread-2", topicKind: "task", topicRef: "task/199", title: "Task #199", status: "open", entryCount: 1 },
    ],
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
    ...overrides,
  };
}

const tree: EpicTree = {
  epic: {
    id: "epic-250",
    number: 250,
    title: "Reorganise the opportunities list",
    state: "factory:design-approved",
    open: true,
    htmlUrl: "https://github.com/acme/app/issues/250",
    repo: "acme/app",
    gate: null,
  },
  startGate: { approvers: [], amApprover: true },
  nodes: [
    {
      id: "task-198",
      number: 198,
      title: readyTask.title,
      state: "factory:ready",
      open: true,
      htmlUrl: readyTask.htmlUrl,
      repo: "acme/app",
      crossRepo: false,
      assignees: [],
      blockedBy: [],
      blocks: [],
      waiting: false,
      agentHalted: false,
      approvable: true,
    },
  ],
};

const threadDetail: ThreadDetail = {
  id: "thread-1",
  epicIssueId: "epic-250",
  topicKind: "task",
  topicRef: "task/198",
  title: "Task #198",
  status: "open",
  entries: [
    {
      id: "entry-1",
      author: "genai-people-swfactory-console[bot]",
      isAgent: true,
      isApproval: false,
      source: "github",
      bodyHtml: "<p>Unblocked — an implementer can start.</p>",
      htmlUrl: "https://github.com/acme/app/issues/198#issuecomment-1",
      createdAt: new Date("2026-08-31T14:35:46Z").toISOString(),
    },
  ],
} as unknown as ThreadDetail;

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockImplementation((path: string) => {
    if (path.endsWith("/tree")) return Promise.resolve(tree as never);
    if (path.startsWith("/api/threads/")) return Promise.resolve(threadDetail as never);
    return Promise.resolve({} as never);
  });
  vi.mocked(api.post).mockReset().mockResolvedValue({ ok: true, commentUrl: "https://github.com/c/1" } as never);
});

describe("the start gate reads the same in every tab", () => {
  it("the Tasks tab offers Approve on a ready task", async () => {
    renderIn(<TasksTab data={workspace()} />);
    const button = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(button);
    expect(api.post).toHaveBeenCalledWith("/api/issues/task-198/approve");
  });

  it("the Tree tab offers the same Approve, not its own wording", async () => {
    renderIn(<DependencyTreeTab epicId="epic-250" onOpenGate={() => {}} />);
    const button = await screen.findByRole("button", { name: "Approve" });
    expect(screen.queryByText(/start implementer/)).toBeNull();
    await userEvent.click(button);
    expect(api.post).toHaveBeenCalledWith("/api/issues/task-198/approve");
  });

  it("a task thread offers Approve, and Resolve says it is only about the thread", async () => {
    renderIn(<ThreadsTab data={workspace()} />);
    // Collapsed, the ready task's thread already carries the button.
    const button = screen.getAllByRole("button", { name: "Approve" });
    expect(button).toHaveLength(1);
    await userEvent.click(button[0]!);
    expect(api.post).toHaveBeenCalledWith("/api/issues/task-198/approve");

    await userEvent.click(screen.getByText("Task #199"));
    const resolve = await screen.findByRole("button", { name: "Resolve thread" });
    expect(resolve.getAttribute("title")).toMatch(/does not approve/);
  });

  it("shows the approver list instead of a live button when the gate is not yours", async () => {
    renderIn(<TasksTab data={workspace({ startGate: { approvers: ["bob"], amApprover: false } })} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText(/waiting on @bob to approve/)).toBeTruthy();
  });

  it("reports a refused approval beside the button that was pressed", async () => {
    const { ApiError } = await import("../api.js");
    renderIn(<TasksTab data={workspace()} />);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "starting implementers is assigned to: bob"));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(/assigned to: bob/)).toBeTruthy());
  });
});
