import { afterEach, describe, expect, it, vi } from "vitest";
import { UserClient } from "../src/github.js";
import { parseSimulate } from "../src/testing-policy.js";

afterEach(() => vi.unstubAllGlobals());

/** Answer by "METHOD path"; anything unlisted is a 404. */
function stub(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    calls.push(key);
    const hit = routes[key] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), { status: hit.status });
  });
  return calls;
}

const gh = () => new UserClient("https://api.invalid", async () => "t");
const VAR = "/repos/o/infra/actions/variables/SIM_SCENARIOS";

describe("Actions variables", () => {
  it("reads a variable, and a missing one as null", async () => {
    stub({ [`GET ${VAR}`]: { status: 200, body: { name: "SIM_SCENARIOS", value: "manual" } } });
    expect(await gh().getActionsVariable("o", "infra", "SIM_SCENARIOS")).toBe("manual");
    stub({});
    expect(await gh().getActionsVariable("o", "infra", "SIM_SCENARIOS")).toBeNull();
  });

  it("throws a refusal rather than calling it unset", async () => {
    stub({ [`GET ${VAR}`]: { status: 403, body: { message: "Resource not accessible by integration" } } });
    await expect(gh().getActionsVariable("o", "infra", "SIM_SCENARIOS")).rejects.toMatchObject({ status: 403 });
  });

  it("updates in place, and creates the variable when it does not exist", async () => {
    let calls = stub({ [`PATCH ${VAR}`]: { status: 204 } });
    await gh().setActionsVariable("o", "infra", "SIM_SCENARIOS", "manual");
    expect(calls).toEqual([`PATCH ${VAR}`]);
    calls = stub({ "POST /repos/o/infra/actions/variables": { status: 201, body: {} } });
    await gh().setActionsVariable("o", "infra", "SIM_SCENARIOS", "manual");
    expect(calls).toEqual([`PATCH ${VAR}`, "POST /repos/o/infra/actions/variables"]);
  });

  it("deletes, and a variable already gone is fine", async () => {
    stub({ [`DELETE ${VAR}`]: { status: 204 } });
    await gh().deleteActionsVariable("o", "infra", "SIM_SCENARIOS");
    stub({});
    await gh().deleteActionsVariable("o", "infra", "SIM_SCENARIOS");
  });
});

describe("getCommitStatus", () => {
  it("picks one context's status off a ref", async () => {
    stub({
      "GET /repos/o/api/commits/staging/status": {
        status: 200,
        body: { sha: "abc", statuses: [{ context: "ci", state: "success" }, { context: "sim", state: "pending", description: "d", target_url: "u" }] },
      },
    });
    expect(await gh().getCommitStatus("o", "api", "staging", "sim")).toEqual({ state: "pending", description: "d", target_url: "u", sha: "abc" });
    expect(await gh().getCommitStatus("o", "api", "staging", "other")).toBeNull();
    stub({});
    expect(await gh().getCommitStatus("o", "api", "staging", "sim")).toBeNull();
  });
});

describe("parseSimulate", () => {
  it("reads the run repo and status context, or null", () => {
    expect(parseSimulate({ simulate: { run_repo: "o/infra", status_context: "o/sim" } })).toEqual({ runRepo: "o/infra", statusContext: "o/sim" });
    expect(parseSimulate({ simulate: { run_repo: "o/infra" } })).toEqual({ runRepo: "o/infra", statusContext: null });
    expect(parseSimulate({ system_tests: true })).toBeNull();
    expect(parseSimulate({ simulate: { run_repo: "not a repo" } })).toBeNull();
    expect(parseSimulate(null)).toBeNull();
  });
});
