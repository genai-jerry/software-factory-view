# Tasks: Expedite Mode (Console)

Depends on `add-expedite-mode` in `claude-software-factory` (sections 1–6)
for final label names, gate keys and next-step wording.

## 1. Core catalog

- [x] 1.1 Add `factory:expedite` (orthogonal marker) and
      `factory:epic-ready` (state between `factory:on-epic` and
      `factory:in-staging`) to `packages/core/src/factory.ts`; extend the
      gate map with GS at `factory:epic-ready` (`staging` key, `release`
      fallback); verify state-exclusivity helpers treat the marker like
      blocked/in-progress.
- [x] 1.2 Update `phases.ts`, `derive.ts`/`epic-status.ts` (expedited flag
      on the epic derivation; epic-ready phase), `start-gate.ts` and
      `next-step.ts` (base + expedited wording, mirroring
      `handbook/next-step.json`); verify derivations with unit tests for
      expedited and non-expedited epics in each state.

## 2. Workspace

- [x] 2.1 Build the Expedite toggle + confirm dialog (waived vs. remaining
      gates), wired to the existing user-token label write path; disable
      with reasons on trackers/profile/fast-track and pre-spec dormancy
      note; timeline entry on flip; verify the label write posts as the
      user, never the app.
- [x] 2.2 Build the GS gate panel at `factory:epic-ready`: assembly
      evidence, open-questions guard, Approve posting literal `Approved` as
      the user, staging-not-production wording; verify G3 panel untouched.
- [x] 2.3 Stage rail, board and task-board treatment: expedite badge,
      "auto — <role> next" chips (live with `factory:in-progress`), manual
      starts demoted but reachable; verify non-expedited rendering is
      byte-identical to today.

## 3. Attention queue

- [x] 3.1 Implement suppression of per-task Approve and start-role items
      for expedited epics; keep epic-ready/in-staging/blocked (and the
      projected missing-token degradation comment) surfacing; verify with
      queue unit tests either side of marker removal.
- [x] 3.2 Make `factory:epic-ready` a needs-you item for every epic,
      targeted at `staging` approvers with the release-to-staging reason;
      remove the old all-on-epic start wording; verify queue snapshot tests.

## 4. Verification

- [x] 4.1 E2E: expedited epic walkthrough (toggle on at design-ready →
      badges and suppression → epic-ready GS panel → Approve → in-staging
      G3 panel) at 360px and desktop, axe-checked; fixtures updated for the
      two new labels.
      _Written (`apps/web/e2e/harness.tsx` screens + `ux.spec.ts` cases) and
      typechecked, but NOT executed here: Playwright could not download a
      browser in this environment. CI runs it. The same behaviour is covered
      by runnable jsdom tests in `apps/web/src/pages/Expedite.test.tsx`._
