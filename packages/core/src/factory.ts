/**
 * Constants describing the factory's label state machine. These mirror
 * claude-software-factory (FACTORY.md §3, scripts/setup-labels.sh) and must
 * stay in sync with it — the Console renders factory state, never invents it.
 *
 * The colours are not decoration: onboarding creates and repairs labels from
 * this table, and `setup-labels.sh` does the same from its own. A value that
 * differs between the two does not settle — each run rewrites what the other
 * wrote, and the label flickers. Copy from `setup-labels.sh`; never pick one.
 */

export const FACTORY_LABELS = [
  { name: "factory:backlog", color: "8B949E", description: "Filed, waiting for its release milestone to be approved" },
  { name: "factory:release-planning", color: "3F5D8A", description: "Awaiting `Plan release` on the tracker (nothing running)" },
  { name: "factory:release-ready", color: "5C7CBF", description: "Release plan posted, awaiting gate G0 approval" },
  { name: "factory:release-approved", color: "246B4A", description: "Release approved (G0); its issues enter intake" },
  { name: "factory:intake", color: "0E5A8A", description: "New requirement awaiting intake analysis" },
  { name: "factory:spec-ready", color: "4A90D9", description: "Spec PR open, awaiting gate G1 approval" },
  { name: "factory:spec-approved", color: "2E7D4F", description: "Spec approved (G1); released for planning" },
  { name: "factory:planned", color: "5B4A8A", description: "tasks.md + sub-issues created, awaiting design" },
  { name: "factory:design-ready", color: "8E6BBF", description: "design.md PR(s) open, awaiting gate G2 approval" },
  { name: "factory:design-approved", color: "1E6B45", description: "Design approved (G2); released for implementation" },
  { name: "factory:ready", color: "B07D2B", description: "Task unblocked; implementer may start" },
  { name: "factory:in-review", color: "C98A1B", description: "Draft PR under agent review" },
  { name: "factory:in-test", color: "D4A017", description: "QA verifying WHEN/THEN scenarios" },
  { name: "factory:ready-to-ship", color: "6AA84F", description: "Green + approved; awaiting the merge onto the epic branch (or staging when the epic has none)" },
  { name: "factory:on-epic", color: "4F9E58", description: "Merged onto the epic branch and green there; waiting for the rest of the epic" },
  { name: "factory:epic-ready", color: "41A08A", description: "Epic fully assembled and green; awaiting gate GS (release to staging)" },
  // System test cases (FACTORY.md §4b). States, but only ever on a
  // `test(<epic>)` sub-issue: a case a human runs against the assembled epic.
  // No role is ever started on one, which is why none of them appears in the
  // expedite map or offers a start control.
  { name: "factory:manual-test", color: "D96C1F", description: "System test case ready for a human to run (test sub-issue)" },
  { name: "factory:test-passed", color: "1F7A4D", description: "System test case passed (test sub-issue; terminal)" },
  { name: "factory:test-failed", color: "C0392B", description: "System test case failed; a fix task is in flight (test sub-issue)" },
  { name: "factory:test-skipped", color: "6C757D", description: "System test case skipped by a staging approver (test sub-issue; terminal)" },
  // Bug reports (FACTORY.md §4c). The same shape as the case states above and
  // for the same reason: a human found something, the factory filed an
  // ordinary task to fix it, and the same human confirms the repair. They sit
  // only on a `bug(<epic>)` sub-issue, and no role ever runs on one.
  { name: "factory:bug-open", color: "C0392B", description: "Bug raised; its fix task is in flight (bug sub-issue)" },
  { name: "factory:bug-retest", color: "D96C1F", description: "Bug fix assembled; a human confirms the repair (bug sub-issue)" },
  { name: "factory:bug-verified", color: "1F7A4D", description: "Bug repair confirmed by a tester (bug sub-issue; terminal)" },
  { name: "factory:in-staging", color: "3D9970", description: "Merged to staging and verified there; awaiting gate G3 promotion to the default branch" },
  { name: "factory:deployed", color: "0B8043", description: "In production; soak in progress" },
  { name: "factory:fast-track", color: "8C8C8C", description: "Small fix bypassing OpenSpec ceremony" },
  { name: "factory:blocked", color: "A63D40", description: "Factory flow needs human attention" },
  { name: "factory:incident", color: "7A1F1F", description: "Post-deploy regression under investigation" },
] as const;

/**
 * Kind/marker labels the factory also creates. Deliberately NOT states:
 * `factory:release` marks a release tracker issue (which also carries one
 * `factory:release-*` state), `factory:in-progress` sits alongside the state
 * label for the duration of an agent run, and `factory:expedite` sits
 * alongside it for as long as a human wants the epic run without the per-stage
 * starts. They are provisioned during onboarding but must never win state
 * derivation.
 */
export const RELEASE_KIND_LABEL = "factory:release";

/** The run marker: a factory agent is working on this issue right now. */
export const IN_PROGRESS_LABEL = "factory:in-progress";

/**
 * The expedite marker: a human asked for this epic to be built without the
 * per-stage human starts (claude-software-factory: `add-expedite-mode`).
 *
 * Orthogonal, exactly like the run marker — it never replaces the state label,
 * and it is applied to the EPIC only: a task is expedited because its epic is,
 * so the factory never copies the label onto the sub-issues and neither does
 * the Console. While it is present the factory approves G1 and G2 itself and
 * starts each task's implementer, reviewer, QA and assembly as the previous
 * one lands. It waives starts, not decisions: gate GS (`factory:epic-ready`)
 * and gate G3 (`factory:in-staging`) stay human.
 */
export const EXPEDITE_LABEL = "factory:expedite";

/**
 * The bug kind marker (FACTORY.md §4c): this issue is a defect a tester raised
 * against an epic under test. Orthogonal like the markers above — it stays on
 * the report for life, alongside one of the three `factory:bug-*` states, and
 * must never win state derivation.
 */
export const BUG_KIND_LABEL = "factory:bug";

/**
 * The epic's own assembled-but-not-released state, between `factory:on-epic`
 * (its last task landed on the epic branch) and `factory:in-staging` (the
 * integration branch has it). Universal: every epic passes through it,
 * expedited or not, because gate GS holds here.
 */
export const EPIC_READY_STATE = "factory:epic-ready";

/**
 * The state an epic holds for the whole of its build.
 *
 * FACTORY.md §3 reads it "Released for implementation", not "the design gate
 * passed": every state after it belongs to a *task*, so an epic sits here
 * from gate G2 until the Release Manager carries it onward. It is also the
 * dispatcher's guard for re-running on task close (FACTORY.md §2a), so it
 * must not be advanced to make a badge read better — a task freed by a later
 * merge would then strand with no factory state at all.
 */
export const DESIGN_APPROVED_STATE = "factory:design-approved";

/**
 * The three states of a system test case (FACTORY.md §4b), and the two
 * comment bodies that move it.
 *
 * A case is released to `MANUAL_TEST_STATE` by the Dispatcher once its plan is
 * merged and the code it exercises is assembled; a human runs it and records
 * the verdict. `Test Passed` is authorised against the `testers` list (which
 * falls back to `implementation`); `Test Failed` is open to any collaborator,
 * because a failure only adds work — it files a fix task and parks the case
 * until that lands.
 */
export const MANUAL_TEST_STATE = "factory:manual-test";
export const TEST_PASSED_STATE = "factory:test-passed";
export const TEST_FAILED_STATE = "factory:test-failed";
/**
 * A case a staging approver chose not to run (`Skip tests` on the epic or on
 * the case). Terminal like a pass, but it is not one: the counts say
 * "skipped", and the release carries it as evidence rather than proof.
 */
export const TEST_SKIPPED_STATE = "factory:test-skipped";

/** Exact comment body the router accepts as a passing system test verdict. */
export const TEST_PASSED_BODY = "Test Passed";
/** Exact comment body the router accepts as a failing system test verdict. */
export const TEST_FAILED_BODY = "Test Failed";
/** Exact comment body that asks the Test Planner to write a plan for an epic. */
export const PLAN_TESTS_BODY = "Plan tests";

/**
 * The three states of a bug report (FACTORY.md §4c).
 *
 * A report is raised at `BUG_OPEN_STATE` with an ordinary `task(<epic>)` filed
 * to fix it; the Dispatcher moves it to `BUG_RETEST_STATE` once that task is
 * assembled onto the epic branch, and a tester answers with the same two
 * verdicts a case takes — because a re-test is a test. `Test Passed` closes it
 * at `BUG_VERIFIED_STATE`; `Test Failed` files another fix and returns it to
 * `BUG_OPEN_STATE`, still one report with one history.
 */
export const BUG_OPEN_STATE = "factory:bug-open";
export const BUG_RETEST_STATE = "factory:bug-retest";
export const BUG_VERIFIED_STATE = "factory:bug-verified";

/**
 * The epic states a bug may be raised against (§4c): from the first task
 * landing through the staging window. Earlier nothing has been built to be
 * wrong — that is a requirement; later the change has left the factory.
 */
export const BUG_ACCEPT_STATES: readonly string[] = [
  DESIGN_APPROVED_STATE,
  EPIC_READY_STATE,
  "factory:in-staging",
];

/**
 * The exact comment the factory reads as a bug report. The first line is the
 * control and everything under it is the report — the one factory control that
 * reads past its own line, so the Console posts both in one comment rather
 * than splitting the observation into a second one nothing routes.
 */
export function bugCommentBody(title: string, report: string): string {
  const head = title.trim();
  const body = report.trim();
  return body ? `Bug: ${head}\n\n${body}` : `Bug: ${head}`;
}

/** The epic states from which a system test plan may still be adopted (§4b). */
export const PLAN_TESTS_STATES: readonly string[] = [
  "factory:planned",
  "factory:design-ready",
  DESIGN_APPROVED_STATE,
  EPIC_READY_STATE,
  "factory:in-staging",
];

export const FACTORY_KIND_LABELS = [
  { name: RELEASE_KIND_LABEL, color: "24597A", description: "Tracker issue for a release milestone (kind, not a state)" },
  { name: BUG_KIND_LABEL, color: "B33A3A", description: "Bug report raised against an epic during testing (kind, not a state)" },
  { name: IN_PROGRESS_LABEL, color: "1F6FEB", description: "A factory agent run is live on this issue right now" },
  { name: EXPEDITE_LABEL, color: "D93F87", description: "Auto-advance every stage after the spec, up to the staging gate (kind, not a state)" },
] as const;

export type FactoryState = (typeof FACTORY_LABELS)[number]["name"];

export const FACTORY_STATE_NAMES: readonly FactoryState[] = FACTORY_LABELS.map((l) => l.name);

export function isFactoryState(label: string): label is FactoryState {
  return (FACTORY_STATE_NAMES as readonly string[]).includes(label);
}

/**
 * Pipeline order for the board columns / stage rail. Backlog, the release-*
 * tracker states, blocked, fast-track and incident are off-rail: fast-track
 * gets its own board column, the rest land in Held.
 */
export const PIPELINE_ORDER: readonly FactoryState[] = [
  "factory:intake",
  "factory:spec-ready",
  "factory:spec-approved",
  "factory:planned",
  "factory:design-ready",
  "factory:design-approved",
  "factory:ready",
  "factory:in-review",
  "factory:in-test",
  "factory:ready-to-ship",
  "factory:on-epic",
  EPIC_READY_STATE,
  "factory:in-staging",
  "factory:deployed",
];

/**
 * The system test case states (FACTORY.md §4b), in the order a case moves
 * through them.
 *
 * Deliberately NOT part of `PIPELINE_ORDER`: the rail and the board columns
 * are the path a *change* takes, and a case is a parallel track hanging off
 * one point of it. Splicing them into the rail would shift every epic's
 * stage display to describe work belonging to its sub-issues.
 */
export const TEST_STATE_ORDER: readonly string[] = [
  MANUAL_TEST_STATE,
  TEST_FAILED_STATE,
  TEST_PASSED_STATE,
  TEST_SKIPPED_STATE,
];

export function isTestState(label: string | null | undefined): boolean {
  return Boolean(label && TEST_STATE_ORDER.includes(label));
}

/**
 * The bug report states, in the order a report moves through them. Out of
 * `PIPELINE_ORDER` for the same reason the case states are: a report is a
 * parallel track hanging off one point of a change's path, not a step on it.
 */
export const BUG_STATE_ORDER: readonly string[] = [
  BUG_OPEN_STATE,
  BUG_RETEST_STATE,
  BUG_VERIFIED_STATE,
];

export function isBugState(label: string | null | undefined): boolean {
  return Boolean(label && BUG_STATE_ORDER.includes(label));
}

export type Gate = "spec" | "design" | "implementation" | "testers" | "staging" | "release";

/** States at which a gate holds, and which approver list owns it. */
export const GATE_STATES: Record<string, { gate: Gate; label: string }> = {
  "factory:spec-ready": { gate: "spec", label: "G1" },
  "factory:design-ready": { gate: "design", label: "G2" },
  "factory:ready": { gate: "implementation", label: "start" },
  // GS holds at epic-ready: the epic is assembled and green on its own branch
  // but nothing of it is on the integration branch yet, so releasing it there
  // is a decision — the last one before staging proves the change. Comment-
  // approvable like G1/G2, and universal: expedite waives the starts before
  // this point, never this gate. factory:on-epic still deliberately has NO
  // gate; it is the Release Manager's assembly step (FACTORY.md §6b).
  [EPIC_READY_STATE]: { gate: "staging", label: "GS" },
  // Not a gate in the approval sense — nothing is being authorised — but the
  // same shape: a state that holds until a named group of humans acts, whose
  // list the Console has to resolve to show the case to the right people.
  [MANUAL_TEST_STATE]: { gate: "testers", label: "system test" },
  // The same shape again, one step later (§4c): the fix for a bug is
  // assembled, and the person who reported it is the one who can say whether
  // it is actually gone.
  [BUG_RETEST_STATE]: { gate: "testers", label: "bug re-test" },
  // G3 holds at in-staging, not ready-to-ship or on-epic: the merges onto the
  // epic branch (FACTORY.md §6b) and the integration branch (§6a) are the
  // Release Manager's steps, and only once the change is proved on staging
  // does a human decide whether to promote it.
  "factory:in-staging": { gate: "release", label: "G3" },
};

/**
 * Gates that borrow another gate's approver list when their own is unset.
 *
 * GS is newer than most `.github/factory-approvers.json` files, so an estate
 * that has never heard of it has no `staging` key at all. The factory reads
 * `staging`, then `release`, then "any collaborator"; the Console must route
 * attention down the same chain or it would show the staging gate to nobody
 * on exactly the estates that have not upgraded their approver file.
 */
export const GATE_FALLBACK: Partial<Record<Gate, Gate>> = {
  staging: "release",
  // `testers` is newer still, and a repo that turns system tests on before
  // naming its testers must still show a runnable case to somebody. The
  // factory reads testers, then implementation, then "any collaborator".
  testers: "implementation",
};

/** A gate's approver lists in priority order — the first non-empty one owns it. */
export function gateApproverChain(gate: string): string[] {
  const next = GATE_FALLBACK[gate as Gate];
  return next ? [gate, next] : [gate];
}

/**
 * The list that actually owns a gate here, given a lookup into whatever the
 * caller has already loaded. An all-empty chain answers with the gate's own
 * (empty) list, which every caller already reads as "any collaborator".
 */
export function resolveGateApprovers(
  gate: string,
  listFor: (gate: string) => string[],
): { gate: string; approvers: string[]; fellBackFrom: string | null } {
  for (const candidate of gateApproverChain(gate)) {
    const approvers = listFor(candidate);
    if (approvers.length > 0) return { gate: candidate, approvers, fellBackFrom: candidate === gate ? null : gate };
  }
  return { gate, approvers: [], fellBackFrom: null };
}

/** Exact comment body the factory router accepts for G1/G2/implementation starts. */
export const APPROVED_BODY = "Approved";

/** Exact comment body the factory router accepts to skip the Reviewer at `factory:in-review`. */
export const REVIEW_DONE_BODY = "Review Done";

/** The one state `REVIEW_DONE_BODY` has any effect on. */
export const IN_REVIEW_STATE = "factory:in-review";

export interface ApproverFile {
  spec: string[];
  design: string[];
  implementation: string[];
  /** Who runs system test cases and may pass them (§4b). See `GATE_FALLBACK`. */
  testers: string[];
  /** Gate GS. Absent in files written before GS existed — see `GATE_FALLBACK`. */
  staging: string[];
  release: string[];
}

export function parseApproverFile(json: unknown): ApproverFile {
  const obj = (json ?? {}) as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(obj[k]) ? (obj[k] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  return {
    spec: list("spec"),
    design: list("design"),
    implementation: list("implementation"),
    testers: list("testers"),
    staging: list("staging"),
    release: list("release"),
  };
}
