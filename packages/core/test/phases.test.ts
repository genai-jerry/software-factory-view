import { describe, expect, it } from "vitest";
import { blockerNumbersFromBody, blockerRefsFromBody, parentRefFromBody } from "../src/derive.js";
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

  it("parked and fast-lane states map to their real phases", () => {
    expect(phaseOfState("factory:backlog")).toBe("held");
    expect(phaseOfState("factory:fast-track")).toBe("building");
    expect(phaseOfState("factory:release-ready")).toBe("planning");
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

describe("blockerRefsFromBody", () => {
  it("parses qualified cross-repo refs alongside bare numbers", () => {
    expect(blockerRefsFromBody("Blocked by acme/api#12")).toEqual([{ repo: "acme/api", number: 12 }]);
    expect(blockerRefsFromBody("Blocked by #5, acme/api#12")).toEqual([
      { repo: null, number: 5 },
      { repo: "acme/api", number: 12 },
    ]);
    expect(blockerRefsFromBody("depends on https://github.com/acme/api/issues/9")).toEqual([
      { repo: "acme/api", number: 9 },
    ]);
  });

  it("stays line-anchored — prose around a qualified ref creates no edge", () => {
    expect(blockerRefsFromBody("this was blocked by acme/api#12 last week")).toEqual([]);
    expect(blockerRefsFromBody("blocked by acme/api#12\nafter acme/api#12")).toEqual([
      { repo: "acme/api", number: 12 },
    ]);
  });
});

describe("parentRefFromBody", () => {
  it("resolves the factory's parent markers, qualified or not", () => {
    expect(parentRefFromBody("Parent: #7")).toEqual({ repo: null, number: 7 });
    expect(parentRefFromBody("epic #7")).toEqual({ repo: null, number: 7 });
    expect(parentRefFromBody("Part of acme/hub#31")).toEqual({ repo: "acme/hub", number: 31 });
    expect(parentRefFromBody("sub-issue of https://github.com/acme/hub/issues/31")).toEqual({
      repo: "acme/hub",
      number: 31,
    });
    expect(parentRefFromBody("no markers")).toBeNull();
    expect(parentRefFromBody(null)).toBeNull();
  });
});
