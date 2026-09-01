import { describe, expect, it } from "vitest";
import {
  deriveExpedited,
  deriveFactoryState,
  deriveIssueKind,
  EPIC_READY_STATE,
  EXPEDITE_LABEL,
  FACTORY_KIND_LABELS,
  GATE_STATES,
  gateApproverChain,
  IN_PROGRESS_LABEL,
  isFactoryState,
  nextStep,
  parseApproverFile,
  PIPELINE_ORDER,
  phaseOfState,
  resolveGateApprovers,
  startStatusIsAutomatic,
  startStatusTakesApproval,
  taskStartStatus,
} from "../src/index.js";

/**
 * Expedite mode, as the Console has to read it (change
 * `add-expedite-mode-console`). Two labels arrive together and mean opposite
 * kinds of thing: `factory:expedite` is a marker that must never win state
 * derivation, and `factory:epic-ready` is a state that must sit in exactly one
 * place in the pipeline. Getting either wrong is invisible until an epic is
 * mis-rendered mid-build.
 */

describe("the expedite marker is orthogonal to the state", () => {
  it("is a kind label, not a state — it never wins derivation", () => {
    expect(isFactoryState(EXPEDITE_LABEL)).toBe(false);
    expect(FACTORY_KIND_LABELS.some((l) => l.name === EXPEDITE_LABEL)).toBe(true);
    expect(deriveFactoryState([EXPEDITE_LABEL, "factory:in-review"])).toBe("factory:in-review");
    // Order-independent, exactly like the run marker beside it.
    expect(deriveFactoryState(["factory:in-review", EXPEDITE_LABEL, IN_PROGRESS_LABEL])).toBe("factory:in-review");
    // And on its own it leaves the issue off the rail rather than inventing a state.
    expect(deriveFactoryState([EXPEDITE_LABEL])).toBeNull();
  });

  it("does not change what kind of issue this is", () => {
    const labels = [EXPEDITE_LABEL, "factory:design-approved"];
    expect(deriveIssueKind({ labels, title: "Payment reminders", hasParent: false })).toBe("epic");
    expect(deriveIssueKind({ labels, title: "task(api): send", hasParent: true })).toBe("task");
  });

  it("reads the epic's labels, and is simply absent everywhere else", () => {
    expect(deriveExpedited([EXPEDITE_LABEL, "factory:planned"])).toBe(true);
    expect(deriveExpedited(["factory:planned"])).toBe(false);
    // A task carries no marker of its own — callers pass the epic's labels, and
    // a task whose epic is not projected yet is just not expedited.
    expect(deriveExpedited([])).toBe(false);
    expect(deriveExpedited(null)).toBe(false);
  });
});

describe("factory:epic-ready is a state, in one place", () => {
  it("sits between on-epic and in-staging on the rail", () => {
    expect(isFactoryState(EPIC_READY_STATE)).toBe(true);
    const i = PIPELINE_ORDER.indexOf(EPIC_READY_STATE);
    expect(PIPELINE_ORDER[i - 1]).toBe("factory:on-epic");
    expect(PIPELINE_ORDER[i + 1]).toBe("factory:in-staging");
  });

  it("is a shipping-phase state carrying gate GS", () => {
    expect(phaseOfState(EPIC_READY_STATE)).toBe("shipping");
    expect(GATE_STATES[EPIC_READY_STATE]).toEqual({ gate: "staging", label: "GS" });
    // G3 stays exactly where it was: on-epic still has no gate at all.
    expect(GATE_STATES["factory:in-staging"]).toEqual({ gate: "release", label: "G3" });
    expect(GATE_STATES["factory:on-epic"]).toBeUndefined();
  });
});

describe("the GS approver list falls back to release", () => {
  it("chains staging → release, and nothing else chains", () => {
    expect(gateApproverChain("staging")).toEqual(["staging", "release"]);
    expect(gateApproverChain("spec")).toEqual(["spec"]);
    expect(gateApproverChain("release")).toEqual(["release"]);
  });

  it("prefers its own list, borrows release when it has none, then any collaborator", () => {
    const lists: Record<string, string[]> = { staging: ["sam"], release: ["dan"] };
    expect(resolveGateApprovers("staging", (g) => lists[g] ?? [])).toEqual({
      gate: "staging",
      approvers: ["sam"],
      fellBackFrom: null,
    });
    expect(resolveGateApprovers("staging", (g) => (g === "release" ? ["dan"] : []))).toEqual({
      gate: "release",
      approvers: ["dan"],
      fellBackFrom: "staging",
    });
    // Both empty: the caller's own "any collaborator" reading, not a lie about a list.
    expect(resolveGateApprovers("staging", () => [])).toEqual({ gate: "staging", approvers: [], fellBackFrom: null });
  });

  it("parses a staging key, and an approver file that predates it", () => {
    expect(parseApproverFile({ staging: ["sam"], release: ["dan"] }).staging).toEqual(["sam"]);
    expect(parseApproverFile({ spec: ["alice"], release: ["dan"] }).staging).toEqual([]);
  });
});

describe("the task start gate under expedite", () => {
  const base = { open: true, state: "factory:ready", labels: [] as string[], approvedAt: null, readySince: null };

  it("reports `auto`: nothing is owed and nothing is offered", () => {
    const status = taskStartStatus({ ...base, expedited: true });
    expect(status).toBe("auto");
    expect(startStatusTakesApproval(status)).toBe(false);
    expect(startStatusIsAutomatic(status)).toBe(true);
  });

  it("still reports a live run — the marker does not hide an implementer", () => {
    expect(taskStartStatus({ ...base, labels: [IN_PROGRESS_LABEL], expedited: true })).toBe("running");
  });

  it("leaves a non-expedited task reading exactly as it did", () => {
    expect(taskStartStatus(base)).toBe("awaiting");
    expect(taskStartStatus({ ...base, expedited: false })).toBe("awaiting");
    expect(taskStartStatus({ ...base, approvedAt: new Date(), readySince: null })).toBe("approved");
  });
});

/**
 * The wording, state by state. What matters is not the sentences themselves
 * but which side of the line each state falls on: expedite takes over the
 * starts and leaves the decisions, so `automatic` and `waitsOnPerson` have to
 * flip in step for exactly the states it covers, and for no others.
 */
describe("nextStep, expedited and not", () => {
  const STARTS_TAKEN_OVER = [
    "factory:spec-ready",
    "factory:design-ready",
    "factory:ready",
    "factory:in-review",
    "factory:in-test",
    "factory:ready-to-ship",
    "factory:on-epic",
  ];

  it("hands the taken-over stages to the factory and stops asking for a person", () => {
    for (const state of STARTS_TAKEN_OVER) {
      const plain = nextStep(state, ["sam"]);
      const fast = nextStep(state, ["sam"], { expedited: true });
      expect(fast.automatic, state).toBe(true);
      expect(fast.waitsOnPerson, state).toBe(false);
      expect(fast.how, state).not.toBe(plain.how);
      // Never automatic without the marker — this is the whole no-regression rule.
      expect(plain.automatic, state).toBe(false);
    }
  });

  it("keeps naming the role, so a human can still take the stage over", () => {
    expect(nextStep("factory:in-review", [], { expedited: true }).startRole).toBe("reviewer");
    expect(nextStep("factory:in-test", [], { expedited: true }).startRole).toBe("qa");
    expect(nextStep("factory:ready-to-ship", [], { expedited: true }).startRole).toBe("release");
  });

  it("keeps the two gates expedite exists to protect, word for word", () => {
    for (const state of [EPIC_READY_STATE, "factory:in-staging"]) {
      const plain = nextStep(state, ["sam"]);
      const fast = nextStep(state, ["sam"], { expedited: true });
      expect(fast, state).toEqual(plain);
      expect(fast.waitsOnPerson, state).toBe(true);
      expect(fast.automatic, state).toBe(false);
    }
  });

  it("keeps a halted agent a human's problem", () => {
    expect(nextStep("factory:blocked", [], { expedited: true })).toEqual(nextStep("factory:blocked", []));
    const halted = nextStep("factory:design-approved", [], { expedited: true, tasks: { total: 4, done: 1, blocked: 1 } });
    expect(halted.waitsOnPerson).toBe(true);
    expect(halted.automatic).toBe(false);
  });

  it("answers GS with the staging gate and says staging, not production", () => {
    const step = nextStep(EPIC_READY_STATE, ["sam"]);
    expect(step.who).toBe("gate GS — @sam");
    expect(step.how).toMatch(/integration branch, not to production/);
    expect(step.startRole).toBeNull(); // an approval, not a role start
  });

  it("stops offering the start-the-Release-Manager ask once an expedited epic is built", () => {
    const tasks = { total: 3, done: 3, blocked: 0 };
    expect(nextStep("factory:design-approved", [], { tasks }).waitsOnPerson).toBe(true);
    const fast = nextStep("factory:design-approved", [], { tasks, expedited: true });
    expect(fast.waitsOnPerson).toBe(false);
    expect(fast.automatic).toBe(true);
    expect(fast.startRole).toBe("release"); // still reachable by hand
  });

  it("says a live run is live, instead of naming its role as next", () => {
    const next = nextStep("factory:in-review", [], { expedited: true });
    expect(next.how).toMatch(/Reviewer runs on this task by itself/);
    expect(next.startRole).toBe("reviewer");

    const live = nextStep("factory:in-review", [], { expedited: true, running: true });
    expect(live.how).toMatch(/The Reviewer is running on this now/);
    expect(live.automatic).toBe(true);
    // No role to offer: starting it again would put a second agent on the issue.
    expect(live.startRole).toBeNull();

    // The marker is what makes the run marker readable here — without expedite
    // the base table answers exactly as it always did.
    expect(nextStep("factory:in-review", [], { running: true })).toEqual(nextStep("factory:in-review", []));
  });

  it("reads a `ready` task from the start gate's own answer", () => {
    const auto = nextStep("factory:ready", ["sam"], { startStatus: "auto" });
    expect(auto.automatic).toBe(true);
    expect(auto.how).not.toMatch(/Approve/);
    // A stalled approval under expedite is the factory's retry, not a second ask.
    expect(nextStep("factory:ready", ["sam"], { startStatus: "stalled", expedited: true }).waitsOnPerson).toBe(false);
    expect(nextStep("factory:ready", ["sam"], { startStatus: "stalled" }).waitsOnPerson).toBe(true);
  });
});
