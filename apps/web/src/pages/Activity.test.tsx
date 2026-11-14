import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { FocusProvider } from "../lib/filter.js";
import { ActivityPage } from "./Activity.js";

// Minutes before noon today, so a run near midnight cannot split "today" in two.
const ago = (minutes: number) => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return new Date(noon.getTime() - minutes * 60_000).toISOString();
};
const line = (n: number, minutes: number, person = false) => ({
  at: ago(minutes), who: person ? "jerry" : "Implementer", person, text: `did thing ${n}`, stage: null, repo: "acme/api", epicId: "e1",
});

function show(lines: unknown[]) {
  vi.spyOn(api, "get").mockImplementation((async (path: string) => (path.startsWith("/api/activity") ? { lines } : path === "/api/running" ? { running: [] } : { usage: null })) as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FocusProvider>
          <ActivityPage />
        </FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("ActivityPage", () => {
  it("shows five lines a day at a time, pages each day on its own, and starts over on a new filter", async () => {
    // Twelve lines today (minutes apart) — newest first.
    const today = Array.from({ length: 12 }, (_, i) => line(i + 1, i, i % 2 === 0));
    show(today);
    const day = (await screen.findByRole("heading", { name: "Today" })).closest("section")!;
    expect(within(day).getAllByRole("link")).toHaveLength(5);
    expect(day).toHaveTextContent("1–5 of 12");
    expect(day).toHaveTextContent("did thing 1");
    expect(within(day).getByRole("button", { name: "‹ Newer" })).toBeDisabled();
    fireEvent.click(within(day).getByRole("button", { name: "Older ›" }));
    expect(day).toHaveTextContent("6–10 of 12");
    expect(day).toHaveTextContent("did thing 6");
    expect(day).not.toHaveTextContent("did thing 1 ");
    fireEvent.click(within(day).getByRole("button", { name: "Older ›" }));
    expect(within(day).getAllByRole("link")).toHaveLength(2);
    expect(within(day).getByRole("button", { name: "Older ›" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "People" }));
    expect(day).toHaveTextContent("1–5 of 6");
  });

  it("shows no pager when a day fits on one page", async () => {
    show([line(1, 1), line(2, 2)]);
    const day = (await screen.findByRole("heading", { name: "Today" })).closest("section")!;
    expect(within(day).queryByRole("navigation")).toBeNull();
  });
});
