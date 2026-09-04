import { BUG_ACCEPT_STATES, IN_PROGRESS_LABEL, RELEASE_KIND_LABEL } from "./factory.js";

/**
 * Whether the Console may offer **Report a bug** on an epic (FACTORY.md §4c).
 *
 * The same discipline as `plan-tests.ts`: the factory answers a `Bug` comment
 * it cannot act on with an explanation posted on the issue, and a button whose
 * only effect is that explanation is worse than no button — the person clicks,
 * nothing happens, and the answer is in a thread they have to go and find. So
 * the refusals are decided here, before the click, in the same order and for
 * the same reasons the router decides them, and the reason is shown where the
 * button would have been.
 *
 * When the router's ladder changes, this changes with it. The Console never
 * invents a rule the factory does not enforce, and never hides one it does.
 */
export interface BugReportInput {
  /** The epic's derived factory state. */
  state: string | null;
  /** Whether the epic issue is open. */
  open: boolean;
  /** `epic`, `task`, `test`, `bug`, `plain` — the projected issue kind. */
  kind: string;
  /** The epic's labels, for the kind markers the state cannot carry. */
  labels: string[];
  /**
   * The repo's `.github/factory-testing.json` verdict for `bug_reports`:
   * `true`/`false` from the projected policy, `null` where the Console has not
   * read the file yet. Null is treated as "may be on", exactly as the test
   * actions treat it — refusing on an unread file would hide the action on
   * every repo until the next reconcile walk, and the factory's own refusal is
   * a comment that says precisely what to add.
   */
  bugReports: boolean | null;
}

export interface BugReportAvailability {
  /** Draw the control. */
  offered: boolean;
  /** Why not, in the words the reader needs. Null exactly when offered. */
  reason: string | null;
}

export function bugReportAvailability(input: BugReportInput): BugReportAvailability {
  const no = (reason: string): BugReportAvailability => ({ offered: false, reason });

  if (input.bugReports === false) {
    return no(
      'Bug reports are off in this repository — add "bug_reports": true to .github/factory-testing.json to turn them on.',
    );
  }
  if (
    input.kind !== "epic" ||
    input.labels.includes(RELEASE_KIND_LABEL) ||
    input.labels.includes("factory:profile") ||
    input.labels.includes("factory:fast-track")
  ) {
    return no("A bug is raised against an epic — the requirement issue whose code the factory built.");
  }
  if (!input.open || input.state === "factory:deployed") {
    return no(
      "This epic has shipped, so a defect in it is a new issue — or factory:incident if production is affected.",
    );
  }
  if (!input.state || !BUG_ACCEPT_STATES.includes(input.state)) {
    return no(
      "A bug is a defect in code the factory has built, and this epic has not built any yet. Bugs are accepted from factory:design-approved onward.",
    );
  }
  // The Console's own guard, not the router's — the factory would happily
  // raise a report mid-run. But a run live on the epic is usually the
  // Dispatcher or the Release Manager moving the very states this reads, and
  // a report filed into that moment lands with its epic somewhere else.
  if (input.labels.includes(IN_PROGRESS_LABEL)) {
    return no("A factory run is live on this epic right now — wait for it to finish, then report it.");
  }
  return { offered: true, reason: null };
}
