import { loadConfig } from "@console/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK_GONE, askOrchestrator, dispatchFactoryRole, fetchOrchestratorRun, orchestratorClock, syncDispatchStatus } from "../src/orchestrator-dispatch.js";

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
      console_url: "http://localhost:5173",
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

  it("forwards the GitHub App installation id so the orchestrator can mint a token at action time", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ queued: true, dispatch_id: "d1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await dispatchFactoryRole(
      cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" }),
      { owner: "acme", repo: "api", role: "profiler", issue: 7, installationId: 99 },
    );
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
      installation_id: 99,
      console_url: "http://localhost:5173",
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

  // The ledger's SQLite hands back the clock bare; a browser would read
  // "2026-11-05 06:01:48" as local time and show a four-minute run as
  // hours long. The proxy says UTC. A zoned value is left as it means.
  it("reads a bare orchestrator clock as UTC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: "r1", outcome: "running", started_at: "2026-11-05 06:01:48.213069", finished_at: null }),
            { status: 200 },
          ),
      ),
    );
    const got = await fetchOrchestratorRun(cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "t" }), "r1");
    expect(got).toMatchObject({ ok: true, run: { started_at: "2026-11-05T06:01:48.213Z", finished_at: null } });
    expect(orchestratorClock("2026-11-05T11:31:48+05:30")).toBe("2026-11-05T06:01:48.000Z");
    expect(orchestratorClock("2026-11-05T06:01:48Z")).toBe("2026-11-05T06:01:48.000Z");
    expect(orchestratorClock("not a clock")).toBe("not a clock");
    expect(orchestratorClock(null)).toBeNull();
  });
});

describe("askOrchestrator", () => {
  const live = () => cfg({ ORCHESTRATOR_URL: "http://127.0.0.1:8080", ORCHESTRATOR_DISPATCH_TOKEN: "op-token" });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  /** An orchestrator that answers each GET /asks/{id} with the next of `states`, then the last one. */
  function orchestrator(states: Array<Record<string, unknown> | Error>, submit = json(202, { status: "running" })) {
    const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    let i = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/asks")) return submit;
      if (url.endsWith("/ask")) return json(200, { answer: "Answered while it waited.", model: "m" });
      const state = states[Math.min(i++, states.length - 1)]!;
      if (state instanceof Error) throw state;
      return json(200, state);
    });
    return seen;
  }

  it("hands the question over as a background ask and collects the answer, holding no request open", async () => {
    const seen = orchestrator([
      { status: "running" },
      { status: "done", answer: "The cap was hit.", model: "m", usage: { input_tokens: 5, output_tokens: 7 }, session: "s1", resumed: false },
    ]);
    const got = await askOrchestrator(live(), { owner: "acme", repo: "api", question: "why?", context: "", mode: "shape" });
    expect(got).toEqual({ ok: true, answer: "The cap was hit.", model: "m", inputTokens: 5, outputTokens: 7, session: "s1", resumed: false });
    const id = String(seen[0]!.body!.id);
    expect(seen[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8080/asks", body: { id, owner: "acme", repo: "api", question: "why?", mode: "shape" } });
    expect(seen.slice(1).map((c) => c.url)).toEqual([`http://127.0.0.1:8080/asks/${id}`, `http://127.0.0.1:8080/asks/${id}`]);
  });

  it("checks again when the orchestrator cannot be reached for a moment", async () => {
    orchestrator([new TypeError("fetch failed"), { status: "done", answer: "Still here." }]);
    expect(await askOrchestrator(live(), { owner: "a", repo: "b", question: "q", context: "" })).toMatchObject({ ok: true, answer: "Still here." });
  });

  it("passes on why the ask failed, a usage limit as 429, and a lost ask in plain words", async () => {
    orchestrator([{ status: "failed", error: "Claude usage limit reached.", error_status: 429 }]);
    expect(await askOrchestrator(live(), { owner: "a", repo: "b", question: "q", context: "" })).toEqual({ error: "Claude usage limit reached.", status: 429 });
    orchestrator([{}], json(202, {}));
    vi.stubGlobal("fetch", async (url: string) => (url.endsWith("/asks") ? json(202, {}) : json(404, { detail: "no such ask" })));
    expect(await askOrchestrator(live(), { owner: "a", repo: "b", question: "q", context: "" })).toEqual({ error: ASK_GONE, status: 502 });
    orchestrator([], json(429, { detail: "Claude usage limit reached." }));
    expect(await askOrchestrator(live(), { owner: "a", repo: "b", question: "q", context: "" })).toEqual({ error: "Claude usage limit reached.", status: 429 });
  });

  it("waits on /ask when the orchestrator predates background asks", async () => {
    const seen = orchestrator([], json(404, { detail: "Not Found" }));
    expect(await askOrchestrator(live(), { owner: "a", repo: "b", question: "q", context: "" })).toMatchObject({ ok: true, answer: "Answered while it waited." });
    expect(seen.map((c) => c.url)).toEqual(["http://127.0.0.1:8080/asks", "http://127.0.0.1:8080/ask"]);
  });
});
