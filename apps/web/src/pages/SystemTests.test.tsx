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
const { TestsTab } = await import("./SystemTests.js");
const { TasksTab } = await import("./EpicWorkspace.js");

/**
 * The Tests tab (FACTORY.md §4b).
 *
 * Three invariants: a case never appears among the code tasks (a case in a
 * task column reads as work the factory owes, and it inflates every count a
 * reader takes from the board), the only control a case offers is a verdict —
 * no start button, ever — and the Plan tests action appears exactly where the
 * factory would act on it.
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

const noTests: EpicWorkspace["systemTests"] = {
  enabled: true,
  mode: "gate",
  planned: false,
  plan: null,
  planTests: { offered: true, reason: null },
};

const noBugs: EpicWorkspace["bugs"] = {
  enabled: true,
  rows: [],
  report: { offered: true, reason: null },
};

const bugStep = {
  who: "the testers",
  how: "Re-run what you did when you found this.",
  startRole: null,
  startLabel: null,
  waitsOnPerson: true,
  automatic: false,
};

const retestBug = {
  id: "bug-41", number: 41, title: "bug(9): discount ignored at checkout",
  state: "factory:bug-retest", open: true, htmlUrl: "https://gh/41",
  fixes: [{ id: "task-42", number: 42, title: "task(9): fix bug #41", state: "factory:on-epic", open: false, htmlUrl: "https://gh/42" }],
  nextStep: bugStep,
};
const fixingBug = { ...retestBug, id: "bug-43", number: 43, title: "bug(9): totals off by a cent", state: "factory:bug-open" };
const verifiedBug = { ...retestBug, id: "bug-44", number: 44, state: "factory:bug-verified", open: false };

function workspace(
  tasks: EpicWorkspace["tasks"],
  systemTests: Partial<EpicWorkspace["systemTests"]> = {},
  bugs: Partial<EpicWorkspace["bugs"]> = {},
): EpicWorkspace {
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
    systemTests: {
      ...noTests,
      // An epic with cases has a plan, and the action is not offered on one.
      ...(tasks.some((t) => t.kind === "test")
        ? { planned: true, planTests: { offered: false, reason: "This epic already has a test plan." } }
        : {}),
      ...systemTests,
    },
    bugs: { ...noBugs, ...bugs },
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "github-actions", githubActionsEnabled: true, canStart: false },
  } as unknown as EpicWorkspace;
}

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe("cases live on their own tab, not among the code tasks", () => {
  it("lists them with the pass count", () => {
    renderIn(<TestsTab data={workspace([task, runnableCase, passedCase])} />);
    expect(screen.getByText(/System tests \(1\/2 passed\)/)).toBeTruthy();
  });

  it("never offers a start control on a case", () => {
    renderIn(<TestsTab data={workspace([runnableCase])} />);
    // The board's start vocabulary belongs to tasks. A case takes a verdict.
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fail" })).toBeTruthy();
  });

  it("shows a case that is not runnable yet without buttons", () => {
    renderIn(<TestsTab data={workspace([pendingCase])} />);
    // The banner and the group heading both say it; either is enough.
    expect(screen.getAllByText(/not runnable yet/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
  });

  it("shows a failed case without offering a second verdict", () => {
    renderIn(<TestsTab data={workspace([failedCase])} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
  });

  it("keeps the task board free of cases, and says where they went", () => {
    renderIn(<TasksTab data={workspace([task, runnableCase, passedCase])} />);
    // No case row, no verdict control — just the count and the way over.
    expect(screen.queryByText(/ST-4/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
    expect(screen.getByText(/2 system tests on this epic, 1 passed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open the Tests tab/ })).toBeTruthy();
  });

  it("says nothing about tests on the board of an epic that has none", () => {
    renderIn(<TasksTab data={workspace([task])} />);
    expect(screen.queryByText(/system test/i)).toBeNull();
  });
});

describe("recording a verdict", () => {
  it("confirms first, then posts the verdict with the evidence", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as never);
    renderIn(<TestsTab data={workspace([runnableCase])} />);
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
    renderIn(<TestsTab data={workspace([runnableCase])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Fail" }));
    expect(screen.getByText(/files a task to fix it/)).toBeTruthy();
  });

  it("can be cancelled without posting", async () => {
    renderIn(<TestsTab data={workspace([runnableCase])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pass" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
  });
});

describe("asking for a plan", () => {
  it("offers Plan tests on an epic that has none", () => {
    renderIn(<TestsTab data={workspace([task])} />);
    expect(screen.getByRole("button", { name: "Plan tests" })).toBeTruthy();
    expect(screen.getByText(/No test plan on this epic yet/)).toBeTruthy();
  });

  it("confirms what it will do, then posts", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true } as never);
    renderIn(<TestsTab data={workspace([task])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Plan tests" }));
    // Nothing is posted on the first click: this starts an agent.
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/Ask the Test Planner for a plan\?/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/epics/epic-9/plan-tests", {}));
  });

  it("can be cancelled without posting", async () => {
    renderIn(<TestsTab data={workspace([task])} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Plan tests" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Plan tests" })).toBeTruthy();
  });

  it("does not offer it beside a plan the epic already has", () => {
    renderIn(<TestsTab data={workspace([runnableCase])} />);
    expect(screen.queryByRole("button", { name: "Plan tests" })).toBeNull();
  });

  it("says why instead, where the factory would refuse", () => {
    renderIn(
      <TestsTab
        data={workspace([task], {
          planTests: { offered: false, reason: "A test plan needs the task breakdown, which arrives with the Planner." },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Plan tests" })).toBeNull();
    expect(screen.getByText(/arrives with the Planner/)).toBeTruthy();
  });

  it("says the repository runs no system tests, and offers nothing", () => {
    renderIn(
      <TestsTab
        data={workspace([task], {
          enabled: false,
          planTests: { offered: false, reason: "System tests are off in this repository." },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Plan tests" })).toBeNull();
    expect(screen.getByText(/System tests are off in/)).toBeTruthy();
  });

  it("says an unmerged plan is why the cases are not runnable", () => {
    renderIn(
      <TestsTab
        data={workspace([pendingCase], { plan: { path: "openspec/changes/9-x/system-tests/test-plan.md", merged: false } })}
      />,
    );
    expect(screen.getByText(/written but not merged yet/)).toBeTruthy();
  });
});

/**
 * Bugs (FACTORY.md §4c). A report is not a case and not a task: it never
 * offers a start, it appears on neither the board nor the case list, and the
 * only control it ever offers is the re-test verdict — and only once the fix
 * the factory filed for it is assembled.
 */
describe("bugs raised in testing", () => {
  it("groups reports by what they are waiting for", () => {
    renderIn(<TestsTab data={workspace([task], {}, { rows: [retestBug, fixingBug, verifiedBug] })} />);
    expect(screen.getByText(/Bugs \(1\/3 verified\)/)).toBeTruthy();
    expect(screen.getByText(/Ready to re-test \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Being fixed \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Verified \(1\)/)).toBeTruthy();
  });

  it("offers the verdict only on a bug whose fix is assembled", () => {
    renderIn(<TestsTab data={workspace([task], {}, { rows: [fixingBug] })} />);
    expect(screen.queryByRole("button", { name: "Pass" })).toBeNull();
    renderIn(<TestsTab data={workspace([task], {}, { rows: [retestBug] })} />);
    expect(screen.getByRole("button", { name: "Pass" })).toBeTruthy();
  });

  it("never offers a start control on a report", () => {
    renderIn(<TestsTab data={workspace([task], {}, { rows: [fixingBug] })} />);
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("posts the title and the report as one comment", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderIn(<TestsTab data={workspace([task])} />);
    await userEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    await userEvent.type(screen.getByLabelText("Bug title"), "discount ignored");
    await userEvent.type(screen.getByLabelText("Bug report"), "Saw 100.00, expected 90.00");
    await userEvent.click(screen.getByRole("button", { name: "Raise it" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/epics/epic-9/bugs", {
        title: "discount ignored",
        report: "Saw 100.00, expected 90.00",
      }),
    );
  });

  it("will not raise a bug with no report in it", async () => {
    renderIn(<TestsTab data={workspace([task])} />);
    await userEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    await userEvent.type(screen.getByLabelText("Bug title"), "something is wrong");
    // The control that reads past its first line is the only reason a bug can
    // carry its evidence at all — an empty report would file a fix quoting
    // nothing, so the button stays disabled until there is one.
    expect(screen.getByRole("button", { name: "Raise it" }).hasAttribute("disabled")).toBe(true);
  });

  it("says why when the repo has bug reports off", () => {
    renderIn(<TestsTab data={workspace([task], {}, { enabled: false, rows: [], report: { offered: false, reason: "off" } })} />);
    expect(screen.getByText(/Bug reports are off in this repository/)).toBeTruthy();
  });
});
