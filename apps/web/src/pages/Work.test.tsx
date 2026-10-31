import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { FocusProvider } from "../lib/filter.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionEntry, BoardCard, MyWork } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { WorkPage } = await import("./Work.js");
const { DecisionsQueuePage } = await import("./DecisionsQueue.js");

/**
 * The Work list and the Decisions queue (redesign boards 1 and 2) are built
 * from the board, the attention queue and the running list. These pin the
 * two things a reader relies on: a row says who acts and what in one line,
 * and a button on a decision card is the whole decision.
 */

function renderAt(path: string, ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <FocusProvider>{ui}</FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const epic: BoardCard = {
  epicId: "e35",
  number: 35,
  title: "Show day-wise calling performance in the leads page",
  repo: "genai-jerry/beacon-api",
  estateId: "est",
  state: "factory:design-approved",
  open: true,
  daysInState: 1,
  blocked: false,
  expedited: true,
  tasks: { total: 5, ready: 0, inReview: 0, inTest: 0, shipping: 5, done: 0, blocked: 0, waiting: 0, inFlight: 5, tests: { total: 16, passed: 0, runnable: 16, failed: 0, outstanding: 16 } },
};

const designEpic: BoardCard = {
  ...epic,
  epicId: "e36",
  number: 36,
  title: "Retry CRM lookups that time out",
  state: "factory:design-ready",
  tasks: { total: 0, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0 },
};

const quietEpic: BoardCard = { ...epic, epicId: "e97", number: 97, title: "Sarvam changes", state: "factory:intake", expedited: false, tasks: designEpic.tasks };

function testCase(i: number): AttentionEntry {
  return {
    kind: "task-start",
    rank: 3,
    whyYou: "you are a tester",
    epicId: "e35",
    issueId: `t${i}`,
    title: `test(35): ST-${i} case ${i}`,
    repo: "genai-jerry/beacon-api",
    state: "factory:manual-test",
    ageDays: 0,
    question: null,
    expedited: true,
    link: "/epics/e35?tab=tests",
  };
}

const gate: AttentionEntry = {
  kind: "gate",
  rank: 2,
  whyYou: "G2 awaits approval",
  epicId: "e36",
  issueId: "e36",
  title: "Retry CRM lookups that time out",
  repo: "genai-jerry/beacon-api",
  state: "factory:design-ready",
  ageDays: 2,
  question: null,
  expedited: false,
  link: "/epics/e36?tab=gate",
};

const myWork: MyWork = { needsYou: [gate, ...Array.from({ length: 16 }, (_, i) => testCase(i + 1))], mine: [], waitingOn: [] };

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/board")) return { columns: [], cards: [epic, designEpic, quietEpic] };
    if (path.startsWith("/api/my-work")) return myWork;
    if (path.startsWith("/api/running")) return { items: [] };
    if (path.startsWith("/api/estates")) return { estates: [], ingestion: { lastReceivedAt: null, lastProcessedAt: null, pending: 0 } };
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("WorkPage", () => {
  it("groups work items by who acts and says what in one line", async () => {
    renderAt("/", <WorkPage />);
    await screen.findByText("Needs a decision");
    // One row per work item, not one per test case.
    expect(screen.getAllByText("Show day-wise calling performance in the leads page")).toHaveLength(1);
    expect(screen.getByText("16 of 16 tests are left.")).toBeInTheDocument();
    expect(screen.getByText("You run the tests")).toBeInTheDocument();
    expect(screen.getByText("approve the design.")).toBeInTheDocument();
    // The intake epic waits on the factory, under its own heading.
    expect(screen.getByText("Sarvam changes")).toBeInTheDocument();
    expect(screen.getByText("The plan is being written. You will be asked to approve it.")).toBeInTheDocument();
    // The counters add up.
    expect(screen.getByText("need you").previousSibling).toHaveTextContent("2");
    expect(screen.getByText("1 approval, 1 test run")).toBeInTheDocument();
  });
});

describe("DecisionsQueuePage", () => {
  it("approves a design from the card and refreshes", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, commentUrl: "https://github.com/x" });
    renderAt("/decisions", <DecisionsQueuePage />);
    const approve = await screen.findByRole("button", { name: "Approve the design" });
    await userEvent.click(approve);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/epics/e36/gate/approve", { acknowledgeOpenQuestions: false }));
    expect(await screen.findByText("Approved. The factory has it.")).toBeInTheDocument();
  });

  it("asks for changes with a note that posts to GitHub", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderAt("/decisions", <DecisionsQueuePage />);
    await userEvent.click(await screen.findByRole("button", { name: "Ask for changes" }));
    await userEvent.type(screen.getByLabelText("What should change?"), "Make the window 14 days.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/epics/e36/gate/request-changes", { body: "Make the window 14 days." }));
  });

  it("collapses the test cases into one Run card", async () => {
    renderAt("/decisions", <DecisionsQueuePage />);
    expect(await screen.findByRole("heading", { name: "Run 16 tests" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run them" })).toHaveAttribute("href", "/epics/e35?tab=tests");
    expect(screen.getByText("and 13 more")).toBeInTheDocument();
  });
});
