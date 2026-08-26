import { describe, expect, it } from "vitest";
import { attentionReason, canReachSettings, factoryShort, isOrgAdminRole, peopleLabel } from "./labels.js";
import type { Me, SetupStatus } from "../types.js";

describe("peopleLabel", () => {
  it("maps factory states to people language", () => {
    expect(peopleLabel("factory:spec-ready")).toBe("Approve spec");
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
    expect(factoryShort("factory:ready-to-ship")).toBe("G3");
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
