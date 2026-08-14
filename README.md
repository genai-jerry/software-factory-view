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
- **Mission control** — attention queue ("what needs me", with the *why*), pipeline board, organisation health.
- **Epic workspace** — stage rail, artifact reader (as-proposed ⇄ as-approved), timeline, task board,
  threads overlaid on GitHub comments via hidden `<!-- console:thread=… -->` markers, `[≡ raw]` links everywhere.
- **Gate panel** — the exact document PRs, what-changed-since-you-looked, open-questions guard with recorded
  "approve anyway", **Approve** (posts the literal `Approved` as you), request changes, per-PR merge buttons for G3.
- **Blocked inbox** — reply to `factory:blocked` issues as an ordinary comment; the factory's own trigger unblocks.
- **Decision log** — structured decisions posted to the epic with `<!-- console:decision=… -->`, indexed and
  searchable; gate approvals auto-record.
- **Ask the Factory** — cited Q&A grounded only in the epic's own artifacts/threads/PRs/runs, per-org token budget.
- **Onboarding** — GitHub App self-registration (manifest flow), in-app organisation/repo connection, labels step,
  write-through secrets, stub-files PR, 9-check validation suite, adopt-existing-install.

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

### Scripts

| Script | What it does |
|---|---|
| `./scripts/setup.sh` | One-time: checks the toolchain, writes `.env` with a generated encryption key, installs, builds, starts Postgres/Redis, migrates |
| `./scripts/dev.sh` | Dev mode — API + worker + Vite with rebuild-on-change, on **:5173**. `./scripts/dev.sh api worker` runs a subset |
| `./scripts/start.sh` | Full Docker stack (nginx + api + worker + postgres + redis) on **:8080**. `--rebuild` forces a rebuild |
| `./scripts/stop.sh` | Stops dev processes and the Docker stack. `--volumes` also drops the database |
| `./scripts/logs.sh` | Tails logs from whichever mode is running; `./scripts/logs.sh api` for one service |

```bash
./scripts/setup.sh     # once
./scripts/dev.sh       # then, day to day
```

### Configuration: one secret, everything else in the app

`.env` needs exactly **one** value, and `setup.sh` generates it:

```
CONSOLE_MASTER_KEY=...   # 32 random bytes; encrypts stored tokens, the App's
                         # private key, and cached repo content at rest
```

There are **no repo or org IDs in any config file.** The factory is a SaaS: one
GitHub App, pinned with `GITHUB_APP_*` secrets (or set later by a factory admin
in Settings), is installed on every organisation that wants the factory.

When you open the Console, the **home page** is a two-station ticket until you
belong to an organisation:

1. **Sign in with GitHub** — that *is* registration; there is no separate account.
2. **Organisation and repositories** — install the factory App on an org you
   belong to, tick the repositories to watch, connect. The Console syncs them
   immediately, no waiting on a webhook. The first person to connect an organisation
   owns it.

After that, `/` is mission control. Repositories that are connected but not yet
factory-enabled get a banner pointing at **Onboarding** (labels, secrets, stub
PR, validation). A factory admin rotates the GitHub App from **Settings**.

Set `PUBLIC_ORIGIN` if you reach the Console anywhere other than the default for
your mode; OAuth callbacks and the App's webhook URL are derived from it.
`ANTHROPIC_API_KEY` is optional and only enables the Q&A panel.

## Cloud deploy (VPS)

Same path as Sales OS: GitHub Actions builds images, scps them to the VPS,
`docker load`s, then `docker compose up` in `~/factory-console`. Postgres and
Redis are in that compose file. Traefik on `lighthouse-network` routes
`Host(CONSOLE_HOST)` to nginx. The workflow runs on push to `main` and from
**Actions → Deploy → Run workflow**.

### GitHub Environment `production`

Create the environment, then set. GitHub forbids secret names that start with
`GITHUB_`, so the App credentials use `GH_*` here; the workflow writes them to
the VPS `.env` as `GITHUB_APP_*` / `GITHUB_OAUTH_*`.

**Secrets**

- `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_KEY` — copy from lighthouse-sales (SSH to the VPS)
- `CONSOLE_MASTER_KEY` — `openssl rand -base64 32` (back this up)
- `DB_PASSWORD` — password for the in-compose Postgres
- `GH_APP_ID` — the SaaS GitHub App's numeric id
- `GH_APP_PRIVATE_KEY` — the App's PEM (newlines can be stored as `\n`)
- `GH_APP_WEBHOOK_SECRET`
- `GH_OAUTH_CLIENT_ID`
- `GH_OAUTH_CLIENT_SECRET`
- `ANTHROPIC_API_KEY` — optional, Ask the Factory

**Variables**

- `PUBLIC_ORIGIN` — the HTTPS URL browsers will use, e.g. `https://sf.genaipeople.com`. Traefik terminates TLS and routes that hostname to nginx. Do not use `:80` — Traefik already binds 80/443 on this VPS.

The workflow builds `factory-console-app:latest` and `factory-console-web:latest`, copies [`infra/docker-compose.deploy.yml`](infra/docker-compose.deploy.yml) to `~/factory-console/docker-compose.yml`, and starts the stack. Images use `pull_policy: never` so the host does not try GHCR.

Full list: [`infra/cloud.env.example`](infra/cloud.env.example). Never set `DEV_FAKE_LOGIN=1`.

### First deploy

1. Set the secrets and variables above. `PUBLIC_ORIGIN` must be an `https://` hostname whose DNS A record points at `187.127.165.119` (this VPS).
2. Push to `main` (or run the workflow). CI typechecks, tests, builds the images, then deploys.
3. Confirm five containers are up (`factory-console-api-1` healthy, plus worker, web, postgres, redis). nginx is not published on :80; Traefik fronts it.
4. Open `PUBLIC_ORIGIN`. The home page is sign in, then connect an organisation and repositories. The GitHub App is the platform App from the secrets above; a factory admin can rotate it later in Settings. On that App's GitHub page:
   - Webhook URL: `{PUBLIC_ORIGIN}/webhooks/github`
   - Callback URL (Identifying and authorizing users): `{PUBLIC_ORIGIN}/auth/github/callback`
   - **Advanced → Danger zone → Make public.** A private App 404s on Sign in with GitHub for anyone who is not the owner. ("Where can this GitHub App be installed?" only appears when creating a new App.)

The root `docker-compose.yml` is for local `build:` only. Do not point Hostinger Docker Manager at it.

### Adopt your existing factory organisation

After connecting repos, Onboarding → **Reconcile this organisation now** walks GitHub and imports
issues, PRs, runs, gate assignments (`factory-approvers.json`) and change-folder
artifacts — zero re-setup for a repo that was factory-enabled by hand.

### Webhooks and local runs

GitHub cannot reach `localhost`, so on a local run no webhooks arrive. Everything still
works — reconcile pulls the current state on demand. For live updates, expose the
Console (`cloudflared tunnel --url http://localhost:5173`), set `PUBLIC_ORIGIN` to that
URL, and register the App from there so its webhook URL matches.

`DEV_FAKE_LOGIN=1` enables `/auth/dev-login` to browse the UI with no GitHub App at all
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
| [07-pipeline-view-state-display](docs/plan/07-pipeline-view-state-display.md) | Individual-first "My work" view, peek disclosure, dependency Q&A, manager tree view |
| [08-pipeline-view-implementation](docs/plan/08-pipeline-view-implementation.md) | Implementation plan for 07: work packages, migrations (assignees, task dependencies, QA scope, milestones), per-file changes, tests |
