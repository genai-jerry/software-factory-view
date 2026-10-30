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
