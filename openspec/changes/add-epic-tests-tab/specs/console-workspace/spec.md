# Delta Spec: console-workspace (the Tests tab)

## ADDED Requirements

### Requirement: The epic's system tests have their own tab

The epic workspace SHALL carry a **Tests** tab, between Tasks and Threads,
which renders the epic's system test cases (FACTORY.md §4b): the four groups
— ready to run, failed, not runnable yet, passed — each case's identifier
(`ST-<n>`), its dependency chips, its state and, on a runnable case, the
Pass/Fail verdict controls. The tab SHALL render for every epic, including
one with no cases. Its label SHALL carry the pass count (`Tests (1/3)`)
where cases exist and read plainly `Tests` where none do.

The task board SHALL NOT render the case rows. It SHALL keep the count: a
line naming how many cases the epic has, how many have passed, and linking
to the tab.

#### Scenario: Cases move off the board

- **WHEN** an epic has three `task(` and three `test(` sub-issues, one case
  passed
- **THEN** the Tests tab lists the three cases with their verdict controls,
  the tab reads `Tests (1/3)`, and the task board shows no case row and no
  verdict control — only "3 system tests on this epic, 1 passed" and a link
  to the tab

#### Scenario: An epic with no cases still has the tab

- **WHEN** an epic has no test sub-issues
- **THEN** the Tests tab renders, reads `Tests`, and the task board says
  nothing about system tests

#### Scenario: A released case is reachable from the queue

- **WHEN** the attention queue lists "system test ST-4 is ready to run"
- **THEN** its link opens the epic on the Tests tab, where the verdict
  controls are

### Requirement: Plan tests adopts a plan on an epic that has none

The Tests tab SHALL offer a **Plan tests** action on an epic with no test
plan — neither the `test-plan` artifact nor any case sub-issue — in a
repository whose system-test policy is on or not yet read, in the states the
factory adopts from (`factory:planned`, `factory:design-ready`,
`factory:design-approved`, `factory:epic-ready`, `factory:in-staging`).
Pressing it SHALL confirm what the Test Planner will write before posting,
and SHALL then post the literal `Plan tests` on the epic as the acting user
through the user token — never as the Console's App.

Where the factory would refuse the comment, the Console SHALL show the
reason in place of the button and post nothing. The refusals are the
router's: the policy is off, the issue is not an epic (a task, a case, a
release tracker, the profile issue, a fast-track issue), the epic has
shipped or is closed, or it has not reached `factory:planned`. The Console
SHALL additionally withhold the action while a factory run is live on the
epic, and on an epic that already has a plan.

The same decision SHALL guard the endpoint, so a click the screen offered
cannot be refused by the server and a click from a stale screen is refused
with the reason the screen would have shown.

#### Scenario: Adoption on an in-flight epic

- **WHEN** an epic at `factory:design-approved` in a policy-on repo has no
  plan and no cases
- **THEN** the Tests tab offers Plan tests, and confirming it posts exactly
  `Plan tests` on the epic as the signed-in user

#### Scenario: Refused before the Planner has run

- **WHEN** the epic is at `factory:spec-approved`
- **THEN** no button is offered, and the tab says a plan needs the task
  breakdown that arrives with the Planner at `factory:planned`

#### Scenario: Refused where the repository runs no system tests

- **WHEN** the repo's `.github/factory-testing.json` is absent or has
  `system_tests: false`
- **THEN** the tab says system tests are off in that repository, offers no
  button, and the endpoint answers 409

#### Scenario: Not offered beside a plan that exists

- **WHEN** the epic already has cases, or the `test-plan` artifact
- **THEN** no Plan tests button is drawn, and the case list is the tab's
  whole content

### Requirement: The repository's system-test policy is projected

The worker SHALL mirror `.github/factory-testing.json` onto the repo row on
the same triggers as the approver file — a push touching the factory config
files, and every reconcile walk — recording whether system tests are on and
which mode. An absent file SHALL record as off. A malformed file, or GitHub
being unreachable, SHALL leave the last recorded answer in place. A repo
whose policy has never been read SHALL be distinguishable from one whose
policy says off, and the Console SHALL treat only the latter as a reason to
withhold the test actions.

#### Scenario: Policy off hides the action

- **WHEN** the file says `system_tests: false`
- **THEN** the repo row records off, and no epic in it offers Plan tests

#### Scenario: An unread policy is not an off one

- **WHEN** a repo has been connected but no reconcile walk has read its
  policy
- **THEN** the epic payload reports the policy as unknown and the action is
  still offered, leaving the factory's own refusal — which names the file to
  add — as the answer
