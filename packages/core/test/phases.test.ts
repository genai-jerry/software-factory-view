import { describe, expect, it } from "vitest";
import { blockerNumbersFromBody } from "../src/derive.js";
import { FACTORY_LABELS } from "../src/factory.js";
import { NEXT_MOVER, phaseOfState, STATE_SENTENCE, stateSentence } from "../src/phases.js";

describe("phaseOfState", () => {
  it("is total over every factory label", () => {
    for (const l of FACTORY_LABELS) {
      expect(["specifying", "planning", "building", "shipping", "held"]).toContain(phaseOfState(l.name));
    }
  });

  it("sends null and off-rail drift to held", () => {
    expect(phaseOfState(null)).toBe("held");
    expect(phaseOfState("factory:blocked")).toBe("held");
    expect(phaseOfState("something:weird")).toBe("held");
  });
});

describe("state copy", () => {
  it("has a sentence and a next-mover for every factory label", () => {
    for (const l of FACTORY_LABELS) {
      expect(STATE_SENTENCE[l.name], l.name).toBeTruthy();
      expect(NEXT_MOVER[l.name], l.name).toBeTruthy();
    }
  });

  it("fills the approver slot", () => {
    expect(stateSentence("factory:spec-ready", ["jerry", "sam"])).toContain("@jerry, @sam");
    expect(stateSentence("factory:spec-ready", [])).toContain("any collaborator");
    expect(stateSentence(null, [])).toContain("outside the pipeline");
  });
});

describe("blockerNumbersFromBody", () => {
  it("parses the marker forms, one per line", () => {
    expect(blockerNumbersFromBody("Blocked by #12")).toEqual([12]);
    expect(blockerNumbersFromBody("depends on: #12, #13")).toEqual([12, 13]);
    expect(blockerNumbersFromBody("- after #7")).toEqual([7]);
    expect(blockerNumbersFromBody("Blocked by #5\nAfter #6")).toEqual([5, 6]);
  });

  it("ignores prose mentions and dedupes", () => {
    expect(blockerNumbersFromBody("this was blocked by #12 last week")).toEqual([]);
    expect(blockerNumbersFromBody("blocked by #12\ndepends on #12")).toEqual([12]);
    expect(blockerNumbersFromBody(null)).toEqual([]);
    expect(blockerNumbersFromBody("no markers here")).toEqual([]);
  });
});
