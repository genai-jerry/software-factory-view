# Tasks: A Tests Tab on the Epic

## 1. The policy as a projection

- [x] 1.1 Add nullable `system_tests` / `test_mode` columns to `repos`
      (migration 0014) and `importTestingPolicy` in the worker, wired in
      beside `importGateAssignments` in both the config-file push branch and
      the reconcile walk; verify on, off, absent, malformed and unreachable,
      and that "not read" stays distinct from "off".

## 2. The decision, once

- [x] 2.1 Add `planTestsAvailability` to `packages/core`, mirroring the
      router's `is_plan_tests` refusals plus the Console's own two (a live
      run, an existing plan); verify every refusal and every adoptable
      state.

## 3. API

- [x] 3.1 Add the `systemTests` block to `/api/epics/:id` — policy, mode,
      whether a plan exists, the plan document and whether it is merged, and
      the availability — computed from the projection with no live GitHub
      call.
- [x] 3.2 Add `POST /api/epics/:id/plan-tests`, guarded by the same helper,
      posting the literal `Plan tests` as the acting user and writing an
      audit row; verify the 409s for policy-off, too-early, already-planned
      and not-an-epic.
- [x] 3.3 Point the attention queue's runnable-case item at `?tab=tests`.

## 4. Web

- [x] 4.1 Move the case list and the verdict controls into a new
      `pages/SystemTests.tsx`, add the `tests` tab with its pass count, and
      replace the board's case group with a counted pointer to the tab.
- [x] 4.2 Add the Plan tests action with its confirm, the reason shown where
      the factory would refuse, and the unmerged-plan banner; point the issue
      peek's Open workspace at `?tab=tests` for a case.
- [x] 4.3 Add a banner on the epic, beside the task start gate's, naming the
      cases ready to run and linking to the tab.

## 5. Verification

- [x] 5.1 Unit tests: the tab lists what the board no longer does, the board
      keeps the count, the Plan tests confirm posts once and cancels
      cleanly, and each refusal renders its reason.
- [x] 5.2 E2E: the Tests tab of an epic with cases and of an epic with none,
      at 360/768/1280px, neither panning.

## Deviations from this plan, and why

- **The tab renders even where the repo's policy is off.** Hiding it would
  make an epic in a policy-off repo silently different from every other
  epic, and the tab is where "this repository runs no system tests" can
  actually be said. The action, not the tab, is what the policy gates.

- **Re-planning an epic that already has a plan is not offered.** The
  factory's router would accept it — the comment is unrestricted — but a
  button labelled "Plan tests" beside a list of cases reads as "write these
  again", and revising a plan is a request made on the epic's thread like
  every other revision.

- **The pre-existing e2e failures on the expedite and GS screens are
  untouched.** Six of them are a strict-mode locator matching two elements,
  and four are the axe and gate-panel legs that need the API up; all ten
  fail identically on `main`. This change's three legs pass.
