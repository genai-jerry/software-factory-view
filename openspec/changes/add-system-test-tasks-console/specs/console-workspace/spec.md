# Delta Spec: console-workspace (system test tasks)

## ADDED Requirements

### Requirement: Test sub-issues are their own kind

The Console SHALL derive a `test` issue kind from the `test(<epic>)` title
prefix, beside `task` from `task(<epic>)`, and SHALL render test sub-issues
on the task board as a distinct group with the case identifier (`ST-<n>`),
their dependency chips (parsed from the same `Blocked by` markers as tasks),
their state — pending (no label), runnable (`factory:manual-test`), passed
(`factory:test-passed`), failed (`factory:test-failed`, linking the fix
task) — and never an implementation start control. Code-task counts SHALL
exclude test sub-issues, and the epic status SHALL read them separately
("Building 4/6 · Testing 2/5"); an epic whose code tasks are all
`factory:on-epic` with tests outstanding SHALL read "Assembled · waiting on
N tests".

#### Scenario: Board groups tests apart from tasks

- **WHEN** an epic has six `task(` and five `test(` sub-issues, two of them
  passed
- **THEN** the board shows the tests in their own group with identifiers and
  verdicts, the status badge reads "Building 4/6 · Testing 2/5", and no test
  row offers Approve or a start button

#### Scenario: Failed case links its fix

- **WHEN** a test sub-issue is `factory:test-failed` with `Blocked by #48`
  in its body
- **THEN** its row shows the failure, links task #48 and that task's current
  state, and says the case re-opens when the fix lands

### Requirement: Pass and Fail post the literal comments as the user

On a test sub-issue at `factory:manual-test` the workspace SHALL offer
**Pass** and **Fail**. Each SHALL post the literal comment body — `Test
Passed` or `Test Failed` — via the user-token client as the acting member,
never as the app; an optional evidence text entered alongside SHALL be
posted as an ordinary comment before the verdict so the strict-match body is
the newest comment. Pass SHALL be offered only when the acting user is in
the `testers` list (falling back to `implementation`, then any
collaborator); Fail SHALL be offered to any collaborator. Neither SHALL be
offered in any other state; a case at `factory:test-failed` SHALL show the
fix task instead. A verdict already posted but not yet routed SHALL be shown
as pending, with the same grace-period reasoning as the implementation
start approval.

#### Scenario: Pass with evidence

- **WHEN** a tester enters "verified on preview, screenshot attached" and
  presses Pass on ST-4 at `factory:manual-test`
- **THEN** two comments are posted as the tester in order — the evidence,
  then exactly `Test Passed` — and the row shows the verdict as pending
  until the projection sees `factory:test-passed`

#### Scenario: Pass hidden from a non-tester

- **WHEN** a collaborator outside a non-empty `testers` list opens a runnable
  case
- **THEN** the row offers Fail but not Pass, and says who may pass it

### Requirement: The plan and data are artifacts

The artifact reader SHALL list `system-tests/test-plan.md` and
`system-tests/test-data.md` beside `proposal.md`, `specs/`, `tasks.md` and
`design.md`, with the same as-proposed ⇄ as-approved toggle (their approval
is gate G2's merge of the design PR). A test sub-issue's peek SHALL show its
`### ST-<n>` section from the approved plan and the data sets it names.

#### Scenario: Peek shows the case

- **WHEN** a member opens the peek for the sub-issue of ST-4
- **THEN** it shows ST-4's Covers, Preconditions, Steps and Expected from the
  approved plan, and the records of every data set in its `Data:` line

### Requirement: Gate GS panel carries the test matrix

The GS panel at `factory:epic-ready` SHALL include a test matrix — every
test sub-issue with its verdict, the user who gave it and when — above the
assembly evidence. Before the epic reaches `factory:epic-ready`, an
assembled epic waiting on tests SHALL render the matrix with the open cases
and the testers named, and no Approve. Under `mode: advisory`, or for an
epic without an epic branch, unverified cases SHALL be listed as a warning
above Approve (or above the G3 merge buttons) rather than hiding it.

#### Scenario: Gate mode holds the panel

- **WHEN** every code task is `factory:on-epic`, the policy is `mode: gate`,
  and two cases are `factory:manual-test`
- **THEN** the epic's gate tab shows the matrix with the two open cases and
  their testers, says the epic is assembled and waiting on them, and offers
  no Approve

#### Scenario: Advisory mode warns

- **WHEN** the same epic is at `factory:epic-ready` under `mode: advisory`
- **THEN** the GS panel shows the matrix with the two unverified cases as a
  warning and still offers Approve
