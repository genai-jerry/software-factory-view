import { describe, expect, it } from "vitest";
import { requirementBody, splitOpenSpec } from "../src/openspec-draft.js";

const SPEC = [
  "## Problem / need\nLeads get asked twice.",
  "## OpenSpec change: `Appointment-Continuity`",
  "````openspec proposal.md\n## Why\nA lead confirms once.\n````",
  "````openspec specs/appointment-continuity/spec.md\n## ADDED Requirements\n\n### Requirement: Confirm once\nThe flow SHALL NOT ask again.\n\n#### Scenario: Reschedule\n- **WHEN** the CRM moves the call\n- **THEN** no confirmation is sent\n````",
].join("\n\n");

describe("splitOpenSpec", () => {
  it("parts the form from the change and its files", () => {
    const d = splitOpenSpec(SPEC);
    expect(d.form).toBe("## Problem / need\nLeads get asked twice.");
    expect(d.slug).toBe("appointment-continuity");
    expect(d.files.map((f) => f.path)).toEqual(["proposal.md", "specs/appointment-continuity/spec.md"]);
    expect(d.files[1]!.content).toContain("#### Scenario: Reschedule");
  });

  it("drops a file whose path would leave the change folder", () => {
    const d = splitOpenSpec("## Problem / need\nX\n\n````openspec ../../etc/passwd.md\nno\n````\n\n````openspec /abs.md\nno\n````");
    expect(d.files).toEqual([]);
    expect(d.form).toBe("## Problem / need\nX");
  });

  it("reads a requirement written before the OpenSpec draft as all form", () => {
    expect(splitOpenSpec("## What should be built?\nA panel.")).toEqual({ form: "## What should be built?\nA panel.", slug: null, files: [] });
  });
});

describe("requirementBody", () => {
  it("folds each file, fenced so its own headings stay intact", () => {
    const body = requirementBody(SPEC);
    expect(body.startsWith("## Problem / need\nLeads get asked twice.\n\n## OpenSpec draft")).toBe(true);
    expect(body).toContain("<details><summary><code>proposal.md</code></summary>\n\n````markdown\n## Why\nA lead confirms once.\n````\n</details>");
    expect(body).toContain("openspec/changes/<this issue's number>-appointment-continuity/");
  });

  it("leaves a requirement without a draft as it is", () => {
    expect(requirementBody("## What should be built?\nA panel.\n")).toBe("## What should be built?\nA panel.");
  });
});
