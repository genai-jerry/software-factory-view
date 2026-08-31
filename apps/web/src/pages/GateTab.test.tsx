import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import type { GatePanelData, Me } from "../types.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}));

const { api } = await import("../api.js");
const { GateTab } = await import("./EpicWorkspace.js");

const me: Me = { login: "alice", name: "Alice", avatarUrl: null, orgs: [] };

const panel: GatePanelData = {
  gate: "spec",
  label: "G1",
  state: "factory:spec-ready",
  amApprover: true,
  approvers: [],
  commentApprovable: true,
  documentPrs: [],
  releasePrs: [],
  artifacts: [],
  currentSha: null,
  changedSinceLastView: false,
  lastViewedSha: null,
  openQuestions: [],
};

function renderGate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <GateTab epicId="e1" me={me} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockReset().mockResolvedValue(panel as never);
  vi.mocked(api.post).mockReset().mockResolvedValue({} as never);
});

/**
 * The Decide card sits below a full rendered spec, so a failure reported only
 * at the top of the tab is off-screen: the button reads as doing nothing. Both
 * tests are about the click producing visible feedback where it was clicked.
 */
describe("the approve button reports its own failures", () => {
  it("shows GitHub's refusal beside the button", async () => {
    renderGate();
    const button = await screen.findByRole("button", { name: /Approve as @alice/ });
    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError(403, "GitHub declined to comment on acme/app#7: Resource not accessible by integration"),
    );
    await userEvent.click(button);

    const message = await screen.findByText(/Resource not accessible by integration/);
    expect(message.textContent).toMatch(/Approval was not posted/);
    // Rendered inside the Decide card, alongside the control that failed.
    expect(message.closest(".card")).toBe(button.closest(".card"));
  });

  it("offers the acknowledgement when the guard reports questions the panel did not list", async () => {
    renderGate();
    const button = await screen.findByRole("button", { name: /Approve as @alice/ });
    expect(screen.queryByRole("checkbox")).toBeNull();

    vi.mocked(api.post).mockRejectedValueOnce(
      new ApiError(409, "open questions exist on this gate's artifacts: Proposal", {
        openQuestionCount: 1,
      }),
    );
    await userEvent.click(button);

    const ack = await screen.findByRole("checkbox");
    expect(screen.getByText(/1 open question/)).toBeTruthy();
    // Blocked until acknowledged, then live again.
    await waitFor(() => expect(screen.getByRole("button", { name: /Approve as @alice/ })).toBeDisabled());
    await userEvent.click(ack);
    expect(screen.getByRole("button", { name: /Approve as @alice/ })).toBeEnabled();
  });
});
