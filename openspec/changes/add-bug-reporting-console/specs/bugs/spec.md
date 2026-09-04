# Delta Spec: bugs

## Purpose

How the Console renders and acts on an epic's bug reports (FACTORY.md §4c):
what a report is (and is not), where it appears, and the two things a person
does with one here.

## ADDED Requirements

### Requirement: A report is its own kind

An issue titled `bug(<epic>): <title>` SHALL project as kind `bug`, and the
three `factory:bug-*` labels SHALL be states while `factory:bug` SHALL be a
kind marker that never wins state derivation. A report SHALL be counted in
neither the code-task rollup nor the case rollup, and SHALL appear on neither
the task board nor the case list. The task the factory files to fix it is an
ordinary task and SHALL be counted with the code.

#### Scenario: Not a task

- **WHEN** an epic has two code tasks (one of them a bug fix) and three reports
- **THEN** the task rollup totals two, the bug rollup totals three, and no
  report appears among the board's columns

#### Scenario: No start control

- **WHEN** a report is rendered
- **THEN** it offers no Approve or start control in any state — the work is the
  fix task, and the report is the record

### Requirement: Raising a bug from the epic

The Tests tab SHALL offer **Report a bug** exactly where the factory would act
on the comment — an open epic at `factory:design-approved`,
`factory:epic-ready` or `factory:in-staging`, in a repo whose `bug_reports`
policy is not false, with no factory run live — and SHALL show the reason in
its place otherwise. It SHALL take a one-line title and a report, both
required, and SHALL post them as a single `Bug` comment as the acting user.

#### Scenario: Posted as one comment

- **WHEN** a tester fills in the title and the report and confirms
- **THEN** one comment is posted, `Bug: <title>` followed by the report, and
  the factory raises the report and files its fix

#### Scenario: Report required

- **WHEN** the title is filled in and the report is empty
- **THEN** the control cannot be submitted — a report with no observation
  would file a fix task quoting nothing

#### Scenario: Refused before the click

- **WHEN** the epic has built nothing yet, has shipped, is not an epic, or the
  repo has bug reports off
- **THEN** no control is drawn and the reason is shown in its place

### Requirement: Confirming a repair

A report at `factory:bug-retest` SHALL offer the same Pass/Fail control a
runnable case offers, posting the same literal `Test Passed` / `Test Failed`
as the acting user, and SHALL offer it in no other state. Gate GS SHALL show
every report with its verdict beside the test matrix, and SHALL warn when any
is open.

#### Scenario: Only at re-test

- **WHEN** a report is at `factory:bug-open`
- **THEN** no verdict control is offered — there is nothing to re-test until
  the fix is assembled

#### Scenario: Evidence at the gate

- **WHEN** an epic reaches gate GS with an open report (advisory mode, or no
  epic branch)
- **THEN** the panel lists the reports and warns that approving releases the
  epic to staging with that defect unrepaired
