import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.js";
import { SettingsPage } from "./Settings.js";

/*
 * Epic #178 spec, "Settings rows on a phone": each repository name and time on
 * a Settings row stays visible at 360px. jsdom cannot measure layout, so this
 * pins the structure the stylesheet relies on — the name and the time sit in
 * their own classed spans, and no inline min-width pushes them off the row.
 * The 360px measurement itself belongs to the phone checks in apps/web/e2e.
 */

const REPO = "genai-jerry/a-really-long-repository-name-for-phones";
const when = "2026-11-13T04:44:00.000Z";

const answers: Record<string, unknown> = {
  "/api/setup/status": {
    configured: true, source: "database", appSlug: "factory", appId: "1", clientId: "c", hasWebhookSecret: true,
    canEditApp: true, hasMasterKey: true, credentialError: null, publicOrigin: "https://compass.example",
    insightEnabled: true, devLogin: false, appReset: false,
  },
  "/api/ops/ingestion": {
    summary: { lastReceivedAt: when, lastProcessedAt: when, pending: 0, failing: 0, total: 2 },
    deliveries: [
      { deliveryGuid: "g1", event: "issues", action: "labeled", repo: REPO, receivedAt: when, processedAt: null, error: "projection failed: 502" },
    ],
    reconciles: [
      { id: "r1", estateName: "acme", trigger: "nightly", startedAt: when, finishedAt: when, reposWalked: 1, issuesSeen: 2, pullsSeen: 3, errors: ["rate limited"] },
    ],
  },
};

function show() {
  vi.spyOn(api, "get").mockImplementation(async (path: string) => {
    if (path in answers) return answers[path];
    throw new Error(`no answer for ${path}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsPage me={{ login: "tester", name: null, avatarUrl: null, orgs: [] }} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Settings rows on a phone", () => {
  it("puts the repository name and the time of a webhook row in their own wrapping spans", async () => {
    const { container } = show();
    const name = await screen.findByText(REPO);
    expect(name.classList).toContain("check-row-name");
    expect(name.classList).toContain("wrap-anywhere");
    const row = name.closest(".check-row")!;
    expect(row.querySelector(".check-row-time")?.textContent).toBe(new Date(when).toLocaleString());
    expect(screen.getByText("projection failed: 502").classList).toContain("check-row-error");
    // No inline width on any row: the stylesheet decides, so a phone can wrap it.
    for (const span of container.querySelectorAll<HTMLElement>(".check-row span")) {
      expect(span.style.minWidth).toBe("");
    }
  });

  it("does the same for the estate name and time of a reconcile row", async () => {
    show();
    const estate = await screen.findByText("acme");
    expect(estate.classList).toContain("check-row-name");
    expect(estate.closest(".check-row")!.querySelector(".check-row-time")).not.toBeNull();
    expect(screen.getByText("rate limited").classList).toContain("check-row-error");
  });
});
