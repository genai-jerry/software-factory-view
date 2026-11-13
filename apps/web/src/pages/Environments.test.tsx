import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { FocusProvider } from "../lib/filter.js";
import type { EnvCard, EnvironmentsView } from "../types.js";
import { EnvironmentsPage, envState, laneColors, mergedWords } from "./Environments.js";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const card = (over: Partial<EnvCard>): EnvCard => ({
  id: "acme/api#40", kind: "task", repo: "acme/api", title: "The status map", issueId: "i40", epicId: "e34",
  active: null, queue: [], notes: [], lastUsedAt: at(30), pulls: [], ...over,
});

const pull = (number: number, title: string, state: "open" | "merged" | "closed", headRef: string, baseRef = "factory/epic-34") => ({
  number, title, state, mergedAt: state === "merged" ? at(60 * 24) : null, headRef, baseRef, url: `https://github.com/acme/api/pull/${number}`,
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
      onStaging: [{ ref: "acme/api#34", title: "Booker status" }],
      pulls: [
        pull(250, "release(34): integrate factory/epic-34 into staging", "merged", "factory/epic-34", "staging"),
        pull(236, "Booking: the lead's timezone goes with the book request", "merged", "fix/booking-timezone", "staging"),
      ],
    }),
  ],
  lanes: [
    {
      ref: "acme/api#34", epicId: "e34", title: "Booker status", tasksTotal: 9, tasksMerged: 7,
      epic: card({ id: "acme/api#34", kind: "epic", title: "Booker status", lastUsedAt: at(60),
        notes: [{ at: at(60), role: "Dispatcher", title: "Booker status", outcome: "success", summary: "Released the last two tasks.", runId: "d1",
          merged: [
            { number: 240, title: "task(34): The status map", baseRef: "factory/epic-34", url: "https://github.com/acme/api/pull/240" },
            { number: 241, title: "task(34): Quiet hours", baseRef: "factory/epic-34", url: "https://github.com/acme/api/pull/241" },
          ] }] }),
      tasks: [
        card({ active: { runId: "r40", role: "Implementer", title: "The status map", state: "running", since: at(12) },
          notes: [{ at: at(200), role: "Implementer", title: "The status map", outcome: "timeout", summary: "Loader tests hang. Stub the lookup first.", runId: "t1" }],
          pulls: [pull(246, "fix(34): status map colours", "open", "factory/40-colours"), pull(240, "task(34): The status map", "merged", "factory/40-the-status-map")] }),
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

  it("says which model a run uses, in words", async () => {
    const withModel: EnvironmentsView = {
      ...view,
      sessions: { ...view.sessions!, inUse: [{ runId: "r40", model: "claude-opus-5-5", role: "Implementer", title: "The status map", staging: false, since: at(12) }, view.sessions!.inUse[1]!] },
    };
    show(withModel);
    const meter = await screen.findByLabelText("2 of 4 Claude sessions in use");
    expect(within(meter).getByRole("link", { name: "Implementer (Opus 5.5) · The status map" })).toBeTruthy();
    const { modelName } = await import("./Environments.js");
    expect([modelName("claude-opus-5-5"), modelName("claude-sonnet-5"), modelName("claude-haiku-4-5-20251001"), modelName("gpt-x"), modelName(null)]).toEqual(["Opus 5.5", "Sonnet 5", "Haiku 4.5", "gpt-x", null]);
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

  it("names the repo of each task and each staging, and not on epics", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    const task = within(board).getByRole("button", { name: /^The status map:/ });
    expect(within(task).getByTitle("Built in acme/api")).toHaveTextContent("api");
    const epic = within(board).getAllByRole("button", { name: /^Booker status:/ })[0]!;
    expect(within(epic).queryByTitle(/^Built in/)).toBeNull();
    const staging = within(board).getByRole("button", { name: /^Staging:/ });
    expect(within(staging).getByTitle("The staging branch of acme/api")).toHaveTextContent("api");
  });

  it("colours each epic's lane, and shows the same colour on staging once it is merged there", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    const hue = laneColors(["acme/api#34"]).get("acme/api#34")!;
    const epicCell = within(board).getAllByRole("button", { name: /^Booker status:/ })[0]!.closest(".env-lane-epic") as HTMLElement;
    expect(epicCell.style.getPropertyValue("--lane")).toBe(hue);
    const staged = within(board).getByText("Merged onto staging").parentElement!;
    expect(staged).toHaveTextContent("Booker status");
    expect((staged.querySelector(".env-swatch") as HTMLElement).style.background).not.toBe("");
  });

  it("gives every epic on the page its own colour, in epic-number order", () => {
    const c = laneColors(["o/api#193", "o/api#138", "o/api#35", "o/api#193"]);
    expect(c.size).toBe(3);
    expect(new Set(c.values()).size).toBe(3);
    expect([...c.keys()]).toEqual(["o/api#35", "o/api#138", "o/api#193"]);
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

  it("puts a pull-request icon on a card that has pull requests, counting the merged ones", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    const icon = within(board).getByRole("button", { name: "Pull requests of The status map: 1 merged, 1 open" });
    expect(icon).toHaveTextContent("1");
    expect(icon.getAttribute("aria-expanded")).toBe("false");
    // staging's counts its merged ones alone; an idle task with none has no icon
    expect(within(board).getByRole("button", { name: "Pull requests of Staging: 2 merged" })).toHaveTextContent("2");
    expect(within(board).queryByRole("button", { name: /^Pull requests of Idle one/ })).toBeNull();
    // the icon never shows a number sign on the card itself
    expect(board.textContent).not.toMatch(/#\d/);
  });

  it("opens the pull requests in a popup, each linking to GitHub, and closes it on Escape", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    const icon = within(board).getByRole("button", { name: "Pull requests of The status map: 1 merged, 1 open" });
    fireEvent.click(icon);
    const pop = within(board).getByRole("dialog", { name: "Pull requests · The status map" });
    expect(icon.getAttribute("aria-expanded")).toBe("true");
    const items = within(pop).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("#246");
    expect(items[0]).toHaveTextContent("fix(34): status map colours");
    expect(items[0]).toHaveTextContent("open · factory/40-colours → factory/epic-34");
    expect(items[1]).toHaveTextContent("#240");
    expect(items[1]).toHaveTextContent(/merged .*· factory\/40-the-status-map → factory\/epic-34/);
    expect(within(items[0]!).getByRole("link").getAttribute("href")).toBe("https://github.com/acme/api/pull/246");
    expect(within(items[0]!).getByRole("link").getAttribute("target")).toBe("_blank");
    // the card's own button is untouched: the popup is not inside it
    expect(within(board).getByRole("button", { name: /^The status map:/ }).contains(pop)).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(board).queryByRole("dialog")).toBeNull();
    expect(icon.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the pull requests in the bottom sheet on a phone, not a popup that can leave the screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q === "(max-width: 767px)",
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      show(view);
      const board = await screen.findByLabelText("Build environments");
      fireEvent.click(within(board).getByRole("button", { name: "Pull requests of The status map: 1 merged, 1 open" }));
      const sheet = screen.getByRole("dialog", { name: "Pull requests · The status map" });
      expect(sheet).toHaveClass("sheet");
      expect(document.querySelector(".env-pulls-pop")).toBeNull();
      expect(within(sheet).getAllByRole("listitem")).toHaveLength(2);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("says on a card which branch its last run merged onto, and names the pull requests in the sheet", async () => {
    show(view);
    const board = await screen.findByLabelText("Build environments");
    const epic = within(board).getAllByRole("button", { name: /^Booker status:/ })[0]!;
    expect(epic).toHaveTextContent("Merged 2 pull requests onto factory/epic-34");
    expect(epic.textContent).not.toMatch(/#\d/);
    fireEvent.click(epic);
    const sheet = await screen.findByRole("dialog");
    const merged = within(sheet).getByText(/^Merged:/).closest(".env-merged") as HTMLElement;
    expect(merged).toHaveTextContent("#240 → factory/epic-34, #241 → factory/epic-34");
    expect(within(merged).getByRole("link", { name: "#240" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/240");
  });

  it("words what a run merged by branch", () => {
    const m = (number: number, baseRef: string) => ({ number, title: "", baseRef, url: "" });
    expect(mergedWords([m(1, "factory/epic-193")])).toBe("Merged 1 pull request onto factory/epic-193");
    expect(mergedWords([m(1, "factory/epic-193"), m(2, "factory/epic-193"), m(3, "staging")])).toBe("Merged 2 pull requests onto factory/epic-193, 1 onto staging");
  });

  it("reads a card's state from its turn, its queue and its last run", () => {
    expect(envState(card({ active: { runId: "a", role: "QA", title: null, state: "running", since: null } }))).toBe("running");
    expect(envState(card({ active: { runId: "a", role: "QA", title: null, state: "waiting for a session", since: null } }))).toBe("waiting");
    expect(envState(card({ queue: [{ runId: "a", role: "QA", title: null, state: "waiting", since: null }] }))).toBe("waiting");
    expect(envState(card({ notes: [{ at: null, role: "QA", title: null, outcome: "timeout", summary: "", runId: null }] }))).toBe("failed");
    expect(envState(card({}))).toBe("idle");
  });
});
