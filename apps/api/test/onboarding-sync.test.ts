import { describe, expect, it } from "vitest";
import { reconcileStubFile } from "../src/routes/onboarding.js";

/**
 * Re-running the stub step on an already-enabled repo is how a policy key
 * added after setup reaches an estate (`epics`, FACTORY.md §6b). It is only
 * safe to offer as a button because it is strictly additive — these are the
 * cases that keep it that way.
 */
describe("reconcileStubFile", () => {
  const wanted = `${JSON.stringify({ staging: "staging", required: true, auto_create: true, epics: true }, null, 2)}\n`;

  it("writes a file the repo does not have at all", () => {
    expect(reconcileStubFile(null, wanted)).toBe(wanted);
  });

  it("adds a key the repo predates without touching the rest", () => {
    const existing = `${JSON.stringify({ staging: "develop", required: true, auto_create: false }, null, 2)}\n`;
    const merged = reconcileStubFile(existing, wanted);
    expect(merged).not.toBeNull();
    const parsed = JSON.parse(merged!) as Record<string, unknown>;
    expect(parsed["epics"]).toBe(true);
    // The repo renamed its integration branch and turned auto_create off —
    // both are local decisions and must survive.
    expect(parsed["staging"]).toBe("develop");
    expect(parsed["auto_create"]).toBe(false);
  });

  it("reports nothing to do when every key is already present", () => {
    const existing = `${JSON.stringify({ staging: "qa", required: false, auto_create: true, epics: false }, null, 2)}\n`;
    expect(reconcileStubFile(existing, wanted)).toBeNull();
  });

  it("never overwrites an approver or model list", () => {
    const existing = `${JSON.stringify({ spec: ["alice"], design: [] }, null, 2)}\n`;
    const incoming = `${JSON.stringify({ spec: ["bob"], design: ["carol"], release: ["dan"] }, null, 2)}\n`;
    const parsed = JSON.parse(reconcileStubFile(existing, incoming)!) as Record<string, unknown>;
    expect(parsed["spec"]).toEqual(["alice"]); // kept, not replaced
    expect(parsed["design"]).toEqual([]); // an empty list is still the repo's answer
    expect(parsed["release"]).toEqual(["dan"]); // absent key: added
  });

  it("merges nested objects key by key", () => {
    const existing = `${JSON.stringify({ roles: { implementer: ["opus"] } }, null, 2)}\n`;
    const incoming = `${JSON.stringify({ roles: { implementer: ["sonnet"], qa: ["haiku"] } }, null, 2)}\n`;
    const parsed = JSON.parse(reconcileStubFile(existing, incoming)!) as { roles: Record<string, unknown> };
    expect(parsed.roles["implementer"]).toEqual(["opus"]);
    expect(parsed.roles["qa"]).toEqual(["haiku"]);
  });

  it("leaves non-JSON files (workflow stubs, issue templates) alone", () => {
    expect(reconcileStubFile("name: Factory pipeline\non: issues\n", "name: Factory pipeline\non: push\n")).toBeNull();
  });
});
