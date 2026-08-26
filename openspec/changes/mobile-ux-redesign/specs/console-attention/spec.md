## Purpose

Defines the individual-first daily work surfaces — My work, issue peek, blocked inbox, flow, and the decision log — so a member can see whose move it is and act from a phone without scanning a factory-wide board.

## ADDED Requirements

### Requirement: My work is the default home
Signed-in members who belong to an organisation SHALL land on My work (`/`) grouped in fixed order: **Needs you**, **Yours, in flight**, **Waiting on others**. Each row SHALL show at most: title, one reason in plain language, one state chip, age. Factory label names MAY appear as secondary text. Tapping a row SHALL open the peek, not navigate away.

#### Scenario: Empty needs-you
- **WHEN** a member has no attention items
- **THEN** the Needs you section reads "Nothing is waiting on you. The factory is running." and does not show a blank card

#### Scenario: Row language is a job, not a label
- **WHEN** a spec-ready gate is waiting on the member
- **THEN** the reason reads as an action (for example "Approve the spec") and the chip may show G1 or spec-ready as secondary

### Requirement: Needs-you ranking is preserved on every viewport
Needs you SHALL keep the existing ownership ranking (agent halted on you, then gates awaiting you, then implementation Approved, then unowned estate-wide blocked). Rank-1 rows SHALL use the halt treatment. Rank-4 unowned rows SHALL be visually quieter and labelled as unowned.

#### Scenario: Agent-halted outranks a broadcast blocked
- **WHEN** a member is the assignee of a blocked issue and another blocked issue is unowned in the same org
- **THEN** the assigned blocked issue appears above the unowned one on both 360px and 1280px viewports

### Requirement: Peek is a full-height sheet on compact viewports
On viewports below 768px the issue peek SHALL present as a full-height sheet (not a 480px side drawer). It SHALL include, in order: title and state in a sentence, who moves next, the blocked question when present, a reply box when the viewer can unblock, the one-hop dependency strip, last event, Ask the Factory, Open workspace, and a GitHub raw link. The sheet SHALL be closable by Close, Escape, and a drag/dismiss control.

#### Scenario: Phone peek shows the blocked question and reply
- **WHEN** a member opens peek on a blocked issue they can answer, at 390px width
- **THEN** they can read the agent's question and post a reply without scrolling horizontally or opening the epic workspace

#### Scenario: Desktop peek remains a side drawer
- **WHEN** a member opens peek at 1280px width
- **THEN** the peek is a right-side drawer of at most 480px and the underlying list remains visible

### Requirement: Factory tab does not ship a thirteen-column board on compact viewports
On viewports below 768px the Factory tab (and Flow's board lens) SHALL present epics as a **phase-stacked list** (Held, Being specified, Being planned, Being built, Shipping, Fast track) rather than a horizontally scrolling 210px-column kanban. On viewports 1024px and above the existing column board MAY be shown. Card tap SHALL open peek.

#### Scenario: Phone factory view is a list
- **WHEN** a member opens the Factory tab at 360px width
- **THEN** they see stacked phase sections, not a row of thirteen 210px columns requiring horizontal pan of the page

#### Scenario: Desktop factory view keeps the board
- **WHEN** a member opens the Factory tab at 1280px width
- **THEN** they see the pipeline board with one column per factory state plus Fast track and Held

### Requirement: Flow tree is readable on a phone
The Flow tree SHALL wrap node metadata instead of overflowing. Expand/collapse controls SHALL be 44×44 preferred targets. Tapping the epic title SHALL open peek; a separate control SHALL open the workspace. Keyboard users SHALL toggle a node with Enter and Space.

#### Scenario: Tree node wraps on a phone
- **WHEN** an epic title plus gate approver list would exceed 360px
- **THEN** the row wraps onto subsequent lines and remains fully tappable

### Requirement: Blocked inbox is an answer surface
Each blocked issue SHALL show the agent's question (when known), age, repository, and a Reply action. On compact viewports Reply SHALL expand in place with a textarea (16px font, appropriate `enterkeyhint`) and a "Post reply & unblock" primary button. Posting SHALL remain an ordinary GitHub comment under the viewer's identity.

#### Scenario: Reply from a phone
- **WHEN** a member opens Inbox, taps Reply, types an answer, and confirms
- **THEN** the comment is posted as that GitHub user and the row leaves the inbox after the factory clears the blocked label (or shows a pending state until refresh)

### Requirement: Decision log is searchable on a small screen
The decision log SHALL keep search above the list. Each decision card SHALL stack title, status, author, date, then body. Search input SHALL not zoom iOS (font-size at least 16px).

#### Scenario: Search does not zoom on iOS
- **WHEN** a member focuses the decision search field on a 390px viewport
- **THEN** the field's computed font-size is at least 16px
