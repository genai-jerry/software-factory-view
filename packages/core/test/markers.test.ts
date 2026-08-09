import { describe, expect, it } from "vitest";
import {
  decisionMarker,
  isAgentComment,
  isApprovedComment,
  parseConsoleMarkers,
  stripConsoleMarkers,
  threadMarker,
} from "../src/markers.js";

/**
 * Marker conformance (spec 07 §6 risk "marker-comment scheme collides with
 * factory automation"): console markers must never perturb the factory's two
 * comment triggers — the exact-match `Approved` body and the
 * `<!-- factory-agent -->` authorship marker.
 */
describe("marker conformance against factory triggers", () => {
  it("a thread-marked reply is NOT an approval", () => {
    const body = `Approved\n\n${threadMarker("gate/spec")}`;
    expect(isApprovedComment(body)).toBe(false);
  });

  it("the Console's approval body is the bare literal and passes the exact match", () => {
    expect(isApprovedComment("Approved")).toBe(true);
    expect(isApprovedComment("Approved ")).toBe(true); // factory trims
    expect(isApprovedComment("Approved, but...")).toBe(false);
  });

  it("console markers never contain the factory-agent marker", () => {
    for (const m of [threadMarker("artifact/proposal"), decisionMarker("abc-123")]) {
      expect(isAgentComment(m)).toBe(false);
    }
  });

  it("factory agent comments are recognised regardless of console markers", () => {
    const body = `Handing off to reviewer.\n\n<!-- factory-agent -->\n${threadMarker("gate/design")}`;
    expect(isAgentComment(body)).toBe(true);
    expect(parseConsoleMarkers(body).thread).toBe("gate/design");
  });
});

describe("marker round-trip", () => {
  it("parses thread and decision markers back out of a comment body", () => {
    const body = `Some reply text\n\n${threadMarker("task/21")}\n${decisionMarker("d1f2")}`;
    const markers = parseConsoleMarkers(body);
    expect(markers.thread).toBe("task/21");
    expect(markers.decision).toBe("d1f2");
  });

  it("rejects marker values outside the safe alphabet", () => {
    expect(() => threadMarker("evil --> <script>")).toThrow();
  });

  it("stripping markers leaves the human-visible text", () => {
    const body = `Visible text\n\n${threadMarker("inbox")}`;
    expect(stripConsoleMarkers(body)).toBe("Visible text");
  });

  it("ignores unknown console marker keys rather than failing", () => {
    expect(parseConsoleMarkers("<!-- console:future=x -->")).toEqual({});
  });
});
