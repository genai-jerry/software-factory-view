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
const focusState = vi.hoisted(() => ({ project: "", setProject: (_id: string) => undefined as void }));
vi.mock("../lib/filter.js", () => ({
  useFocus: () => ({ project: focusState.project, repo: "", setProject: (id: string) => focusState.setProject(id), setRepo: () => undefined, qs: "", key: "" }),
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
          <Route path="/investigate" element={<ShapePage kind="investigate" />} />
          <Route path="/investigate/:id" element={<ShapePage kind="investigate" />} />
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

  it("offers the whole project when it has more than one repository, and opens the work where the person picks", async () => {
    const two = {
      targets: [
        { id: "r1", fullName: "genai-jerry/beacon-web", projectId: "p", projectName: "Beacon", factoryEnabled: true },
        { id: "r2", fullName: "genai-jerry/beacon-api", projectId: "p", projectName: "Beacon", factoryEnabled: true },
      ],
    };
    const spanning: ShapeConversation = {
      ...conversation,
      conversation: {
        ...conversation.conversation,
        scope: "project",
        repoId: "r2",
        project: { id: "p", name: "Beacon", repos: [{ id: "r2", fullName: "genai-jerry/beacon-api" }, { id: "r1", fullName: "genai-jerry/beacon-web" }] },
        spec: "## What should be built?\n- A shared status.",
      },
    };
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: [{ ...summaries[0]!, scope: "project", projectName: "Beacon" }] };
      if (p === "/api/work/targets") return two;
      if (p === "/api/shape/c1") return spanning;
      if (p.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (p: string) => (p === "/api/shape" ? { id: "c9" } : { number: 121, htmlUrl: "https://github.com/genai-jerry/beacon-web/issues/121" }));
    renderAt("/shape/c1");
    expect(await screen.findByText("Here is the page with the panel.")).toBeInTheDocument();
    expect(screen.getAllByText("All of Beacon").length).toBeGreaterThan(0);
    expect(screen.getByText(/reads the latest main of every repository in Beacon/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open as work" }));
    const form = screen.getByRole("dialog", { name: "Open as work" });
    await userEvent.selectOptions(within(form).getByLabelText("Where it opens"), "beacon-web");
    await userEvent.click(within(form).getByRole("button", { name: "Open it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/work", { title: "Day-wise calling panel", fast: false, repoId: "r1" }));

    // A new idea across the whole project (this navigates away from the conversation).
    await userEvent.selectOptions(screen.getByLabelText("Which product"), "All of Beacon");
    await userEvent.click(screen.getByRole("button", { name: "New idea" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape", { projectId: "p" }));
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

  it("shows the OpenSpec draft one file per fold, the proposal open", async () => {
    const spec = [
      "## Problem / need\nLeads get asked to confirm twice.",
      "## OpenSpec change: appointment-continuity",
      "````openspec proposal.md\n## Why\nA lead confirms once.\n````",
      "````openspec specs/appointment-continuity/spec.md\n### Requirement: Confirm once\n#### Scenario: Reschedule\n- **WHEN** the CRM moves the call\n- **THEN** no confirmation is sent\n````",
    ].join("\n\n");
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1") return { ...conversation, conversation: { ...conversation.conversation, spec } };
      return {};
    });
    renderAt("/shape/c1");
    await screen.findByText("Here is the page with the panel.");
    await userEvent.click(screen.getByRole("button", { name: "Show the requirement" }));
    const panel = await screen.findByRole("complementary", { name: "Requirement" });
    expect(within(panel).getByText("Leads get asked to confirm twice.")).toBeInTheDocument();
    expect(within(panel).getByText("appointment-continuity")).toBeInTheDocument();
    const proposal = within(panel).getByText("proposal.md").closest("details")!;
    const specFile = within(panel).getByText("specs/appointment-continuity/spec.md").closest("details")!;
    expect(proposal).toHaveAttribute("open");
    expect(specFile).not.toHaveAttribute("open");
    expect(within(specFile).getByText("WHEN").tagName).toBe("STRONG");
    // The fences themselves never show.
    expect(panel.textContent).not.toContain("````");
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
    const form = screen.getByRole("dialog", { name: "Open as work" });
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

describe("ShapePage answers in the background", () => {
  const pendingReply = { ...conversation.messages[1]!, id: "m3", body: "", bodyHtml: "", mocks: [], status: "pending" as const, error: null };
  const doneReply = { ...pendingReply, body: "It lives in the leads list component.", bodyHtml: "<p>It lives in the leads list component.</p>", status: "done" as const };

  it("shows the thinking bubble at once, polls, and swaps in the answer when it lands", async () => {
    let answered = false;
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1") {
        const extra = answered ? doneReply : pendingReply;
        return { ...conversation, messages: [...conversation.messages, { ...conversation.messages[0]!, id: "u2", body: "Where does it live?" }, extra] };
      }
      return {};
    });
    vi.mocked(api.post).mockResolvedValue({ message: pendingReply, conversation: { title: "Day-wise calling panel" } });
    renderAt("/shape/c1");
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    // The composer waits while the answer is written.
    expect(screen.getByLabelText("Your message")).toBeDisabled();
    expect(screen.getByLabelText("Your message")).toHaveAttribute("placeholder", "Waiting for the answer…");
    answered = true;
    expect(await screen.findByText("It lives in the leads list component.", {}, { timeout: 6_000 })).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.getByLabelText("Your message")).toBeEnabled();
  }, 10_000);

  it("shows why an answer failed and tries it again on request", async () => {
    const failed = { ...pendingReply, status: "failed" as const, error: "No model in the preference chain for 'ask' is accessible" };
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1") return { ...conversation, messages: [...conversation.messages, failed] };
      return {};
    });
    vi.mocked(api.post).mockResolvedValue({ message: pendingReply, conversation: { title: "Day-wise calling panel" } });
    renderAt("/shape/c1");
    expect(await screen.findByText(/No model in the preference chain/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/messages/m3/retry", {}));
  });

  it("says the requirement is being written, then shows it", async () => {
    let phase: "idle" | "pending" | "done" = "idle";
    vi.mocked(api.get).mockImplementation(async (p: string) => {
      if (p === "/api/shape") return { conversations: summaries };
      if (p === "/api/work/targets") return targets;
      if (p === "/api/shape/c1")
        return phase === "done"
          ? { ...conversation, conversation: { ...conversation.conversation, spec: "## What should be built?\n- A panel.", specStatus: "done" } }
          : { ...conversation, conversation: { ...conversation.conversation, specStatus: phase } };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path.endsWith("/spec")) {
        phase = "pending";
        return { specStatus: "pending" };
      }
      return {};
    });
    renderAt("/shape/c1");
    await screen.findByText("Here is the page with the panel.");
    await userEvent.click(screen.getByRole("button", { name: "Write the requirement" }));
    expect(await screen.findByText(/Writing the requirement…/)).toBeInTheDocument();
    phase = "done";
    // The next poll swaps the waiting panel for the written requirement.
    await waitFor(() => expect(screen.getByText("A panel.")).toBeInTheDocument(), { timeout: 6_000 });
    expect(screen.queryByText(/Writing the requirement…/)).toBeNull();
  }, 10_000);
});

describe("ShapePage for a new product", () => {
  it("offers something new, and starts it with no repository", async () => {
    vi.mocked(api.post).mockResolvedValue({ id: "c9" });
    renderAt("/shape");
    await userEvent.selectOptions(await screen.findByLabelText("Which product"), "Something new (no repository yet)");
    expect(screen.getByText(/Claude reads no code/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New idea" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape", { newProduct: true }));
  });

  it("turns an idea about Beacon into a new product", async () => {
    vi.mocked(api.post).mockResolvedValue({ scope: "new" });
    renderAt("/shape/c1");
    await userEvent.click(await screen.findByRole("button", { name: /Not about beacon-web\? Treat it as a new product/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/new-product", {}));
  });

  it("shows a new product as such, and makes the person pick where the work opens", async () => {
    const fresh: ShapeConversation = {
      conversation: { ...conversation.conversation, scope: "new", repo: null, repoId: null, spec: "## What should be built?\nA translator.", homes: [{ id: "r1", fullName: "genai-jerry/beacon-web" }] },
      messages: conversation.messages,
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: [{ ...summaries[0]!, scope: "new", repo: null, repoId: null }] };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return fresh;
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockResolvedValue({ number: 1, htmlUrl: "https://github.com/genai-jerry/beacon-web/issues/1" });
    renderAt("/shape/c1");
    expect(await screen.findByText(/shaped from scratch/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Treat it as a new product/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open as work" }));
    expect(screen.getByText(/A new product usually gets its own repository/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/work", { title: "Day-wise calling panel", fast: false, repoId: "r1" }));
  });

  it("creates a repository for the new product, then opens the work in it", async () => {
    const fresh: ShapeConversation = {
      conversation: { ...conversation.conversation, title: "Lens — camera translator", orgId: "o1", scope: "new", repo: null, repoId: null, spec: "## What should be built?\nA translator.", homes: [] },
      messages: conversation.messages,
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: [] };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return fresh;
      if (path === "/api/orgs/o1/repo-homes")
        return { canEdit: true, accounts: [{ estateId: "e1", login: "genai-jerry", type: "User", canCreate: true }, { estateId: "e2", login: "other", type: "User", canCreate: false }] };
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === "/api/orgs/o1/repos") return { repoId: "r9", fullName: "genai-jerry/lens-camera-translator", setUp: true };
      return { number: 1, htmlUrl: "https://github.com/genai-jerry/lens-camera-translator/issues/1" };
    });
    renderAt("/shape/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Open as work" }));
    expect(await screen.findByLabelText("Repository name")).toHaveValue("lens-camera-translator");
    expect(screen.queryByRole("option", { name: "other" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Create the repository and open it" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/repos", {
        estateId: "e1",
        name: "lens-camera-translator",
        description: "Lens — camera translator",
        private: true,
        projectName: "Lens camera translator", // from the repository's name, editable
      }),
    );
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/work", { title: "Lens — camera translator", fast: false, repoId: "r9" }));
  });

  it("puts a repository made while in a project into that project, and can make a new one", async () => {
    focusState.project = "p";
    try {
      const fresh: ShapeConversation = {
        conversation: { ...conversation.conversation, title: "Beacon mobile", orgId: "o1", scope: "new", repo: null, repoId: null, spec: "## What\nAn app.", homes: [] },
        messages: conversation.messages,
      };
      vi.mocked(api.get).mockImplementation(async (path: string) => {
        if (path === "/api/shape") return { conversations: [] };
        if (path === "/api/work/targets") return targets;
        if (path === "/api/shape/c1") return fresh;
        if (path === "/api/orgs/o1/repo-homes") return { canEdit: true, accounts: [{ estateId: "e1", login: "genai-jerry", type: "User", canCreate: true }] };
        if (path.startsWith("/api/board")) return { columns: [], cards };
        return {};
      });
      vi.mocked(api.post).mockImplementation(async (path: string) =>
        path === "/api/orgs/o1/repos" ? { repoId: "r9", fullName: "genai-jerry/beacon-mobile", setUp: true, projectId: "p" } : { number: 1, htmlUrl: "https://github.com/x/1" },
      );
      renderAt("/shape/c1");
      await userEvent.click(await screen.findByRole("button", { name: "Open as work" }));
      expect(await screen.findByLabelText("Project")).toHaveValue("p");
      expect(screen.getByRole("option", { name: "Beacon (the project you are in)" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Create the repository and open it" }));
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/repos", expect.objectContaining({ projectName: "Beacon" })));
    } finally {
      focusState.project = "";
    }
  });

  it("shows Claude's proposed repository as a card, and creates it only when the person confirms", async () => {
    const proposing: ShapeConversation = {
      conversation: { ...conversation.conversation, title: "Lens", orgId: "o1", scope: "new", repo: null, repoId: null, homes: [] },
      messages: [
        conversation.messages[0]!,
        {
          ...conversation.messages[1]!,
          mocks: [],
          bodyHtml: "<p>Proposed a repository.</p>",
          repoProposal: { name: "lens", description: "Camera translator", private: true, project: "new" },
        },
      ],
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: [] };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return proposing;
      if (path === "/api/orgs/o1/repo-homes") return { canEdit: true, accounts: [{ estateId: "e1", login: "genai-jerry", type: "User", canCreate: true }] };
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (path: string) =>
      path === "/api/orgs/o1/repos" ? { repoId: "r9", fullName: "genai-jerry/lens", htmlUrl: "https://github.com/genai-jerry/lens", setUp: true } : { repoId: "r9", repo: "genai-jerry/lens" },
    );
    renderAt("/shape/c1");
    const card = await screen.findByRole("region", { name: "Proposed repository" });
    expect(await within(card).findByLabelText("Repository name")).toHaveValue("lens");
    expect(within(card).getByLabelText("Project")).toHaveValue(""); // "new": a project of its own
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Create it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/repos", expect.objectContaining({ name: "lens", description: "Camera translator", private: true })));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/repo", { repoId: "r9" }));
    expect(await screen.findByText(/The idea now lives there/)).toBeInTheDocument();
  });

  it("opens the idea as work from Claude's proposal: writes the requirement first, then opens it", async () => {
    let specStatus: "idle" | "pending" | "done" = "idle";
    const proposing = (): ShapeConversation => ({
      conversation: { ...conversation.conversation, spec: specStatus === "done" ? "## What\nA translator." : null, specStatus },
      messages: [
        conversation.messages[0]!,
        { ...conversation.messages[1]!, mocks: [], bodyHtml: "<p>Ready.</p>", workProposal: { title: "Mirror: camera translator", fast: false } },
      ],
    });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: summaries };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return proposing();
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (path: string) => {
      if (path === "/api/shape/c1/spec") {
        specStatus = "done";
        return { specStatus: "pending" };
      }
      return { number: 5, htmlUrl: "https://github.com/genai-jerry/beacon-web/issues/5" };
    });
    renderAt("/shape/c1");
    const card = await screen.findByRole("region", { name: "Open as work" });
    expect(within(card).getByLabelText("Name it")).toHaveValue("Mirror: camera translator");
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole("button", { name: "Write the requirement and open it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/spec"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape/c1/work", { title: "Mirror: camera translator", fast: false }), { timeout: 8_000 });
    const order = vi.mocked(api.post).mock.calls.map((c) => c[0]);
    expect(order.indexOf("/api/shape/c1/spec")).toBeLessThan(order.indexOf("/api/shape/c1/work"));
  }, 12_000);

  it("says what to do next, and that a typed yes does not act on a proposal", async () => {
    const waiting: ShapeConversation = {
      conversation: { ...conversation.conversation, orgId: "o1" },
      messages: [conversation.messages[0]!, { ...conversation.messages[1]!, mocks: [], workProposal: { title: "Panel", fast: false } }],
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: summaries };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return waiting;
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    renderAt("/shape/c1");
    expect(await screen.findByText(/press its button\. Replying “yes” in the chat does not do it/)).toBeInTheDocument();
  });

  it("disables the proposal's button while the requirement is being written", async () => {
    const writing: ShapeConversation = {
      conversation: { ...conversation.conversation, orgId: "o1", specStatus: "pending" },
      messages: [conversation.messages[0]!, { ...conversation.messages[1]!, mocks: [], workProposal: { title: "Panel", fast: false } }],
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: summaries };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return writing;
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    renderAt("/shape/c1");
    const card = await screen.findByLabelText("Open as work");
    expect(within(card).getByRole("button", { name: "Writing the requirement…" })).toBeDisabled();
  });

  it("lets the person name a new project, starting from the repository's name", async () => {
    const fresh: ShapeConversation = {
      conversation: { ...conversation.conversation, title: "Mirror", orgId: "o1", scope: "new", repo: null, repoId: null, spec: "## What\nAn app.", homes: [] },
      messages: conversation.messages,
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape") return { conversations: [] };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return fresh;
      if (path === "/api/orgs/o1/repo-homes") return { canEdit: true, accounts: [{ estateId: "e1", login: "genai-jerry", type: "User", canCreate: true }] };
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
    vi.mocked(api.post).mockImplementation(async (path: string) =>
      path === "/api/orgs/o1/repos" ? { repoId: "r9", fullName: "genai-jerry/mirror", setUp: true } : { number: 1, htmlUrl: "https://github.com/x/1" },
    );
    renderAt("/shape/c1");
    await userEvent.click(await screen.findByRole("button", { name: "Open as work" }));
    const name = await screen.findByLabelText("Project name");
    expect(name).toHaveValue("Mirror");
    await userEvent.clear(name);
    await userEvent.type(name, "Mirror translator");
    await userEvent.click(screen.getByRole("button", { name: "Create the repository and open it" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/orgs/o1/repos", expect.objectContaining({ name: "mirror", projectName: "Mirror translator" })));
  });
});

describe("Investigate", () => {
  const found: ShapeConversation = {
    conversation: { ...conversation.conversation, kind: "investigate", title: "Replies vanished", orgId: "o1", spec: null },
    messages: [],
  };
  const open = (tools: unknown) => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/shape?kind=investigate") return { conversations: [{ ...summaries[0]!, kind: "investigate", title: "Replies vanished" }] };
      if (path === "/api/work/targets") return targets;
      if (path === "/api/shape/c1") return found;
      if (path === "/api/orgs/o1/tools") return tools;
      if (path.startsWith("/api/board")) return { columns: [], cards };
      return {};
    });
  };

  it("starts an investigation in a running product: no epic, no 'something new'", async () => {
    open({ servers: [] });
    vi.mocked(api.post).mockResolvedValue({ id: "i9" });
    renderAt("/investigate");
    expect((await screen.findAllByRole("heading", { name: "Investigate a problem" })).length).toBeGreaterThan(0);
    expect(screen.queryByText("About an epic")).toBeNull();
    expect(await screen.findByLabelText("Where did it happen")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Something new/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "New investigation" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/shape", { repoId: "r1", kind: "investigate" }));
  });

  it("talks about logs and fix plans, and says when no log tool is connected", async () => {
    open({ servers: [] });
    renderAt("/investigate/c1");
    expect(await screen.findByRole("button", { name: "Write the fix plan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Investigate" })).toHaveAttribute("href", "/investigate");
    expect(screen.getByText(/Claude searches the production logs and reads the code/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "What errors repeated most in the last 24 hours?" })).toBeInTheDocument();
    expect(await screen.findByText(/No tool is connected, so Claude can read the code but not the production logs/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Treat it as a new product/ })).toBeNull();
  });

  it("does not nag when a tool is connected", async () => {
    open({ servers: [{ enabled: true, useShape: true }] });
    renderAt("/investigate/c1");
    await screen.findByRole("button", { name: "Write the fix plan" });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/orgs/o1/tools"));
    expect(screen.queryByText(/No tool is connected/)).toBeNull();
  });
});

