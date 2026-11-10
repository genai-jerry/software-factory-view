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
const phases = [
  { id: "clarify", label: "Clarify", detail: "New work is made clear.", steps: [{ key: "intake", label: "Clarify", detail: "Reads the requirement." }] },
  {
    id: "design",
    label: "Design",
    detail: "Plan, design and test plan.",
    steps: [
      { key: "planner", label: "Plan", detail: "Splits the spec into tasks." },
      { key: "architect", label: "Design", detail: "Writes the design." },
    ],
  },
];
const settings = (canEdit = true, orgChains: Record<string, string[]> = { "phase:design": ["claude-opus-5-5", "claude-sonnet-5-5"] }) => ({
  orgId: "o1",
  orgName: "genai",
  canEdit,
  phases,
  maxChain: 4,
  org: { chains: orgChains, updatedBy: "jerry", updatedAt: "2026-11-10T08:00:00Z" },
  projects: [{ id: "p1", name: "Beacon", chains: {}, updatedBy: null, updatedAt: null }],
});
const listed = {
  ok: true,
  source: "claude-sign-in",
  listedAt: "2026-11-10T08:00:00Z",
  models: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", deprecated: false },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", deprecated: false },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", deprecated: false },
  ],
};

function respond(models: unknown, available: unknown = listed) {
  vi.mocked(api.get).mockImplementation(async (path: string) => (path.includes("/models/available") ? available : models) as never);
}

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
  it("offers the models Claude lists, sets a phase, and a step inside it on its own", async () => {
    respond(settings());
    vi.mocked(api.put).mockResolvedValue({});
    renderPage();
    expect(await screen.findByText(/3 models offered to the factory's Claude sign-in/)).toBeInTheDocument();
    const first = screen.getByLabelText("Design: first choice");
    expect(first).toHaveValue("claude-opus-5-5");
    expect(screen.getAllByRole("option", { name: /Claude Fable 5\.1 — claude-fable-5-1/ }).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: /Set each step \(Plan, Design\)/ }));
    expect(screen.getAllByText("Uses Design: claude-opus-5-5, then claude-sonnet-5-5.")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Design › Plan: first choice"), "claude-fable-5-1");
    await userEvent.selectOptions(screen.getByLabelText("Clarify: first choice"), "claude-sonnet-5-5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/api/orgs/o1/models/org", {
        chains: { "phase:clarify": ["claude-sonnet-5-5"], "phase:design": ["claude-opus-5-5", "claude-sonnet-5-5"], planner: ["claude-fable-5-1"] },
      }),
    );
  });

  it("keeps a saved model Claude no longer offers, and says so", async () => {
    respond(settings(true, { "phase:clarify": ["claude-opus-5"] }));
    renderPage();
    expect(await screen.findByRole("option", { name: "claude-opus-5 (not offered to this credential)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Clarify: first choice")).toHaveValue("claude-opus-5");
  });

  it("falls back to typing an id when Claude cannot list, and can list again", async () => {
    respond(settings(), { ok: false, error: "No Claude credential is stored for the factory yet." });
    renderPage();
    expect(await screen.findByText(/No Claude credential is stored/)).toBeInTheDocument();
    const box = screen.getByLabelText("Clarify: first choice");
    expect(box.tagName).toBe("INPUT");
    await userEvent.type(box, "claude-opus-5-5");
    expect(box).toHaveValue("claude-opus-5-5");
    await userEvent.click(screen.getByRole("button", { name: "List again" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/orgs/o1/models/available?refresh=1"));
  });

  it("shows a project what it inherits from the organisation", async () => {
    respond(settings());
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Set for"), "p1");
    expect(screen.getByLabelText("Design: first choice")).toHaveValue("");
    expect(screen.getByText("Uses the organisation's Design: claude-opus-5-5, then claude-sonnet-5-5.")).toBeInTheDocument();
  });

  it("is read-only for someone who is not an admin", async () => {
    respond(settings(false));
    renderPage();
    expect(await screen.findByLabelText("Design: first choice")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
