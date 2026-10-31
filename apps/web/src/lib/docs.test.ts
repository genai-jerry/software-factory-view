import { describe, expect, it } from "vitest";
import { bullets, designParts, findSection, paragraphs, scenarios, sections } from "./docs.js";

const PROPOSAL = `# Day-wise calling performance on the leads page

## Problem

Setters add up each day's calls by hand from the monthly view.

1. A lead's **calling status** is not shown.
2. There is no day-wise view.

## Interpretations taken (correct these at gate G1 if wrong)

- **"Day-wise"** groups appointments by the day the appointment falls on
  (\`appointment_at\`, in the workspace's own time zone).
- **Window**: default the last 30 days (including today), requestable up to
  90.
  - a sub-bullet that is not an item

## Non-goals
`;

const SPEC = `# Day-wise appointment call status (delta)

## ADDED Requirements

### Requirement: Day-wise appointment status counts

#### Scenario: Appointments grouped by their day

- WHEN three appointments fall on the same day
- THEN that day's entry reports 3

#### Scenario: A quiet day still appears
`;

const DESIGN = `# Design — Day-wise calling performance (beacon-api)

## What this repo builds

Prose.

## Reuse (what is extended, not duplicated)

The existing funnel's day rule is reused.

Why: one rule, one place.

## Task 1 — \`appointments.by_day()\` (#62)

Computes the counts.

## Task 2 — the endpoint (#63)

Depends on task 1.

## Failure modes and edge cases, per spec requirement

A day with nothing shows zeros.
`;

describe("sections and bullets", () => {
  it("reads headings with their bodies", () => {
    const all = sections(PROPOSAL);
    expect(all.map((s) => [s.level, s.title])).toEqual([
      [1, "Day-wise calling performance on the leads page"],
      [2, "Problem"],
      [2, "Interpretations taken (correct these at gate G1 if wrong)"],
      [2, "Non-goals"],
    ]);
    expect(paragraphs(findSection(all, "problem"))).toEqual(["Setters add up each day's calls by hand from the monthly view."]);
  });

  it("joins wrapped bullet lines and drops sub-bullets", () => {
    const items = bullets(findSection(sections(PROPOSAL), "interpretations"));
    expect(items).toHaveLength(2);
    expect(items[0]).toBe("**\"Day-wise\"** groups appointments by the day the appointment falls on (`appointment_at`, in the workspace's own time zone).");
    expect(items[1]).toBe("**Window**: default the last 30 days (including today), requestable up to 90.");
  });
});

describe("scenarios", () => {
  it("lists a spec's scenario titles", () => {
    expect(scenarios(SPEC)).toEqual(["Appointments grouped by their day", "A quiet day still appears"]);
  });
});

describe("designParts", () => {
  it("reads numbered decisions when the design names them", () => {
    const parts = designParts(`# Design

## Decisions

### D1 — The counts are computed in the API once a minute and cached

Why: the page stays fast for customers with thousands of leads.

### D2 — A day is the customer's local day, not UTC

Why: a 00:30 appointment must not slip to the day before.

## Task 1 — compute counts (#62)

Body.

## Reuse

Not a decision once D-numbers exist.
`);
    expect(parts.decisions).toEqual([
      { id: "D1", title: "The counts are computed in the API once a minute and cached", why: ["the page stays fast for customers with thousands of leads."] },
      { id: "D2", title: "A day is the customer's local day, not UTC", why: ["a 00:30 appointment must not slip to the day before."] },
    ]);
    expect(parts.tasks).toHaveLength(1);
  });

  it("separates decisions from the task order", () => {
    const parts = designParts(DESIGN);
    expect(parts.decisions.map((d) => [d.id, d.title])).toEqual([
      ["D1", "Reuse (what is extended, not duplicated)"],
      ["D2", "Failure modes and edge cases, per spec requirement"],
    ]);
    expect(parts.decisions[0]!.why).toEqual(["The existing funnel's day rule is reused.", "Why: one rule, one place."]);
    expect(parts.tasks).toEqual([
      { n: 1, title: "`appointments.by_day()`", issue: 62, after: [] },
      { n: 2, title: "the endpoint", issue: 63, after: [1] },
    ]);
  });
});
