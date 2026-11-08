# Tasks: Telegram Decisions

## 1. One source of decisions

- [x] 1.1 Move `buildWork`, `decisionCards`, `askOf`, `pointerFor`,
      `newestAge`, `byRepo` and their types from `apps/web/src/lib/work.ts`
      to `packages/core/src/decisions.ts`; re-export from the web file; keep
      `work.test.ts` passing unchanged.
- [x] 1.2 Read `/api/board`, `/api/my-work` (needsYou) and `/api/running`
      in-process as the person (design §2a).
- [x] 1.3 `decisionsFor(deps, ctx)` in `apps/api/src/decisions.ts`, with a
      test that it equals what the page computes for the same fixtures.
- [x] 1.4 `asUser(app, deps, userId)` — mint a 2-minute session, inject,
      delete it (design §2a).

## 2. Actions callable without a request

- [x] 2.1 Gate approve, issue reply and start-role go through `asUser`
      against the existing routes; their status and error message are what
      the bot reports.
- [x] 2.2 Test: an injected call is authored by the linked person, and the
      minted session is gone afterwards.

## 3. Config, schema, client

- [x] 3.1 Config: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
      `TELEGRAM_WEBHOOK_SECRET` (all optional; feature flag = token set);
      never logged, never in `/api/setup`.
- [x] 3.2 Drizzle schema + migration: `telegram_links`,
      `telegram_notifications`, `telegram_conversations`, `telegram_updates`.
- [x] 3.3 `TelegramClient` (sendMessage, editMessageText,
      editMessageReplyMarkup, answerCallbackQuery, sendChatAction,
      setWebhook) over fetch, HTML escaping helper; fake for tests.

## 4. Linking

- [x] 4.1 Signed single-use start token (HMAC from the master key, 15 min,
      base64url ≤ 64 chars).
- [x] 4.2 `GET /api/me/telegram` (status), `POST /api/me/telegram/link`
      (returns the t.me link), `POST /api/me/telegram/pause`, `DELETE`
      (disconnect: deletes link, notifications, conversations).
- [x] 4.3 `/start <token>`, `/stop`, and the unknown-chat reply.
- [x] 4.4 A `/telegram` page every signed-in person can reach (Settings is
      admin-only): Connect, Connected as @…, Pause, Disconnect; says when the
      feature is off. Linked from the side navigation and the More menu.

## 5. Webhook and inbound queue

- [x] 5.1 `POST /api/telegram/webhook`: secret header check (401), private
      chats only, dedupe by `update_id`, 200, handled in-process after the
      reply (design §2 amendment).
- [x] 5.2 `setWebhook` on API start when configured.
- [x] 5.3 `handleUpdate` dispatching messages and callback queries.

## 6. Notifier

- [x] 6.1 60-second sweep timer in the API process (design §4 amendment).
- [x] 6.2 Per linked unpaused user: `decisionsFor` → send new (message text
      and buttons per ask, titles not numbers), edit resolved; first-sweep
      cap of 10.
- [x] 6.3 Message rendering per ask (answer/ship/release/decide/run/review/
      start) mirroring the Decisions card copy; tests with snapshots.

## 7. Buttons

- [x] 7.1 `go:` → confirmation message with the exact comment; `no:` →
      cancel; `yes:` → re-check via `decisionsFor`, act, edit message with
      result and link.
- [x] 7.2 Error replies: already decided, not yours, sign in again, GitHub
      refused (its message).
- [x] 7.3 Tests: approve-plan end to end with fakes; stale decision refused;
      lapsed sign-in posts nothing.

## 8. Discussion

- [x] 8.1 `telegram_conversations` lifecycle (open on reply/Discuss, close on
      post/cancel/24 h idle).
- [x] 8.2 Context builder (decision summary, issue body, last 20 thread
      entries, blocking questions) and `askOrchestrator` call with
      resume; typing indicator.
- [x] 8.3 `PROPOSED COMMENT:` parsing → Post it / Edit / Cancel; Post it
      re-checks and posts via `replyToIssue` (or `approveGate` for a bare
      approval).
- [x] 8.4 Routing of plain messages (reply target → latest open
      conversation → "Which decision?" picker).
- [x] 8.5 Tests: question answered without posting; drafted answer posted
      only after Post it; resume uses the stored session.

## 8a. Discussion summary on the issue

- [x] 8a.1 Summarise turn (same session, fixed instructions) run when a draft
      is shown; summary shown above the draft; Edit covers both.
- [x] 8a.2 Post the summary as the Compass App installation (bot author),
      store `summary_comment_id`; then the decision as the person; decision
      never posted if the summary failed; *Try again* re-posts only the
      decision.
- [x] 8a.3 Cancel / 24 h idle with ≥ 1 exchange → summary marked "No decision
      yet".
- [x] 8a.4 Tests: order (summary then decision); summary failure posts
      nothing; retry does not duplicate the summary; button-only decision
      posts no summary; blocked issue resumes once (on the answer).

## 9. Ship

- [x] 9.1 Docs: `docs/telegram.md` — create the bot, the three secrets,
      what people see, how to disconnect, rollback.
- [ ] 9.2 Jerry sets the secrets on the VPS (not Claude); deploy; connect;
      verify one real decision end to end (notify → Discuss → Post it →
      factory resumes).
