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
  it("every state label is recognised", () => {
    for (const l of FACTORY_LABELS) expect(deriveFactoryState([l.name])).toBe(l.name);
  });
  it("backlog is a state — a parked issue must not vanish from the console", () => {
    expect(deriveFactoryState(["factory:backlog"])).toBe("factory:backlog");
  });
  it("kind markers are not states", () => {
    expect(deriveFactoryState(["factory:release"])).toBeNull();
    expect(deriveFactoryState(["factory:in-progress"])).toBeNull();
    expect(deriveFactoryState(["factory:profile"])).toBeNull();
  });
  it("the orthogonal in-progress run marker never wins over the state", () => {
    expect(deriveFactoryState(["factory:fast-track", "factory:in-progress"])).toBe("factory:fast-track");
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
  it("fast-track issue is an epic — it must reach the board and tree", () => {
    expect(deriveIssueKind({ labels: ["factory:fast-track"], title: "Small fix", hasParent: false })).toBe("epic");
  });
  it("release tracker stays plain despite carrying a release-* state", () => {
    expect(
      deriveIssueKind({ labels: ["factory:release", "factory:release-ready"], title: "release(2026.09)", hasParent: false }),
    ).toBe("plain");
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

  it("promotion follows the org's integration branch, not the name 'staging'", () => {
    // FACTORY.md §6a: the branch is the org's (develop, qa, integration, ...)
    // and the default branch is not always main.
    expect(derivePrKind("develop", "master", { integration: "develop", default: "master" }))
      .toEqual({ kind: "promotion", issueNumber: null });
    // A branch that merely looks like one is not a promotion.
    expect(derivePrKind("staging", "main", { integration: "develop", default: "main" }).kind).toBe("other");
    // Null/empty (a repo the Console has not resolved yet) falls back to staging -> main.
    expect(derivePrKind("staging", "main", { integration: null, default: null }).kind).toBe("promotion");
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
