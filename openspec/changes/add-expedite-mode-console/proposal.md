# Add Expedite Mode to the Console

## Why

The factory is gaining **expedite mode** (change `add-expedite-mode` in
`claude-software-factory`): an orthogonal marker label `factory:expedite` a
human applies to an epic at any step after the spec exists, from which point
the factory auto-approves gates G1 and G2 and auto-runs every per-task stage
(implement → review → test → assemble) until the epic is fully assembled.
The chain stops at a **new epic state `factory:epic-ready`** and a **new
human gate GS (staging release)**; gate G3 (production promotion) is
unchanged. `factory:epic-ready` and GS are universal — every epic passes
through them, expedited or not.

The Console is the humans' control panel; without this change it would show
an unknown label, keep rendering "start the Reviewer / QA / Release" and
per-task Approve attention items that the factory now handles itself, and
offer no way to flip the one switch the feature is about. The Console must
expose the switch, tell the truth about what runs by itself, and surface the
two decisions that remain.

## What Changes

- **Core catalog:** `packages/core` learns both labels —
  `factory:expedite` as an orthogonal marker (alongside blocked/in-progress),
  `factory:epic-ready` as a state between `factory:on-epic` and
  `factory:in-staging` — plus the GS gate mapping (`staging` approver key,
  `release` fallback) and next-step wording (base + expedited variants,
  mirroring `handbook/next-step.json`).
- **Expedite toggle** in the epic workspace: available at every post-spec
  stage, applies/removes `factory:expedite` as the acting user via the
  user-token client (never as the app). Applying shows a confirm step that
  lists exactly which gates it waives (G1, G2, implementation starts,
  review/QA/assembly starts) and which remain human (staging, production);
  the timeline records who flipped it and when. The toggle is disabled with
  the factory's refusal reasons where they apply (tracker, profile,
  fast-track issues) and reflects reverts (unauthorized application) when
  the projection catches them.
- **Truthful stage rail and attention queue:** an expedited epic shows an
  expedite badge on board rows, queue rows and the workspace; while the
  marker is present the queue suppresses the per-task Approve and the
  start-the-next-role attention items for that epic (the factory does
  those), surfacing only `factory:epic-ready`, `factory:in-staging` (G3)
  and `factory:blocked`. Non-expedited epics keep today's items.
- **Gate GS panel** at `factory:epic-ready`: evidence (assembly report,
  suite results, tasks table all-green), the same open-questions guard as
  G1/G2, and an **Approve** that posts the literal `Approved` on the epic
  as the user — the same mechanism as existing comment gates. G3's panel is
  unchanged and keeps its per-PR merge buttons.
- **Task board** rows of an expedited epic show that the next hop is
  automatic (chip: "auto — Reviewer next"), driven by the marker plus
  `factory:in-progress`, instead of start buttons.

Not in this change: any factory-side behavior (that is `add-expedite-mode`),
notifications/email, RBAC beyond the existing collaborator checks, or an
org-wide expedite default.

## Capabilities

### New Capabilities

- _(none — expedite is rendered through existing Console capabilities)_

### Modified Capabilities

- `console-workspace`: expedite toggle + confirm + timeline entry; expedite
  badge; GS gate panel with comment-approve; task-board auto chips;
  epic-ready in the stage rail.
- `console-attention`: expedited-epic suppression rules; `factory:epic-ready`
  as a needs-you item for `staging` approvers; badge on rows.

## Impact

- `packages/core` (factory.ts, phases.ts, start-gate.ts, next-step.ts,
  derive.ts / epic-status.ts), `apps/web` (workspace, board, queue, gate
  panel), `apps/api` (label write endpoint reuse for the toggle), e2e
  fixtures.
- Depends on the factory change's label names and gate semantics; build
  after `add-expedite-mode` sections 1–6 land so names are final.
- No schema migration: labels flow through the existing projection; the
  toggle uses the existing user-token label write path.
