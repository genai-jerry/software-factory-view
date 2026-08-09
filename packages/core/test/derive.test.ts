import { describe, expect, it } from "vitest";
import { deriveFactoryState, deriveIssueKind, derivePrKind, parseChangePath } from "../src/derive.js";
import { FACTORY_LABELS } from "../src/factory.js";

describe("factory state derivation", () => {
  it("finds the single factory state label among noise", () => {
    expect(deriveFactoryState(["bug", "factory:design-ready", "p1"])).toBe("factory:design-ready");
  });
  it("null when no factory label", () => {
    expect(deriveFactoryState(["bug"])).toBeNull();
  });
  it("all 14 labels are recognised", () => {
    for (const l of FACTORY_LABELS) expect(deriveFactoryState([l.name])).toBe(l.name);
  });
});

describe("issue kind derivation", () => {
  it("factory-labelled non-sub-issue is an epic", () => {
    expect(deriveIssueKind({ labels: ["factory:intake"], title: "Payment reminders", hasParent: false })).toBe("epic");
  });
  it("sub-issue with factory label is a task", () => {
    expect(deriveIssueKind({ labels: ["factory:ready"], title: "task(api): add endpoint", hasParent: true })).toBe("task");
  });
  it("task(...) title without parent link still reads as task", () => {
    expect(deriveIssueKind({ labels: [], title: "task(ui): wire button", hasParent: false })).toBe("task");
  });
  it("plain issue stays plain", () => {
    expect(deriveIssueKind({ labels: ["question"], title: "How do I…", hasParent: false })).toBe("plain");
  });
});

describe("PR kind from branch naming (FACTORY.md §6)", () => {
  it("spec branch", () => {
    expect(derivePrKind("factory/16-spec", "main")).toEqual({ kind: "spec", issueNumber: 16 });
  });
  it("design branch", () => {
    expect(derivePrKind("factory/16-design", "main")).toEqual({ kind: "design", issueNumber: 16 });
  });
  it("task branch", () => {
    expect(derivePrKind("factory/21-add-reminder-model", "staging")).toEqual({ kind: "task", issueNumber: 21 });
  });
  it("staging promotion", () => {
    expect(derivePrKind("staging", "main")).toEqual({ kind: "promotion", issueNumber: null });
  });
  it("anything else is other", () => {
    expect(derivePrKind("feature/foo", "main").kind).toBe("other");
  });
});

describe("change folder paths (OpenSpec conventions §5)", () => {
  it("proposal", () => {
    expect(parseChangePath("openspec/changes/16-payment-reminders/proposal.md")).toEqual({
      slug: "16-payment-reminders",
      epicNumber: 16,
      artifact: "proposal",
    });
  });
  it("nested spec file", () => {
    const p = parseChangePath("openspec/changes/16-payment-reminders/specs/reminders.md");
    expect(p?.artifact).toBe("spec");
  });
  it("non-change path is null", () => {
    expect(parseChangePath("src/index.ts")).toBeNull();
  });
});
