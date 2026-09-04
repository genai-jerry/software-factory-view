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
  kind: "task",
  caseId: null,
  state: "factory:ready",
  open: true,
  htmlUrl: "https://github.com/acme/app/issues/198",
  blockedBy: [],
  blocks: [],
  startStatus: "awaiting" as const,
  approvable: true,
  nextStep: {
    who: "the implementation approvers — any collaborator",
    how: "Approve to start the Implementer on this task.",
    startRole: null,
    startLabel: null,
    waitsOnPerson: true,
    automatic: false,
  },
};

const waitingTask = {
  ...readyTask,
  id: "task-199",
  number: 199,
  title: "Single Appointment column",
  state: null,
  startStatus: "none" as const,
  approvable: false,
  nextStep: { who: "the factory", how: "Nothing to do.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
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
      status: "Building 0/2",
      nextStep: { who: "the factory", how: "Nothing to do.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
    },
    repo: { id: "repo-1", fullName: "acme/app", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks: [readyTask, waitingTask],
    rollup: { total: 2, ready: 1, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 1, inFlight: 0 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [
      { id: "thread-1", topicKind: "task", topicRef: "task/198", title: "Task #198", status: "open", entryCount: 1 },
      { id: "thread-2", topicKind: "task", topicRef: "task/199", title: "Task #199", status: "open", entryCount: 1 },
    ],
    bugs: { enabled: null, rows: [], report: { offered: false, reason: null } },
    systemTests: { enabled: null, mode: null, planned: false, plan: null, planTests: { offered: false, reason: null } },
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
    rollup: { total: 2, ready: 1, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 1, inFlight: 0 },
    status: "Building 0/2",
    nextStep: { who: "its tasks", how: "Building — 0 of 2 tasks done.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
    gate: null,
    expedited: false,
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
      startStatus: "awaiting",
      approvable: true,
      nextStep: {
    who: "the implementation approvers — any collaborator",
    how: "Approve to start the Implementer on this task.",
    startRole: null,
    startLabel: null,
    waitsOnPerson: true,
    automatic: false,
  },
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

  it("the top-of-workspace prompt counts only tasks that still take an approval", () => {
    renderIn(<TasksTab data={workspace()} />);
    expect(screen.getByText(/1 task ready to build/)).toBeTruthy();
  });

  it("offers the button again when an approval went unrouted", async () => {
    const stalled = { ...readyTask, startStatus: "stalled" as const, approvable: true };
    renderIn(<TasksTab data={workspace({ tasks: [stalled, waitingTask] })} />);
    expect(screen.getByText(/no implementer started/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(api.post).toHaveBeenCalledWith("/api/issues/task-198/approve");
  });

  it("reports a refused approval beside the button that was pressed", async () => {
    const { ApiError } = await import("../api.js");
    renderIn(<TasksTab data={workspace()} />);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "starting implementers is assigned to: bob"));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText(/assigned to: bob/)).toBeTruthy());
  });
});

/**
 * The bug this suite grew for: `factory:ready` stays on the task while the
 * approval is routed and while the implementer runs, so the Console kept
 * offering Approve on a task that had already been approved — a second press
 * posts a second `Approved`, and the router starts a second implementer.
 */
describe("an approved task stops asking to be approved", () => {
  const approved = { ...readyTask, startStatus: "approved" as const, approvable: false };
  const running = { ...readyTask, startStatus: "running" as const, approvable: false };

  it("the Tasks tab says the factory has it, with no button", () => {
    renderIn(<TasksTab data={workspace({ tasks: [approved, waitingTask] })} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    // Filed under what it is waiting for — the factory, not a person.
    expect(screen.getByText("Building (1)")).toBeTruthy();
    expect(screen.queryByText(/^Ready \(/)).toBeNull();
    expect(screen.getAllByText(/Approved — starting/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/ready to build —/)).toBeNull();
  });

  it("the Tasks tab names a live implementer instead of the start gate", () => {
    renderIn(<TasksTab data={workspace({ tasks: [running, waitingTask] })} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getAllByText(/Implementer running/).length).toBeGreaterThan(0);
    expect(screen.getByText(/working on #198 now/)).toBeTruthy();
  });

  it("the Tree tab drops the button on the same task", async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.endsWith("/tree")) {
        return Promise.resolve({
          ...tree,
          nodes: [{ ...tree.nodes[0]!, startStatus: "running", approvable: false }],
        } as never);
      }
      return Promise.resolve({} as never);
    });
    renderIn(<DependencyTreeTab epicId="epic-250" onOpenGate={() => {}} />);
    expect((await screen.findAllByText(/Implementer running/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("a task thread badges the run instead of offering Approve", () => {
    renderIn(<ThreadsTab data={workspace({ tasks: [running, waitingTask] })} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Implementer running")).toBeTruthy();
  });
});

/**
 * The complaint this came from: a task at `factory:in-review` showed a badge
 * and a Comment button, and nothing said the pipeline was waiting for a human
 * to start the Reviewer. A state is not an instruction.
 */
describe("every card says what is expected next", () => {
  const reviewStep = {
    who: "you, then the Reviewer",
    how: "This state starts nothing on its own. Start the Reviewer: it reads the draft PR and moves the task to In test.",
    startRole: "reviewer" as const,
    startLabel: "Start the Reviewer",
    waitsOnPerson: true,
    automatic: false,
  };
  const inReview = {
    ...readyTask,
    state: "factory:in-review",
    startStatus: "none" as const,
    approvable: false,
    nextStep: reviewStep,
  };

  it("the Tasks tab names the next actor and offers the role they must start", async () => {
    renderIn(<TasksTab data={workspace({ tasks: [inReview, waitingTask] })} />);
    expect(screen.getByText(/Next: you, then the Reviewer/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start the Reviewer" }));
    expect(api.post).toHaveBeenCalledWith("/api/issues/task-198/start-role", { role: "reviewer" });
  });

  it("offers no start button where the factory is the one working", () => {
    const intake = {
      ...readyTask,
      state: "factory:intake",
      startStatus: "none" as const,
      approvable: false,
      nextStep: { who: "the factory", how: "The Intake Analyst is drafting the spec.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
    };
    renderIn(<TasksTab data={workspace({ tasks: [intake] })} />);
    expect(screen.getByText(/Next: the factory/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
  });

  it("reports a refused start beside the button that was pressed", async () => {
    const { ApiError } = await import("../api.js");
    renderIn(<TasksTab data={workspace({ tasks: [inReview] })} />);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(409, "a factory run is already live on #198"));
    await userEvent.click(screen.getByRole("button", { name: "Start the Reviewer" }));
    await waitFor(() => expect(screen.getByText(/already live on #198/)).toBeTruthy());
  });

  it("the Tree tab says the same thing on the same task", async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.endsWith("/tree")) {
        return Promise.resolve({
          ...tree,
          nodes: [{ ...tree.nodes[0]!, state: "factory:in-review", startStatus: "none", approvable: false, nextStep: reviewStep }],
        } as never);
      }
      return Promise.resolve({} as never);
    });
    renderIn(<DependencyTreeTab epicId="epic-250" onOpenGate={() => {}} />);
    expect(await screen.findByText(/Next: you, then the Reviewer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start the Reviewer" })).toBeTruthy();
  });
});
