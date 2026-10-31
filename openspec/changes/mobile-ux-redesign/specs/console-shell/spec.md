## Purpose

Defines the Compass application chrome, navigation information architecture, visual language, and accessibility floor so every signed-in surface is usable from a 360px phone to a wide desktop.

## ADDED Requirements

### Requirement: Viewport and layout floor
The Console SHALL render without page-level horizontal scrolling at viewports from 360px wide upward. The primary content column SHALL remain readable at a 16px root font size without pinch-zoom. Interactive controls SHALL have a minimum 24×24 CSS pixel target (WCAG 2.2 Success Criterion 2.5.8) and a preferred 44×44 CSS pixel target (Apple HIG / WCAG 2.5.5). Adjacent targets SHALL be separated by at least 8px.

#### Scenario: Phone portrait has no page-level overflow
- **WHEN** a signed-in member opens any primary route at a 360×800 CSS pixel viewport
- **THEN** the document does not require horizontal panning, body text is at least 16px, and primary buttons meet the 44×44 preferred target

#### Scenario: Landscape phone still fits
- **WHEN** a signed-in member rotates to a 800×360 viewport
- **THEN** the shell remains usable (navigation reachable, no overlapping panels) and content reflows rather than clipping

### Requirement: Responsive application shell
On viewports below 768px the Console SHALL present a compact shell: a top bar (brand, current focus, account) and a bottom navigation of at most four primary destinations. On viewports 1024px and above the Console SHALL present a persistent side navigation. Between 768px and 1023px the Console SHALL present the compact shell or a collapsible side navigation, never both stacked in a way that consumes more than 20% of vertical space.

#### Scenario: Compact shell on a phone
- **WHEN** a signed-in member is on a 390px-wide viewport
- **THEN** they see a top bar and a four-item bottom navigation, and they do not see a permanently visible 220px left sidebar

#### Scenario: Wide shell on a desktop
- **WHEN** a signed-in member is on a 1280px-wide viewport
- **THEN** they see a persistent side navigation listing the same destinations as the compact shell's primary plus overflow items

### Requirement: Navigation information architecture
The compact bottom navigation SHALL expose exactly these primary destinations, in order: **My work** (`/`), **Flow** (`/flow`), **Inbox** (`/blocked`), **More**. **More** SHALL open a sheet listing Decisions, Onboarding, Settings (when the viewer may edit the GitHub App or org settings), Theme, and Sign out. Destination labels SHALL describe the job, not the factory internals. An Inbox badge SHALL show the count of blocked issues the member can act on when that count is greater than zero.

#### Scenario: Member reaches blocked issues from the phone nav
- **WHEN** a signed-in member taps Inbox in the bottom navigation
- **THEN** they arrive at `/blocked` without opening More

#### Scenario: Settings stays out of the primary four
- **WHEN** a signed-in member who can edit the GitHub App opens More
- **THEN** Settings is listed in the sheet and is not a fifth bottom-nav item

#### Scenario: Member without app-edit rights
- **WHEN** a signed-in member for whom `canEditApp` is false opens More
- **THEN** Settings is omitted from the sheet (org-level settings that they can edit MAY still appear under a "Organisation" row)

### Requirement: Focus context is always visible
When a project or repository focus filter is active, the shell SHALL show a persistent chip naming that focus. Clearing the chip SHALL restore the unfiltered view. The focus control SHALL be reachable from every primary route without horizontal overflow.

#### Scenario: Focus chip on a filtered My work view
- **WHEN** a member has focused a single repository and opens My work on a 360px viewport
- **THEN** a chip naming that repository is visible in the top bar or directly below it, and dismissing the chip clears the focus

### Requirement: Keyboard, focus, and motion
Every interactive control SHALL be reachable by keyboard. Focus SHALL be visible (a 2px accent outline, not color alone). Modal overlays (peek drawer, run modal, More sheet, confirmations) SHALL trap focus, restore it to the opener on close, and dismiss on Escape and on a clearly labelled Close control. The Console SHALL honour `prefers-reduced-motion: reduce` by disabling non-essential transitions. A skip link SHALL move focus to the main landmark.

#### Scenario: Peek drawer is a dialog
- **WHEN** a member opens an issue peek and presses Escape
- **THEN** the peek closes and focus returns to the row that opened it

#### Scenario: Skip to content
- **WHEN** a keyboard user activates the skip link
- **THEN** focus moves to the main content landmark and the next Tab stays in that content

### Requirement: Contrast, names, and semantics
Text and UI components SHALL meet WCAG 2.2 AA contrast (4.5:1 for body text, 3:1 for large text and UI components). Meaningful images SHALL have alternative text; decorative images SHALL be empty-alt. Icon-only controls (close, theme, raw link) SHALL expose an accessible name. Landmarks SHALL include `banner`, `navigation`, `main`. Color SHALL not be the only indicator of rank, blocked, or gate state.

#### Scenario: Close control has a name
- **WHEN** a screen reader user lands on the peek close control
- **THEN** it is announced as "Close" (or equivalent), not as an unnamed button

#### Scenario: Rank-1 needs-you is not color-only
- **WHEN** a rank-1 attention row is shown
- **THEN** it carries a text label (for example "Agent halted") in addition to any colour treatment

### Requirement: Visual language
The Console SHALL use a single token set for colour, type, space, and radius across light, dark, and system themes. Display and body type SHALL be a humanist sans suitable for dense operations (IBM Plex Sans or an equivalent licensed/self-hosted pair); SHAs, ticket numbers, and factory labels SHALL use a matching mono. The signature pattern is a **halt bar**: when the factory is stopped on the current user, a persistent, high-contrast action region presents the question and the primary action. Themes SHALL not flash the wrong palette on first paint.

#### Scenario: Halt bar appears when an agent is waiting
- **WHEN** the current user has at least one rank-1 or open-gate attention item
- **THEN** a halt bar is visible on My work (and on the relevant epic workspace) naming the item and offering the primary action

#### Scenario: Theme persists without flash
- **WHEN** a user who chose dark theme reloads the app under a light OS preference
- **THEN** the first paint is dark

### Requirement: Safe areas and touch
The compact shell SHALL pad bottom navigation and sticky action bars for `env(safe-area-inset-*)` so home-indicator devices do not obscure controls. Primary actions SHALL sit in the thumb-reachable lower third on compact viewports except when a confirmation must appear adjacent to the content being confirmed (gate Approve).

#### Scenario: iPhone home indicator does not cover Inbox
- **WHEN** a member uses a device that reports a non-zero `safe-area-inset-bottom`
- **THEN** the bottom navigation labels and badge remain fully tappable above that inset
