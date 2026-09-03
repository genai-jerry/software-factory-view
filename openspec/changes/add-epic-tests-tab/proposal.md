# A Tests Tab on the Epic, and a Plan Tests Button

## Why

`add-system-test-tasks-console` landed the system test cases (FACTORY.md
§4b) at the foot of the epic's **Tasks** tab, under their own heading. Two
things are wrong with that home.

A case is not a task. No agent runs on one, none of the board's columns
describes it, and the person it is addressed to is a tester, not the
approver watching the build. Filed below the board, it is also the last
thing on the longest tab — the wrong place for the only work in the factory
that a human does by hand, and the one item expedite never suppresses.

And the epic that has *no* cases had nowhere at all to say so. Section 2.2a
of the last change planned a **Plan system tests** action for exactly that
epic — an epic that passed gate G2 before system tests were turned on, whose
chain has long finished, and which adopts a plan by someone commenting
`Plan tests` on it. The factory has accepted that comment since
`add-system-test-generation` landed; the Console never grew the button, so
the only way to ask is to type the words on GitHub.

## What Changes

- **A Tests tab** on the epic workspace, between Tasks and Threads, carrying
  the case list that used to sit under the task board: the four groups
  (ready to run, failed, not runnable yet, passed), the case identifiers and
  dependency chips, and the Pass/Fail verdict controls, unchanged. Its label
  carries the pass count — `Tests (1/3)` — and it renders for every epic,
  including one with no cases at all.
- **The task board keeps the count, not the list.** A one-line pointer
  ("2 system tests on this epic, 1 passed — open the Tests tab") replaces the
  case group: an epic whose tasks are all done is not finished while its
  tests are outstanding, and the board is where a reader would otherwise take
  that reading.
- **A Plan tests button** on the Tests tab, offered on an epic with no plan
  in the states the factory adopts from. It posts the literal `Plan tests` as
  the acting user through the user token — the same mechanism as Approve and
  the verdicts — after a confirm that says what the Test Planner will write
  and that the resulting PR must be merged before any case reaches a tester.
- **The refusals are decided before the click.** A new core helper,
  `planTestsAvailability`, mirrors the router's `is_plan_tests` branch: off
  policy, not an epic, shipped or closed, earlier than `factory:planned`.
  Where the factory would refuse, the tab shows the reason instead of a
  button. Two refusals are the Console's own and are marked as such: a live
  factory run, and an epic that already has a plan.
- **The repo's test policy becomes a projection.** The worker mirrors
  `.github/factory-testing.json` onto the repo row on the same triggers as
  the approver file (config-file push, reconcile walk), so the read path
  answers "does this repo run system tests?" without a live GitHub call.
  Three states, kept distinct: on, off, and not read yet — an unread policy
  is not an off one, and must not hide the action on every repo connected
  before the sync first ran.
- **The links follow the cases.** The attention queue's "system test ST-4 is
  ready to run" item and the issue peek's Open workspace button land on
  `?tab=tests`, where the verdict controls now live.

Not in this change: any factory-side behaviour (the `Plan tests` route
already exists), editing the test plan in the Console, revising a plan an
epic already has, or a settings editor for `.github/factory-testing.json`.

## Capabilities

### Modified Capabilities

- `console-workspace`: the Tests tab, the board's pointer in place of the
  case list, the Plan tests action, and the epic payload's `systemTests`
  block.

## Impact

- `packages/core` (new `plan-tests.ts`), `packages/db` (two nullable columns
  on `repos`, migration 0014), `apps/worker` (`importTestingPolicy`, wired
  into ingest and reconcile), `apps/api` (the `systemTests` block on
  `/api/epics/:id`, `POST /api/epics/:id/plan-tests`, the attention link),
  `apps/web` (a new `SystemTests.tsx` page, the tab, the board pointer, the
  peek link), e2e harness and spec.
- No behaviour change for a repo that runs no system tests beyond the tab
  existing and saying so.
