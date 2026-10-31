import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusProvider } from "../lib/filter.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { NewWorkPage } = await import("./NewWork.js");
const { ActivityPage } = await import("./Activity.js");

/** Add work (board 3) posts the item; Activity (board 3b) lists the lines by day. */

function renderAt(path: string, ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <FocusProvider>
          <Routes>
            <Route path="/work/new" element={ui} />
            <Route path="/activity" element={ui} />
            <Route path="/" element={<p>Work list</p>} />
          </Routes>
        </FocusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith("/api/work/targets"))
      return { targets: [{ id: "r1", fullName: "genai-jerry/beacon-api", projectId: "p", projectName: "Beacon", factoryEnabled: true }, { id: "r2", fullName: "genai-jerry/off", projectId: null, projectName: null, factoryEnabled: false }] };
    if (path.startsWith("/api/activity"))
      return {
        lines: [
          { at: new Date().toISOString(), who: "jerry", person: true, text: "jerry approved the plan for Day-wise.", stage: "clarify", repo: "genai-jerry/beacon-api", epicId: "e1" },
          { at: new Date().toISOString(), who: "The factory", person: false, text: "The factory built task #62 of Day-wise.", stage: "build", repo: "genai-jerry/beacon-api", epicId: "e1" },
        ],
      };
    if (path.startsWith("/api/running")) return { items: [] };
    if (path.startsWith("/api/orchestrator/usage")) return { runs: 3, window_hours: 5, active_runs: 0, limit: { reached: false, resets_at: null } };
    return {};
  });
});

describe("NewWorkPage", () => {
  it("files the item in the chosen repository with the fast lane when asked", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, number: 98, htmlUrl: "https://github.com/x", repo: "genai-jerry/beacon-api" });
    renderAt("/work/new", <NewWorkPage />);
    await userEvent.type(await screen.findByLabelText("What do you want done?"), "Show day-wise calling performance");
    await userEvent.type(screen.getByLabelText("Why, and for whom"), "Setters add it up by hand.");
    // Only factory-enabled repositories are offered.
    expect(screen.queryByRole("option", { name: "off" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Fast\./));
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/work", { repoId: "r1", title: "Show day-wise calling performance", body: "Setters add it up by hand.", fast: true }),
    );
    expect(await screen.findByText("Work list")).toBeInTheDocument();
  });
});

describe("ActivityPage", () => {
  it("lists the lines under today and filters by who", async () => {
    renderAt("/activity", <ActivityPage />);
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("approved the plan for Day-wise.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "People" }));
    expect(screen.queryByText("built task #62 of Day-wise.")).not.toBeInTheDocument();
    expect(screen.getByText("3 runs in the last 5 hours.")).toBeInTheDocument();
  });
});
