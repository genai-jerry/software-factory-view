import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { ModelsPage } = await import("./Models.js");

const me = { login: "jerry", name: null, avatarUrl: null, orgs: [{ id: "o1", name: "genai", role: "owner" }] };
const data = (canEdit = true) => ({
  orgId: "o1",
  orgName: "genai",
  canEdit,
  phases: [
    { key: "shape", label: "Shape", detail: "Talking an idea through.", group: "talk" },
    { key: "implementer", label: "Build", detail: "Writes the code.", group: "build" },
    { key: "reviewer", label: "Review", detail: "Reviews each pull request.", group: "build" },
  ],
  choices: ["claude-opus-5-5", "claude-sonnet-5-5"],
  maxChain: 4,
  org: { chains: { implementer: ["claude-opus-5-5", "claude-sonnet-5-5"] }, updatedBy: "jerry", updatedAt: "2026-11-10T08:00:00Z" },
  projects: [{ id: "p1", name: "Beacon", chains: {}, updatedBy: null, updatedAt: null }],
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelsPage me={me as never} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.put).mockReset();
});

describe("ModelsPage", () => {
  it("shows the organisation's choices and saves a change", async () => {
    vi.mocked(api.get).mockResolvedValue(data());
    vi.mocked(api.put).mockResolvedValue({});
    renderPage();
    expect(await screen.findByLabelText("Build: first choice")).toHaveValue("claude-opus-5-5");
    expect(screen.getByLabelText("Build: if that is unavailable")).toHaveValue("claude-sonnet-5-5");
    expect(screen.getAllByText(/Uses: The repository's file, or the factory's default/).length).toBe(2);

    await userEvent.type(screen.getByLabelText("Review: first choice"), "claude-sonnet-5-5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/orgs/o1/models/org", {
        chains: { implementer: ["claude-opus-5-5", "claude-sonnet-5-5"], reviewer: ["claude-sonnet-5-5"] },
      }),
    );
  });

  it("sets a project's own models, showing the organisation's where it sets none", async () => {
    vi.mocked(api.get).mockResolvedValue(data());
    vi.mocked(api.put).mockResolvedValue({});
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Set for"), "p1");
    expect(screen.getByLabelText("Build: first choice")).toHaveValue("");
    expect(screen.getByText("Uses: Organisation: claude-opus-5-5, then claude-sonnet-5-5")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Shape: first choice"), "claude-opus-5-5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/orgs/o1/models/p1", { chains: { shape: ["claude-opus-5-5"] } }));
  });

  it("is read-only for someone who is not an admin", async () => {
    vi.mocked(api.get).mockResolvedValue(data(false));
    renderPage();
    expect(await screen.findByLabelText("Build: first choice")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
