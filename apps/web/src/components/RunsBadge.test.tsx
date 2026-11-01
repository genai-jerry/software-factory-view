import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const { api } = await import("../api.js");
const { RunsBadge, runLine } = await import("./RunsBadge.js");

function renderIn(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.mocked(api.get).mockReset());

describe("RunsBadge", () => {
  it("counts the live runs and lists them on a click, each opening its run", async () => {
    vi.mocked(api.get).mockResolvedValue({
      running: [
        { issueId: "e36", number: 36, title: "Bug : Check issue and find a fix", repo: "genai-jerry/beacon-api", kind: "epic", role: "release", runId: "r1", epicId: "e36", epicNumber: 36, epicTitle: "Bug : Check issue and find a fix" },
        { issueId: "t62", number: 62, title: "task(35): compute counts", repo: "genai-jerry/beacon-api", kind: "task", role: "implementer", runId: null, epicId: "e35", epicNumber: 35, epicTitle: "Day-wise" },
      ],
    });
    renderIn(<RunsBadge />);
    const pill = await screen.findByRole("button", { name: /2 running/ });
    await userEvent.click(pill);
    const pop = screen.getByRole("dialog", { name: "Running now" });
    expect(pop).toHaveTextContent("Release manager on Bug : Check issue and find a fix");
    expect(pop).toHaveTextContent("the task “compute counts” of Day-wise");
    expect(screen.getByRole("link", { name: /Release manager on Bug/ })).toHaveAttribute("href", "/runs/r1");
    expect(screen.getByRole("link", { name: /compute counts/ })).toHaveAttribute("href", "/work/e35");
  });

  it("says the factory is idle when nothing runs", async () => {
    vi.mocked(api.get).mockResolvedValue({ running: [] });
    renderIn(<RunsBadge />);
    expect(await screen.findByRole("button", { name: /Factory idle/ })).toBeInTheDocument();
  });

  it("names a task run by its task and epic", () => {
    expect(runLine({ issueId: "t", number: 1, title: "task(9): add renewals", repo: "a/b", kind: "task", role: "qa", epicId: "e", epicNumber: 9, epicTitle: "Renewals" })).toEqual({
      who: "Tester",
      what: "the task “add renewals” of Renewals",
    });
  });
});
