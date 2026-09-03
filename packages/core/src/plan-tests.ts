import { IN_PROGRESS_LABEL, PLAN_TESTS_STATES, RELEASE_KIND_LABEL } from "./factory.js";

/**
 * Whether the Console may offer **Plan tests** on an epic (FACTORY.md §4b,
 * "Adopting it on an epic already in flight").
 *
 * The comment itself is unrestricted — writing a plan only adds documents and
 * work — but the router refuses it in six shapes, each with an explanation it
 * posts on the issue. A button that posts a comment whose only effect is that
 * refusal is worse than no button: the person clicks, waits for a run that
 * never starts, and finds the answer in a thread. So the same six refusals are
 * decided here, before the click, and the reason is shown where the button
 * would have been.
 *
 * This mirrors `ADOPTABLE_STATES` and the `is_plan_tests` branch of the
 * factory's router. When they change, this changes with them — the Console
 * never invents a rule the factory does not enforce.
 */
export interface PlanTestsInput {
  /** The epic's derived factory state. */
  state: string | null;
  /** Whether the epic issue is open. */
  open: boolean;
  /** `epic`, `task`, `test`, `release` — the projected issue kind. */
  kind: string;
  /** The epic's labels, for the kind markers the state cannot carry. */
  labels: string[];
  /**
   * The repo's `.github/factory-testing.json` verdict: `true`/`false` from the
   * projected policy, `null` where the Console has not read the file yet (a
   * repo connected before the policy was synced). Null is treated as "may be
   * on" — refusing on an unread file would hide the action on every repo until
   * the next reconcile walk, and the factory's own refusal is a comment that
   * says exactly what to add.
   */
  systemTests: boolean | null;
  /** The epic already has a test plan: cases, or the plan artifact itself. */
  hasPlan: boolean;
}

export interface PlanTestsAvailability {
  /** Draw the button. */
  offered: boolean;
  /** Why not, in the words the reader needs. Null exactly when offered. */
  reason: string | null;
}

export function planTestsAvailability(input: PlanTestsInput): PlanTestsAvailability {
  const yes = { offered: true, reason: null };
  const no = (reason: string) => ({ offered: false, reason });

  if (input.systemTests === false) {
    return no(
      'System tests are off in this repository — add .github/factory-testing.json with "system_tests": true to turn them on.',
    );
  }
  if (
    input.kind !== "epic" ||
    input.labels.includes(RELEASE_KIND_LABEL) ||
    input.labels.includes("factory:profile") ||
    input.labels.includes("factory:fast-track")
  ) {
    return no("A test plan is written for an epic — a requirement issue with an approved spec and a task breakdown.");
  }
  if (!input.open || input.state === "factory:deployed") {
    return no("This epic has shipped. System tests prove a change before it is promoted, and there is nothing left to hold.");
  }
  if (!input.state || !PLAN_TESTS_STATES.includes(input.state)) {
    return no(
      "A test plan needs the task breakdown to work out which tasks each case depends on, and that arrives with the Planner at factory:planned.",
    );
  }
  // The Console's own guard, not the router's: the factory would start a
  // second Test Planner on top of the one already running, and the two would
  // write the same file on the same branch.
  if (input.labels.includes(IN_PROGRESS_LABEL)) {
    return no("A factory run is live on this epic right now — wait for it to finish, then ask again.");
  }
  // Also the Console's own: the router would happily revise a plan, but a
  // button labelled "Plan tests" beside a list of cases reads as "write these
  // again", and the person pressing it means to *have* tests, not to renumber
  // the ones they have. Revising a plan is a request to the Test Planner, made
  // where every other revision is made — on the epic's thread.
  if (input.hasPlan) {
    return no("This epic already has a test plan. Ask for a revision on the epic thread rather than re-planning it here.");
  }
  return yes;
}
