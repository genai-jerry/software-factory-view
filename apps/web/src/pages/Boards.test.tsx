import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicWorkspace, GatePanelData, PrSummary } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api, ApiError } = await import("../api.js");
const { ReleaseBoard } = await import("./ReleaseBoard.js");
const { BuildBoard, taskWord } = await import("./BuildBoard.js");

/**
 * Release (board 8) and Build (board 6). Two things are pinned: shipping
 * merges the promotion PRs in order and stops at the first refusal, saying
 * what was and was not merged; and a stopped builder's question is answered
 * from the board.
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

function task(over: Partial<EpicWorkspace["tasks"][number]>): EpicWorkspace["tasks"][number] {
  return { id: "t", number: 0, title: "", kind: "task", caseId: null, state: "factory:on-epic", open: true, htmlUrl: "", blockedBy: [], blocks: [], nextStep, startStatus: "none", approvable: false, ...over };
}

function epic(over: Partial<EpicWorkspace["epic"]>, tasks: EpicWorkspace["tasks"] = []): EpicWorkspace {
  return {
    epic: { id: "e1", number: 40, title: "WhatsApp link previews", bodyHtml: "<p>Links get a preview card.</p>", state: "factory:in-staging", open: true, author: "jerry", htmlUrl: "", labels: [], status: null, nextStep, ...over },
    repo: { id: "r", fullName: "genai-jerry/beacon-whatsapp", defaultBranch: "main" },
    pipeline: [],
    gate: null,
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks,
    rollup: { total: 3, ready: 0, inReview: 0, inTest: 0, shipping: 3, done: 0, blocked: 0, waiting: 0, inFlight: 3 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [],
    bugs: { enabled: true, rows: [], report: { offered: false, reason: null } },
    systemTests: { enabled: true, mode: "gate", planned: true, plan: null, planTests: { offered: false, reason: null } },
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
  };
}

function pr(id: string, title: string): PrSummary {
  return { id, number: 1, title, kind: "promotion", state: "open", draft: false, ciStatus: "success", headRef: "staging", baseRef: "main", htmlUrl: "" };
}

const gate: GatePanelData = {
  gate: "release",
  label: "G3",
  state: "factory:in-staging",
  amApprover: true,
  approvers: ["jerry"],
  approversFrom: null,
  commentApprovable: false,
  assembly: null,
  documentPrs: [],
  releasePrs: [pr("p1", "Promote beacon-api"), pr("p2", "Promote beacon-web")],
  artifacts: [],
  currentSha: null,
  changedSinceLastView: false,
  lastViewedSha: null,
  openQuestions: [],
};

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.endsWith("/gate")) return gate;
    if (path.endsWith("/timeline")) return { events: [{ type: "state", at: "2026-10-30T10:12:00Z", detail: "Released to staging", actor: "jerry" }] };
    if (path.includes("/peek")) return { blocked: { since: null, question: "May the status column be the phone column?" } };
    return {};
  });
});

describe("ReleaseBoard at production", () => {
  it("ships by merging the promotion PRs in order", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, sha: "abc" });
    renderIn(<ReleaseBoard data={epic({ state: "factory:in-staging" })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ship to production" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls.map((c) => c[0])).toEqual(["/api/prs/p1/merge", "/api/prs/p2/merge"]);
    expect(await screen.findByText("Shipped. Ops verifies production next.")).toBeInTheDocument();
    expect(screen.getByText("Released to staging")).toBeInTheDocument();
  });

  it("stops at the first refusal and says what was merged", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new ApiError(409, "GitHub declined the merge: not mergeable"));
    renderIn(<ReleaseBoard data={epic({ state: "factory:in-staging" })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ship to production" }));
    expect(await screen.findByText(/Stopped after 1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/Promote beacon-web was declined/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it("warns before shipping when cases have not been run", async () => {
    const cases = [
      task({ id: "c1", number: 50, title: "test(40): ST-1 Preview shows", kind: "test", caseId: "ST-1", state: "factory:manual-test" }),
      task({ id: "c2", number: 51, title: "test(40): ST-2 No preview for a bare link", kind: "test", caseId: "ST-2", state: "factory:test-skipped", open: false }),
      task({ id: "c3", number: 52, title: "test(40): ST-3 Preview on a long link", kind: "test", caseId: "ST-3", state: "factory:test-passed", open: false }),
    ];
    renderIn(<ReleaseBoard data={epic({ state: "factory:in-staging" }, cases)} />);
    await screen.findByRole("heading", { name: "Your decision" });
    expect(screen.getByText("1 test case has not been run. Shipping now ships untested.")).toBeInTheDocument();
    // Skipped is said apart from passed, never folded into it.
    expect(screen.getByText("3 tasks, 1 of 3 tests passed, 1 skipped")).toBeInTheDocument();
  });

  it("offers Release to staging at GS", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path.endsWith("/gate")) return { ...gate, gate: "staging", state: "factory:epic-ready", releasePrs: [] };
      if (path.endsWith("/timeline")) return { events: [] };
      return {};
    });
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderIn(<ReleaseBoard data={epic({ state: "factory:epic-ready" })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Release to staging" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/epics/e1/gate/approve", { acknowledgeOpenQuestions: false }));
  });
});

describe("BuildBoard", () => {
  const tasks = [
    task({ id: "a", number: 1, title: "task(34): The status map learns the sheet kind", state: "factory:on-epic" }),
    task({ id: "b", number: 4, title: "task(34): The adapter writes status words", state: "factory:blocked" }),
    task({ id: "c", number: 5, title: "task(34): The poller reports changes", state: "factory:in-review", running: true, runningRole: "reviewer", runId: "run-9" }),
    task({ id: "d", number: 6, title: "task(34): The page shows the columns", state: "factory:ready", blockedBy: [{ id: "b", number: 4, title: "", state: "factory:blocked", open: true, htmlUrl: "" }] }),
  ];

  it("says each task's standing in words", () => {
    expect(tasks.map((t) => taskWord(t).text)).toEqual(["Done", "Stopped · asks you", "Being reviewed", "Waiting on #4"]);
  });

  it("answers a stopped builder from the board", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderIn(<BuildBoard data={epic({ state: "factory:design-approved" }, tasks)} />);
    const card = await screen.findByRole("region", { name: "Needs an answer" });
    expect(await within(card).findByText("May the status column be the phone column?")).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText("Your answer"), "Refuse the phone column.");
    await userEvent.click(within(card).getByRole("button", { name: "Reply and continue" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/issues/b/reply", { body: "Refuse the phone column." }));
    expect(screen.getByText("1 of 4 built")).toBeInTheDocument();
    expect(screen.getByText("Reviewer on task 5.")).toBeInTheDocument();
  });
});
