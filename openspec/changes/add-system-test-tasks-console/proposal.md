# Add System Test Tasks to the Console

## Why

The factory is gaining **system test generation** (change
`add-system-test-generation` in `claude-software-factory`): a Test Planner
writes `system-tests/test-plan.md` and `system-tests/test-data.md` into the
change folder after gate G1, mirrors every case into a `test(<epic>): ST-<n>
<title>` sub-issue, and the Dispatcher releases each case to a **new state
`factory:manual-test`** once the code it depends on is on the epic branch. A
human runs it and comments exactly `Test Passed` or `Test Failed`; the
factory moves the case to `factory:test-passed` (closed) or
`factory:test-failed` (a fix task is filed and in flight). Under `mode:
gate` the epic reaches `factory:epic-ready` only when every case has passed.

Without this change the Console shows three unknown labels, counts test
sub-issues as tasks that never got an implementer, offers nobody the two
comments that move them, and renders a GS panel that says "assembled and
green" for an epic whose testers have not started. The Console is where the
humans in the loop decide; the tester is now one of them.

## What Changes

- **Core catalog:** `packages/core` learns the three states
  (`factory:manual-test`, `factory:test-passed`, `factory:test-failed`), the
  `test(` sub-issue kind (beside `task(`), the `testers` approver key with
  its `implementation` fallback, the two comment bodies (`Test Passed`,
  `Test Failed`), and the next-step wording for the three states (mirroring
  `handbook/next-step.json`). Onboarding's labels step provisions the three
  labels from the same table as `setup-labels.sh`.
- **Task board and epic status:** test sub-issues render as a distinct kind
  with their case identifier, dependency chips and verdict; they are counted
  separately from code tasks ("Building 4/6 · Testing 2/5"), and an
  assembled epic waiting on tests reads "Assembled · waiting on 3 tests"
  rather than "All tasks done".
- **Tester actions:** a runnable case offers **Pass** and **Fail** actions
  that post the literal `Test Passed` / `Test Failed` as the acting user
  through the user-token client — the same mechanism as `Review Done` — with
  a free-text evidence field that is posted as an ordinary comment first.
  Pass is offered only to the `testers` (fallback `implementation`) list;
  Fail to any collaborator. `factory:test-failed` rows link the fix task.
- **Artifact reader:** `system-tests/test-plan.md` and `test-data.md` appear
  beside `tasks.md` and `design.md` (as-proposed ⇄ as-approved), and a test
  sub-issue's peek shows its case section from the plan.
- **Gate GS panel:** the evidence block gains the **test matrix** — case,
  verdict, tester, when — and, under `mode: gate`, the panel is not offered
  until the matrix is all green; under `advisory`, for an epic without an
  epic branch, or for an epic that adopted its plan after reaching the gate,
  unverified cases are listed as a warning above Approve. The Console never
  implies a state the factory has not set: an epic that adopted tests late
  keeps `factory:epic-ready` and reads as approvable-with-warnings.
- **Adopting tests on an in-flight epic:** an epic with no test plan, in a
  repo where the policy is on, shows a **Plan system tests** action that
  posts the literal `Plan tests` as the acting user (the same mechanism as
  Approve and Review Done), with a note saying what it will do and that the
  resulting plan PR has to be merged before any case reaches a tester. While
  that PR is open the workspace shows the cases as pending with the reason
  and a link to the PR, rather than as runnable. The action is hidden where
  the factory refuses adoption — before `factory:planned`, on shipped or
  closed epics, on trackers, profile and fast-track issues.
- **Attention queue:** a case reaching `factory:manual-test` is a needs-you
  item for the testers ("system test ST-4 is ready to run"); a
  `factory:test-failed` case surfaces to the implementation approvers via
  its fix task exactly as any `factory:ready` task does; an assembled epic
  waiting on tests is not a GS item until it is `factory:epic-ready`.

Not in this change: any factory-side behaviour (that is
`add-system-test-generation`), editing the test plan in the Console, a
config editor for `.github/factory-testing.json`, or notifications beyond
the existing attention queue.

## Capabilities

### New Capabilities

- _(none — system tests are rendered through existing Console capabilities)_

### Modified Capabilities

- `console-workspace`: test sub-issue kind and rows, Pass/Fail actions,
  artifact reader entries, epic status wording, GS panel test matrix and
  hold.
- `console-attention`: tester needs-you items for runnable cases; GS item
  timing under `mode: gate`.

## Impact

- `packages/core` (factory.ts, phases.ts, derive.ts, epic-status.ts,
  next-step.ts, a new test-verdict helper), `apps/api` (tree routes for the
  two comments, attention, read routes for the two artifacts), `apps/web`
  (task board, peek, gate tab, artifact reader), e2e fixtures.
- Depends on the factory change's label names, comment bodies (`Test
  Passed`, `Test Failed`, `Plan tests`), the `testers` key and the
  `.github/factory-testing.json` shape; build after
  `add-system-test-generation` sections 1, 2 and 3 land.
- No schema migration: the three labels and the `test(` title flow through
  the existing projection; the policy file is read like the other
  `.github/factory-*.json` files.
