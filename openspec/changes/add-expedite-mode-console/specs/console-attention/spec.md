# Delta Spec: console-attention (expedite mode)

## ADDED Requirements

### Requirement: Expedited epics only surface real decisions

While an epic carries `factory:expedite`, the attention queue SHALL suppress
that epic's (and its tasks') per-task implementation Approve items and the
start-the-next-role items for review, QA and assembly — the factory advances
those itself. The epic SHALL still surface for: `factory:epic-ready`
(gate GS, targeted at the `staging` approvers with fallback to `release`),
`factory:in-staging` (gate G3), `factory:blocked` (any stage), and the
Actions engine's missing-token degradation comment when projected. Removing
the marker restores today's attention items from the epic's current state.

#### Scenario: No start items while expedited

- **WHEN** a task of an expedited epic reaches `factory:in-review`
- **THEN** the queue shows no "start the Reviewer" item for it, and the
  epic's row carries the expedite badge

#### Scenario: Epic-ready is a needs-you item

- **WHEN** an expedited epic flips to `factory:epic-ready`
- **THEN** the queue surfaces it to the `staging` approvers with the reason
  "release to staging is waiting on you" and a path to the GS panel

### Requirement: Epic-ready surfaces for every epic

`factory:epic-ready` SHALL be a needs-you state for non-expedited epics too,
replacing the previous "all tasks on-epic — start the Release Manager"
attention wording with the GS gate item, so the queue matches the factory's
universal staging gate.

#### Scenario: Non-expedited epic reaches the gate

- **WHEN** a non-expedited epic flips to `factory:epic-ready`
- **THEN** the queue shows the GS item to the `staging` approvers, not a
  start-the-Release-Manager item
