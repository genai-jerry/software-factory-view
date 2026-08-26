## Purpose

Defines getting started, organisation connection, factory enablement, and settings so an operator can stand up and configure the factory from a phone, and a member can complete sign-in without a desktop.

## ADDED Requirements

### Requirement: Getting-started ticket fits a phone
The unauthenticated or no-org home SHALL keep the sequential ticket (GitHub App when required, Sign in, Organisation and repositories, Enable the factory). Ticket rows SHALL stack number, title, and status on viewports below 640px. Primary actions (Sign in with GitHub, Connect) SHALL be full-width 44px-tall buttons. Helper copy SHALL stay under 80 words per station.

#### Scenario: Sign-in station on a phone
- **WHEN** a visitor who does not need to register a GitHub App opens `/` at 390px width
- **THEN** they see one current station, a full-width "Sign in with GitHub" button, and no overlapping header controls

### Requirement: Sign-in recovery is a job, not an API dump
When the Console API is down or the session is in error, the page SHALL say what the visitor can do (retry, sign in again, ask the host operator) and SHALL NOT require reading Redis, worker, or PEM jargon to take the next step. Operator-only diagnostics MAY sit behind a "Technical details" disclosure.

#### Scenario: API down
- **WHEN** `/api/setup/status` fails
- **THEN** the visitor sees that the Console is unavailable and to retry, with technical error text in a collapsed disclosure

### Requirement: Organisation connect is a checklist
Picking an account and ticking repositories SHALL use 44px-tall rows. The repository list SHALL scroll inside a bounded region (not the whole page) with a visible count of selected repos. Confirming SHALL remain the existing GitHub App install/connect flow. After connect, the Console SHALL send the operator to factory enablement, not a blank mission control.

#### Scenario: Select repos with a thumb
- **WHEN** a signed-in user with no orgs opens the organisation station and expands an account
- **THEN** each repository row is tappable, selected count is visible, and Connect remains enabled only when at least one repo is selected (or the product's existing allow-empty rule, if any, is stated in the UI)

### Requirement: Onboarding steps are one-at-a-time on compact viewports
Factory enablement for a repository SHALL present steps as an accordion: only the current incomplete step is expanded on viewports below 768px. Completed steps collapse to a one-line summary (done / skipped / failed). Destructive actions (reset) SHALL require a typed or explicit confirmation and SHALL NOT sit adjacent to the primary "continue" button.

#### Scenario: Phone shows one onboarding step
- **WHEN** a repo still needs labels and the operator is at 390px width
- **THEN** the labels step is expanded and later steps (secrets, stub PR, validate) are collapsed

#### Scenario: Reset is hard to miss-tap
- **WHEN** an operator views a repo card that includes Reset
- **THEN** Reset is visually secondary, separated from the primary step action, and asks for confirmation before running

### Requirement: Validation results are a list, not a table
The 9-check validation suite SHALL render as stacked rows: status word (pass / fail / skip), check name, and explanation. Failures SHALL state the human fix. The suite SHALL remain read-only on a healthy repo.

#### Scenario: Failed check explains the fix
- **WHEN** validation fails because `factory-approvers.json` is missing
- **THEN** the row says the file is missing and that the enablement PR or a manual add will fix it

### Requirement: Settings are sectioned and thumb-reachable
Settings SHALL group GitHub App (when `canEditApp`), Ingestion (when visible), and one card per organisation. PEM and secret fields SHALL use `autocomplete` and `spellcheck` appropriate to secrets, a monospace field, and a show/hide toggle. Save actions SHALL be sticky on compact viewports. Copy that names environment variables SHALL be secondary to in-app actions.

#### Scenario: Org model key on a phone
- **WHEN** an org admin opens Settings at 390px width and saves an insight API key
- **THEN** the key field is usable (16px, show/hide), the save control is reachable above the home indicator, and success is confirmed in plain language

### Requirement: Orchestrator run is a readable log
The `/runs/:runId` page SHALL stack status, model, and transcript. The log SHALL wrap; it SHALL NOT force page-level horizontal scroll. Unauthenticated visitors SHALL see the existing sign-in prompt with `next` preserved.

#### Scenario: Wrapped run log
- **WHEN** a signed-in member opens a run whose log lines exceed 360px
- **THEN** lines wrap or scroll inside the log region, and the page does not pan
