import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicWorkspace, GatePanelData, Me } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { ExpediteToggle, GateTab, TasksTab } = await import("./EpicWorkspace.js");

/**
 * Expedite in the workspace (change `add-expedite-mode-console`).
 *
 * The switch is easy to flip and its effect is invisible afterwards, so two
 * things are pinned here: the confirm has to say exactly what stops asking
 * for a person, and the board it produces has to stop asking — while keeping
 * every manual start reachable, because a human may take any stage over.
 */

const me: Me = { login: "tester", name: "Tester", avatarUrl: null, orgs: [] };

const off: EpicWorkspace["expedite"] = { on: false, available: true, dormant: false, reason: null, lastFlip: null };

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const autoTask: EpicWorkspace["tasks"][number] = {
  id: "task-10",
  number: 10,
  title: "task(api): reminder schedule",
  kind: "task",
  caseId: null,
  state: "factory:ready",
  open: true,
  htmlUrl: "https://gh/10",
  blockedBy: [],
  blocks: [],
  startStatus: "auto",
  approvable: false,
  nextStep: {
    who: "the factory — expedited",
    how: "Expedite is on: the factory starts the Implementer on this task itself.",
    startRole: null,
    startLabel: null,
    waitsOnPerson: false,
    automatic: true,
  },
};

const autoQaTask: EpicWorkspace["tasks"][number] = {
  ...autoTask,
  id: "task-11",
  number: 11,
  title: "task(api): reminder email",
  state: "factory:in-test",
  startStatus: "none",
  nextStep: {
    who: "the factory — expedited",
    how: "Expedite is on: QA runs on this task by itself.",
    startRole: "qa",
    startLabel: "Start QA",
    waitsOnPerson: false,
    automatic: true,
  },
};

function workspace(overrides: Partial<EpicWorkspace> = {}): EpicWorkspace {
  return {
    epic: {
      id: "epic-9",
      number: 9,
      title: "Payment reminders",
      bodyHtml: "",
      state: "factory:design-approved",
      open: true,
      author: "alice",
      htmlUrl: "https://gh/9",
      labels: ["factory:design-approved", "factory:expedite"],
      status: "Building 1/3",
      nextStep: { who: "its tasks", how: "Building.", startRole: null, startLabel: null, waitsOnPerson: false, automatic: false },
    },
    repo: { id: "repo-1", fullName: "acme/api", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    expedite: { ...off, on: true },
    startGate: { approvers: [], amApprover: true },
    tasks: [autoTask, autoQaTask],
    rollup: { total: 2, ready: 1, inReview: 0, inTest: 1, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 1 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [],
    bugs: { enabled: null, rows: [], report: { offered: false, reason: null } },
    systemTests: { enabled: null, mode: null, planned: false, plan: null, planTests: { offered: false, reason: null } },
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset().mockResolvedValue({ ok: true } as never);
});

describe("the expedite toggle", () => {
  it("confirms with both lists before applying, and applies as a label write", async () => {
    renderIn(<ExpediteToggle epicId="epic-9" expedite={off} />);
    await userEvent.click(screen.getByRole("button", { name: "Expedite…" }));

    // Waived, in the factory's own terms.
    expect(screen.getByText(/G1 — the spec gate/)).toBeTruthy();
    expect(screen.getByText(/G2 — the design gate/)).toBeTruthy();
    expect(screen.getByText(/Implementation starts/)).toBeTruthy();
    expect(screen.getByText(/Review, QA and assembly starts/)).toBeTruthy();
    // Kept — the reason it is safe to offer at all.
    expect(screen.getByText(/GS — the release to staging/)).toBeTruthy();
    expect(screen.getByText(/G3 — the promotion to production/)).toBeTruthy();
    // Nothing has been written yet.
    expect(api.post).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Turn expedite on" }));
    expect(api.post).toHaveBeenCalledWith("/api/epics/epic-9/expedite", { on: true });
  });

  it("removes it without a confirm — taking a shortcut away needs no ceremony", async () => {
    renderIn(<ExpediteToggle epicId="epic-9" expedite={{ ...off, on: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "Turn expedite off" }));
    expect(api.post).toHaveBeenCalledWith("/api/epics/epic-9/expedite", { on: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says why it is unavailable instead of offering a button that would fail", () => {
    renderIn(
      <ExpediteToggle
        epicId="epic-9"
        expedite={{ ...off, available: false, reason: "The fast lane already runs without gates." }}
      />,
    );
    expect(screen.getByRole("button", { name: "Expedite…" })).toBeDisabled();
    expect(screen.getByText(/fast lane already runs without gates/)).toBeTruthy();
  });

  it("explains a factory revert rather than silently showing the switch back off", () => {
    renderIn(
      <ExpediteToggle
        epicId="epic-9"
        expedite={{ ...off, lastFlip: { on: true, actor: "tester", at: "2026-08-30T09:00:00.000Z" } }}
      />,
    );
    expect(screen.getByText(/the marker is not on the issue now/)).toBeTruthy();
    expect(screen.getByText(/@tester/)).toBeTruthy();
  });

  it("reports a refused write where the button was pressed", async () => {
    const { ApiError } = await import("../api.js");
    renderIn(<ExpediteToggle epicId="epic-9" expedite={{ ...off, on: true }} />);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "GitHub declined to add `factory:expedite`"));
    await userEvent.click(screen.getByRole("button", { name: "Turn expedite off" }));
    await waitFor(() => expect(screen.getByText(/GitHub declined to add/)).toBeTruthy());
  });
});

describe("the task board of an expedited epic", () => {
  it("shows the automatic next hop instead of asking for a start", () => {
    renderIn(<TasksTab data={workspace()} />);
    // Twice for the ready task (the row's state badge and the start-gate cue),
    // exactly as `Approved — starting` already reads on a non-expedited board.
    expect(screen.getAllByText("auto — Implementer next").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/QA next/).length).toBeGreaterThan(0);
    // Nothing on the board asks for a person: both starts are behind a closed
    // disclosure rather than sitting on the row as the move.
    for (const name of ["Approve", "Start QA"]) {
      const behind = screen.getByRole("button", { name }).closest("details.manual-start") as HTMLDetailsElement | null;
      expect(behind, name).not.toBeNull();
      expect(behind!.open, name).toBe(false);
    }
    expect(screen.getByText(/the next decision is gate GS/)).toBeTruthy();
  });

  it("keeps every manual start reachable behind one disclosure", async () => {
    renderIn(<TasksTab data={workspace()} />);
    const disclosures = screen.getAllByText("Start it by hand");
    expect(disclosures.length).toBe(2); // the ready task's approval, and QA
    for (const summary of disclosures) await userEvent.click(summary);
    for (const name of ["Approve", "Start QA"]) {
      const behind = screen.getByRole("button", { name }).closest("details.manual-start") as HTMLDetailsElement;
      expect(behind.open, name).toBe(true);
    }
  });

  it("renders a non-expedited board exactly as before", () => {
    const plain = workspace({
      expedite: off,
      tasks: [
        {
          ...autoTask,
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
    });
    renderIn(<TasksTab data={plain} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByText(/auto —/)).toBeNull();
    expect(screen.queryByText("Start it by hand")).toBeNull();
  });
});

const gsPanel: GatePanelData = {
  gate: "staging",
  label: "GS",
  state: "factory:epic-ready",
  amApprover: true,
  approvers: ["tester"],
  approversFrom: "release",
  commentApprovable: true,
  assembly: {
    tasks: [{ number: 10, title: "task(api): reminder schedule", state: "factory:on-epic", open: true, htmlUrl: "https://gh/10" }],
    cases: [],
    testsOutstanding: 0,
    bugs: [],
    bugsOpen: 0,
    allGreen: true,
    report: { author: "factory-bot", at: "2026-08-31T10:00:00.000Z", html: "<p>Assembly green.</p>", htmlUrl: "https://gh/9#c9" },
    prs: [],
  },
  documentPrs: [],
  releasePrs: [],
  artifacts: [],
  currentSha: null,
  changedSinceLastView: false,
  lastViewedSha: null,
  openQuestions: [],
};

describe("the GS gate panel", () => {
  it("shows the assembly, whose list is standing in, and that this is staging", async () => {
    vi.mocked(api.get).mockResolvedValue(gsPanel as never);
    renderIn(<GateTab epicId="epic-9" me={me} />);

    expect(await screen.findByText(/GS — release to staging/)).toBeTruthy();
    expect(screen.getByText(/staging, not production/)).toBeTruthy();
    expect(screen.getByText(/the release approvers stand in/)).toBeTruthy();
    expect(screen.getByText("all tasks landed")).toBeTruthy();
    expect(screen.getByText(/Assembly green/)).toBeTruthy();
    expect(screen.getByText(/#10 reminder schedule/)).toBeTruthy();
  });

  it("shows no test matrix for an epic that runs none", async () => {
    vi.mocked(api.get).mockResolvedValue(gsPanel as never);
    renderIn(<GateTab epicId="epic-9" me={me} />);
    await screen.findByText("all tasks landed");
    expect(screen.queryByText("System tests")).toBeNull();
  });

  it("carries the test matrix as the evidence for the decision", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...gsPanel,
      assembly: {
        ...gsPanel.assembly,
        cases: [
          { number: 30, title: "test(9): ST-1 Reminder fires", state: "factory:test-passed", open: false,
            htmlUrl: "https://gh/30", caseId: "ST-1", verdict: "passed", verdictBy: "tess",
            verdictAt: "2026-09-02T09:00:00.000Z" },
          { number: 31, title: "test(9): ST-2 Refund path", state: "factory:manual-test", open: true,
            htmlUrl: "https://gh/31", caseId: "ST-2", verdict: "runnable", verdictBy: null, verdictAt: null },
        ],
        testsOutstanding: 1,
      },
    } as never);
    renderIn(<GateTab epicId="epic-9" me={me} />);
    expect(await screen.findByText("System tests")).toBeTruthy();
    expect(screen.getByText("1/2 passed")).toBeTruthy();
    expect(screen.getByText(/#30 Reminder fires/)).toBeTruthy();
    // Who gave the verdict is the point; the date's format is the runtime's.
    expect(screen.getByText(/@tess/)).toBeTruthy();
    // Unverified cases warn, and never withhold the button: an epic that is
    // AT this gate with cases open is one the factory chose not to hold, so
    // the decision belongs to the approver.
    expect(screen.getByText(/1 case not passed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("approves by the same comment mechanism as G1 and G2", async () => {
    vi.mocked(api.get).mockResolvedValue(gsPanel as never);
    renderIn(<GateTab epicId="epic-9" me={me} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(api.post).toHaveBeenCalledWith("/api/epics/epic-9/gate/approve", { acknowledgeOpenQuestions: false });
  });

  it("leaves G3 with its merge buttons and no assembly card", async () => {
    vi.mocked(api.get).mockResolvedValue({
      ...gsPanel,
      gate: "release",
      label: "G3",
      state: "factory:in-staging",
      approversFrom: null,
      commentApprovable: false,
      assembly: null,
      releasePrs: [
        {
          id: "pr-1",
          number: 41,
          title: "Promote staging to main",
          kind: "promotion",
          state: "open",
          draft: false,
          ciStatus: "success",
          headRef: "staging",
          baseRef: "main",
          htmlUrl: "https://gh/pr/41",
        },
      ],
    } as never);
    renderIn(<GateTab epicId="epic-9" me={me} />);
    expect(await screen.findByRole("button", { name: "Merge as @tester" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByText("What was assembled")).toBeNull();
  });
});
