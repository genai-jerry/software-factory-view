# Delta Spec: console-workspace (expedite mode)

## ADDED Requirements

### Requirement: Expedite toggle acts as the user and confirms what it waives

The epic workspace SHALL offer an Expedite toggle on requirement (epic)
issues at every stage from `factory:spec-ready` onward. Turning it on SHALL
first show a confirm step listing the gates it waives (G1 spec, G2 design,
implementation starts, review/QA/assembly starts) and the gates that remain
human (GS staging, G3 production), then apply `factory:expedite` via the
user-token client as the acting member. Turning it off SHALL remove the
label the same way, without a confirm. The toggle SHALL be unavailable, with
the reason, on release trackers, profile issues and `factory:fast-track`
issues, and pre-spec it SHALL state that expedite lies dormant until the
spec exists. A factory revert of an unauthorized application SHALL be
reflected once projected, with the factory's comment as the explanation.

#### Scenario: Applying expedite at design-ready

- **WHEN** a member opens an epic at `factory:design-ready` and confirms the
  Expedite toggle
- **THEN** `factory:expedite` is applied as that member, the confirm listed
  G1/G2/starts as waived and staging/production as remaining, and the
  timeline records the flip

### Requirement: Gate GS panel at epic-ready

At `factory:epic-ready` the workspace SHALL render a gate panel titled as
the staging-release gate (GS): the assembly evidence (Release/dispatch
report, suite results, all-tasks state table), the open-questions guard used
by G1/G2, and an Approve action that posts the literal comment `Approved` on
the epic as the acting user. The panel SHALL name the `staging` approvers
(falling back to the `release` list, then any collaborator) and state
plainly that approving releases the epic to the integration branch, not to
production. The G3 panel at `factory:in-staging` is unchanged.

#### Scenario: Approving GS from the Console

- **WHEN** a `staging` approver presses Approve on the GS panel
- **THEN** the Console posts `Approved` on the epic as that user and the
  panel reflects the factory's resulting state once projected

### Requirement: Truthful automation cues on expedited epics

While an epic carries `factory:expedite`, the stage rail and task board
SHALL show an expedite badge and replace start controls with an automatic
next-hop cue (e.g. "auto — Reviewer next", live when `factory:in-progress`
is present); manual start buttons SHALL remain available behind an explicit
affordance, since any human may still take over any stage. When the marker
is absent, today's controls render unchanged.

#### Scenario: Task board on an expedited epic

- **WHEN** a task of an expedited epic sits at `factory:in-test` with no run
  live
- **THEN** its row shows the expedite badge and "auto — QA next" instead of
  a bare Start QA button, with the manual start reachable but secondary
