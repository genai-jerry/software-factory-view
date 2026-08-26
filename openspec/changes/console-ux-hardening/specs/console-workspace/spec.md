## ADDED Requirements

### Requirement: Sheets dismiss by drag as well as Close and Escape
Issue peek, Ask the Factory, History, and More SHALL remain a single sheet primitive. On compact viewports the sheet SHALL dismiss when the member drags or swipes down past a threshold, as well as via labelled Close and Escape. Focus SHALL restore to the control that opened the sheet.

#### Scenario: Swipe closes peek
- **WHEN** a member opens peek at 360px width and swipes the sheet downward past the dismiss threshold
- **THEN** peek closes and focus returns to the row that opened it

### Requirement: Compact Approve and Merge confirm
On viewports below 768px, Approve (G1/G2) and Merge (G3) SHALL not complete on the first tap. The first tap SHALL reveal a confirm that names the action and that Approve posts the word `Approved` as the signed-in user. The second tap SHALL perform the existing GitHub write. Request changes SHALL keep its existing comment flow. Open-questions acknowledgement SHALL still be required before confirm is available.

#### Scenario: Phone G1 confirm
- **WHEN** a listed spec approver on a 360px Gate tab acknowledges open questions if shown and taps Approve
- **THEN** they see a confirm; after they confirm, the Console posts `Approved` under their OAuth identity

#### Scenario: First Approve tap does not post
- **WHEN** that approver taps Approve once and does not confirm
- **THEN** no GitHub comment is posted

### Requirement: Ask prompts are thumb-sized
Canned Ask the Factory prompts SHALL be 44px-preferred targets with at least 8px separation. They SHALL NOT use compact chip padding as the hit area.

#### Scenario: Prompt tap on a phone
- **WHEN** a member opens Ask at 360px width
- **THEN** each canned prompt is independently tappable without activating a neighbour

### Requirement: Contextual help for gate and Focus
The Gate tab SHALL state, before the first Approve on a compact viewport, that Approve posts the literal comment `Approved` as the signed-in GitHub user. The Focus control SHALL expose a short accessible description of what focusing a project or repository does. Help SHALL be inline and dismissible, not a separate documentation app.

#### Scenario: First-time Approve explanation
- **WHEN** an approver opens the Gate tab at 360px
- **THEN** they can read that Approve posts `Approved` as them before they confirm
