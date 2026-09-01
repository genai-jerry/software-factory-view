import { describe, expect, it } from "vitest";
import { parseOpenQuestionAreas } from "../src/open-questions.js";

const DESIGN_MD = `
## Context

Some context.

## Decisions

### D1. Do the thing

## Open Questions

1. Should the manager's team view show mixed history separately?
2. Something else entirely, not tied to an area.

| Area | Item | Questions |
| --- | --- | --- |
| coaching-hub | Manager's team view | 6, 8 |
| coaching-hub | Mixed history stays separated | 6 |

## Migration Plan

Nothing here should be picked up.
`;

describe("parseOpenQuestionAreas", () => {
  it("extracts the by-area table from the Open Questions section", () => {
    expect(parseOpenQuestionAreas(DESIGN_MD)).toEqual([
      { area: "coaching-hub", item: "Manager's team view", questionNumbers: ["6", "8"] },
      { area: "coaching-hub", item: "Mixed history stays separated", questionNumbers: ["6"] },
    ]);
  });

  it("returns nothing when there is no Open Questions heading", () => {
    expect(parseOpenQuestionAreas("## Context\n\nno questions here")).toEqual([]);
  });

  it("returns nothing when the section has a list but no table", () => {
    const md = "## Open Questions\n\n1. Just a plain question, no table.\n\n## Migration Plan\n";
    expect(parseOpenQuestionAreas(md)).toEqual([]);
  });

  it("does not read past the next heading into an unrelated table", () => {
    const md = `## Open Questions

1. A question with no area breakdown.

## Migration Plan

| Area | Item | Questions |
| --- | --- | --- |
| decoy | should not appear | 1 |
`;
    expect(parseOpenQuestionAreas(md)).toEqual([]);
  });

  it("ignores a malformed row missing a cell", () => {
    const md = `## Open Questions

| Area | Item | Questions |
| --- | --- | --- |
| coaching-hub | Manager's team view | 6, 8 |
| incomplete row |
`;
    expect(parseOpenQuestionAreas(md)).toEqual([{ area: "coaching-hub", item: "Manager's team view", questionNumbers: ["6", "8"] }]);
  });
});
