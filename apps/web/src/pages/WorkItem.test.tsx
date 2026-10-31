import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicWorkspace, Me } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { WorkItemPage } = await import("./WorkItem.js");

/**
 * The work item page at Test (redesign board 7): the cases a person runs,
 * each with its steps from the plan and Pass/Fail that posts the verdict.
 */

const me: Me = { login: "sowmya", name: "Sowmya", avatarUrl: null, orgs: [] };

function renderItem() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/work/e35"]}>
        <Routes>
          <Route path="/work/:id" element={<WorkItemPage me={me} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const nextStep: EpicWorkspace["epic"]["nextStep"] = { who: "the testers", how: "run the case", startRole: null, startLabel: null, waitsOnPerson: true, automatic: false };

function task(over: Partial<EpicWorkspace["tasks"][number]>): EpicWorkspace["tasks"][number] {
  return {
    id: "t",
    number: 0,
    title: "",
    kind: "task",
    caseId: null,
    state: "factory:on-epic",
    open: true,
    htmlUrl: "https://github.com/x",
    blockedBy: [],
    blocks: [],
    nextStep,
    startStatus: "none",
    approvable: false,
    ...over,
  };
}

const epic: EpicWorkspace = {
  epic: {
    id: "e35",
    number: 35,
    title: "Show day-wise calling performance in the leads page",
    bodyHtml: "",
    state: "factory:design-approved",
    open: true,
    author: "genai-jerry",
    htmlUrl: "https://github.com/genai-jerry/beacon-api/issues/35",
    labels: ["factory:design-approved"],
    status: null,
    nextStep,
  },
  repo: { id: "r", fullName: "genai-jerry/beacon-api", defaultBranch: "main" },
  pipeline: [],
  gate: null,
  expedite: { on: true, available: true, dormant: false, reason: null, lastFlip: null },
  startGate: { approvers: [], amApprover: true },
  tasks: [
    task({ id: "k1", number: 62, title: "task(35): compute counts", state: "factory:on-epic" }),
    task({ id: "c1", number: 66, title: "test(35): ST-1 A lead's CRM calling status reaches the leads page", kind: "test", caseId: "ST-1", state: "factory:manual-test" }),
    task({ id: "c2", number: 67, title: "test(35): ST-2 A lead with no CRM calling status shows a placeholder", kind: "test", caseId: "ST-2", state: "factory:test-passed", open: false }),
    task({
      id: "c3",
      number: 68,
      title: "test(35): ST-3 A calling status changed in the CRM follows through",
      kind: "test",
      caseId: "ST-3",
      state: "factory:on-epic",
      blockedBy: [{ id: "k9", number: 25, title: "task(35): show status", state: "factory:ready", open: true, htmlUrl: "" }],
    }),
  ],
  rollup: { total: 1, ready: 0, inReview: 0, inTest: 0, shipping: 1, done: 0, blocked: 0, waiting: 0, inFlight: 1 },
  blockedSubIssues: [],
  change: { id: "ch", slug: "35-daywise", status: "open" },
  artifacts: [],
  threads: [],
  bugs: { enabled: true, rows: [], report: { offered: true, reason: null } },
  systemTests: {
    enabled: true,
    mode: "gate",
    planned: true,
    plan: { path: "openspec/changes/35-daywise/system-tests/test-plan.md", merged: true },
    planTests: { offered: false, reason: null },
  },
  freshness: { lastSyncedAt: null, stale: false },
  orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
};

const PLAN = `# Plan

## Environment

Run both repos on the local stack.

| Needs | Detail |
|---|---|
| Auth | \`AUTH_ENABLED=true\` |

## Test cases

### ST-1: A lead's CRM calling status reaches the leads page

- \`Steps:\`
  1. Open \`/leads\` in beacon-web.
  2. Find the three leads.
- \`Expected:\` each row shows its CRM status.
`;

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/api/epics/e35") return epic;
    if (path.startsWith("/api/epics/e35/artifact")) return { path: "", ref: "proposed", sha: "s", markdown: PLAN, html: "", otherSha: null };
    if (path.startsWith("/api/epics/e35/qa")) return { enabled: false, provider: null, model: null, budget: null, conversations: [] };
    if (path.startsWith("/api/setup/status")) return {};
    if (path.startsWith("/api/threads")) return { threads: [] };
    return {};
  });
});

describe("WorkItemPage at Test", () => {
  it("puts the item at Test and lists the cases with their standing", async () => {
    renderItem();
    await screen.findByRole("heading", { name: /Test cases/ });
    expect(screen.getByRole("navigation", { name: "Stage" }).querySelector(".wi-stage.now")).toHaveTextContent("Test");
    expect(screen.getByText("1 of 3 passed")).toBeInTheDocument();
    expect(screen.getByText("1 to run · 1 not ready")).toBeInTheDocument();
    const st1 = screen.getByRole("article", { name: /^ST-1:/ });
    expect(within(st1).getByText("Run it")).toBeInTheDocument();
    // Steps come from the plan (a second read) and are open on a runnable case.
    expect(await within(st1).findByText("Open /leads in beacon-web.")).toBeInTheDocument();
    expect(within(st1).getByText(/each row shows its CRM status/)).toBeInTheDocument();
    // A case that waits on a task says which.
    expect(within(screen.getByRole("article", { name: /^ST-3:/ })).getByText("After #25 is built.")).toBeInTheDocument();
    // The environment comes from the plan.
    expect(screen.getByText("Run both repos on the local stack.")).toBeInTheDocument();
    expect(screen.getByText("AUTH_ENABLED=true")).toBeInTheDocument();
    // Passed cases are folded away.
    expect(screen.getByRole("button", { name: "Show the 1 passed test" })).toBeInTheDocument();
  });

  it("records a pass from the case", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderItem();
    const st1 = await screen.findByRole("article", { name: /^ST-1:/ });
    await userEvent.click(within(st1).getByRole("button", { name: "Pass" }));
    await userEvent.click(within(st1).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/issues/c1/test-verdict", { verdict: "passed", evidence: undefined }));
  });
});
