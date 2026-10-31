import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { FocusProvider } from "../lib/filter.js";
import type { RunningItem } from "../types.js";
import { RunningCards, runningLink } from "./RunningCards.js";

const item = (over: Partial<RunningItem> = {}): RunningItem => ({
  issueId: "i1", number: 11, title: "The sheets adapter applies the columns", repo: "acme/connectors",
  kind: "task", role: "Implementer", epicId: "e1", epicNumber: 34, epicTitle: "Booker status", ...over,
});

function show(running: RunningItem[]) {
  vi.spyOn(api, "get").mockResolvedValue({ running });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FocusProvider>
          <RunningCards />
        </FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("RunningCards", () => {
  it("shows one small card per live run, each linking to its thread or epic", async () => {
    show([item(), item({ issueId: "i2", number: 34, kind: "epic", role: "Dispatcher", title: "Booker status", repo: "acme/api" })]);
    const region = await screen.findByLabelText("Running now");
    expect(region).toHaveTextContent("Running now (2)");
    expect(region).toHaveTextContent("Implementer running");
    expect(region).toHaveTextContent("Dispatcher running");
    expect(region).toHaveTextContent("epic #34"); // the task names its epic; the epic card does not repeat it
    const links = screen.getAllByRole("link");
    expect(links[0]!.getAttribute("href")).toBe("/epics/e1?tab=threads&thread=task%2F11");
    expect(links[1]!.getAttribute("href")).toBe("/epics/e1");
  });

  it("renders nothing when no run is live", async () => {
    const { container } = show([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("links a task to its own thread", () => {
    expect(runningLink(item({ number: 62 }))).toBe("/epics/e1?tab=threads&thread=task%2F62");
  });
});
