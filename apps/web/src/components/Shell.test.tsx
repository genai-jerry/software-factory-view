// The one-row bottom nav (epic 178, task 2; design D2): below 1024px the nav
// shows five items — Work, Decisions, Shape, Investigate, More — and
// Activity lives in the More sheet. The side nav keeps Activity in place.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, SetupStatus } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const { api } = await import("../api.js");
const { Shell, isMorePage } = await import("./Shell.js");
const { FocusProvider } = await import("../lib/filter.js");

const me: Me = { login: "tester", name: "Test User", avatarUrl: null, orgs: [{ id: "org-1", name: "acme", role: "member" }] };

function renderShell(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <FocusProvider>
          <Shell me={me} setup={undefined as SetupStatus | undefined}>
            <p>page</p>
          </Shell>
        </FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bottomNav(): HTMLElement {
  const nav = document.querySelector<HTMLElement>("nav.bottom-nav");
  if (!nav) throw new Error("no bottom nav");
  return nav;
}

/** The nav's own items, in order: its direct children (links and the More button). */
function itemNames(nav: HTMLElement): string[] {
  return Array.from(nav.children).map((el) => (el.textContent ?? "").trim());
}

beforeEach(() => vi.mocked(api.get).mockReset());

describe("bottom nav", () => {
  it("shows exactly five items in order: Work, Decisions, Shape, Investigate, More", () => {
    renderShell();
    expect(itemNames(bottomNav())).toEqual(["Work", "Decisions", "Shape", "Investigate", "More"]);
    expect(within(bottomNav()).queryByRole("link", { name: "Activity" })).toBeNull();
  });

  it("opens a More sheet that lists Activity first", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(within(bottomNav()).getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    const links = within(sheet).getAllByRole("link");
    expect(links[0]).toHaveTextContent("Activity");
    expect(links[0]).toHaveAttribute("href", "/activity");
  });

  it("marks More as active on a page reached through More", () => {
    renderShell("/activity");
    expect(within(bottomNav()).getByRole("button", { name: "More" })).toHaveClass("active");
  });

  it("leaves More inactive on a page in the nav row", () => {
    renderShell("/shape");
    expect(within(bottomNav()).getByRole("button", { name: "More" })).not.toHaveClass("active");
  });
});

describe("side nav", () => {
  it("keeps Activity in place", () => {
    renderShell();
    const side = document.querySelector<HTMLElement>("nav.sidenav")!;
    expect(within(side).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
  });
});

describe("isMorePage", () => {
  it("matches More pages and their sub-paths, not the nav-row pages", () => {
    expect(isMorePage("/activity")).toBe(true);
    expect(isMorePage("/settings")).toBe(true);
    expect(isMorePage("/environments/abc")).toBe(true);
    expect(isMorePage("/")).toBe(false);
    expect(isMorePage("/decisions")).toBe(false);
    expect(isMorePage("/activityx")).toBe(false);
  });
});
