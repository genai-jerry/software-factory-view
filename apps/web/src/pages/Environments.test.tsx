import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { FocusProvider } from "../lib/filter.js";
import type { EnvCard, EnvironmentsView } from "../types.js";
import { EnvironmentsPage, envState } from "./Environments.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const card = (over: Partial<EnvCard>): EnvCard => ({
  id: "acme/api#40", kind: "task", repo: "acme/api", title: "The status map", issueId: "i40", epicId: "e34",
  active: null, queue: [], notes: [], lastUsedAt: at(30), ...over,
});

const view: EnvironmentsView = {
  available: true,
  sessions: {
    total: 4,
    inUse: [
      { runId: "r40", role: "Implementer", title: "The status map", staging: false, since: at(12) },
      { runId: "rel", role: "Release Manager", title: "Booker status", staging: true, since: at(6) },
    ],
    waiting: [{ runId: "r41", role: "Reviewer", title: "Quiet hours", staging: false, since: at(2) }],
  },
  staging: [
    card({
      id: "acme/api@staging", kind: "staging", title: "Staging", issueId: null, epicId: null,
      active: { runId: "rel", role: "Release Manager", title: "Booker status", state: "running", since: at(6) },
      queue: [{ runId: "rel2", role: "Release Manager", title: "Flow triggers", state: "waiting", since: at(1) }],
      notes: [{ at: at(120), role: "Release Manager", title: "Older epic", outcome: "success", summary: "Merged onto staging; deploy asked.", runId: "old" }],
    }),
  ],
  lanes: [
    {
      ref: "acme/api#34", epicId: "e34", title: "Booker status", tasksTotal: 9, tasksMerged: 7,
      epic: card({ id: "acme/api#34", kind: "epic", title: "Booker status", lastUsedAt: at(60),
        notes: [{ at: at(60), role: "Dispatcher", title: "Booker status", outcome: "success", summary: "Released the last two tasks.", runId: "d1" }] }),
      tasks: [
        card({ active: { runId: "r40", role: "Implementer", title: "The status map", state: "running", since: at(12) },
          notes: [{ at: at(200), role: "Implementer", title: "The status map", outcome: "timeout", summary: "Loader tests hang. Stub the lookup first.", runId: "t1" }] }),
        card({ id: "acme/api#41", title: "Quiet hours", active: { runId: "r41", role: "Reviewer", title: "Quiet hours", state: "waiting for a session", since: at(2) } }),
        card({ id: "acme/api#42", title: "Idle one", notes: [{ at: at(300), role: "QA", title: null, outcome: "error", summary: "", runId: null }] }),
        card({ id: "acme/api#43", title: "Idle two" }),
        card({ id: "acme/api#44", title: "Idle three" }),
        card({ id: "acme/api#45", title: "Idle four" }),
      ],
    },
  ],
  other: [],
};

function show(data: EnvironmentsView) {
  vi.spyOn(api, "get").mockImplementation((async () => data) as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FocusProvider>
          <EnvironmentsPage />
        </FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("EnvironmentsPage", () => {
  it("shows the sessions in use, each linking to its run, and who waits", async () => {
    show(view);
    const meter = await screen.findByLabelText("2 of 4 Claude sessions in use");
    expect(within(meter).getByRole("link", { name: "Implementer · The status map" }).getAttribute("href")).toBe("/runs/r40");
    expect(within(meter).getByRole("link", { name: "Release Manager · staging" })).toBeTruthy();
    expect(within(meter).getAllByText("free")).toHaveLength(2);
    expect(meter).toHaveTextContent("1 waiting for a free session");
  });

  it("draws staging with its order: who is on it now, then who is next", async () => {
    show(view);
    const order = await screen.findByLabelText("Order onto staging");
    const items = within(order).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Booker status");
    expect(items[0]).toContain("now");
    expect(items[1]).toContain("Flow triggers");
    expect(items[1]).toContain("waiting");
  });

  it("puts tasks in their epic's lane, busy ones first, idle ones folded away", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    expect(board).toHaveTextContent("Implementer · running · 12 min");
    expect(board).toHaveTextContent("Reviewer · waiting for a free session");
    expect(board).toHaveTextContent("7 of 9 tasks merged into the epic");
    expect(board).toHaveTextContent("Remembers: Released the last two tasks.");
    // the failed task and two idle ones show; the third idle one folds
    expect(board).toHaveTextContent("Idle · last run failed");
    expect(within(board).getByText("Idle three")).toBeTruthy();
    expect(within(board).queryByText("Idle four")).toBeNull();
    fireEvent.click(within(board).getByRole("button", { name: "1 more idle" }));
    expect(within(board).getByText("Idle four")).toBeTruthy();
    // never issue numbers
    expect(board.textContent).not.toMatch(/#\d/);
  });

  it("opens an environment to show what it remembers, newest first, with its runs", async () => {
    show(view);
    fireEvent.click(await screen.findByRole("button", { name: /^The status map: Running/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveTextContent("What this environment remembers");
    expect(sheet).toHaveTextContent("Loader tests hang. Stub the lookup first.");
    expect(sheet).toHaveTextContent("ran out of time");
    expect(within(sheet).getByRole("link", { name: "open the run" }).getAttribute("href")).toBe("/runs/r40");
    expect(within(sheet).getByRole("link", { name: "Open the epic" }).getAttribute("href")).toBe("/epics/e34");
  });

  it("says so when the orchestrator cannot list environments yet", async () => {
    show({ available: false, sessions: null, staging: [], lanes: [], other: [] });
    expect(await screen.findByText(/does not list its environments yet/)).toBeTruthy();
  });

  it("reads a card's state from its turn, its queue and its last run", () => {
    expect(envState(card({ active: { runId: "a", role: "QA", title: null, state: "running", since: null } }))).toBe("running");
    expect(envState(card({ active: { runId: "a", role: "QA", title: null, state: "waiting for a session", since: null } }))).toBe("waiting");
    expect(envState(card({ queue: [{ runId: "a", role: "QA", title: null, state: "waiting", since: null }] }))).toBe("waiting");
    expect(envState(card({ notes: [{ at: null, role: "QA", title: null, outcome: "timeout", summary: "", runId: null }] }))).toBe("failed");
    expect(envState(card({}))).toBe("idle");
  });
});
