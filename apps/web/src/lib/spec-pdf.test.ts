import { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { inlineRuns, pdfFileName, pdfSafe, specBlocks, specPdf } from "./spec-pdf.js";

const SPEC = [
  "## What should be built?",
  "Leads get asked to confirm **twice**.",
  "- one",
  "- two",
  "",
  "## OpenSpec change: `appointment-continuity`",
  "",
  "````openspec proposal.md",
  "## Why",
  "The second ask → confusion.",
  "````",
  "",
  "````openspec specs/appointment-continuity/spec.md",
  "#### Scenario: once",
  "- **WHEN** a lead confirms",
  "- **THEN** nobody asks again",
  "```",
  "GET /api/leads",
  "```",
  "````",
].join("\n");

describe("spec PDF", () => {
  it("reads the spec's markdown into blocks", () => {
    const blocks = specBlocks("# Title\nText\n- a\n- b\n1. x\n```\ncode  line\n```\n| a | b |\n|---|---|\n---\n> quoted");
    expect(blocks.map((b) => b.kind)).toEqual(["h", "p", "ul", "ol", "code", "code", "rule", "p"]);
    expect(blocks[4]).toEqual({ kind: "code", lines: ["code  line"] });
    expect(blocks[5]).toEqual({ kind: "code", lines: ["| a | b |", "|---|---|"] });
    expect(blocks[7]).toEqual({ kind: "p", text: "quoted" });
    expect(inlineRuns("**WHEN** a `lead` confirms")).toEqual([
      { text: "WHEN", bold: true },
      { text: " a lead confirms", bold: false },
    ]);
  });

  it("keeps what the built-in fonts can print and spells out the rest", () => {
    expect(pdfSafe("a → b ≥ c — “ok” café ✓")).toBe("a -> b >= c — “ok” café [x]");
    expect(pdfSafe("done 🎉 日本")).toBe("done  ??");
  });

  it("names the file after the change, else the title", () => {
    expect(pdfFileName("Day-wise calling panel", "appointment-continuity")).toBe("appointment-continuity.pdf");
    expect(pdfFileName("Lens — camera translator", null)).toBe("lens-camera-translator.pdf");
    expect(pdfFileName("🎉", null)).toBe("requirement.pdf");
  });

  it("lays out the form, then every OpenSpec file, with page numbers", () => {
    const long = `${Array.from({ length: 120 }, (_, i) => `- point ${i} ${"word ".repeat(30)}`).join("\n")}\n${SPEC}`;
    const { doc, fileName } = specPdf(jsPDF, { title: "Day-wise calling panel", kind: "Requirement", spec: SPEC, when: new Date(2026, 10, 11) });
    expect(fileName).toBe("appointment-continuity.pdf");
    const out = doc.output();
    for (const text of ["Day-wise calling panel", "What should be built?", "twice", "OpenSpec draft: appointment-continuity",
      "proposal.md", "specs/appointment-continuity/spec.md", "WHEN", "GET /api/leads", "1 / 1"]) {
      expect(out).toContain(text);
    }
    expect(out).not.toContain("````");
    const big = specPdf(jsPDF, { title: "T", kind: "Fix plan", spec: long }).doc;
    expect(big.getNumberOfPages()).toBeGreaterThan(2);
    expect(big.output()).toContain(`${big.getNumberOfPages()} / ${big.getNumberOfPages()}`);
  });
});
