## Purpose

Makes sure every Compass screen is usable in a phone browser, and that a screen
which stops fitting a phone fails the build.

## ADDED Requirements

### Requirement: Single-row bottom nav
On screens narrower than 1024px, the bottom nav SHALL show at most 5 items in
one row.

#### Scenario: Nav on a phone
- **WHEN** a signed-in person opens any page at 360px wide
- **THEN** the bottom nav is one row tall and shows Work, Decisions, Shape, Investigate and More
- **AND** Activity can be reached from More

### Requirement: Action bars never cover the nav
Sticky action bars and save bars MUST sit fully above the bottom nav.

#### Scenario: Settings save bar on a phone
- **WHEN** a person changes a setting at 360px wide
- **THEN** the save bar and the bottom nav do not overlap

### Requirement: No sideways page scroll
No route SHALL scroll the page sideways or cut off content at 360px wide.

#### Scenario: Settings rows on a phone
- **WHEN** a person opens Settings at 360px wide
- **THEN** the page is no wider than the screen
- **AND** each repository name and time is fully visible

#### Scenario: Every route checked
- **WHEN** the phone checks run against every route at 360px
- **THEN** each route's page is no wider than the screen

### Requirement: Popovers become sheets on phones
Popovers and drawers SHALL open as sheets that stay fully on screen on phones.

#### Scenario: Runs popover on a phone
- **WHEN** a person opens the runs list from the header at 360px wide
- **THEN** it opens as a sheet that is fully inside the screen

### Requirement: Touch-sized controls
Every control SHALL be at least 44 by 44 pixels on phones.

#### Scenario: Removing an attached image
- **WHEN** a person attaches an image in Shape at 360px wide
- **THEN** the button that removes it is at least 44 by 44 pixels

### Requirement: Chat stays usable with the keyboard open
In Shape and Investigate on phones, the composer SHALL stay visible while
typing, and the conversation list SHALL open from a "Conversations" button.

#### Scenario: Typing a message on a phone
- **WHEN** a person focuses the composer at 360px wide and the keyboard opens
- **THEN** the composer and the latest message stay visible

#### Scenario: Finding past conversations
- **WHEN** a person opens Shape at 360px wide
- **THEN** the chat fills the screen and a "Conversations" button opens the list

### Requirement: Phone checks enforced in CI
CI MUST run the 360px layout check and an accessibility check on every route,
and the build MUST fail when either fails.

#### Scenario: A screen stops fitting
- **WHEN** a change makes any route wider than 360px
- **THEN** the CI build fails and names that route
