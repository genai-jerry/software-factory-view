import { describe, expect, it } from "vitest";
import { attentionReason, canReachSettings, factoryShort, isOrgAdminRole, peopleLabel } from "./labels.js";
import type { Me, SetupStatus } from "../types.js";

describe("peopleLabel", () => {
  it("maps factory states to people language", () => {
    expect(peopleLabel("factory:spec-ready")).toBe("Approve spec");
    expect(peopleLabel("factory:on-epic")).toBe("On epic branch");
    expect(peopleLabel("factory:blocked")).toBe("Agent halted");
    expect(peopleLabel("factory:deployed")).toBe("Shipped");
  });

  it("falls back when the state is unknown", () => {
    expect(peopleLabel(null)).toBe("No factory state");
    expect(peopleLabel("factory:mystery")).toBe("mystery");
  });
});

describe("factoryShort", () => {
  it("keeps gate chips as G1–G3", () => {
    expect(factoryShort("factory:spec-ready")).toBe("G1");
    expect(factoryShort("factory:design-ready")).toBe("G2");
    // G3 holds at in-staging: ready-to-ship is now the release manager's
    // integration merge, which no human approves.
    expect(factoryShort("factory:in-staging")).toBe("G3");
    expect(factoryShort("factory:ready-to-ship")).toBe("ready-to-ship");
    // on-epic is the release manager's epic assembly (FACTORY.md §6b) —
    // deliberately no gate chip.
    expect(factoryShort("factory:on-epic")).toBe("on-epic");
  });
});

describe("attentionReason", () => {
  it("explains blocked and gate kinds", () => {
    expect(attentionReason("blocked", 1, "why", "factory:blocked")).toBe("Answer the agent");
    expect(attentionReason("blocked", 4, "why", "factory:blocked")).toBe("Unowned — anyone may reply");
    expect(attentionReason("gate", 2, "why", "factory:spec-ready")).toBe("Approve the spec");
  });
});

describe("canReachSettings", () => {
  const setup = (canEditApp: boolean): SetupStatus => ({
    configured: true,
    source: "database",
    appSlug: "factory",
    appId: "1",
    clientId: "c",
    hasWebhookSecret: true,
    canEditApp,
    hasMasterKey: true,
    credentialError: null,
    publicOrigin: "http://localhost",
    insightEnabled: false,
    devLogin: false,
    appReset: false,
  });

  it("lets org admins in even without App-owner rights", () => {
    const me: Me = { login: "ada", name: "Ada", avatarUrl: null, orgs: [{ id: "1", name: "acme", role: "admin" }] };
    expect(canReachSettings(me, setup(false))).toBe(true);
    expect(isOrgAdminRole("member")).toBe(false);
  });

  it("lets the App owner in", () => {
    const me: Me = { login: "ada", name: "Ada", avatarUrl: null, orgs: [{ id: "1", name: "acme", role: "member" }] };
    expect(canReachSettings(me, setup(true))).toBe(true);
  });
});

describe("attentionReason for tester work", () => {
  it("names a system test case and a bug re-test, not an implementation start", () => {
    expect(attentionReason("task-start", 3, "why", "factory:manual-test")).toBe("Run the test case");
    expect(attentionReason("task-start", 3, "why", "factory:bug-retest")).toBe("Re-test the bug fix");
    expect(attentionReason("task-start", 3, "why", "factory:ready")).toBe("Approve implementation start");
  });
});
