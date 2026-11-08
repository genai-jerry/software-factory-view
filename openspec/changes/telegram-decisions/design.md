# Design: Telegram Decisions

## Context

Compass computes "what waits on whom" per request: `/api/board` (cards),
`/api/my-work` (`buildAttention` → `needsYou` for the viewer) and
`/api/running`, combined in the browser by `decisionCards` in
`apps/web/src/lib/work.ts`. Decision actions are HTTP routes that act with
the viewer's own GitHub token (`RequestCtx.userToken`, renewed in the
background by `UserTokenStore`): gate approve / request-changes
(`routes/gate.ts`), reply (`routes/write.ts`), start-role (`start-role.ts`).
The factory checks who wrote an approval, so authorship must stay the
person's. Conversations with Claude go through `askOrchestrator` (read-only
session on the orchestrator, resumable by `session`, keyed workspace by
`conversation`).

## Goals / Non-goals

Goals: the phone shows exactly the decisions the page shows; acting from the
phone is the same action as acting in Compass; nothing is ever posted without
an explicit confirmation from the linked person.

Non-goals: other channels, groups, non-decision notifications (see proposal).

## Decisions

### 1. Telegram Bot API directly, no library

Four calls are needed — `sendMessage`, `editMessageText`/`editMessageReplyMarkup`,
`answerCallbackQuery`, `setWebhook` (+ `sendChatAction` for "typing"). A ~100
line `TelegramClient` over `fetch` in `apps/api/src/telegram/client.ts` keeps
the dependency surface small and is trivially faked in tests. Messages use
`parse_mode: "HTML"` with escaping (MarkdownV2 escaping is error-prone).

Alternative: grammY/telegraf — rejected, more than we use.

### 2. Webhook, not long polling

`setWebhook(url=<PUBLIC_URL>/api/telegram/webhook, secret_token=TELEGRAM_WEBHOOK_SECRET,
allowed_updates=["message","callback_query"])` on API start. The route checks
the secret header, stores nothing for unlinked chats, enqueues the update on
the `telegram-inbound` BullMQ queue and returns 200 at once (Telegram retries
slow webhooks; a Claude turn can take a minute). Updates are deduplicated by
`update_id`.

### 3. One source of truth for "decisions for a person"

Move `buildWork`/`decisionCards`/`askOf`/`pointerFor` and their types from
`apps/web/src/lib/work.ts` to `packages/core/src/decisions.ts`; the web file
re-exports them, so the page and badge are unchanged. On the server,
`decisionsFor(deps, ctx)` runs the same queries as `/api/board`,
`/api/my-work` and `/api/running` (extracted from those routes into
functions) and returns `decisionCards(...)`. The notifier and the button
re-check both use it.

### 4. The notifier

A BullMQ job scheduler `telegram-notify` (every 60 s) in the API process
(which owns the query code). For each linked, unpaused user:

1. Build a `RequestCtx` for the user (`userId`, `login`, `orgIds` from
   memberships, `userToken` from `UserTokenStore`). A user whose grant cannot
   be renewed still gets notifications (reads use the App installation where
   the routes already do); actions will ask them to sign in.
2. `decisionsFor` → key each card `epicId|repo|ask|issueId|state`.
3. New keys → send message, insert `telegram_notifications` row
   (user, key, chat id, message id, epicId, repo, ask, issueId, sentAt).
4. Rows whose key vanished and are still open → edit to "Done — <how>" (how:
   from the latest state-history event when it can tell, else "no longer
   waiting on you"), drop buttons, set `resolvedAt`.

First sweep after linking: newest 10, plus "N more in Compass".

### 5. Callback data and confirmation

`callback_data` is `<verb>:<notificationId>` (≤ 64 bytes) — verbs `go`
(decisive action, asks to confirm), `yes`, `no`, `discuss`. `yes` re-runs
`decisionsFor` and refuses unless the same key is still present for this
user; then calls the extracted action with the user's ctx:

| ask | action |
|---|---|
| decide / release / ship (gate) | `approveGate(deps, ctx, epicId, { acknowledgeOpenQuestions: false })` |
| review (role start) | `startRole(deps, ctx, issueId, role)` |
| start (task start) | `approveTaskStart(...)` — same as the Decisions page |
| answer (blocked) | no one-tap action; only Discuss (an answer needs words) |
| run (manual tests) | Open in Compass only (results need the test page) |
| ship via PR merge | Open in Compass only (merge stays a deliberate desktop act) |

Actions are extracted from the route handlers into functions that throw typed
errors (`SignInRequiredError`, `NotAllowedError`, `GitHubWriteError`) instead
of writing to a Fastify `reply`; the routes become thin wrappers, so HTTP
behaviour is unchanged and covered by the existing tests.

### 6. Discussion

`telegram_conversations` (id, userId, notificationId, chatId, session,
messages jsonb, status open|posted|cancelled, updatedAt). A turn calls
`askOrchestrator(cfg, { owner, repo, question, context, mode: "ask",
conversation: id, session })` with context = decision summary + issue body +
last 20 thread entries + blocking questions, and instructions:

> You are helping <login> decide on a factory item from their phone. Answer
> briefly. You cannot post anything. When they have decided, end your reply
> with a line `PROPOSED COMMENT:` followed by the exact comment to post, and
> nothing after it.

If the reply has `PROPOSED COMMENT:`, the bot shows the text after it with
*Post it / Edit / Cancel*. *Post it* re-checks that the item is still open
and calls `replyToIssue(deps, ctx, issueId, body)` (or `approveGate` when the
comment is exactly an approval at a gate the person holds, so gate rules like
open-question acknowledgement apply). Credentials for `askOrchestrator` come
from `orchestrator-secrets` as Shape does. While waiting, `sendChatAction:
typing` every 4 s.

Routing a plain message: `reply_to_message.message_id` → the notification or
conversation it belongs to; otherwise the user's most recently updated open
conversation; otherwise ask "Which decision is this about?" with one button per
open notification (max 8).

### 6a. The discussion summary goes on the issue first

Why a separate bot comment, checked against the factory router
(`claude-software-factory/orchestrator/src/factory_orchestrator/router.py`
`_route_comment`):

- A gate approval must be a comment whose whole body is `Approved`
  (`^\s*approved\s*[.!]?\s*$`), so the summary cannot share that comment.
- Any non-bot comment without the agent marker on a `factory:blocked` issue
  resumes it, so a summary posted as the person would resume the builder
  before the answer exists.
- `author.type == "Bot"` comments are skipped. Posting the summary with the
  Compass GitHub App installation token makes it a pure record. (Using
  `<!-- factory-agent -->` instead was rejected: Compass reads marked comments
  as role comments and would surface the summary as the builder's question.)

Flow on *Post it* after a discussion (and on cancel / idle with ≥ 1 exchange):

1. A summarise turn on the same session: "Summarise this discussion for the
   issue record: questions raised, answers and facts given, options
   considered, the decision and its reasons (or 'No decision yet'). Only what
   was said. Markdown, under 250 words." — produced when the draft is shown,
   so the person confirms the exact text.
2. Post it as the App: `**Discussion on Telegram with @<login>** · <date>` +
   summary + footer "Recorded by Compass. The decision follows as
   @<login>'s own comment." (no decision follows when it is "No decision
   yet").
3. Only if 2 succeeded, post the decision as the person (§5/§6 path).
   If 3 fails after 2 succeeded, the bot says the summary is on the issue but
   the decision was not posted, and offers *Try again* (re-posts only the
   decision).

`telegram_conversations` gains `summary_comment_id` so a retry never posts the
summary twice.

### 7. Linking

`telegram_link_tokens` are not a table: the token is an HMAC-signed
`userId.expiry.nonce` (key derived from `CONSOLE_MASTER_KEY`), with the nonce
recorded on use to make it single-use (`telegram_links.lastNonce`). Telegram
limits the start parameter to 64 chars of `[A-Za-z0-9_-]` — base64url, short
ids.

## Data model

```
telegram_links(user_id pk → users, chat_id bigint unique, tg_username text,
  paused bool default false, linked_at, last_nonce text)
telegram_notifications(id uuid pk, user_id, key text, chat_id, message_id,
  epic_id, issue_id, repo, ask, sent_at, resolved_at null,
  unique(user_id, key) where resolved_at is null)
telegram_conversations(id uuid pk, user_id, notification_id null, chat_id,
  session text null, messages jsonb, status text, summary text null,
  summary_comment_id bigint null, updated_at)
telegram_updates(update_id bigint pk, received_at)   -- dedupe, pruned after 1 day
```

## Risks / Trade-offs

- **Acting as a person from a chat.** Mitigated by: chat bound by a one-time
  link from a signed-in session; confirmation on every write; re-check before
  every write; nothing auto-posted from Claude output. A stolen Telegram
  account can approve — same exposure as a stolen laptop session; disconnect
  is one tap in Settings.
- **Message volume** for people who approve many tasks: one message per card
  (an epic's 16 test cases are one card), plus pause. A digest is out of
  scope.
- **The 60 s sweep runs every user's decision queries.** Few users today; the
  queries already serve the badge every 15 s per open tab. Revisit with
  event-driven triggers from the ingest worker if users grow.
- **Claude latency** on a phone: typing indicator; answers are short by
  instruction.

## Migration / rollout

Off until `TELEGRAM_BOT_TOKEN` is set. Jerry creates the bot with @BotFather,
sets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`
on the VPS, deploys, connects in Settings. Rollback: unset the token and
redeploy; the webhook registration left at Telegram then only reaches a 404
(or delete it with the documented `deleteWebhook` curl).

- **The summary is Claude's account of the chat.** Mitigated: the person sees
  and can edit it before anything posts; it is posted as the Compass app, so
  it never carries their authority.

## Open questions

- Should a gate's *Ask for changes* be offered as a button that opens a
  discussion pre-filled for a change request? (Assumed: yes, via Discuss.)
