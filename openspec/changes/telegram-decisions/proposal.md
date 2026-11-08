# Telegram Decisions

## Why

The factory stops for people: a gate to approve, a release to staging, a
builder blocked on a question, tests to run. Today those decisions are only
visible in Compass (the Decisions page and its badge) and in GitHub
notifications. An approver who is away from the desk does not see them, and
work sits blocked until they next open Compass.

The decision itself is usually small ("Approved", an answer to one
question). It should reach the person on their phone, and they should be able
to give it — or talk it through first — without opening a laptop.

Telegram is the channel: its Bot API is official and free, a bot may message
anyone who has started a chat with it at any time, inline buttons call back to
the server, and linking a chat to a Compass login needs no phone number. (The
WhatsApp route was rejected: lighthouse-whatsapp uses Baileys, an unofficial
client that risks a ban, and the official Cloud API needs Meta business
verification plus paid, pre-approved templates for every unprompted message.)

## What Changes

- **Connect Telegram (Settings).** A person links their Telegram chat to
  their Compass login with a one-time deep link (`t.me/<bot>?start=<token>`).
  They can pause notifications or disconnect.
- **Decision notifications.** When a decision starts waiting on a linked
  person — the same set the Decisions page shows them, one per item per repo,
  skipping items a factory run is already acting on — the bot sends one
  message: title, repo, what is needed, the blocking questions, and buttons.
  A decision is sent once; it is not re-sent while it stays open. When the
  decision is resolved (by anyone, anywhere) the message is edited to say so
  and its buttons are removed.
- **Decide with a button.** Buttons match the Decisions page: *Approve the
  plan / Approve the design / Release to staging / Ship to production*,
  *Start the Reviewer/QA/…*, *Open in Compass*, and *Discuss*. A decisive
  button asks "Post 'Approved' on <title> as you?" and acts on Yes. Every
  action is posted to GitHub **as that person** with their own sign-in, so the
  factory's approver checks are unchanged.
- **Discuss.** Replying to a decision message, or tapping *Discuss*, starts a
  conversation about that item with Compass's read-only Claude session (the
  one Shape and the epic panel use), with the issue, its thread and the
  blocking questions as context. When the person settles on an answer, the bot
  drafts the exact comment, shows it, and posts it only after *Post it*.
- **The discussion goes on the record.** Before a decision reached in a
  discussion is posted, a summary of the discussion — questions, answers,
  options, what was decided and why — is posted on the issue by the Compass
  app, then the decision follows as the person's own comment. The person sees
  and can edit both before *Post it*. A discussion abandoned without a
  decision is summarised too, marked "No decision yet".
- **Compass shows it.** Comments posted from Telegram are ordinary GitHub
  comments by the person; the issue thread in Compass shows them like any
  other.

## Non-goals

- WhatsApp, Slack or email channels (the notifier is written so a second
  channel can be added later, but none is built).
- Group chats; the bot works in private chats only.
- Notifying about things that are not decisions (progress, runs finishing).
- Free-form commands that act without a decision message ("/approve 193").
- Digest or quiet-hours scheduling beyond a per-person pause switch.

## Capabilities

### New Capabilities

- `telegram-decisions`: linking a Telegram chat to a Compass user, sending
  decision notifications, acting on them with buttons, and discussing an item
  with Claude before posting a confirmed comment.

### Modified Capabilities

- None. The Decisions page and attention queue are read, not changed; the
  gate/reply/start-role actions are extracted so both HTTP and Telegram call
  them, with identical behaviour.

## Impact

- **New config:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_BOT_USERNAME` (feature off when the token is unset).
- **DB:** new tables `telegram_links`, `telegram_notifications`,
  `telegram_conversations` (+ migration).
- **API:** `POST /api/telegram/webhook` (public, secret-checked),
  `GET/DELETE /api/me/telegram`, `POST /api/me/telegram/link`,
  `POST /api/me/telegram/pause` (status, start link, pause, disconnect). Decision actions in `routes/gate.ts`, `routes/write.ts` and
  `start-role.ts` are extracted into functions callable with a server-built
  `RequestCtx`.
- **API process:** a repeating `telegram-notify` job (every minute, BullMQ
  job scheduler so only one runs) and a `telegram-inbound` queue so the
  webhook answers Telegram at once and slow Claude turns run behind it.
- **Web:** a Telegram page (`/telegram`) every signed-in person can reach —
  Settings is admin-only.
- **Shared logic:** `decisionCards` and its helpers move from
  `apps/web/src/lib/work.ts` to `packages/core` so the server notifies about
  exactly what the page shows.
- **Ops:** create the bot with @BotFather; set the three secrets on the VPS
  (Jerry does this — Claude never sets deploy secrets); the API registers the
  webhook URL on start.
