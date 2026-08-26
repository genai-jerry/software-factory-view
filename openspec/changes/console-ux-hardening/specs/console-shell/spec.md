## ADDED Requirements

### Requirement: Compact top bar does not wrap into a second job
On viewports below 768px the top bar SHALL be a single row: brand, one Focus control, account avatar. Login text MAY be omitted on compact viewports (the avatar SHALL have an accessible name). The Focus control SHALL be a chip or single button that opens a sheet of project and repository choices; it SHALL NOT place two native `<select>` elements in the top bar on compact viewports.

#### Scenario: Phone top bar stays one row
- **WHEN** a signed-in member opens My work at 360px width with no focus set
- **THEN** the top bar does not wrap onto a second line, brand and Focus and account remain visible, and no permanently visible sidebar is shown

#### Scenario: Focus is a sheet on a phone
- **WHEN** the member taps Focus at 360px width
- **THEN** a dialog lists projects and repositories, choosing one sets the same persisted focus as today, and Escape or Close dismisses the sheet and returns focus to the Focus control

### Requirement: Exactly one halt region
When the factory is stopped on the current user (rank-1 attention or an open gate awaiting them), the shell SHALL show at most one halt bar. The halt bar SHALL remain visible while navigating between My work, Flow, Inbox, and the relevant epic. The Console SHALL NOT also show a duplicate “gate is waiting on you” banner or a second sticky Approve on the same screen as that halt bar. Opening the halt action SHALL take the member to peek (blocked) or the Gate tab (approver).

#### Scenario: Halt follows the member off My work
- **WHEN** a member has a rank-1 blocked item and opens Flow
- **THEN** the halt bar remains visible and its action still opens that item’s peek or workspace Gate

#### Scenario: Gate workspace does not stack halt and banner
- **WHEN** an approver opens an epic that is waiting on them and then opens the Gate tab
- **THEN** they see the sticky gate actions and they do not see a second halt bar plus an info banner repeating the same fact

### Requirement: Landscape phone remains usable
At an 800×360 CSS-pixel viewport the compact shell SHALL keep bottom navigation reachable, SHALL NOT overlay halt bar and action bar so that the document is unreadable, and SHALL NOT require page-level horizontal panning.

#### Scenario: Landscape My work
- **WHEN** a signed-in member opens `/` at 800×360
- **THEN** My work content is readable, primary navigation is reachable, and document scrollWidth does not exceed clientWidth by more than 1px

### Requirement: More deep-links land on the right Settings section
When More lists both Organisation and GitHub App, each control SHALL navigate to Settings with a distinct section target. An org admin who is not the GitHub App owner SHALL reach Organisation settings. A GitHub App owner SHALL reach the GitHub App section.

#### Scenario: Org admin opens Organisation from More
- **WHEN** an org owner with `canEditApp` false taps Organisation in More
- **THEN** they arrive at Settings scrolled to (or showing only) organisation configuration, not a missing page

### Requirement: Viewport tests exercise live signed-in routes
Automated viewport checks SHALL load the signed-in application routes (or a harness that mounts the same page components against a mocked API), not a static shell-only fixture as the sole evidence. Suites SHALL run at 360×800, 768×1024, 1280×800, and 800×360 and SHALL assert no page-level horizontal overflow on My work, peek, Gate, Inbox, and onboarding. An axe-core pass SHALL run on My work and on the Gate tab at 360px.

#### Scenario: Real My work does not pan at 360px
- **WHEN** the signed-in My work page is opened at 360×800 with at least one Needs-you row in the fixture
- **THEN** the document does not require horizontal panning and the halt bar plus bottom navigation do not cover the row title

#### Scenario: Axe on live My work
- **WHEN** axe-core runs on signed-in My work at 360px
- **THEN** it reports no violations at WCAG 2.2 AA for that page
