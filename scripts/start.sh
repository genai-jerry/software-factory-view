#!/usr/bin/env bash
#
# Start the whole stack in Docker: postgres, redis, api, worker, web.
# This is the production-shaped layout — one origin on :8080, nginx serving the
# SPA and proxying /api, /auth and /webhooks to the API.
#
# Usage:
#   ./scripts/start.sh            # build if needed, then up
#   ./scripts/start.sh --rebuild  # force a rebuild
#
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

[ -f .env ] || die "No .env — run ./scripts/setup.sh first"
docker_up || die "Docker is not running"

if [ -z "$(env_value CONSOLE_MASTER_KEY)" ]; then
  die "CONSOLE_MASTER_KEY is missing from .env — run ./scripts/setup.sh"
fi

# Every published port is settled before anything starts: docker aborts the
# whole `up` on one "port is already allocated", and on a developer machine at
# least one of these four is often taken — not least by this project's own
# dev.sh. Each is pinned in .env (DB_PORT, REDIS_PORT, API_PORT, WEB_PORT) and
# only moved when it is genuinely occupied by something that is not ours.
load_env
claim_port postgres DB_PORT   5432
claim_port redis    REDIS_PORT 6379
claim_port api      API_PORT   8787
claim_port web      WEB_PORT   8080

# The browser reaches the stack on WEB_PORT, and OAuth callbacks and the App's
# webhook URL are derived from PUBLIC_ORIGIN — so a stale port here is a broken
# sign-in. Keep a local origin in step with the port actually being published;
# leave a tunnel or a real hostname alone, since that is a deliberate choice.
origin="$(env_value PUBLIC_ORIGIN)"
local_origin="http://localhost:$WEB_PORT"
if [ -z "$origin" ]; then
  set_env_value PUBLIC_ORIGIN "$local_origin"
  origin="$local_origin"
  ok "PUBLIC_ORIGIN defaulted to $origin"
elif [ "$origin" != "$local_origin" ]; then
  case "$origin" in
    http://localhost:*|http://127.0.0.1:*)
      set_env_value PUBLIC_ORIGIN "$local_origin"
      warn "PUBLIC_ORIGIN was $origin but the UI is published on :$WEB_PORT — updated to $local_origin"
      origin="$local_origin"
      ;;
    *)
      dim "PUBLIC_ORIGIN is $origin (not the local :$WEB_PORT) — leaving it as you set it"
      ;;
  esac
fi

say "Starting the stack"
# Spelled out rather than built up in an array: under `set -u`, bash 3.2 — the
# bash macOS ships — treats an empty array as unbound and aborts.
if [ "${1:-}" = "--rebuild" ]; then
  compose up -d --build || die "docker compose failed"
else
  compose up -d || die "docker compose failed"
fi

wait_for_port "$WEB_PORT" web 90 || warn "web has not opened :$WEB_PORT yet — check ./scripts/logs.sh web"

echo
ok "Factory Console is up."
cat <<EOF

   UI       http://localhost:$WEB_PORT
   Setup    http://localhost:$WEB_PORT/setup
   API      http://localhost:$WEB_PORT/api/health   (direct: http://localhost:$API_PORT/api/health)
   Logs     ./scripts/logs.sh          Stop  ./scripts/stop.sh

First run: open the UI and let the setup screen create the GitHub App, then
install it on your org and connect repositories from the Onboarding page.

EOF

if [ "$origin" = "$local_origin" ]; then
  dim "Note: GitHub cannot reach localhost, so webhooks will not arrive. The"
  dim "Console still works — use 'Reconcile estate now' to pull updates, or"
  dim "expose it with a tunnel (cloudflared/ngrok) and set PUBLIC_ORIGIN to that URL."
fi
