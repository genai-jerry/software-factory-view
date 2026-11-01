import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShapeConversation, ShapeConversationSummary } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("../lib/filter.js", () => ({
  useFocus: () => ({ project: "", repo: "", setProject: () => undefined, setRepo: () => undefined, qs: "", key: "" }),
}));
const { api } = await import("../api.js");
const { ShapePage } = await import("./Shape.js");

/**
 * Shape: the person's ideas on the left, the conversation in the middle. Pinned:
 * sending uploads the attachment first and then posts the message; an HTML
 * mock in an answer renders in a sandboxed preview; Write the requirement
 * shows the spec; Open as work posts and shows where the item went.
 */

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/shape" element={<ShapePage />} />
          <Route path="/shape/:id" element={<ShapePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const targets = { targets: [{ id: "r1", fullName: "genai-jerry/beacon-web", projectId: "p", projectName: "Beacon", factoryEnabled: true }] };
const summaries: ShapeConversationSummary[] = [
  { id: "c1", title: "Day-wise calling panel", repo: "genai-jerry/beacon-web", repoId: "r1", updatedAt: "2026-11-01T10:00:00Z", hasSpec: false, issueUrl: null },
];
const MOCK_HTML = "<!doctype html><html><body><h1>Leads</h1><p>Day-wise panel</p></body></html>";
const conversation: ShapeConversation = {
  conversation: { id: "c1", title: "Day-wise calling panel", repoId: "r1", repo: "genai-jerry/beacon-web", spec: null, specUpdatedAt: null, issueUrl: null, issueId: null },
  messages: [
    { id: "m1", role: "user", body: "Show me the leads page with a day-wise panel", bodyHtml: "", mocks: [], attachments: [], createdAt: "2026-11-01T10:00:00Z" },
    {
      id: "m2",
      role: "assistant",
      body: "Here is the page with the panel.",
      bodyHtml: "<p>Here is the page with the panel.</p>",
      mocks: [{ html: MOCK_HTML }],
      attachments: [],
      createdAt: "2026-11-01T10:01:00Z",
    },
  ],
};

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/api/shape") return { conversations: summaries };
    if (path === "/api/work/targets") return targets;
    if (path === "/api/shape/c1") return conversation;
    if (path.startsWith("/api/board")) return { columns: [], cards };
    return {};
  });
});

const cards = [
  { epicId: "e35", number: 35, title: "Day-wise calling performance", repo: "genai-jerry/beacon-api", estateId: "s", state: "factory:design-approved", open: true, daysInState: 1, blocked: false, expedited: false, tasks: {} },
  { epicId: "t62", number: 62, title: "task(35): compute counts", repo: "genai-jerry/beacon-api", estateId: "s", state: "factory:ready", open: true, daysInState: 1, blocked: false, expedited: false, tasks: {} },
];

describe("ShapePage", () => {
  it("lists the person's ideas and opens a new one in the chosen repository", async () => {
    vi.mocked(api.post).mockResolvedValue({ id: "c9" });
    renderAt("/shape");
    expect(await screen.findByRole("link", { name: /Day-wise calling panel/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New idea" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape", { repoId: "r1" }));
  });

  it("renders an answer's mock in a sandboxed preview, with the code one toggle away", async () => {
    renderAt("/shape/c1");
    expect(await screen.findByText("Here is the page with the panel.")).toBeInTheDocument();
    const frame = screen.getByTitle(/^Mock \d+$/) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toBe(MOCK_HTML);
    expect(frame.getAttribute("sandbox")).toBe("");
    await userEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByText(/Day-wise panel<\/p>/)).toBeInTheDocument();
  });

  it("uploads the attachment first, then posts the message with its id", async () => {
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith("/attachments")) return { id: "a1", name: "shot.png", mime: "image/png", url: "/api/shape/attachments/a1" };
      if (path.endsWith("/messages")) return { message: conversation.messages[1], conversation: { title: "Day-wise calling panel" } };
      return {};
    });
    renderAt("/shape/c1");
    await screen.findByText("Here is the page with the panel.");
    const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Attach images"), file);
    expect(await screen.findByAltText("shot.png")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your message"), "Make the panel match this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/messages", { text: "Make the panel match this", attachmentIds: ["a1"] }));
    const calls = vi.mocked(api.post).mock.calls.map((c) => c[0]);
    expect(calls.indexOf("/api/shape/c1/attachments")).toBeLessThan(calls.indexOf("/api/shape/c1/messages"));
    expect(vi.mocked(api.post).mock.calls.find((c) => c[0] === "/api/shape/c1/attachments")?.[1]).toMatchObject({ name: "shot.png", mime: "image/png", dataB64: expect.any(String) });
  });

  it("writes the requirement and shows it beside the conversation", async () => {
    const spec = "## What should be built?\n- A day-wise panel beside the monthly table.\n## Open questions\n1. Which time zone?";
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith("/spec")) {
        vi.mocked(api.get).mockImplementation(async (p: string) => {
          if (p === "/api/shape") return { conversations: summaries };
          if (p === "/api/work/targets") return targets;
          if (p === "/api/shape/c1") return { ...conversation, conversation: { ...conversation.conversation, spec } };
          return {};
        });
        return { spec };
      }
      return {};
    });
    renderAt("/shape/c1");
    await screen.findByText("Here is the page with the panel.");
    await userEvent.click(screen.getByRole("button", { name: "Write the requirement" }));
    const panel = await screen.findByRole("complementary", { name: "Requirement" });
    await waitFor(() => expect(within(panel).getByText("A day-wise panel beside the monthly table.")).toBeInTheDocument());
    expect(within(panel).getByText("Which time zone?")).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith("/api/shape/c1/spec");
  });

  it("opens the requirement as work and shows where it went", async () => {
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1") return { ...conversation, conversation: { ...conversation.conversation, spec: "## What should be built?\n- A panel." } };
      return {};
    });
    vi.mocked(api.post).mockResolvedValue({ number: 120, htmlUrl: "https://github.com/genai-jerry/beacon-web/issues/120", epicId: "e120" });
    renderAt("/shape/c1");
    await screen.findByText("Here is the page with the panel.");
    await userEvent.click(screen.getByRole("button", { name: "Open as work" }));
    const form = screen.getByRole("region", { name: "Open as work" });
    await userEvent.click(within(form).getByRole("checkbox"));
    await userEvent.click(within(form).getByRole("button", { name: "Open it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/work", { title: "Day-wise calling panel", fast: true }));
    const banner = await screen.findByRole("status");
    expect(within(banner).getByRole("link", { name: "Day-wise calling panel" })).toHaveAttribute("href", "/work/e120");
  });

  it("starts an idea about an epic, and says so at the top of the conversation", async () => {
    vi.mocked(api.post).mockResolvedValue({ id: "c35" });
    renderAt("/shape");
    await screen.findByRole("link", { name: /Day-wise calling panel/ });
    await userEvent.click(screen.getByRole("radio", { name: "About an epic" }));
    const pick = (await screen.findByLabelText("Which epic")) as HTMLSelectElement;
    // Only epics are offered, never their tasks.
    expect(Array.from(pick.options).map((o) => o.textContent)).toEqual(["Day-wise calling performance"]);
    await userEvent.click(screen.getByRole("button", { name: "New idea" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape", { epicId: "e35" }));
  });

  it("shows which epic a conversation is about and offers the epic's questions", async () => {
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1")
        return {
          conversation: { ...conversation.conversation, epic: { id: "e35", number: 35, title: "Day-wise calling performance", state: "factory:design-approved" } },
          messages: [],
        };
      return {};
    });
    renderAt("/shape/c1");
    expect(await screen.findByRole("link", { name: "Day-wise calling performance" })).toHaveAttribute("href", "/work/e35");
    expect(screen.getByText(/reads its branch and documents/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What is left before this ships?" })).toBeInTheDocument();
    expect(screen.queryByText(/reads the latest main/)).toBeNull();
  });
});
