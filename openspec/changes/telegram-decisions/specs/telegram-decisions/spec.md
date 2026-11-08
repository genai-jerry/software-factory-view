# Delta Spec: telegram-decisions

## ADDED Requirements

### Requirement: A person links their Telegram chat to their Compass login

Compass SHALL let a signed-in person link one Telegram private chat to their
Compass user through a one-time deep link `https://t.me/<bot>?start=<token>`.
The token SHALL be random, single-use and expire after 15 minutes. When the
bot receives `/start <token>` it SHALL bind that chat id to the token's user,
reply naming the GitHub login it linked, and the Telegram page (`/telegram`,
reachable by every signed-in person) SHALL show the link. A
chat SHALL be linked to at most one user and a user to at most one chat;
linking again replaces the old chat. The person SHALL be able to pause
notifications and to disconnect, from the Telegram page or with `/pause`,
`/resume` and `/stop` in the chat.
The feature SHALL be off (no Settings section, no webhook, no job) when
`TELEGRAM_BOT_TOKEN` is unset.

#### Scenario: Linking

- **WHEN** Jerry clicks "Connect Telegram" on the Telegram page and taps Start in the bot
- **THEN** the bot replies "Linked to GitHub @genai-jerry. Decisions waiting on you will arrive here." and the page shows "Connected"

#### Scenario: Expired or reused token

- **WHEN** the bot receives `/start` with a token that is expired or already used
- **THEN** it links nothing and replies that the link has expired, pointing to the Telegram page for a new one

#### Scenario: Unknown chat

- **WHEN** a message or button press arrives from a chat that is not linked
- **THEN** the bot acts on nothing and replies how to connect from the Telegram page

### Requirement: Each decision waiting on a person is sent to them once

For every linked, unpaused person, Compass SHALL compute the decisions the
Decisions page would show them — the same `decisionCards` result, one card per
item per repo, excluding items with a factory run live on the epic — and send
each new one as a Telegram message. A decision's identity SHALL be (epic, repo,
ask, the issue the ask is about, the state it is at); the same identity SHALL
NOT be sent twice while it remains open. The message SHALL give the item title
(never an issue number alone), the repo, what the person needs to do, the facts
the Decisions card shows, the blocking questions when the ask is an answer, and
the buttons for that ask. When a sent decision is no longer in the person's
set, the message SHALL be edited to say it was resolved and its buttons
removed. If the first sweep after linking finds several open decisions, they
SHALL be sent, newest first, at most 10, with a line saying how many more are
in Compass.

#### Scenario: A release becomes ready

- **WHEN** an epic reaches `factory:epic-ready` and its GS approver is linked
- **THEN** within two minutes they receive "Release to staging — Improvement to whatsapp coordination flow (beacon-api)", the task and test counts, and the buttons Release to staging, Discuss, Open in Compass

#### Scenario: No repeat while it waits

- **WHEN** the same decision is still open on the next sweep
- **THEN** no new message is sent

#### Scenario: Resolved elsewhere

- **WHEN** the person approves the same gate on the Compass Decisions page
- **THEN** the Telegram message is edited to "Done — no longer waiting on you" with no buttons

#### Scenario: Run already acting

- **WHEN** the Release Manager is running on an epic that is still labelled epic-ready
- **THEN** no release message is sent for it

### Requirement: Buttons act as the person, after a confirmation

A decisive button (approve at a gate, release, ship, start a role) SHALL first
reply with the exact action and comment — "Post 'Approved' on 'Improvement to
whatsapp coordination flow' as @genai-jerry?" — with *Yes* and *Cancel*. On
*Yes* Compass SHALL perform the same action the Decisions page performs, with
a request context built for the linked user, so the GitHub comment or label
is authored by that person with their own GitHub sign-in. Before acting it
SHALL re-check that the decision is still open and still the person's; if not,
it SHALL act on nothing and say so. On success it SHALL edit the message to
what was done with a link to the comment. If the person's GitHub sign-in has
lapsed, it SHALL post nothing and reply asking them to sign in to Compass.
Button callback data SHALL carry only an opaque id; the server looks up the
decision.

#### Scenario: Approve the plan

- **WHEN** the approver taps Approve the plan, then Yes
- **THEN** "Approved" is posted on the epic by @genai-jerry, the message reads "Approved — the design starts next" with a link, and the factory advances exactly as for a Compass approval

#### Scenario: Not theirs any more

- **WHEN** the person taps Yes after someone else already approved
- **THEN** nothing is posted and the bot replies "Already decided — nothing posted"

#### Scenario: Sign-in lapsed

- **WHEN** the person's GitHub authorization has been revoked
- **THEN** nothing is posted and the bot replies "Sign in to Compass again, then tap Yes" with a link

### Requirement: A person can discuss a decision before answering

Replying to a decision message in Telegram, or tapping *Discuss*, SHALL open
a conversation about that item. Each message SHALL be answered by Compass's
read-only orchestrator session (the `askOrchestrator` used by Shape) with the
issue body, its recent thread, the blocking questions and the decision being
asked as context, resuming the same session across turns. The assistant SHALL
NOT post anything by itself: when the person indicates an answer, it SHALL
propose the exact comment, and the bot SHALL show it — after the discussion
summary that will precede it — with *Post it*, *Edit* and *Cancel*. *Post it*
SHALL post the summary and then the comment as the person (the same path as
a Compass reply), which resumes a blocked issue exactly as a reply from Compass
does. A plain message with no reply target SHALL continue the most recent open
conversation; if none, the bot SHALL ask which decision it is about. A
conversation SHALL end when its comment is posted, when cancelled, or after
24 hours idle.

#### Scenario: Answer a blocked builder

- **WHEN** the builder is blocked asking "Should the reminder use the clinic's timezone or the patient's?" and Jerry replies "patient's, but fall back to the clinic if unknown"
- **THEN** the bot shows the discussion summary and the drafted comment answering that question, posts both only after Post it (the answer as @genai-jerry), and the issue resumes

#### Scenario: Ask a question first

- **WHEN** Jerry replies "what changed since the last round?" to a release message
- **THEN** the bot answers from the issue and thread without posting anything to GitHub

#### Scenario: Approve from the discussion

- **WHEN** after discussing, Jerry writes "ok, approve it"
- **THEN** the bot proposes the summary and "Approved" and posts them only after Post it, with the same open-and-yours re-check as a button

### Requirement: Every discussion is summarised on the issue before its decision

When a decision is posted after a Telegram discussion about the item, Compass
SHALL first post a summary of that discussion as a separate comment on the
issue the decision is about, and only then post the decision. The summary
SHALL be written by the read-only Claude session from the conversation alone,
headed "Discussion on Telegram with @<login>", and SHALL state the questions
raised, the answers and facts given, options considered, and what was decided
and why. It SHALL NOT invent anything that was not said. The confirmation step
SHALL show the person both texts — the summary, then the decision comment —
and *Post it* posts both in that order; *Edit* lets them correct either.

The summary SHALL be posted by the Compass GitHub App (a bot comment), not as
the person, so the factory never reads it as a decision: the router ignores
bot comments, a person's comment on a blocked issue resumes it, and a gate
approval must be the single word `Approved`. The decision comment SHALL still
be posted as the person. If the summary cannot be posted, the decision SHALL
NOT be posted either, and the bot SHALL say why.

A discussion that ends without a decision — cancelled, or idle for 24 hours —
after at least one question and answer SHALL also be summarised on the issue,
marked "No decision yet". A decision taken with a button and no discussion
posts no summary.

#### Scenario: Discussion then answer

- **WHEN** Jerry discusses a blocked builder's question for four messages and taps Post it on the drafted answer
- **THEN** the issue gets, in order, a bot comment "Discussion on Telegram with @genai-jerry" summarising the exchange, then Jerry's answer posted as him, and the issue resumes once — on the answer

#### Scenario: Discussion then approval

- **WHEN** Jerry asks two questions about a release and then says "ok, release it"
- **THEN** the summary is posted first by the Compass app, then "Approved" is posted as @genai-jerry, and the gate is approved by his comment

#### Scenario: Discussion abandoned

- **WHEN** Jerry asks one question, gets an answer, and cancels
- **THEN** the summary is posted marked "No decision yet" and nothing else is posted

#### Scenario: Summary fails

- **WHEN** GitHub refuses the summary comment
- **THEN** the decision is not posted and the bot replies that nothing was posted and why

### Requirement: Telegram traffic is authenticated and minimal

The webhook SHALL reject any request whose
`X-Telegram-Bot-Api-Secret-Token` header does not match
`TELEGRAM_WEBHOOK_SECRET`. Only private chats SHALL be served. Compass SHALL
store chat ids, message ids and conversation text needed to run the
conversation, delete a person's conversations and link on disconnect, and keep
no Telegram data for unlinked chats. The bot token and webhook secret SHALL
never be logged or sent to the browser.

#### Scenario: Forged webhook

- **WHEN** a request reaches the webhook without the secret header
- **THEN** it is answered 401 and nothing is read or done
