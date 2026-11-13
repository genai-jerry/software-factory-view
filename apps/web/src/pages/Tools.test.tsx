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
const projectsData = {
  projects: [
    { id: "p-beacon", orgId: "o1", name: "Beacon", repos: [] },
    { id: "p-lens", orgId: "o1", name: "Lens", repos: [] },
    { id: "p-other", orgId: "o2", name: "Someone else's", repos: [] },
  ],
  unassigned: [],
};
const respond = (servers: unknown[]) => async (path: string) => (path === "/api/projects" ? projectsData : { orgId: "o1", orgName: "Beacon", canEdit: true, servers });

const sarvam = {
  id: "s1",
  name: "sarvam_docs",
  label: "Sarvam docs",
  url: "https://docs.sarvam.ai/_mcp/server",
  transport: "http",
  headerNames: [],
  projectIds: [],
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

  it("scopes a tool to projects with checkboxes, and says what none ticked means", async () => {
    vi.mocked(api.get).mockImplementation(respond([sarvam]));
    vi.mocked(api.patch).mockResolvedValue(sarvam);
    renderPage();
    expect((await screen.findAllByText(/None ticked: every project can use it/)).length).toBe(2); // the server's, and the add form's
    expect(screen.queryByLabelText("Someone else's")).toBeNull(); // only this org's projects
    await userEvent.click(screen.getAllByLabelText("Beacon")[0]!);
    expect(api.patch).toHaveBeenCalledWith("/api/orgs/o1/tools/s1", { projectIds: ["p-beacon"] });
  });

  it("shows a scoped tool's projects, and unticking the last one makes it for everyone", async () => {
    vi.mocked(api.get).mockImplementation(respond([{ ...sarvam, projectIds: ["p-beacon"] }]));
    vi.mocked(api.patch).mockResolvedValue(sarvam);
    renderPage();
    expect(await screen.findByText(/Only conversations and runs in the ticked projects get it/)).toBeInTheDocument();
    const beacon = screen.getAllByLabelText("Beacon")[0] as HTMLInputElement;
    expect(beacon.checked).toBe(true);
    await userEvent.click(beacon);
    expect(api.patch).toHaveBeenCalledWith("/api/orgs/o1/tools/s1", { projectIds: [] });
  });

  it("lets a new server be scoped as it is added", async () => {
    vi.mocked(api.get).mockImplementation(respond([]));
    vi.mocked(api.post).mockResolvedValue(sarvam);
    renderPage();
    await userEvent.type(await screen.findByPlaceholderText("https://…"), "https://logs.example.com/mcp");
    await userEvent.click(screen.getByLabelText("Lens"));
    await userEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/tools", expect.objectContaining({ url: "https://logs.example.com/mcp", projectIds: ["p-lens"] }));
  });

  it("wraps a long server URL inside its own line on a phone screen, not with an inline style", async () => {
    vi.mocked(api.get).mockImplementation(respond([sarvam]) as never);
    renderPage();
    const url = (await screen.findAllByText(/docs\.sarvam\.ai\/_mcp\/server/)).find((el) => el.tagName === "SPAN")!;
    expect(url.className).toContain("wrap-anywhere");
    expect(url.getAttribute("style")).toBeNull();
  });
});
