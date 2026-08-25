# Local Packaging & Deployment (no GitHub Actions)

`scripts/local-deploy.sh` packages and deploys Factory Console from your
machine, the same way [`lighthouse-backend/scripts/local-deploy.sh`](https://github.com/genai-jerry/lighthouse-backend/blob/main/scripts/local-deploy.sh)
deploys the CRM. It replicates `.github/workflows/deploy.yml` so no GitHub
Actions minutes are spent:

1. Verifies your checkout is the **latest `origin/main`** (production) or
   `origin/staging` (staging).
2. Fetches GitHub **variables** (`PUBLIC_ORIGIN`, `ORCHESTRATOR_URL`) via `gh`.
3. Loads **secrets** from a local env file (see below for why).
4. Builds `linux/amd64` **app** and **web** images (`infra/Dockerfile.api`
   `--target api`, `infra/Dockerfile.web`), SCPs the tarballs plus
   `infra/docker-compose.deploy.yml` to `~/factory-console` on the VPS, and
   runs the same remote script CI uses: load images → upsert `.env` →
   `docker compose up` → wait for `factory-console-api-1` healthy → prune.

The LangGraph orchestrator has a sibling script:
`claude-software-factory/orchestrator/scripts/local-deploy.sh`.

## Prerequisites

- Docker (Apple Silicon works — the script builds for `linux/amd64`).
- [GitHub CLI](https://cli.github.com) authenticated: `gh auth login`.
- SSH private key for the Hostinger VPS (same trio as lighthouse-sales).

## One-time setup

```bash
./scripts/local-deploy.sh production --init-secrets
# then edit ~/.lighthouse-deploy/factory-console.production.env
```

You can copy `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_KEY_FILE` from
`~/.lighthouse-deploy/backend.production.env`. The GitHub App PEM must be a
**single line** with `\n` for newlines (same encoding as the GitHub secret).

## Deploying

```bash
git checkout main && git pull origin main
./scripts/local-deploy.sh production
```

Useful flags: `--show-config`, `--build-only`, `--no-fetch-vars`,
`--skip-git-check`, `--secrets-file <path>`. Env knobs: `DEPLOY_KEY_FILE`,
`DEPLOY_PORT`, `DEPLOY_PLATFORM` (default `linux/amd64`).

## How GitHub configuration is fetched

**Variables** (`PUBLIC_ORIGIN`, `ORCHESTRATOR_URL`) **are readable** and are
exported automatically. Environment-level values override repo-level ones.

**Secrets** (`DEPLOY_*`, `CONSOLE_MASTER_KEY`, `DB_PASSWORD`, `GH_APP_*`,
`GH_OAUTH_*`, `ORCHESTRATOR_DISPATCH_TOKEN`) **cannot be fetched**. They live
in `~/.lighthouse-deploy/factory-console.<env>.env` (`chmod 600`, outside the
repo). Empty optional keys are skipped on the host so existing `.env` entries
survive.

Resolution order (later wins): shell environment → GitHub variables → secrets
file.

## Stop spending on Actions

Local deploys do not disable the workflow. To turn CI deploys off:

```bash
gh workflow disable Deploy -R genai-jerry/software-factory-view
```

Re-enable later with `gh workflow enable`.

## Troubleshooting

- **`gh: Not Found (404)` fetching environment variables** — the environment
  name is missing, or the `gh` token cannot read it. Check
  `gh api repos/genai-jerry/software-factory-view/environments --jq '.environments[].name'`.
- **`exec format error` on the VPS** — leave `DEPLOY_PLATFORM=linux/amd64`.
- **api never becomes healthy** — the script prints `docker compose ps` and
  the last 100 api log lines, same as the workflow.
- **PEM rejected** — store `GH_APP_PRIVATE_KEY` as one line with `\n`, not a
  multiline block (the secrets file is `KEY=VALUE` per line).
