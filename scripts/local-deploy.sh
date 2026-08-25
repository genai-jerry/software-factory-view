#!/usr/bin/env bash
set -euo pipefail

# Local packaging + deployment for Factory Console.
#
# Replicates .github/workflows/deploy.yml from a local machine the same way
# lighthouse-backend/scripts/local-deploy.sh does, so deploys cost no GitHub
# Actions minutes:
#   1. Verifies the checkout is the latest origin/main (or origin/staging).
#   2. Fetches GitHub *variables* (repo-level + environment-level) via gh.
#   3. Loads *secrets* from a local env file (GitHub never returns secret values).
#   4. Builds linux/amd64 images, SCPs tarballs + infra/docker-compose.deploy.yml,
#      and runs the same remote script the workflow runs (load → upsert .env →
#      compose up → health wait).
#
# Configuration precedence (later wins):
#   shell environment  <  GitHub variables  <  secrets file

REPO="genai-jerry/software-factory-view"

usage() {
  cat <<'EOF'
Usage: ./scripts/local-deploy.sh [production|staging] [options]

Builds Factory Console images locally and deploys them to the Hostinger VPS
with docker compose, replicating .github/workflows/deploy.yml without Actions.

Options:
  --secrets-file <path>  Env file with secret values
                         (default: ~/.lighthouse-deploy/factory-console.<env>.env)
  --init-secrets         Write a template secrets file and exit
  --show-config          Print resolved configuration (secrets masked) and exit
  --build-only           Build and save the image tarballs, skip transfer/deploy
  --no-fetch-vars        Skip the gh CLI variable fetch (fully offline mode)
  --skip-git-check       Deploy the working tree as-is (dirty/non-main allowed)
  -h, --help             Show this help

Extra knobs (env vars): DEPLOY_KEY_FILE (SSH key path, alternative to
DEPLOY_KEY content), DEPLOY_PORT (default 22), DEPLOY_PLATFORM
(default linux/amd64 — needed when building on arm64 Macs).

Config precedence (later wins): shell env < GitHub variables < secrets file.
GitHub secret VALUES are not retrievable via any API — only variables are.
EOF
}

log()  { echo "[local-deploy] $*"; }
warn() { echo "[local-deploy] WARNING: $*" >&2; }
die()  { echo "[local-deploy] ERROR: $*" >&2; exit 1; }

host_from_url() {
  local u="${1-}"
  u="${u#http://}"
  u="${u#https://}"
  u="${u%%/*}"
  u="${u%%:*}"
  printf '%s' "$u"
}

# Empty $1 = current repo. Non-empty = git -C <root> (orchestrator lives one dir down).
check_git_for_deploy() {
  local g=(git)
  [[ -n "${1:-}" ]] && g=(git -C "$1")
  log "Verifying checkout against origin/${GIT_BRANCH}..."
  "${g[@]}" fetch origin "$GIT_BRANCH"
  [[ -z "$("${g[@]}" status --porcelain)" ]] || \
    die "Working tree has uncommitted changes. Commit/stash them or pass --skip-git-check."
  local head remote
  head="$("${g[@]}" rev-parse HEAD)"
  remote="$("${g[@]}" rev-parse "origin/${GIT_BRANCH}")"
  if [[ "$head" == "$remote" ]]; then
    :
  elif "${g[@]}" merge-base --is-ancestor "$remote" "$head"; then
    warn "HEAD is $("${g[@]}" rev-list --count "$remote..HEAD") commit(s) ahead of origin/${GIT_BRANCH} — deploying this checkout (not yet on GitHub). git push when you want origin to match."
  elif "${g[@]}" merge-base --is-ancestor "$head" "$remote"; then
    die "HEAD is behind origin/${GIT_BRANCH}. Run: git checkout ${GIT_BRANCH} && git pull origin ${GIT_BRANCH}"
  else
    die "HEAD has diverged from origin/${GIT_BRANCH}. Rebase or merge, or pass --skip-git-check."
  fi
  log "OK — deploying $("${g[@]}" rev-parse --short HEAD) ($("${g[@]}" log -1 --format=%s))"
}

TARGET_ENV="production"
SECRETS_FILE=""
INIT_SECRETS=false
SHOW_CONFIG=false
BUILD_ONLY=false
FETCH_VARS=true
SKIP_GIT_CHECK=false

while (($#)); do
  case "$1" in
    production|staging) TARGET_ENV="$1"; shift ;;
    --secrets-file)     SECRETS_FILE="$2"; shift 2 ;;
    --init-secrets)     INIT_SECRETS=true; shift ;;
    --show-config)      SHOW_CONFIG=true; shift ;;
    --build-only)       BUILD_ONLY=true; shift ;;
    --no-fetch-vars)    FETCH_VARS=false; shift ;;
    --skip-git-check)   SKIP_GIT_CHECK=true; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "Unknown argument: $1 (see --help)" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR%/scripts}"
cd "$ROOT_DIR"

SECRETS_FILE="${SECRETS_FILE:-$HOME/.lighthouse-deploy/factory-console.${TARGET_ENV}.env}"
SECRETS_FILE="${SECRETS_FILE/#\~/$HOME}"

if [[ "$TARGET_ENV" == "production" ]]; then GIT_BRANCH="main"; else GIT_BRANCH="staging"; fi

APP_IMAGE="factory-console-app"
WEB_IMAGE="factory-console-web"
DEPLOY_PLATFORM="${DEPLOY_PLATFORM:-linux/amd64}"

# GitHub Environment secrets (values cannot be read back). GH_* because
# GitHub forbids names starting GITHUB_; the remote .env uses GITHUB_*.
GH_SECRET_NAMES=(DEPLOY_HOST DEPLOY_USER DEPLOY_KEY CONSOLE_MASTER_KEY DB_PASSWORD
                 GH_APP_ID GH_APP_PRIVATE_KEY GH_APP_WEBHOOK_SECRET
                 GH_OAUTH_CLIENT_ID GH_OAUTH_CLIENT_SECRET ANTHROPIC_API_KEY
                 ORCHESTRATOR_DISPATCH_TOKEN)
GH_VAR_NAMES=(PUBLIC_ORIGIN ORCHESTRATOR_URL CONSOLE_HOST APP_RESET)
# GH_APP_* / GH_OAUTH_* are optional: paste them in the Console UI when
# APP_RESET=true (a GitHub variable), or leave existing VPS .env / DB rows.
REQUIRED=(DEPLOY_HOST DEPLOY_USER CONSOLE_MASTER_KEY DB_PASSWORD PUBLIC_ORIGIN)

if $INIT_SECRETS; then
  [[ -e "$SECRETS_FILE" ]] && die "Refusing to overwrite existing ${SECRETS_FILE}"
  mkdir -p "$(dirname "$SECRETS_FILE")"
  umask 077
  {
    echo "# Secret values for Factory Console '${TARGET_ENV}' local deploys."
    echo "# GitHub never returns secret values, so mirror them here by hand."
    echo "# Keep this file OUT of git. chmod 600 is applied automatically."
    echo "# Same SSH trio as lighthouse-backend / lighthouse-sales."
    echo
    echo "DEPLOY_HOST="
    echo "DEPLOY_USER="
    echo "DEPLOY_KEY_FILE=~/.ssh/id_rsa"
    echo "#DEPLOY_PORT=22"
    echo
    echo "CONSOLE_MASTER_KEY="
    echo "DB_PASSWORD="
    echo
    echo "# Optional GitHub App. Omit when APP_RESET=true on the GitHub Environment"
    echo "# (paste credentials in the Console UI) or when the VPS .env / DB already"
    echo "# has them. PEM as a single line with \\n for newlines."
    echo "#GH_APP_ID="
    echo "#GH_APP_PRIVATE_KEY="
    echo "#GH_APP_WEBHOOK_SECRET="
    echo "#GH_OAUTH_CLIENT_ID="
    echo "#GH_OAUTH_CLIENT_SECRET="
    echo
    echo "# Optional — empty values are skipped by the host .env upsert:"
    echo "#ANTHROPIC_API_KEY="
    echo "#ORCHESTRATOR_DISPATCH_TOKEN="
    echo
    echo "# Variables are fetched from GitHub (repo + environment). Override here:"
    echo "#PUBLIC_ORIGIN=https://sf.genaipeople.com"
    echo "#ORCHESTRATOR_URL=http://factory-orchestrator:8080"
    echo "#APP_RESET=true"
  } > "$SECRETS_FILE"
  log "Template written to ${SECRETS_FILE} — fill in the values, then re-run the deploy."
  exit 0
fi

if ! $SKIP_GIT_CHECK; then
  check_git_for_deploy
fi

FETCHED_VARS=""
fetch_var_endpoint() {
  local endpoint="$1" out line name value
  if ! out="$(gh api "$endpoint" --paginate --jq '.variables[] | "\(.name)=\(.value|@base64)"' 2>&1)"; then
    warn "Could not fetch ${endpoint}: ${out}"
    return 0
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    name="${line%%=*}"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="$(printf '%s' "${line#*=}" | base64 --decode)"
    export "${name}=${value}"
    FETCHED_VARS="${FETCHED_VARS}${FETCHED_VARS:+ }${name}"
  done <<< "$out"
}

if $FETCH_VARS; then
  command -v gh >/dev/null 2>&1 || \
    die "gh CLI not found. Install it (https://cli.github.com) and run 'gh auth login', or pass --no-fetch-vars."
  gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"
  log "Fetching GitHub variables for ${REPO} (repo-level, then '${TARGET_ENV}' environment)..."
  fetch_var_endpoint "repos/${REPO}/actions/variables"
  fetch_var_endpoint "repos/${REPO}/environments/${TARGET_ENV}/variables"
  log "Fetched variables: ${FETCHED_VARS:-none}"
  log "PUBLIC_ORIGIN=${PUBLIC_ORIGIN:-<unset>}  APP_RESET=${APP_RESET:-<unset>}  ORCHESTRATOR_URL=${ORCHESTRATOR_URL:-<unset>}"
else
  log "Skipping GitHub variable fetch (--no-fetch-vars)."
fi

load_secrets_file() {
  local file="$1" line key value lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" != *=* ]]; then
      warn "Ignoring malformed line ${lineno} in ${file} (expected KEY=VALUE)"
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      warn "Ignoring invalid key on line ${lineno} in ${file}"
      continue
    fi
    if [[ ${#value} -ge 2 && ( "$value" == \"*\" || "$value" == \'*\' ) ]]; then
      value="${value:1:${#value}-2}"
    fi
    export "${key}=${value}"
  done < "$file"
}

if [[ -f "$SECRETS_FILE" ]]; then
  log "Loading secrets from ${SECRETS_FILE}"
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
  load_secrets_file "$SECRETS_FILE"
else
  warn "Secrets file ${SECRETS_FILE} not found. Create it with: $0 ${TARGET_ENV} --init-secrets"
fi

# Accept either GH_* (GitHub Environment names) or GITHUB_* (VPS .env names).
GH_APP_ID="${GH_APP_ID:-${GITHUB_APP_ID:-}}"
GH_APP_PRIVATE_KEY="${GH_APP_PRIVATE_KEY:-${GITHUB_APP_PRIVATE_KEY:-}}"
GH_APP_WEBHOOK_SECRET="${GH_APP_WEBHOOK_SECRET:-${GITHUB_APP_WEBHOOK_SECRET:-}}"
GH_OAUTH_CLIENT_ID="${GH_OAUTH_CLIENT_ID:-${GITHUB_OAUTH_CLIENT_ID:-}}"
GH_OAUTH_CLIENT_SECRET="${GH_OAUTH_CLIENT_SECRET:-${GITHUB_OAUTH_CLIENT_SECRET:-}}"

if [[ -z "${CONSOLE_HOST:-}" && -n "${PUBLIC_ORIGIN:-}" ]]; then
  CONSOLE_HOST="$(host_from_url "$PUBLIC_ORIGIN")"
fi
CONSOLE_HOST="${CONSOLE_HOST:-}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-}"
APP_RESET="${APP_RESET:-}"
export CONSOLE_HOST PUBLIC_ORIGIN APP_RESET

missing=""
for var in "${REQUIRED[@]}"; do
  [[ -n "${!var:-}" ]] || missing="${missing} ${var}"
done
[[ -n "${DEPLOY_KEY:-}" || -n "${DEPLOY_KEY_FILE:-}" ]] || missing="${missing} DEPLOY_KEY|DEPLOY_KEY_FILE"
[[ -n "${CONSOLE_HOST:-}" ]] || missing="${missing} CONSOLE_HOST|PUBLIC_ORIGIN"
if [[ -n "$missing" ]]; then
  echo "Missing required configuration for ${TARGET_ENV}:${missing}" >&2
  echo "Secrets go in ${SECRETS_FILE}; variables (PUBLIC_ORIGIN, APP_RESET, ORCHESTRATOR_URL) come from GitHub (or the same file)." >&2
  if command -v gh >/dev/null 2>&1; then
    echo "Secret names configured in GitHub for reference (values are NOT retrievable):" >&2
    gh api "repos/${REPO}/environments/${TARGET_ENV}/secrets" --jq '.secrets[].name' 2>/dev/null | sed 's/^/  - /' >&2 || true
  fi
  exit 1
fi

if [[ -z "${GH_APP_ID:-}" || -z "${GH_APP_PRIVATE_KEY:-}" || -z "${GH_APP_WEBHOOK_SECRET:-}" ||
      -z "${GH_OAUTH_CLIENT_ID:-}" || -z "${GH_OAUTH_CLIENT_SECRET:-}" ]]; then
  if [[ "${APP_RESET:-}" == "true" || "${APP_RESET:-}" == "1" ]]; then
    log "GH_* App secrets omitted — APP_RESET=${APP_RESET} so the Console UI can register the GitHub App."
  else
    warn "GH_* App secrets omitted. Existing VPS .env / stored App row is left as-is. Set APP_RESET=true on the GitHub Environment to paste credentials in the UI."
  fi
fi

if [[ -n "${GH_APP_PRIVATE_KEY:-}" ]]; then
  GH_APP_PRIVATE_KEY="$(
    PEM="$GH_APP_PRIVATE_KEY" python3 -c 'import os; print(os.environ["PEM"].replace("\\n","\n").replace("\r\n","\n").strip().replace("\n","\\n"))'
  )"
fi
export GITHUB_APP_ID="${GH_APP_ID:-}"
export GITHUB_APP_PRIVATE_KEY="${GH_APP_PRIVATE_KEY:-}"
export GITHUB_APP_WEBHOOK_SECRET="${GH_APP_WEBHOOK_SECRET:-}"
export GITHUB_OAUTH_CLIENT_ID="${GH_OAUTH_CLIENT_ID:-}"
export GITHUB_OAUTH_CLIENT_SECRET="${GH_OAUTH_CLIENT_SECRET:-}"

if $SHOW_CONFIG; then
  echo "Resolved configuration for ${TARGET_ENV}:"
  for name in "${GH_VAR_NAMES[@]}"; do printf '  %-32s= %s\n' "$name" "${!name:-}"; done
  for name in "${GH_SECRET_NAMES[@]}"; do
    [[ -n "${!name:-}" ]] && printf '  %-32s= <set>\n' "$name" || printf '  %-32s= <empty>\n' "$name"
  done
  printf '  %-32s= %s\n' "DEPLOY_KEY_FILE" "${DEPLOY_KEY_FILE:-}"
  printf '  %-32s= %s\n' "APP_RESET" "${APP_RESET:-}"
  exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

log "Building ${APP_IMAGE}:latest for ${DEPLOY_PLATFORM}..."
docker build --platform "$DEPLOY_PLATFORM" -f infra/Dockerfile.api --target api -t "${APP_IMAGE}:latest" .
log "Building ${WEB_IMAGE}:latest for ${DEPLOY_PLATFORM}..."
docker build --platform "$DEPLOY_PLATFORM" -f infra/Dockerfile.web -t "${WEB_IMAGE}:latest" .

log "Saving images..."
docker save "${APP_IMAGE}:latest" | gzip > "${WORK_DIR}/${APP_IMAGE}.tar.gz"
docker save "${WEB_IMAGE}:latest" | gzip > "${WORK_DIR}/${WEB_IMAGE}.tar.gz"
cp infra/docker-compose.deploy.yml "${WORK_DIR}/docker-compose.yml"
log "Tarballs: $(du -h "${WORK_DIR}/${APP_IMAGE}.tar.gz" | cut -f1) (app), $(du -h "${WORK_DIR}/${WEB_IMAGE}.tar.gz" | cut -f1) (web)"

if $BUILD_ONLY; then
  cp "${WORK_DIR}/${APP_IMAGE}.tar.gz" "${WORK_DIR}/${WEB_IMAGE}.tar.gz" .
  log "--build-only: tarballs left at ./${APP_IMAGE}.tar.gz and ./${WEB_IMAGE}.tar.gz; skipping transfer and deploy."
  exit 0
fi

if [[ -n "${DEPLOY_KEY_FILE:-}" ]]; then
  KEY_PATH="${DEPLOY_KEY_FILE/#\~/$HOME}"
  [[ -f "$KEY_PATH" ]] || die "DEPLOY_KEY_FILE ${KEY_PATH} does not exist."
else
  KEY_PATH="${WORK_DIR}/deploy_key"
  printf '%s\n' "$DEPLOY_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi
DEPLOY_PORT="${DEPLOY_PORT:-22}"
SSH_OPTS=(-i "$KEY_PATH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30)

log "Preparing deploy directory on ${DEPLOY_HOST}..."
ssh "${SSH_OPTS[@]}" -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" \
  'set -euo pipefail; mkdir -p "$HOME/factory-console"'

log "Transferring image tarballs and compose file..."
scp "${SSH_OPTS[@]}" -P "$DEPLOY_PORT" \
  "${WORK_DIR}/${APP_IMAGE}.tar.gz" "${WORK_DIR}/${WEB_IMAGE}.tar.gz" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:/tmp/"
scp "${SSH_OPTS[@]}" -P "$DEPLOY_PORT" \
  "${WORK_DIR}/docker-compose.yml" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:factory-console/docker-compose.yml"

REMOTE_ENVS=(CONSOLE_HOST PUBLIC_ORIGIN CONSOLE_MASTER_KEY DB_PASSWORD APP_RESET
             ANTHROPIC_API_KEY GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY
             GITHUB_APP_WEBHOOK_SECRET GITHUB_OAUTH_CLIENT_ID
             GITHUB_OAUTH_CLIENT_SECRET ORCHESTRATOR_URL
             ORCHESTRATOR_DISPATCH_TOKEN)

REMOTE_SCRIPT="${WORK_DIR}/deploy-remote.sh"
{
  echo "set -euo pipefail"
  for v in "${REMOTE_ENVS[@]}"; do
    printf 'export %s=%q\n' "$v" "${!v:-}"
  done
  # Body below is copied from .github/workflows/deploy.yml "Deploy on host".
  cat <<'REMOTE_EOF'
if [ -z "${CONSOLE_HOST:-}" ]; then
  echo "CONSOLE_HOST is empty — set PUBLIC_ORIGIN on the production environment." >&2
  exit 1
fi

DEPLOY_DIR="$HOME/factory-console"
cd "$DEPLOY_DIR"

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
else
  DC=(docker-compose)
fi

for img in factory-console-app factory-console-web; do
  docker load < "/tmp/${img}.tar.gz"
  rm -f "/tmp/${img}.tar.gz"
done

touch .env
chmod 600 .env
if [ -n "${ORCHESTRATOR_DISPATCH_TOKEN:-}" ] && [ -z "${ORCHESTRATOR_URL:-}" ]; then
  ORCHESTRATOR_URL=http://factory-orchestrator:8080
fi
for KEY in CONSOLE_HOST PUBLIC_ORIGIN CONSOLE_MASTER_KEY DB_PASSWORD APP_RESET \
           ANTHROPIC_API_KEY GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY \
           GITHUB_APP_WEBHOOK_SECRET GITHUB_OAUTH_CLIENT_ID \
           GITHUB_OAUTH_CLIENT_SECRET ORCHESTRATOR_URL \
           ORCHESTRATOR_DISPATCH_TOKEN; do
  VALUE="${!KEY-}"
  [ -z "$VALUE" ] && continue
  TMP="$(mktemp)"
  grep -v "^${KEY}=" .env > "$TMP" || true
  printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"
  mv "$TMP" .env
done
chmod 600 .env

docker network inspect lighthouse-network >/dev/null 2>&1 || \
  docker network create lighthouse-network

"${DC[@]}" up -d --remove-orphans

echo "Waiting for api to become healthy..."
for attempt in $(seq 1 60); do
  STATE=$(docker inspect -f '{{.State.Health.Status}}' factory-console-api-1 2>/dev/null || echo missing)
  if [ "$STATE" = "healthy" ]; then
    echo "api healthy"
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "api did not become healthy (last state: $STATE)" >&2
    "${DC[@]}" ps
    "${DC[@]}" logs --tail 100 api
    exit 1
  fi
  sleep 3
done

docker image prune -f >/dev/null || true
echo "Deployment completed. Console reachable at https://${CONSOLE_HOST}/"
REMOTE_EOF
} > "$REMOTE_SCRIPT"

log "Running deploy on ${DEPLOY_HOST}..."
ssh "${SSH_OPTS[@]}" -p "$DEPLOY_PORT" "${DEPLOY_USER}@${DEPLOY_HOST}" 'bash -s' < "$REMOTE_SCRIPT"

log "Done — Factory Console (${TARGET_ENV}) deployed from local machine."
