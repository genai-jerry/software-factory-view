import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import type { FactoryUsage } from "../types.js";
import { compactTokens, fiveHourPercent, UsageBadge } from "./UsageBadge.js";

function usage(overrides: Partial<FactoryUsage> = {}): FactoryUsage {
  return {
    as_of: "2026-10-30T15:00:00+00:00", window_hours: 5, runs: 14, measured_runs: 9,
    active_runs: 2, total_tokens: 1_412_000, cost_usd: 18.4,
    limit: { reached: false, resets_at: null, waiting_issues: [], message: null },
    rate_limit: null, ...overrides,
  };
}

function show(body: { usage: FactoryUsage | null }) {
  vi.spyOn(api, "get").mockResolvedValue(body);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><UsageBadge /></QueryClientProvider>);
}

describe("UsageBadge", () => {
  it("shows the last five hours' tokens", async () => {
    show({ usage: usage() });
    expect(await screen.findByRole("status")).toHaveTextContent("Claude · 1.4M tokens / 5 h");
  });

  it("says when a usage limit has stopped the factory, and how many wait", async () => {
    show({ usage: usage({ limit: { reached: true, resets_at: "2026-10-30T14:50:00+00:00",
                                   waiting_issues: ["o/a#42", "o/b#11"], message: "…" } }) });
    const badge = await screen.findByRole("status");
    expect(badge).toHaveTextContent(/Claude limit · resets .* · 2 waiting/);
    expect(badge.className).toContain("limit");
    expect(badge.getAttribute("title")).toContain("o/a#42, o/b#11");
  });

  it("shows a share of the allowance only when a run reported one", async () => {
    show({ usage: usage({ rate_limit: { five_hour: { used_percentage: 61.6 } } }) });
    expect(await screen.findByRole("status")).toHaveTextContent("Claude · 62% of 5 h · 1.4M tokens");
  });

  it("renders nothing when the orchestrator cannot say", async () => {
    const { container } = show({ usage: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("formats counts and reads the percentage defensively", () => {
    expect([compactTokens(950), compactTokens(1234), compactTokens(2_500_000)]).toEqual(["950", "1.2k", "2.5M"]);
    expect(fiveHourPercent(null)).toBeNull();
    expect(fiveHourPercent({ five_hour: { used_percentage: "x" } })).toBeNull();
  });
});
