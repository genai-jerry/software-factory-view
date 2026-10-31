import { describe, expect, it } from "vitest";
import { caseIdOf, parseTestPlan, plain } from "./testplan.js";

// A cut of the real plan for beacon-api #35, as the Test Planner wrote it.
const PLAN = `# System Test Plan: Day-wise calling performance on the leads page

Epic: genai-jerry/beacon-api#35

## Scope

These cases prove that a **person** looking at the leads page sees the calling
reality the CRM holds.

## Environment

Both repos of the epic, on their epic branches, running together on
beacon-infra's local stack:

| Needs | Detail |
|---|---|
| beacon-api | branch \`factory/epic-35\`, api **and** worker containers |
| Auth | \`AUTH_ENABLED=true\`. ST-16 is meaningless without it |

Before starting, confirm the health check passes.

**Safety.** Appointment data sets require real AI calls.

## Test cases

Dates are written relative to the day the tester runs the case.

### ST-1: A lead's CRM calling status reaches the leads page

- \`Covers:\` \`leads-calling-status/Every lead\`
- \`Depends on:\` 3, 4
- \`Data:\` DS-1
- \`Execution:\` manual
- \`Preconditions:\` DS-1 loaded and synced into the populated workspace.
- \`Steps:\`
  1. In the CRM, note the Call Status of each of the three statused DS-1 leads.
  2. Open \`/leads\` in beacon-web.
  3. Find each of the three leads in the list.
- \`Expected:\` each of the three lead rows displays its calling status as text,
  and the text is **exactly** the CRM's value.

### ST-2: A lead with no CRM calling status shows a placeholder, not an error

- \`Steps:\`
  1. Open \`/leads\` and find the fourth DS-1 lead.
- \`Expected:\` the row shows an empty cell or a placeholder.

## Traceability

| Scenario | Case |
`;

describe("parseTestPlan", () => {
  it("reads each case's steps, preconditions and expected result", () => {
    const plan = parseTestPlan(PLAN);
    expect(plan.title).toBe("System Test Plan: Day-wise calling performance on the leads page");
    expect([...plan.cases.keys()]).toEqual(["ST-1", "ST-2"]);
    const st1 = plan.cases.get("ST-1")!;
    expect(st1.title).toBe("A lead's CRM calling status reaches the leads page");
    expect(st1.steps).toEqual([
      "In the CRM, note the Call Status of each of the three statused DS-1 leads.",
      "Open `/leads` in beacon-web.",
      "Find each of the three leads in the list.",
    ]);
    expect(st1.preconditions).toBe("DS-1 loaded and synced into the populated workspace.");
    expect(st1.expected).toBe("each of the three lead rows displays its calling status as text, and the text is **exactly** the CRM's value.");
    expect(st1.dependsOn).toBe("3, 4");
    expect(st1.data).toBe("DS-1");
    expect(plan.cases.get("ST-2")!.steps).toHaveLength(1);
  });

  it("reads the environment as notes and a needs table", () => {
    const env = parseTestPlan(PLAN).environment!;
    expect(env.rows).toEqual([
      ["beacon-api", "branch `factory/epic-35`, api **and** worker containers"],
      ["Auth", "`AUTH_ENABLED=true`. ST-16 is meaningless without it"],
    ]);
    expect(env.notes[0]).toMatch(/^Both repos of the epic/);
    expect(env.notes).toContain("Before starting, confirm the health check passes.");
  });

  it("yields nothing for a plan it cannot read, not wrong steps", () => {
    const plan = parseTestPlan("# Notes\n\nJust prose.\n");
    expect(plan.cases.size).toBe(0);
    expect(plan.environment).toBeNull();
  });
});

describe("caseIdOf", () => {
  it("prefers the issue's own case id and falls back to the title", () => {
    expect(caseIdOf("test(35): ST-14 A window", "ST-14")).toBe("ST-14");
    expect(caseIdOf("test(35): ST-14 A window", null)).toBe("ST-14");
    expect(caseIdOf("task(35): compute counts", null)).toBeNull();
  });
});

describe("plain", () => {
  it("drops markup a tester does not need to see", () => {
    expect(plain("branch `factory/epic-35`, api **and** [worker](x) containers")).toBe("branch factory/epic-35, api and worker containers");
  });
});
