import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { FocusProvider } from "../lib/filter.js";
import type { PastRunItem } from "../types.js";
import { RecentRuns, agoText, durationText, outcomeOf } from "./RecentRuns.js";

const run = (over: Partial<PastRunItem> = {}): PastRunItem => ({
  runId: "r1", repo: "acme/api", number: 40, title: "The status map", kind: "task", epicId: "e1", epicNumber: 34,
  role: "Reviewer", outcome: "success", startedAt: "2026-10-30T11:00:00Z", finishedAt: "2026-10-30T11:04:12Z",
  seconds: 252, model: "claude-sonnet-5-5", error: null, hasLog: true, ...over,
});

function show(get: ReturnType<typeof vi.fn>) {
  vi.spyOn(api, "get").mockImplementation(get as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><FocusProvider><RecentRuns /></FocusProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("RecentRuns", () => {
  it("shows what ran, how it ended and for how long, and opens the log", async () => {
    show(vi.fn(async () => ({ runs: [run(), run({ runId: "r2", number: 7, outcome: "error", error: "usage limit", hasLog: false, role: "Implementer" })], hasMore: false })));
    const region = await screen.findByLabelText("Recent runs");
    expect(region).toHaveTextContent("Recent runs (2)");
    expect(region).toHaveTextContent("Succeeded");
    expect(region).toHaveTextContent("Failed");
    expect(region).toHaveTextContent("took 4 min 12 s");
    expect(region).toHaveTextContent("usage limit");
    expect(region).toHaveTextContent("log no longer available");
    expect(screen.getByRole("link", { name: /#40 The status map/ }).getAttribute("href")).toBe("/runs/r1");
    // The run with no log has no log link, only its thread.
    expect(screen.queryByRole("link", { name: /#7/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: "thread" })[0]!.getAttribute("href")).toBe("/epics/e1?tab=threads&thread=task%2F40");
  });

  it("asks for ten, then ten more", async () => {
    const get = vi.fn(async () => ({ runs: [run()], hasMore: true }));
    show(get);
    await screen.findByLabelText("Recent runs");
    expect(get).toHaveBeenLastCalledWith("/api/runs/recent?limit=10");
    fireEvent.click(screen.getByRole("button", { name: "Show 10 more" }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("/api/runs/recent?limit=20"));
  });

  it("renders nothing without history", async () => {
    const { container } = show(vi.fn(async () => ({ runs: [], hasMore: false })));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("words outcomes, durations and ages plainly", () => {
    expect(["success", "error", "timeout", "no_op"].map((o) => outcomeOf(o).label)).toEqual(["Succeeded", "Failed", "Timed out", "No change"]);
    expect([45, 252, 7500].map(durationText)).toEqual(["45 s", "4 min 12 s", "2 h 5 min"]);
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(["2026-10-30T11:59:50Z", "2026-10-30T11:48:00Z", "2026-10-30T09:00:00Z", "2026-10-28T12:00:00Z"].map((t) => agoText(t, now)))
      .toEqual(["just now", "12 min ago", "3 h ago", "2 d ago"]);
  });
});
