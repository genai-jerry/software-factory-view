import { describe, expect, it } from "vitest";
import {
  caseExecution,
  caseFix,
  latestSimulatedSummary,
  latestSimulatedVerdict,
  simulatedSummary,
  simulatedVerdict,
} from "../src/simulated.js";

// The exact shapes claude-software-factory's sim_results.py writes.
const RUN = "https://github.com/o/infra/actions/runs/4401";
const PASSED = `**ST-21 passed in the simulated environment** — run [4401](${RUN}) on \`aaaaaaaaaaaa\`. Closing it.\n\n<!-- sim-run: 4401 ${"a".repeat(40)} -->\n<!-- factory-agent -->`;
const FAILED = [
  `**ST-25 failed in the simulated environment** — run [4401](${RUN}) on \`aaaaaaaaaaaa\`.`,
  "",
  "- step 7 (expect): expected exactly 4 calls items with lead 'nora', found 5",
  "- What the simulators received could not be read",
  "",
  "**You need to:** decide at the production approval (G3). To have it fixed, comment `Test Failed` here.",
  "",
  `<!-- sim-run: 4401 ${"a".repeat(40)} -->`,
  "<!-- factory-agent -->",
].join("\n");
const SUMMARY = [
  `**Simulated tests: 1 of 2 passed** — run [4401](${RUN}) on \`aaaaaaaaaaaa\`.`,
  "**You need to:** look at the failed cases before the production approval (G3).",
  "- ST-25 failed: step 7 (expect): expected exactly 4 calls",
  "- Also failing in this run (not this epic's cases): `retry-gaps`, `old-epic-st-2`.",
  "",
  "<!-- sim-run: 4401 -->",
  "<!-- factory-agent -->",
].join("\n");

describe("simulated cases", () => {
  it("reads a case's execution from its body", () => {
    expect(caseExecution("Part of #9\n\n**Execution:** simulated")).toEqual({ kind: "simulated" });
    expect(caseExecution("**Execution:** manual — real audio on a real phone")).toEqual({
      kind: "manual",
      reason: "real audio on a real phone",
    });
    expect(caseExecution("**Execution:** manual")).toEqual({ kind: "manual", reason: null });
    expect(caseExecution("no line")).toBeNull();
  });

  it("reads a filed fix from the case body", () => {
    expect(caseFix("Part of #9\n\nBlocked by #77\n")).toBe(77);
    expect(caseFix("Part of #9")).toBeNull();
  });

  it("reads a pass and a failure with its steps", () => {
    expect(simulatedVerdict(PASSED)).toEqual({ run: 4401, sha: "a".repeat(40), runUrl: RUN, result: "passed", failures: [] });
    const f = simulatedVerdict(FAILED)!;
    expect(f.result).toBe("failed");
    expect(f.failures).toEqual([
      "step 7 (expect): expected exactly 4 calls items with lead 'nora', found 5",
      "What the simulators received could not be read",
    ]);
    expect(simulatedVerdict("Test Failed")).toBeNull();
  });

  it("does not take the epic summary for a case verdict, nor the other way round", () => {
    expect(simulatedVerdict(SUMMARY)).toBeNull();
    expect(simulatedSummary(FAILED)).toBeNull();
  });

  it("reads the epic summary's run and regressions", () => {
    expect(simulatedSummary(SUMMARY)).toEqual({ run: 4401, runUrl: RUN, regressions: ["retry-gaps", "old-epic-st-2"] });
  });

  it("takes the newest", () => {
    expect(latestSimulatedVerdict([FAILED, "chatter", PASSED, "more"])!.result).toBe("passed");
    expect(latestSimulatedSummary(["x", SUMMARY])!.run).toBe(4401);
    expect(latestSimulatedVerdict(["x"])).toBeNull();
  });
});
