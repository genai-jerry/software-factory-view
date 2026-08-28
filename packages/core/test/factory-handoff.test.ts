import { describe, expect, it } from "vitest";
import { factoryHandoff, factoryStartRole, type HandoffRun } from "../src/factory-handoff.js";

const NOW = Date.parse("2026-08-28T18:00:00Z");

function run(over: Partial<HandoffRun> = {}): HandoffRun {
  return {
    id: "run-1",
    role: "intake",
    startedAt: "2026-08-28T17:50:00Z",
    finishedAt: null,
    outcome: "running",
    error: null,
    ...over,
  };
}

function ask(over: Partial<Parameters<typeof factoryHandoff>[0]> = {}) {
  return factoryHandoff({
    engine: "software-factory",
    open: true,
    labels: ["factory:intake"],
    configured: true,
    runs: [],
    now: NOW,
    ...over,
  });
}

describe("factoryStartRole", () => {
  it("prefers the fast lane over intake, matching the router's label table", () => {
    expect(factoryStartRole(["factory:intake", "factory:fast-track"])?.role).toBe("fasttrack");
  });

  it("is null when no label starts a role", () => {
    expect(factoryStartRole(["factory:backlog"])).toBeNull();
  });
});

describe("factoryHandoff", () => {
  it("says nothing has run when the orchestrator reports no runs", () => {
    const h = ask({ labels: ["factory:fast-track"] });
    expect(h.status).toBe("waiting");
    expect(h.canStart).toBe(true);
    expect(h.startsRole?.human).toBe("fast lane");
    expect(h.headline).toMatch(/fast lane/);
  });

  it("names the missing configuration instead of offering a button that 502s", () => {
    const h = ask({ configured: false, configuredDetail: "ORCHESTRATOR_URL is not set." });
    expect(h.status).toBe("not-configured");
    expect(h.canStart).toBe(false);
    expect(h.detail).toMatch(/ORCHESTRATOR_URL is not set\./);
  });

  it("reports a live run inside the role timeout as running", () => {
    const h = ask({ labels: ["factory:intake", "factory:in-progress"], runs: [run()] });
    expect(h.status).toBe("running");
    expect(h.canClearMarker).toBe(false);
    expect(h.run?.minutesRunning).toBe(10);
  });

  it("calls a run past the role timeout stalled and offers to clear the marker", () => {
    const h = ask({
      labels: ["factory:intake", "factory:in-progress"],
      runs: [run({ startedAt: "2026-08-28T13:59:26Z" })],
    });
    expect(h.status).toBe("stalled");
    expect(h.canClearMarker).toBe(true);
    expect(h.canStart).toBe(false);
    expect(h.headline).toMatch(/4h/);
  });

  it("calls an in-progress marker with no run at all orphaned", () => {
    const h = ask({ labels: ["factory:fast-track", "factory:in-progress"], runs: [] });
    expect(h.status).toBe("orphaned");
    expect(h.canClearMarker).toBe(true);
    expect(h.detail).toMatch(/fast lane/);
  });

  it("does not guess when the orchestrator could not be reached", () => {
    const h = ask({
      labels: ["factory:intake", "factory:in-progress"],
      runs: null,
      runsError: "could not reach the orchestrator",
    });
    expect(h.status).toBe("unknown");
    expect(h.canClearMarker).toBe(false);
  });

  it("surfaces the last failed run rather than pretending nothing ran", () => {
    const h = ask({
      runs: [run({ finishedAt: "2026-08-28T17:55:00Z", outcome: "no_op", error: "changed nothing" })],
    });
    expect(h.status).toBe("failed");
    expect(h.canStart).toBe(true);
    expect(h.headline).toMatch(/no-op/);
    expect(h.detail).toMatch(/changed nothing/);
  });

  it("stays out of the way on GitHub Actions orgs and on issues with no factory label", () => {
    expect(ask({ engine: "github-actions" }).status).toBe("actions");
    expect(ask({ labels: [] }).status).toBe("idle");
    expect(ask({ open: false }).status).toBe("idle");
  });
});
