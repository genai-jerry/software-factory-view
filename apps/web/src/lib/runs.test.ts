import { describe, expect, it } from "vitest";
import { afterRole, phaseWords, stepOf, storyOf } from "./runs.js";

/**
 * A run told in four steps from the orchestrator's phase events. The
 * fixture is the shape the orchestrator recorded on 31 Oct 2026 for a
 * dispatch run on beacon-api #34, with a builder's phases added.
 */

const live = {
  id: "r1",
  repo: "genai-jerry/beacon-api",
  issue: 62,
  role: "implementer",
  started_at: "2026-10-31T09:00:00Z",
  finished_at: null,
  events: [
    { ts: "2026-10-31T09:00:01Z", kind: "phase", message: "resolving model" },
    { ts: "2026-10-31T09:00:05Z", kind: "phase", message: "cloning the repo" },
    { ts: "2026-10-31T09:01:00Z", kind: "phase", message: "running Claude (claude-opus-5)" },
    { ts: "2026-10-31T09:10:00Z", kind: "phase", message: "waiting for tests" },
    { ts: "2026-10-31T09:11:00Z", kind: "phase", message: "fixing failing tests" },
  ],
};

describe("storyOf", () => {
  it("tells a live run as its current step and what came before", () => {
    const s = storyOf(live);
    expect(s.running).toBe(true);
    expect(s.steps.map((x) => x.state)).toEqual(["done", "done", "now", "todo"]);
    expect(s.now).toBe("Some tests failed. Fixing them and running again.");
    expect(s.fixAttempts).toBe(1);
    expect(s.soFar.map((x) => x.words)).toEqual([
      "Choosing which model to use.",
      "Getting a copy of the code.",
      "Reading the design and changing the code.",
      "Running the tests.",
      "Some tests failed. Fixing them and running again.",
    ]);
    expect(s.soFar[2]!.minutes).toBe(9);
    expect(s.soFar[4]!.now).toBe(true);
  });

  it("tells a finished run by its outcome", () => {
    const s = storyOf({ ...live, finished_at: "2026-10-31T09:22:00Z", outcome: "success" });
    expect(s.running).toBe(false);
    expect(s.minutes).toBe(22);
    expect(s.steps.every((x) => x.state === "done")).toBe(true);
    expect(s.now).toBe("Finished and handed over.");
    expect(storyOf({ ...live, finished_at: "2026-10-31T09:22:00Z", outcome: "error", error: "tests still failing" }).now).toBe(
      "Stopped with a problem: tests still failing",
    );
  });
});

describe("words", () => {
  it("maps phases to steps and roles to what follows", () => {
    expect(stepOf("cloning the repo")).toBe("prepare");
    expect(stepOf("running Claude (x)")).toBe("work");
    expect(stepOf("pushing the branch")).toBe("handover");
    expect(phaseWords("running Claude (x)", "reviewer")).toBe("Reading the change and checking it against the design.");
    expect(afterRole("implementer")).toMatch(/^The reviewer checks the change/);
  });
});
