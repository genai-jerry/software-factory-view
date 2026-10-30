import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
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
