# Factory Console (software-factory-view)

A web application that sits on top of the [Claude Software Factory](https://github.com/genai-jerry/claude-software-factory)
and gives the humans in the loop one place to set it up, configure it, staff it,
and — above all — **review and decide without drowning**.

It is a lens and a control panel over GitHub, never a second source of truth:
GitHub stays the state machine, OpenSpec stays the content, and every Console
action materialises as a GitHub operation under the acting user's own identity.

## Status: MVP, ready for testing

Implemented (Phases 0–2 of the [delivery plan](docs/plan/04-delivery-plan.md), plus the core of Phase 3):

- **Ingestion** — GitHub App webhooks (HMAC-verified, idempotency ledger, queued), projections keyed by
  `node_id` with last-writer-wins guards, nightly + on-demand reconciler, immutable encrypted artifact cache.
- **Mission control** — attention queue ("what needs me", with the *why*), pipeline board, estate health.
- **Epic workspace** — stage rail, artifact reader (as-proposed ⇄ as-approved), timeline, task board,
  threads overlaid on GitHub comments via hidden `<!-- console:thread=… -->` markers, `[≡ raw]` links everywhere.
- **Gate panel** — the exact document PRs, what-changed-since-you-looked, open-questions guard with recorded
  "approve anyway", **Approve** (posts the literal `Approved` as you), request changes, per-PR merge buttons for G3.
- **Blocked inbox** — reply to `factory:blocked` issues as an ordinary comment; the factory's own trigger unblocks.
- **Decision log** — structured decisions posted to the epic with `<!-- console:decision=… -->`, indexed and
  searchable; gate approvals auto-record.
- **Ask the Factory** — cited Q&A grounded only in the epic's own artifacts/threads/PRs/runs, per-org token budget.
- **Onboarding** — labels step, write-through secrets, stub-files PR, 9-check validation suite, adopt-existing-install.

Not yet built (per plan): full RBAC/estate scoping, billing, notifications email/Slack, thread digests & gate
review briefs, config editors with config-as-PR, Phase 5 deployment/testing views.

## Architecture

Separate SPA and API (API-driven; see [docs/plan/02-architecture-baseline.md](docs/plan/02-architecture-baseline.md) §1a):

```
apps/web        React 18 + Vite SPA (static files; nginx serves + proxies /api)
apps/api        Fastify: GitHub OAuth, sessions (HttpOnly cookie), REST API, webhook endpoint
apps/worker     BullMQ: webhook projection, reconciler
packages/core   factory constants, markers, derivations, GitHub clients (two-token model), crypto
packages/db     Drizzle schema + migrations (projections vs console-native, strictly separated)
packages/insight Anthropic wrapper: cited, bounded, read-only Q&A
infra           Dockerfiles, nginx.conf; docker-compose.yml at the root
```

Security posture: same-origin deployment (no CORS), `HttpOnly SameSite=Lax` session cookie + custom-header CSRF
check, OAuth tokens and cached repo content encrypted at rest (AES-256-GCM envelope), webhook HMAC verification,
markdown sanitised server-side, strict CSP from nginx. Authoritative GitHub operations are only expressible
through the user-token client — approving or merging as the app is structurally impossible.

## Run it

### 1. Prerequisites

Docker + Docker Compose, and a GitHub org where you can install a GitHub App.
For the Q&A panel: an Anthropic API key.

### 2. Register your GitHub App (once)

GitHub → Settings → Developer settings → GitHub Apps → New:

- **Webhook URL**: `https://<your-host>/webhooks/github` (for local testing use a tunnel, e.g. `smee.io` or `cloudflared`).
- **Webhook secret**: generate one; goes in `.env` as `GITHUB_APP_WEBHOOK_SECRET`.
- **Callback URL**: `https://<your-host>/auth/github/callback` — check *Request user authorization (OAuth) during installation* is **off**; the Console starts its own OAuth flow.
- **Permissions**: Issues RW · Pull requests RW · Contents RW · Actions R · Checks R · Workflows R · Secrets W · Members R · Metadata R.
- **Events**: issues, issue_comment, label, pull_request, pull_request_review, push, check_suite, check_run, workflow_run, installation, installation_repositories.
- Generate a **private key**, convert to PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`.

Install the App on your org and select your estate's repositories
(e.g. `insurance-app-base`). The installation webhook creates the estate.

### 3. Configure and start

```bash
cp .env.example .env        # fill in the App credentials
openssl rand -base64 32     # -> CONSOLE_MASTER_KEY
docker compose up --build
```

Open http://localhost:8080 → Sign in with GitHub.

### 4. Adopt your existing factory estate

Onboarding page → **Reconcile estate now**. The reconciler walks GitHub and
imports issues, PRs, runs, gate assignments (`factory-approvers.json`) and
change-folder artifacts — zero re-setup for a repo that was factory-enabled by
hand. Mission control fills in as it completes.

### 5. Dev mode (no Docker)

```bash
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev:api      # :8787
pnpm dev:worker
pnpm dev:web      # :5173, proxies /api to :8787
```

`DEV_FAKE_LOGIN=1` allows `/auth/dev-login` to exercise the UI without a GitHub App
(read-only — GitHub writes need a real token).

## Testing guide (what to try)

1. **Read model**: file a plain issue on a factory repo → it appears at `factory:intake`
   on the board within a webhook round-trip; the epic workspace shows the thread and timeline.
2. **G1 from the workspace**: when the epic reaches `factory:spec-ready`, the attention
   queue names you (if you're on the `spec` list); the gate panel renders the spec PR
   artifacts; **Approve** posts the literal `Approved` as you and the factory router
   merges + advances — verify on GitHub that the comment is indistinguishable from a typed one.
3. **Threads round-trip**: reply in a thread → an ordinary comment with a hidden marker
   appears on GitHub; answer from GitHub → it lands in the right thread here.
4. **Blocked flow**: when an agent applies `factory:blocked`, reply from the Blocked page →
   label clears via the factory's own comment trigger.
5. **Rebuildability**: `TRUNCATE` the projection tables (or drop the volume), reconcile —
   the workspace reassembles, threads and decisions included (they live in comment markers).
6. **Validation suite**: Onboarding → Validate on a healthy repo → all green, and
   confirm zero writes happened (check the repo's audit log).

```bash
pnpm test        # unit + projection replay + API security tests
pnpm typecheck
pnpm build
```

## Plan documents

| Doc | Content |
|---|---|
| [00-overview](docs/plan/00-overview.md) | Scope, the two rules, terminology |
| [01-feature-inventory](docs/plan/01-feature-inventory.md) | ~110 features with IDs, phases, GitHub materialisations |
| [02-architecture-baseline](docs/plan/02-architecture-baseline.md) | Stack (SPA+API revision), token model, tenancy, invariants |
| [03-data-model-and-ingestion](docs/plan/03-data-model-and-ingestion.md) | Schema, derivations, ingestion contract |
| [04-delivery-plan](docs/plan/04-delivery-plan.md) | Phases → epics → tasks |
| [05-decisions-and-risks](docs/plan/05-decisions-and-risks.md) | Decisions, risks, open questions |
