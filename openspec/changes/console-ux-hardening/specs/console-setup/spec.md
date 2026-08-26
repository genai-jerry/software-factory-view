## ADDED Requirements

### Requirement: Home and onboarding survive the compact chrome
Unauthenticated home and factory enablement SHALL remain usable when the compact top bar and (after sign-in) bottom navigation are present. Primary actions SHALL stay full-width 44px on viewports below 640px. Ticket and accordion stations SHALL NOT be covered by the bottom navigation. PEM and secret fields SHALL remain 16px so iOS does not zoom.

#### Scenario: Sign-in is not hidden by chrome
- **WHEN** a visitor opens `/` at 360px width on the sign-in station
- **THEN** Sign in with GitHub is fully visible above the fold without page-level horizontal pan

#### Scenario: Onboarding accordion still one step
- **WHEN** an org admin opens Onboarding at 360px with labels incomplete
- **THEN** labels is expanded, later steps are collapsed, and the expanded step’s primary action is not obscured by bottom navigation

### Requirement: Settings Save stays above the home indicator
Organisation and GitHub App settings SHALL keep a sticky save/apply control above the compact bottom navigation and the iOS home indicator (`safe-area-inset-bottom`). Secret show/hide SHALL remain a named 44px control.

#### Scenario: Save on a phone
- **WHEN** an org admin edits the Ask-the-Factory key at 360px width
- **THEN** Save is tappable without scrolling it out from under the bottom navigation
