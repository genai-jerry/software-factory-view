# Tasks: System Test Tasks (Console)

Depends on `add-system-test-generation` in `claude-software-factory`
(sections 1, 3 and 5) for final label names, comment bodies, the `testers`
key and the `.github/factory-testing.json` shape.

## 1. Core catalog

- [x] 1.1 Add `factory:manual-test`, `factory:test-passed` and
      `factory:test-failed` to `packages/core/src/factory.ts` (colours and
      descriptions copied from `setup-labels.sh`), the `TEST_PASSED_BODY` /
      `TEST_FAILED_BODY` constants, `MANUAL_TEST_STATE`, and `testers` in
      `ApproverFile` with a `testers → implementation` entry in
      `GATE_FALLBACK`; verify onboarding's labels step provisions 28 labels
      and the state-exclusivity helpers accept the three.
- [x] 1.2 Derive the `test` issue kind from `test(<epic>)` in `derive.ts`,
      map the three states in `phases.ts` (`building`), add
      `STATE_SENTENCE` / `NEXT_MOVER` and `next-step.ts` wording mirroring
      `handbook/next-step.json`, and split `EpicProgress` into code and
      test counts in `epic-status.ts` ("Building a/b · Testing c/d",
      "Assembled · waiting on N tests"); verify with unit tests for an epic
      with and without test sub-issues.
- [x] 1.3 Add a `test-verdict.ts` helper (awaiting / pending verdict /
      passed / failed, with the same grace window as `start-gate.ts`) and a
      reader for `.github/factory-testing.json` beside the other factory
      config files (absent ⇒ off, `mode` default `gate`); verify parsing of
      absent, invalid and both-mode files.

## 2. Workspace

- [x] 2.1 Task board: render test sub-issues as their own group with case
      identifier, dependency chips, state and fix-task link; exclude them
      from code-task counts; verify non-test rendering is byte-identical to
      today.
- [x] 2.2 Pass / Fail actions: `apps/api` tree route that posts an optional
      evidence comment then the literal verdict body as the user (reusing
      the `Review Done` path), visibility by `testers` fallback chain and
      state, pending-verdict rendering; verify the writes never use the app
      token and the verdict body is posted last.
- [x] 2.2a Plan system tests action: visible only on an epic with no plan in
      a policy-on repo and only in the states the factory accepts, posting
      the literal `Plan tests` as the user after a confirm that says what it
      does; render test rows as pending with the open plan PR linked until it
      merges; verify the action is hidden in every refused case.
- [x] 2.3 Artifact reader and peek: list `system-tests/test-plan.md` and
      `test-data.md` with the as-proposed ⇄ as-approved toggle; extract a
      case's `### ST-<n>` section and its `Data:` sets for the test
      sub-issue's peek; verify against a fixture change folder.
- [x] 2.4 Gate tab: test matrix (case, verdict, tester, when) from the
      projected verdict comments; hold the GS panel before
      `factory:epic-ready` with the open cases and testers named; advisory
      / no-epic-branch warning above Approve and above the G3 merge
      buttons; verify both modes with unit tests, including an epic that
      adopted its plan after reaching `factory:epic-ready` (warn, never
      block).

## 3. Attention queue

- [x] 3.1 Add the tester needs-you item for `factory:manual-test` (targeted
      by the `testers` fallback chain, ranked with task starts) and the
      "waiting on N tests" chip on epic rows; keep the GS item at
      `factory:epic-ready` only; verify with queue unit tests for tester and
      non-tester users.

## 4. Verification

- [ ] 4.1 E2E: an epic with three test sub-issues — board grouping, tester
      Pass with evidence, Fail filing a fix and the row linking it, the GS
      hold in gate mode and the warning in advisory mode — at 360px and
      desktop, axe-checked; fixtures updated for the three labels and the
      `test(` kind.
- [ ] 4.2 E2E: adoption on an epic with no plan — the action posts `Plan
      tests`, rows render pending behind the open plan PR, and an epic
      adopted at `factory:epic-ready` shows the warning with Approve still
      available; verify the action is absent in a policy-off repo.
