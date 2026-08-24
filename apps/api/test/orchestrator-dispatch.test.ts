import { loadConfig } from "@console/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchFactoryRole, fetchOrchestratorRun, syncDispatchStatus } from "../src/orchestrator-dispatch.js";

const cfg = (over: Record<string, string> = {}) =>
  loadConfig({ CONSOLE_MASTER_KEY: "x", NODE_ENV: "test", ...over } as never);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dispatchFactoryRole", () => {
  it("explains the silent wait when ORCHESTRATOR_URL is unset", async () => {
    const out = await dispatchFactoryRole(cfg(), { owner: "acme", repo: "api", role: "profiler", issue: 7 });
    expect(out.dispatched).toBeUndefined();
    expect(out.dispatchError).toMatch(/ORCHESTRATOR_URL is not set/);
    expect(out.dispatchError).toMatch(/not to :8080/);
  });

  it("POSTs /dispatch and records a queued run log link", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ queued: true, dispatch_id: "dispatch-abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await dispatchFactoryRole(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080/", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      { owner: "acme", repo: "api", role: "profiler", issue: 7 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/dispatch");
    expect(init.headers).toMatchObject({ authorization: "Bearer op-token" });
    expect(JSON.parse(init.body as string)).toEqual({
      owner: "acme",
      repo: "api",
      role: "profiler",
      issue: 7,
    });
    expect(out).toMatchObject({
      dispatched: true,
      dispatchId: "dispatch-abc",
      run: { htmlUrl: "http://127.0.0.1:8080/runs", status: "queued", engine: "software-factory" },
    });
  });

  it("surfaces an unreachable orchestrator instead of failing silently", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const out = await dispatchFactoryRole(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      { owner: "acme", repo: "api", role: "profiler", issue: 7 },
    );
    expect(out.dispatchError).toMatch(/could not reach the orchestrator/);
    expect(out.dispatched).toBeUndefined();
  });

  it("forwards the Console installation token so the orchestrator need not mint a JWT", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ queued: true, dispatch_id: "d1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await dispatchFactoryRole(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      { owner: "acme", repo: "api", role: "profiler", issue: 7, githubToken: "ghs_from_console" },
    );
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
      github_token: "ghs_from_console",
    });
  });

  it("forwards the Console-retained Claude token so the orchestrator does not use a placeholder key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ queued: true, dispatch_id: "d2" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await dispatchFactoryRole(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      {
        owner: "acme",
        repo: "api",
        role: "profiler",
        issue: 7,
        claudeCodeOauthToken: "oauth-from-console",
        anthropicApiKey: "sk-ant-from-console",
      },
    );
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
      claude_code_oauth_token: "oauth-from-console",
      anthropic_api_key: "sk-ant-from-console",
    });
  });
});

describe("syncDispatchStatus", () => {
  it("fails the step when the queued delivery later dies", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ status: "failed", error: "GitHub App private key is not a valid PEM." }), {
          status: 200,
        }),
    );
    const sync = await syncDispatchStatus(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      {
        dispatchId: "dispatch-abc",
        orchestratorUrl: "http://127.0.0.1:8080",
        run: { status: "queued", htmlUrl: "http://127.0.0.1:8080/runs" },
      },
    );
    expect(sync).toMatchObject({
      status: "failed",
      detail: { dispatchError: expect.stringContaining("private key"), run: { conclusion: "failure" } },
    });
  });

  it("leaves a live queued delivery alone", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "processing" }), { status: 200 }));
    expect(
      await syncDispatchStatus(
        cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
        { dispatchId: "dispatch-abc", orchestratorUrl: "http://127.0.0.1:8080", run: { status: "queued" } },
      ),
    ).toBeNull();
  });
});

describe("fetchOrchestratorRun", () => {
  it("proxies GET /runs/{id} with the dispatch token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "ee6a9128-10c0-469c-baa1-3c47b2a08c3c", outcome: "error", error: "no model" }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const got = await fetchOrchestratorRun(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      "ee6a9128-10c0-469c-baa1-3c47b2a08c3c",
    );
    expect(got).toMatchObject({ ok: true, run: { outcome: "error" } });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:8080/runs/ee6a9128-10c0-469c-baa1-3c47b2a08c3c");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer op-token" });
  });

  it("explains a missing orchestrator URL", async () => {
    const got = await fetchOrchestratorRun(cfg(), "abc");
    expect(got).toMatchObject({ error: expect.stringContaining("ORCHESTRATOR_URL"), status: 502 });
  });
});
