import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import type { EpicWorkspace } from "../types.js";
import { ThreadsTab } from "./EpicWorkspace.js";

const data = {
  epic: { id: "epic-1" },
  tasks: [],
  startGate: { approvers: [], amApprover: true },
  threads: [
    { id: "t-gate", topicKind: "gate", topicRef: "gate/g1", title: "Gate G1 — spec", status: "open", entryCount: 5 },
    { id: "t-11", topicKind: "task", topicRef: "task/11", title: "Task #11", status: "open", entryCount: 31 },
  ],
} as unknown as EpicWorkspace;

function show(thread?: string) {
  const get = vi.spyOn(api, "get").mockResolvedValue({ id: "x", title: "x", entries: [], status: "open" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ThreadsTab data={data} thread={thread} />
    </QueryClientProvider>,
  );
  return get;
}

afterEach(() => vi.restoreAllMocks());

describe("ThreadsTab deep link", () => {
  it("opens the thread named in ?thread= and no other", async () => {
    const get = show("task/11");
    await screen.findByText("Task #11");
    expect(get).toHaveBeenCalledWith("/api/threads/t-11");
    expect(get).not.toHaveBeenCalledWith("/api/threads/t-gate");
  });

  it("opens nothing without it", () => {
    const get = show();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("A blocked thread", () => {
  it("lists the factory's questions beside the reply box", async () => {
    const detail = {
      id: "t-11", title: "Task #11", topicKind: "task", topicRef: "task/11", status: "open", blocked: true,
      questions: ["Allow one more implementer round on this task, or take the fix yourself?", "Should judge_alerts count as a tenant table?"],
      entries: [
        { id: "a", source: "github_comment", author: "bot", bodyHtml: "<p>Round 2 blocked.</p>", isAgent: true, isApproval: false, htmlUrl: null, createdAt: "2026-11-01T10:00:00Z" },
      ],
    };
    vi.spyOn(api, "get").mockResolvedValue(detail);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ThreadsTab data={data} thread="task/11" /></QueryClientProvider>);
    const note = await screen.findByRole("note", { name: "Questions for you" });
    expect(note.textContent).toContain("needs your answers:");
    expect(screen.getByText("Should judge_alerts count as a tenant table?")).toBeTruthy();
    expect(note.textContent).toContain("Your reply clears the block");
  });

  it("says when the factory listed no questions", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ id: "t-11", title: "Task #11", topicKind: "task", topicRef: "task/11", status: "open", blocked: true, questions: [], entries: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ThreadsTab data={data} thread="task/11" /></QueryClientProvider>);
    expect((await screen.findByRole("note", { name: "Questions for you" })).textContent).toContain("did not list its questions");
  });
});

describe("Ask the factory", () => {
  it("sends the box's text as a question and labels the answer", async () => {
    const detail = {
      id: "t-11", title: "Task #11", topicKind: "task", topicRef: "task/11", status: "open",
      entries: [
        { id: "a", source: "ask_question", author: "alice", bodyHtml: "<p>Why blocked?</p>", isAgent: false, isApproval: false, htmlUrl: null, createdAt: "2026-10-31T10:00:00Z" },
        { id: "b", source: "ask_answer", author: "factory", bodyHtml: "<p>The cap.</p>", isAgent: false, isApproval: false, htmlUrl: null, createdAt: "2026-10-31T10:01:00Z" },
      ],
    };
    vi.spyOn(api, "get").mockResolvedValue(detail);
    const post = vi.spyOn(api, "post").mockResolvedValue({ ok: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><ThreadsTab data={data} thread="task/11" /></QueryClientProvider>);
    expect(await screen.findByText("factory answer")).toBeTruthy();
    expect(screen.getByText("question to the factory")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Ask the factory" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Reply/), { target: { value: "What does it touch?" } });
    fireEvent.click(button);
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/threads/t-11/ask", { question: "What does it touch?" }));
  });
});
