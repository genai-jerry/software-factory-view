## ADDED Requirements

### Requirement: Needs-you rows state the job once
Each Needs-you, in-flight, and waiting-on row SHALL show at most: title, one plain-language reason, one state chip, age (and repository as metadata). The reason SHALL NOT be repeated as both a badge label and a second sentence on the same row.

#### Scenario: Spec-ready row is one action
- **WHEN** a spec-ready gate is waiting on the member
- **THEN** the row’s reason appears once (for example “Approve the spec”), the chip may show G1, and the title is a 44px-preferred control that opens peek

### Requirement: Waiting-on offers a chase action
When an issue in Waiting on others has a named next mover, the row SHALL offer a **Nudge** action that posts an ordinary GitHub comment under the viewer’s identity asking that person to move the blocker. Nudge SHALL be disabled or hidden when there is no named person to chase. Compact viewports SHALL keep Nudge on a 44px target and SHALL confirm before posting.

#### Scenario: Nudge from a phone
- **WHEN** a member opens Waiting on others, the blocker is assigned to @alice, and they confirm Nudge
- **THEN** a GitHub comment is posted as that member on the blocking issue and the UI reports that the nudge was sent

### Requirement: Compact reply asks before posting
On viewports below 768px, posting a blocked reply (Inbox or peek) SHALL require an explicit confirm after the body is non-empty. The confirm SHALL state that the comment posts as the signed-in GitHub user. Cancelling SHALL leave the draft intact.

#### Scenario: Accidental send is cancelled
- **WHEN** a member taps Post reply & unblock on a phone, then cancels the confirm
- **THEN** no comment is posted and the typed body remains

### Requirement: Loading is a skeleton, not a word
While My work, peek, Flow, or Inbox is fetching, the Console SHALL show a skeleton of the row or sheet structure. It SHALL NOT use a lone “Loading…” paragraph as the only signed-in waiting state for those surfaces.

#### Scenario: My work first paint
- **WHEN** My work is waiting on `/api/my-work`
- **THEN** the member sees placeholder rows in Needs you (or equivalent skeleton) rather than only the text “Loading…”
