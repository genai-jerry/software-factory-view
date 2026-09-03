# Delta Spec: console-attention (system test tasks)

## ADDED Requirements

### Requirement: A runnable case is a needs-you item for its testers

When a test sub-issue reaches `factory:manual-test`, the attention queue
SHALL surface it to the `testers` list (falling back to `implementation`,
then any collaborator) with the reason "system test ST-<n> is ready to run"
and a link to the case on the task board. It SHALL be ranked with the
per-task implementation start items. Passing or failing the case SHALL
remove the item on the next projection. A case at `factory:test-failed`
SHALL NOT surface itself; its fix task surfaces as any `factory:ready` task
does.

#### Scenario: Tester sees the case

- **WHEN** ST-4 flips to `factory:manual-test` and the acting user is in the
  `testers` list
- **THEN** the queue shows "system test ST-4 is ready to run" for the epic,
  linking the task board

#### Scenario: Non-tester does not

- **WHEN** the acting user is outside a non-empty `testers` list
- **THEN** the queue shows no item for ST-4, and the epic row's badge still
  counts it among the open tests

### Requirement: Gate GS surfaces only when the factory says so

Under `mode: gate` an epic whose code tasks are all assembled but whose
tests are outstanding SHALL NOT surface as a GS item; the queue SHALL show
it only at `factory:epic-ready`, exactly as today. The epic's row SHALL
carry a "waiting on N tests" chip meanwhile, so the hold is visible without
being an item for the staging approvers.

#### Scenario: Assembled but untested is not a GS item

- **WHEN** an epic's last code task lands on the epic branch and three cases
  remain runnable under `mode: gate`
- **THEN** the queue shows no GS item for the epic, and its row reads
  "waiting on 3 tests"
