import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/Shell.js", () => ({ useHalt: () => ({ halt: null, setHalt: () => {} }) }));

const { api } = await import("../api.js");
const { FocusProvider } = await import("../lib/filter.js");
const { MissionControl } = await import("./MissionControl.js");
const { DecisionsPage } = await import("./Decisions.js");

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FocusProvider>{ui}</FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const mineRow = (n: number, phase: string) => ({
  issueId: `i${n}`, epicId: `e${n}`, number: n, title: `Mine ${n}`, repo: "acme/api", kind: "task", state: null, phase,
  whyMine: "assigned", freshness: { lastMovedAt: "2026-11-01T00:00:00Z", quietDays: 3 }, blocked: false,
});

afterEach(() => vi.restoreAllMocks());

describe("Pipeline lists", () => {
  it("shows ten of Yours, in flight at a time, in phase order under their headings", async () => {
    // 8 being built, then 6 in an earlier phase: phase order puts the earlier ones first.
    const mine = [...Array.from({ length: 8 }, (_, i) => mineRow(i + 1, "building")), ...Array.from({ length: 6 }, (_, i) => mineRow(i + 101, "planning"))];
    vi.spyOn(api, "get").mockImplementation((async (path: string) => {
      if (path.startsWith("/api/my-work")) return { needsYou: [], mine, waitingOn: [] };
      if (path.startsWith("/api/running")) return { running: [] };
      if (path.startsWith("/api/runs/recent")) return { runs: [], hasMore: false };
      return { estates: [] };
    }) as never);
    wrap(<MissionControl />);
    const card = (await screen.findByRole("heading", { name: "Yours, in flight" })).closest(".card") as HTMLElement;
    const titles = () => [...card.querySelectorAll(".work-row-title")].map((e) => e.textContent!.replace(/^#\d+ /, ""));
    await within(card).findAllByText(/Mine 101/);
    expect(card).toHaveTextContent("1–10 of 14");
    expect(titles()).toEqual(["Mine 101", "Mine 102", "Mine 103", "Mine 104", "Mine 105", "Mine 106", "Mine 1", "Mine 2", "Mine 3", "Mine 4"]);
    fireEvent.click(within(card).getByRole("button", { name: "Next ›" }));
    expect(card).toHaveTextContent("11–14 of 14");
    expect(titles()).toEqual(["Mine 5", "Mine 6", "Mine 7", "Mine 8"]);
    expect(within(card).getByRole("button", { name: "Next ›" })).toBeDisabled();
  });
});

describe("Decision log", () => {
  it("shows ten decisions at a time and starts over on a new search", async () => {
    const decisions = Array.from({ length: 23 }, (_, i) => ({
      id: `d${i + 1}`, title: `Decision ${i + 1}`, status: "active", decidedBy: "jerry", createdAt: "2026-11-01T00:00:00Z",
      context: null, options: [], chosen: null, consequences: null,
    }));
    vi.spyOn(api, "get").mockImplementation((async () => ({ decisions })) as never);
    wrap(<DecisionsPage />);
    expect(await screen.findByRole("heading", { name: "Decision 1" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(10);
    expect(screen.getByText("1–10 of 23")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Older ›" }));
    fireEvent.click(screen.getByRole("button", { name: "Older ›" }));
    expect(screen.getByRole("heading", { name: "Decision 21" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Search decisions"), { target: { value: "x" } });
    expect(await screen.findByRole("heading", { name: "Decision 1" })).toBeInTheDocument();
  });
});
