import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const { api } = await import("../api.js");
const { StagingRelease } = await import("./ReleaseBoard.js");

/** Gate GS once approved: no second Release button; who approved, and what the factory still needs. */
function show(releaseApproved: unknown) {
  vi.mocked(api.get).mockResolvedValue({ gate: "staging", amApprover: true, approvers: [], openQuestions: [], assembly: null, releaseApproved });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StagingRelease data={{ epic: { id: "e1" } } as never} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the staging release once approved", () => {
  it("shows the factory's request instead of the Release button", async () => {
    show({ by: "genai-jerry", at: "2026-11-09T13:43:00Z", ask: "Merge the design document for Beacon's web app.", askLink: "https://github.com/x/web/pull/70" });
    expect(await screen.findByText(/Released to staging by @genai-jerry/)).toBeInTheDocument();
    expect(screen.getByText(/The factory needs you before it can finish: Merge the design document/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open it on GitHub" })).toHaveAttribute("href", "https://github.com/x/web/pull/70");
    expect(screen.queryByRole("button", { name: "Release to staging" })).toBeNull();
  });

  it("says the factory is finishing when it asks nothing", async () => {
    show({ by: "genai-jerry", at: null, ask: null, askLink: null });
    expect(await screen.findByRole("heading", { name: "Release approved" })).toBeInTheDocument();
    expect(screen.getByText(/finishing the last pieces/)).toBeInTheDocument();
  });

  it("offers the release when nobody has approved it", async () => {
    show(null);
    expect(await screen.findByRole("button", { name: "Release to staging" })).toBeInTheDocument();
  });
});
