import { loadConfig } from "../src/config.js";
import { postOrchestratorGitHubEvent } from "../src/orchestrator-client.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const cfg = (over: Record<string, string> = {}) =>
  loadConfig({ CONSOLE_MASTER_KEY: "x", NODE_ENV: "test", ...over } as never);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("postOrchestratorGitHubEvent", () => {
  it("skips when ORCHESTRATOR_URL is unset", async () => {
    const out = await postOrchestratorGitHubEvent(cfg(), {
      event: "issues",
      payload: { action: "opened" },
      deliveryGuid: "g1",
    });
    expect(out).toEqual({ skipped: true });
  });

  it("POSTs /events with the GitHub delivery id and does not put the Claude token in the payload", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ queued: true, delivery_guid: "g1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await postOrchestratorGitHubEvent(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080/", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      {
        event: "issues",
        payload: { action: "labeled", issue: { number: 102 } },
        deliveryGuid: "g1",
        githubToken: "ghs_from_console",
        claudeCodeOauthToken: "oauth-secret",
      },
    );

    expect(out).toEqual({ queued: true, deliveryGuid: "g1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/events");
    expect(init.headers).toMatchObject({ authorization: "Bearer op-token" });
    expect(JSON.parse(init.body as string)).toEqual({
      event: "issues",
      payload: { action: "labeled", issue: { number: 102 } },
      delivery_guid: "g1",
      github_token: "ghs_from_console",
      claude_code_oauth_token: "oauth-secret",
      console_url: "http://localhost:5173",
    });
  });

  it("surfaces an unreachable orchestrator so the worker can retry", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const out = await postOrchestratorGitHubEvent(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      { event: "issues", payload: {}, deliveryGuid: "g1" },
    );
    expect(out).toMatchObject({ error: expect.stringContaining("could not reach the orchestrator") });
  });
});
