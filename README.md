# Factory Console

[![CI](https://github.com/genai-jerry/software-factory-view/actions/workflows/ci.yml/badge.svg)](https://github.com/genai-jerry/software-factory-view/actions/workflows/ci.yml)
[![CodeQL](https://github.com/genai-jerry/software-factory-view/actions/workflows/codeql.yml/badge.svg)](https://github.com/genai-jerry/software-factory-view/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Factory Console is the web app for the
[Claude Software Factory](https://github.com/genai-jerry/claude-software-factory).
It gives the people who work with the factory one place to set it up, see where
every piece of work is, and approve or reject it at each gate.

The Console is a view over GitHub and a set of controls, never a second source
of truth. GitHub stays the state machine and OpenSpec stays the content. Every
action you take in the Console becomes a GitHub operation made under your own
GitHub identity.

> **Status: MVP (v0.1.0), under active development.** It runs the author's own
> factory estate day to day. Expect rough edges and breaking changes before 1.0.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Self-hosting](#self-hosting)
- [Development](#development)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [Contributing](#contributing) · [Security](#security) · [License](#license)

## Features

**See the work**

- **My work.** An attention queue of what needs you, with the reason it needs you.
- **Flow.** The pipeline board across every connected repository.
- **Epic workspace.** The stage rail, artifact reader (as proposed or as
  approved), timeline, task board, dependency tree (including cross-repo
  dependencies), and live factory-run status.
- **Org health and ops.** Staleness, blocked work, and orchestrator run pages
  with a live event timeline.

**Decide**

- **Gate panel.** The document PRs for each gate, what changed since you last
  looked, and a guard for open questions (you can approve anyway, and that is
  recorded). **Approve** posts the literal `Approved` comment as you. Request
  changes. Per-PR merge buttons at G3, which merge the promotion PR after the
  change is already verified on the integration branch.
- **Expedite mode, the epic-ready phase and gate GS.** Plus a *Mark reviewed*
  shortcut at `factory:in-review`.
- **System tests.** The test-plan artifact, the case catalog, the GS matrix, the
  tester's queue with Test Passed / Test Failed verdicts, and bug reports
  raised against an epic with repair confirmation.
- **Blocked inbox.** Reply to `factory:blocked` issues. Your reply is an ordinary
  comment, and the factory's own trigger unblocks the issue.
- **Decision log.** Structured decisions stored on the epic as hidden-marker
  comments, indexed and searchable. Gate approvals are recorded automatically.
- **Threads.** Discussions overlaid on GitHub comments with hidden
  `<!-- console:thread=… -->` markers, so they round-trip to and from GitHub.
- **Ask the Factory.** Cited Q&A grounded only in the epic's own artifacts,
  threads, PRs and runs, with a per-org token budget. Optional.

**Set up**

- **Onboarding.** GitHub App self-registration (manifest flow), connect an
  organisation and repositories, create labels, write secrets, open the
  stub-files PR, run a 9-check validation suite, and adopt an existing factory
  install with one reconcile.
- **Mobile-first.** At about 360px the signed-in UI is a top bar plus four
  bottom destinations (My work, Flow, Inbox, More). A gate can be read and
  approved on a phone.

Not built yet: full RBAC and estate scoping, billing, email and Slack
notifications, thread digests and gate review briefs, config editors with
config-as-PR, and deployment or testing views beyond what is listed above.
See the [delivery plan](docs/plan/04-delivery-plan.md).

## Quick start

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 20.19 or newer |
| pnpm | 10 (`corepack enable` picks up the pinned `pnpm@10.33.0`) |
| Docker | with Compose v2, for Postgres 16 and Redis |
| git, openssl | any recent version |

### Install and run

```bash
git clone https://github.com/genai-jerry/software-factory-view.git
cd software-factory-view
corepack enable

./scripts/setup.sh     # once: checks tools, writes .env with a generated key,
                       # installs, builds, starts Postgres/Redis, runs migrations
./scripts/dev.sh       # API + worker + Vite with reload, on http://localhost:5173
```

To run the full production-shaped stack (nginx + api + worker + Postgres + Redis)
in Docker instead:

```bash
./scripts/start.sh     # http://localhost:8080   (--rebuild to force a rebuild)
```

| Script | What it does |
|---|---|
| `./scripts/setup.sh` | One-time setup: toolchain check, `.env`, install, build, Postgres/Redis, migrate |
| `./scripts/dev.sh` | Dev mode on **:5173**. `./scripts/dev.sh api worker` runs a subset |
| `./scripts/start.sh` | Full Docker stack on **:8080**. `--rebuild` forces a rebuild |
| `./scripts/stop.sh` | Stops dev processes and the Docker stack. `--volumes` also drops the database |
| `./scripts/logs.sh` | Tails logs from whichever mode is running. `./scripts/logs.sh api` for one service |

### First run

1. Open the Console. Until you belong to an organisation, the home page has two steps:
   1. **Sign in with GitHub.** That is registration. There is no separate account.
   2. **Organisation and repositories.** Install the factory's GitHub App on an
      organisation you belong to, tick the repositories to watch, and connect.
      The Console syncs them immediately. The first person to connect an
      organisation owns it.
2. After that, `/` is mission control. Repositories that are connected but not
   yet factory-enabled show a banner that points to **Onboarding** (labels,
   secrets, stub PR, validation).
3. Already running the factory on those repos? **Onboarding → Reconcile this
   organisation now** imports issues, PRs, runs, gate assignments and change
   artifacts with no re-setup.

To look around without a GitHub App, set `DEV_FAKE_LOGIN=1` in `.env` and
restart. That enables a read-only `/auth/dev-login`. Never enable it in
production.

## Configuration

`.env` needs exactly one value, and `setup.sh` generates it:

```bash
CONSOLE_MASTER_KEY=...   # openssl rand -base64 32
                         # Encrypts stored tokens, the App's private key and
                         # cached repo content at rest. Back it up.
```

There are no repository or organisation IDs in any config file. One GitHub App
signs everyone in and is installed on every organisation that uses the factory.
You can provide it as `GITHUB_APP_*` / `GITHUB_OAUTH_*` variables, or register
it from the Console. A factory admin can rotate it later in **Settings**.

Common optional settings (the full list with comments is in
[`.env.example`](.env.example)):

| Variable | Purpose |
|---|---|
| `PUBLIC_ORIGIN` | The URL browsers use. OAuth callbacks and the App's webhook URL are derived from it. Defaults to `http://localhost:8080` |
| `ANTHROPIC_API_KEY` | Enables the *Ask the Factory* panel. Leave blank to run without it |
| `ORCHESTRATOR_URL`, `ORCHESTRATOR_DISPATCH_TOKEN` | Connect to the factory's [LangGraph orchestrator](https://github.com/genai-jerry/claude-software-factory/tree/main/orchestrator) |
| `GITHUB_API_URL`, `GITHUB_WEB_URL` | GitHub Enterprise Server |
| `DEV_FAKE_LOGIN` | `1` enables read-only dev login. **Development only** |

### Webhooks on a local machine

GitHub cannot reach `localhost`, so a local run receives no webhooks. Everything
still works, because reconcile pulls current state on demand. For live updates,
expose the Console (for example `cloudflared tunnel --url http://localhost:5173`),
set `PUBLIC_ORIGIN` to that URL, and register the App from there so its webhook
URL matches.

## Self-hosting

The Console ships as two images: `infra/Dockerfile.api` (API and worker) and
`infra/Dockerfile.web` (nginx serving the SPA and proxying `/api`). They run with
Postgres 16 and Redis 7.

1. **Register a GitHub App** (or let the Console register one through the
   manifest flow on first run). Set:
   - Webhook URL: `{PUBLIC_ORIGIN}/webhooks/github`
   - Callback URL: `{PUBLIC_ORIGIN}/auth/github/callback`
   - Make the App **public** (Advanced → Make public). Otherwise *Sign in with
     GitHub* fails for anyone except the App's owner.
2. **Configure the environment.** Copy
   [`infra/cloud.env.example`](infra/cloud.env.example) and set at least
   `CONSOLE_MASTER_KEY`, `DB_PASSWORD`, `PUBLIC_ORIGIN` (an `https://` URL) and
   the `GITHUB_APP_*` / `GITHUB_OAUTH_*` values.
3. **Start the stack** with
   [`infra/docker-compose.deploy.yml`](infra/docker-compose.deploy.yml) behind a
   TLS-terminating reverse proxy. The reference deployment uses Traefik on an
   external Docker network named `lighthouse-network`. Create that network
   (`docker network create lighthouse-network`) or rename it in the compose
   file to match your proxy. Migrations run when the API starts.

Two deployment paths are included:

- **GitHub Actions** ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):
  on push to `main` it typechecks, tests and builds the images, copies them to
  a server over SSH, and runs `docker compose up`. Configure it in a GitHub
  Environment named `production`. GitHub forbids secret names that start with
  `GITHUB_`, so the App credentials are stored as `GH_APP_*` / `GH_OAUTH_*` and
  written to the server's `.env` under their real names. The secrets and
  variables are listed at the top of the workflow file.
- **From a laptop** with no Actions minutes:
  `./scripts/local-deploy.sh production`. See
  [`docs/LOCAL_DEPLOYMENT.md`](docs/LOCAL_DEPLOYMENT.md).

The root `docker-compose.yml` is for local builds only. Don't use it in
production.

If you also run the factory's orchestrator on the same host, give the Console
and the orchestrator **different hostnames**. If they share one, the reverse
proxy may serve the orchestrator's JSON at `/` instead of the Console.
[`scripts/fix-vps-host-routing.sh`](scripts/fix-vps-host-routing.sh) repairs a
host that already has the conflict.

## Development

```bash
pnpm typecheck                         # all packages
pnpm build
pnpm test                              # unit, projection replay, API security tests
pnpm --filter @console/web test:e2e    # Playwright at 360/768/1280px + axe
```

### Things to try

1. **Read model.** File a plain issue on a factory repo. It appears at
   `factory:intake` on the board within one webhook round-trip.
2. **G1 from the workspace.** When an epic reaches `factory:spec-ready`, the
   attention queue names you if you're an approver. **Approve** posts `Approved`
   as you, and the factory router merges and advances. On GitHub, the comment is
   indistinguishable from a typed one.
3. **Threads round-trip.** Reply in a thread, then answer from GitHub. The answer
   lands back in the same thread.
4. **Blocked flow.** Reply from the Blocked page, and the label clears.
5. **Rebuildability.** Truncate the projection tables and reconcile. The
   workspace reassembles, threads and decisions included.
6. **Validation.** Onboarding → Validate on a healthy repo is all green and
   makes zero writes.
7. **On a phone.** Open an epic waiting at G1 at about 360px, read the spec, and
   approve without panning.

## Architecture

A separate SPA and API (see
[docs/plan/02-architecture-baseline.md](docs/plan/02-architecture-baseline.md) §1a):

```
apps/web          React 18 + Vite SPA (static; nginx serves it and proxies /api)
apps/api          Fastify 5: GitHub OAuth, sessions, REST API, webhook endpoint
apps/worker       BullMQ: webhook projection, reconciler
packages/core     factory constants, markers, derivations, GitHub clients, crypto
packages/db       Drizzle schema + forward-only SQL migrations (Postgres 16)
packages/insight  cited, bounded, read-only Q&A (Anthropic and OpenAI-compatible)
infra/            Dockerfiles, nginx.conf, deploy compose file
```

**Security model**

- Same-origin deployment with no CORS.
- `HttpOnly SameSite=Lax` session cookie plus a custom-header CSRF check.
- OAuth tokens, the App key and cached repo content are encrypted at rest
  (AES-256-GCM envelope).
- Webhooks are HMAC-verified and deduplicated through an idempotency ledger.
- Markdown is sanitised server-side, and nginx sends a strict CSP.
- Every query is scoped to the caller's organisations.
- Authoritative GitHub operations exist only on the user-token client, so the
  Console cannot approve or merge *as the App*.

## Documentation

| Doc | Content |
|---|---|
| [00-overview](docs/plan/00-overview.md) | Scope, the two rules, terminology |
| [01-feature-inventory](docs/plan/01-feature-inventory.md) | About 110 features with IDs, phases, GitHub materialisations |
| [02-architecture-baseline](docs/plan/02-architecture-baseline.md) | Stack, token model, tenancy, invariants |
| [03-data-model-and-ingestion](docs/plan/03-data-model-and-ingestion.md) | Schema, derivations, ingestion contract |
| [04-delivery-plan](docs/plan/04-delivery-plan.md) | Phases → epics → tasks |
| [05-decisions-and-risks](docs/plan/05-decisions-and-risks.md) | Decisions, risks, open questions |
| [06-repo-profile](docs/plan/06-repo-profile.md) | The repo profile and the Profiler |
| [07](docs/plan/07-pipeline-view-state-display.md) / [08](docs/plan/08-pipeline-view-implementation.md) | Individual-first *My work* view and its implementation |
| [09-ux-ui-redesign](docs/plan/09-ux-ui-redesign.md) | Mobile-first UX/UI redesign |
| [10-factory-ops-view](docs/plan/10-factory-ops-view.md) | Factory ops view |
| [11-dependency-tree-cross-repo-and-branch-policy](docs/plan/11-dependency-tree-cross-repo-and-branch-policy.md) | Dependency tree, cross-repo dependencies, branch policy |
| [LOCAL_DEPLOYMENT](docs/LOCAL_DEPLOYMENT.md) | Deploying from a laptop |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
conventions and the PR checklist, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Maintainers: the one-time repository
settings are in [.github/REPOSITORY_SETTINGS.md](.github/REPOSITORY_SETTINGS.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 genai-jerry
