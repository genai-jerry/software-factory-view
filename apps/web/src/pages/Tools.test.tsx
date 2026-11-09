import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { ToolsPage } = await import("./Tools.js");

const me = { login: "jerry", name: null, avatarUrl: null, orgs: [{ id: "o1", name: "Beacon", role: "owner" }] };

const sarvam = {
  id: "s1",
  name: "sarvam_docs",
  label: "Sarvam docs",
  url: "https://docs.sarvam.ai/_mcp/server",
  transport: "http",
  headerNames: [],
  tools: [
    { name: "searchDocs", title: "Search docs.sarvam.ai Docs", description: "Search the documentation", readOnly: true, allowed: true },
    { name: "reindex", readOnly: false, allowed: false },
  ],
  useShape: true,
  useAsk: true,
  useBuild: true,
  enabled: true,
  checkedAt: "2026-11-09T08:00:00Z",
  checkError: null,
  updatedBy: "jerry",
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToolsPage me={me} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const f of [api.get, api.post, api.patch, api.del]) vi.mocked(f).mockReset();
});

describe("the Tools page", () => {
  it("shows a server's tools, where it is used, and how many are allowed", async () => {
    vi.mocked(api.get).mockResolvedValue({ orgId: "o1", orgName: "Beacon", canEdit: true, servers: [sarvam] });
    renderPage();
    expect(await screen.findByText("Search docs.sarvam.ai Docs")).toBeTruthy();
    expect(screen.getByText(/1 of 2 allowed/)).toBeTruthy();
    expect((screen.getByLabelText(/Builds/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("can change things")).toBeTruthy();
  });

  it("allows a tool with one click", async () => {
    vi.mocked(api.get).mockResolvedValue({ orgId: "o1", orgName: "Beacon", canEdit: true, servers: [sarvam] });
    vi.mocked(api.patch).mockResolvedValue(sarvam);
    renderPage();
    await userEvent.click(await screen.findByRole("checkbox", { name: /reindex/ }));
    expect(api.patch).toHaveBeenCalledWith("/api/orgs/o1/tools/s1", { tools: { reindex: true } });
  });

  it("adds a server by URL and shows why it could not", async () => {
    const { ApiError } = await import("../api.js");
    vi.mocked(api.get).mockResolvedValue({ orgId: "o1", orgName: "Beacon", canEdit: true, servers: [] });
    vi.mocked(api.post).mockRejectedValue(new ApiError(422, "Compass could not list this server's tools: the server answered 405."));
    renderPage();
    await userEvent.type(await screen.findByPlaceholderText("https://…"), "https://docs.sarvam.ai/nope");
    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/tools", { label: "", url: "https://docs.sarvam.ai/nope", transport: "http", headers: [] });
    expect(await screen.findByText(/the server answered 405/)).toBeTruthy();
  });

  it("lets a member look but not change", async () => {
    vi.mocked(api.get).mockResolvedValue({ orgId: "o1", orgName: "Beacon", canEdit: false, servers: [sarvam] });
    renderPage();
    expect(await screen.findByText(/An org admin adds and changes tools/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /reindex/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add server" })).toBeNull();
  });
});
