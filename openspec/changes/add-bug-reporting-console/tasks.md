# Tasks: bugs on the epic

Factory change: `add-bug-reporting` in `claude-software-factory` — the labels,
states, controls and gate rule this renders.

## 1. Core

- [x] 1.1 The three states in `FACTORY_LABELS` (colours copied from
      `setup-labels.sh`, never picked), `factory:bug` in
      `FACTORY_KIND_LABELS`, and `BUG_STATE_ORDER` / `isBugState` kept out of
      `PIPELINE_ORDER`.
- [x] 1.2 `bug` as an `IssueKind`, derived from the `bug(<epic>)` title before
      the parent/state fallbacks, so a report is never a task.
- [x] 1.3 Phases, state sentences, next-mover lines and `nextStep` answers for
      all three; `factory:bug-retest` joins `GATE_STATES` under `testers`.
- [x] 1.4 `bug_reports` in `parseTestingPolicy` (following `system_tests`) and
      `bugsHoldTheGate`.
- [x] 1.5 `bugReportAvailability` — the router's refusal ladder, decided
      before the click.
- [x] 1.6 `testVerdictStatus` reads the bug states, so one control serves both.

## 2. Projection and API

- [x] 2.1 `repos.bug_reports` (migration 0015) and the mirror in
      `importTestingPolicy`.
- [x] 2.2 Reports split out of the task rows: their own `BugRollup`, their own
      payload block, off the board and out of the case list.
- [x] 2.3 `POST /api/epics/:id/bugs` — one comment, title and report, guarded
      by the same availability function the payload uses.
- [x] 2.4 The verdict endpoint accepts a report at `factory:bug-retest`.
- [x] 2.5 Bugs in the gate payload as GS evidence, and an attention item for a
      report waiting on its re-test.

## 3. Web

- [x] 3.1 The Bugs section on the Tests tab: grouped by what each waits on,
      the fix named, the verdict offered only at re-test.
- [x] 3.2 The Report a bug form, with the report required.
- [x] 3.3 The tab label and the tasks-tab pointer carry open bugs; a peek at a
      report opens the Tests tab.
- [x] 3.4 Bugs in the gate panel, with the warning when any is open.

## 4. Tests

- [x] 4.1 Core: kind, states, availability ladder, verdict reading, comment
      shape.
- [x] 4.2 API: the three-way split, the availability ladder over the payload,
      both endpoints' refusals.
- [x] 4.3 Web: grouping, the verdict only at re-test, no start control on a
      report, the form's one-comment post and its required report.
- [x] 4.4 Worker: the policy mirror, including both explicit overrides.
