# Tasks: Telegram Decisions

## 1. One source of decisions

- [ ] 1.1 Move `buildWork`, `decisionCards`, `askOf`, `pointerFor`,
      `newestAge`, `byRepo` and their types from `apps/web/src/lib/work.ts`
      to `packages/core/src/decisions.ts`; re-export from the web file; keep
      `work.test.ts` passing unchanged.
- [ ] 1.2 Extract the bodies of `/api/board`, `/api/my-work` (needsYou) and
      `/api/running` into functions taking `(deps, ctx, focus)`; routes call
      them.
- [ ] 1.3 `decisionsFor(deps, ctx)` in `apps/api/src/decisions.ts`, with a
      test that it equals what the page computes for the same fixtures.
- [ ] 1.4 `ctxForUser(deps, userId)` builds a `RequestCtx` (login, orgIds,
      `userToken` via `UserTokenStore`).

## 2. Actions callable without a request

- [ ] 2.1 Extract gate approve (`routes/gate.ts`) into
      `approveGate(deps, ctx, epicId, opts)` throwing typed errors; route
      maps errors to the same status codes and messages as today.
- [ ] 2.2 Same for issue reply (`routes/write.ts`), start-role
      (`start-role.ts`) and task-start approval.
- [ ] 2.3 Existing route tests still pass; add unit tests for the error
      mapping.

## 3. Config, schema, client

- [ ] 3.1 Config: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`,
      `TELEGRAM_WEBHOOK_SECRET` (all optional; feature flag = token set);
      never logged, never in `/api/setup`.
- [ ] 3.2 Drizzle schema + migration: `telegram_links`,
      `telegram_notifications`, `telegram_conversations`, `telegram_updates`.
- [ ] 3.3 `TelegramClient` (sendMessage, editMessageText,
      editMessageReplyMarkup, answerCallbackQuery, sendChatAction,
      setWebhook) over fetch, HTML escaping helper; fake for tests.

## 4. Linking

- [ ] 4.1 Signed single-use start token (HMAC from the master key, 15 min,
      base64url ≤ 64 chars).
- [ ] 4.2 `GET /api/me/telegram` (status), `POST /api/me/telegram/link`
      (returns the t.me link), `PATCH` (pause), `DELETE` (disconnect: deletes
      link, notifications, conversations).
- [ ] 4.3 `/start <token>`, `/stop`, and the unknown-chat reply.
- [ ] 4.4 Settings → "Telegram" section: Connect, Connected as @…, Pause,
      Disconnect. Hidden when the feature is off.

## 5. Webhook and inbound queue

- [ ] 5.1 `POST /api/telegram/webhook`: secret header check (401), private
      chats only, dedupe by `update_id`, enqueue on `telegram-inbound`, 200.
- [ ] 5.2 `setWebhook` on API start when configured.
- [ ] 5.3 Inbound worker in the API process dispatching messages and
      callback queries.

## 6. Notifier

- [ ] 6.1 `telegram-notify` job scheduler (60 s) in the API process.
- [ ] 6.2 Per linked unpaused user: `decisionsFor` → send new (message text
      and buttons per ask, titles not numbers), edit resolved; first-sweep
      cap of 10.
- [ ] 6.3 Message rendering per ask (answer/ship/release/decide/run/review/
      start) mirroring the Decisions card copy; tests with snapshots.

## 7. Buttons

- [ ] 7.1 `go:` → confirmation message with the exact comment; `no:` →
      cancel; `yes:` → re-check via `decisionsFor`, act, edit message with
      result and link.
- [ ] 7.2 Error replies: already decided, not yours, sign in again, GitHub
      refused (its message).
- [ ] 7.3 Tests: approve-plan end to end with fakes; stale decision refused;
      lapsed sign-in posts nothing.

## 8. Discussion

- [ ] 8.1 `telegram_conversations` lifecycle (open on reply/Discuss, close on
      post/cancel/24 h idle).
- [ ] 8.2 Context builder (decision summary, issue body, last 20 thread
      entries, blocking questions) and `askOrchestrator` call with
      resume; typing indicator.
- [ ] 8.3 `PROPOSED COMMENT:` parsing → Post it / Edit / Cancel; Post it
      re-checks and posts via `replyToIssue` (or `approveGate` for a bare
      approval).
- [ ] 8.4 Routing of plain messages (reply target → latest open
      conversation → "Which decision?" picker).
- [ ] 8.5 Tests: question answered without posting; drafted answer posted
      only after Post it; resume uses the stored session.

## 8a. Discussion summary on the issue

- [ ] 8a.1 Summarise turn (same session, fixed instructions) run when a draft
      is shown; summary shown above the draft; Edit covers both.
- [ ] 8a.2 Post the summary as the Compass App installation (bot author),
      store `summary_comment_id`; then the decision as the person; decision
      never posted if the summary failed; *Try again* re-posts only the
      decision.
- [ ] 8a.3 Cancel / 24 h idle with ≥ 1 exchange → summary marked "No decision
      yet".
- [ ] 8a.4 Tests: order (summary then decision); summary failure posts
      nothing; retry does not duplicate the summary; button-only decision
      posts no summary; blocked issue resumes once (on the answer).

## 9. Ship

- [ ] 9.1 Docs: `docs/telegram.md` — create the bot, the three secrets,
      what people see, how to disconnect, rollback.
- [ ] 9.2 Jerry sets the secrets on the VPS (not Claude); deploy; connect;
      verify one real decision end to end (notify → Discuss → Post it →
      factory resumes).
