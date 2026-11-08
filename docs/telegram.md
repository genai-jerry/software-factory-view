# Telegram decisions

Compass can send each person the decisions that wait on them — gate
approvals, releases to staging, a builder's blocked question, tasks to start —
in a Telegram chat. They can decide there with a button, or reply to talk it
through with Claude first. Nothing is posted on GitHub until they confirm, and
what is posted is posted **as them**, with their own GitHub sign-in, so the
factory's approver rules are unchanged.

Change: `openspec/changes/telegram-decisions`.

## Turn it on (once)

1. In Telegram, talk to **@BotFather**: `/newbot`, pick a name and a username
   (it must end in `bot`, e.g. `genaipeople_compass_bot`). BotFather gives you
   the bot token.
2. Optional, in BotFather: `/setjoingroups` → Disable (the bot only works in
   private chats), and `/setcommands`:
   ```
   pause - Stop sending decisions for now
   resume - Send decisions again
   stop - Disconnect this chat from Compass
   ```
3. Make a webhook secret: `openssl rand -hex 32`.
4. On the GitHub environment **production** of `software-factory-view`:
   - secret `TELEGRAM_BOT_TOKEN` — the BotFather token
   - secret `TELEGRAM_WEBHOOK_SECRET` — the value from step 3
   - variable `TELEGRAM_BOT_USERNAME` — the bot's username, without `@`

   (Laptop deploys read the same names; see `scripts/local-deploy.sh`.)
5. Deploy. On start the API registers
   `<PUBLIC_ORIGIN>/api/telegram/webhook` with Telegram and logs
   `telegram: webhook set to …`. With any of the three unset it logs
   `telegram: off` and nothing else changes.

All three are needed, and `CONSOLE_MASTER_KEY` must be set (it signs the
connect links). The token and secret are never logged or sent to the browser.

## What people do

- **Connect:** Compass → **Telegram** (side navigation, or More on a phone)
  → *Connect Telegram* → *Start* in the chat that opens. The link works once
  and expires in 15 minutes.
- **Decisions arrive** within about a minute of landing on their Decisions
  list — the same list, computed by the same code. Each is sent once; when it
  is decided anywhere, the message is edited to say so. An item a factory run
  is already acting on is not sent. The first time, at most the 10 newest are
  sent, with a count of the rest.
- **Buttons:** *Approve the plan / design*, *Release to staging*, *Start the
  review / test / merge* ask "post this as you?" first; *Yes* re-checks that it
  is still open and still theirs, then acts through the same Compass route the
  page uses. Shipping to production and recording test results stay in
  Compass (*Open in Compass*).
- **Discuss:** reply to a decision message, or tap *Discuss*. Claude (the
  same read-only session Shape uses) answers from the issue, its thread and the
  repo, and cannot post anything. When they decide, it drafts the comment;
  the bot shows **the discussion summary and the comment** with *Post it /
  Edit / Cancel*.
- **On Post it:** the summary goes on the issue first, posted by the Compass
  GitHub App (the factory ignores bot comments, so the record never approves
  or resumes anything), then their decision as their own comment. If the
  summary fails, nothing is posted; if only the comment fails, *Try again*
  re-posts the comment alone.
- A discussion cancelled, or idle for a day, after a real exchange leaves its
  summary on the issue marked "No decision was posted."
- **Pause / disconnect:** on the Telegram page, or `/pause`, `/resume`,
  `/stop` in the chat. Disconnecting deletes the link, the sent-message
  records and the discussions.

## When something is off

- *"Your GitHub sign-in has lapsed"* — they sign in to Compass again, then
  tap *Yes* again. While a sign-in is lapsed, no new decisions are sent to
  them (Compass reads their list as them).
- No messages at all: check the API log for `telegram:`; check
  `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` shows the
  Compass URL and no `last_error_message`.

## Turn it off / roll back

Unset `TELEGRAM_BOT_TOKEN` and redeploy. Telegram keeps calling the old
webhook, which now answers 404; to stop that too:
`curl https://api.telegram.org/bot<TOKEN>/deleteWebhook`.
