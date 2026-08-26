## Purpose

Defines the epic workspace and gate review so an approver can read the artefact, see what changed, and approve, request changes, or merge from a phone without losing the factory's authority model.

## ADDED Requirements

### Requirement: Single-column workspace on compact viewports
On viewports below 1024px the epic workspace SHALL be a single column: header, compact stage, optional halt bar, horizontally scrollable **tab list** (not wrapped into two rows of tiny targets), then the active pane. Ask the Factory and the timeline SHALL move behind an **Ask** control and a **History** control rather than occupying a permanent 340px right rail. On viewports 1024px and above a main pane plus context rail MAY be shown.

#### Scenario: Phone workspace has no right rail
- **WHEN** an approver opens an epic at 390px width
- **THEN** Ask the Factory is not a persistent right column; it is opened from an Ask control and the artefact pane uses the full content width

#### Scenario: Desktop workspace keeps the context rail
- **WHEN** an approver opens an epic at 1280px width
- **THEN** Ask the Factory and the timeline remain in a context rail beside the active tab

### Requirement: Compact stage rail
On compact viewports the stage rail SHALL show the previous stage, the current stage (labelled in people language, with the factory label as secondary), and the next stage. Tapping the rail SHALL expand the full 11-stage machine. Current stage plus "waiting on you" SHALL be visually distinct by label and marker, not colour alone.

#### Scenario: Compact rail shows three stages
- **WHEN** an epic is at `factory:spec-ready` on a 360px viewport
- **THEN** the rail shows intake → **Approve spec (G1)** → spec approved (or equivalent people-language labels) and a control to expand the full rail

### Requirement: Tab list is swipeable and named for jobs
Workspace tabs SHALL be labelled with jobs: Overview, Spec, Gate (only when a gate is open), Tasks, Threads, Decisions. The tab list SHALL scroll horizontally on compact viewports with 44px-tall targets and SHALL not shrink labels below 14px. The open tab SHALL be indicated by a selected state that does not rely on colour alone (underline plus `aria-selected`).

#### Scenario: Gate tab appears only when the gate is open
- **WHEN** the epic is at `factory:spec-ready` and the viewer is looking at the workspace
- **THEN** a Gate tab is present; when the epic leaves a gate state, the Gate tab is absent

### Requirement: Gate review is action-first
When a gate is open and the viewer is an approver, the workspace SHALL present a halt bar (or sticky footer on compact viewports) with the primary actions: **Approve**, **Request changes**, and for the release gate **Merge** per PR. Approve SHALL still post the literal comment `Approved` as the signed-in GitHub user. The open-questions acknowledgement SHALL remain mandatory when unresolved threads exist. The artefact body SHALL remain on the same screen as the action (the action bar does not replace the document).

#### Scenario: Approver completes G1 from a phone
- **WHEN** a listed spec approver opens the Gate tab at 390px width, reads the rendered spec, acknowledges open questions if shown, and taps Approve
- **THEN** the Console posts `Approved` under that user's OAuth identity and confirms success in plain language

#### Scenario: Non-approver does not see Approve
- **WHEN** a member who is not on the gate's approver list opens the Gate tab
- **THEN** Approve and Merge are not shown; they can still read the artefacts and use Request changes / comment if the product already allows it

### Requirement: Artefacts are readable without a side-by-side pane
The artefact reader SHALL stack the file picker, as-proposed / as-approved toggle, and rendered markdown. Tables inside markdown SHALL scroll **inside** the artefact card, not the page. The as-proposed / as-approved toggle SHALL be a labelled segmented control with 44px targets.

#### Scenario: Wide markdown table does not pan the workspace
- **WHEN** a spec contains a wide table and the viewer is at 360px width
- **THEN** only the table region scrolls horizontally; the tab list and halt bar stay fixed to the viewport

### Requirement: What-changed remains visible
When the artefact changed since the viewer last looked, the Gate pane SHALL show a plain-language banner naming the previous and current short SHAs **before** the Approve control. The viewer SHALL be able to open the rendered document without dismissing that banner.

#### Scenario: Stale-read warning precedes Approve
- **WHEN** `changedSinceLastView` is true for this approver
- **THEN** a banner equivalent to "This spec changed since you last looked" appears above the actions

### Requirement: Threads and tasks on a phone
Thread entries SHALL stack author, time, and body. The reply composer SHALL use a 16px textarea and a Post button in a sticky composer when the thread is open. The tasks list SHALL be a vertical list (not a mini kanban) on compact viewports, with blocked tasks using the halt treatment.

#### Scenario: Reply to a thread from a phone
- **WHEN** a member opens Threads, opens a thread, and posts a reply
- **THEN** the reply is an ordinary GitHub comment carrying the existing `console:thread` marker

### Requirement: Ask the Factory is a sheet on compact viewports
On compact viewports Ask the Factory SHALL open as a sheet containing canned prompts, the transcript, citations as buttons, and the composer. Disabled insight SHALL explain in one sentence how to enable it (Settings or host key) rather than showing a budget percentage as the only message.

#### Scenario: Canned prompt on a phone
- **WHEN** insight is enabled and a member opens Ask and taps "Why is this blocked?" from an issue-scoped sheet
- **THEN** the question is submitted with the existing issue-scoped corpus and the answer includes citations
