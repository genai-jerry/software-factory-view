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

# The browser reaches the stack on :8080, so OAuth and webhook URLs must agree.
origin="$(env_value PUBLIC_ORIGIN)"
if [ -z "$origin" ]; then
  set_env_value PUBLIC_ORIGIN "http://localhost:8080"
  ok "PUBLIC_ORIGIN defaulted to http://localhost:8080"
fi

say "Starting the stack"
# Spelled out rather than built up in an array: under `set -u`, bash 3.2 — the
# bash macOS ships — treats an empty array as unbound and aborts.
if [ "${1:-}" = "--rebuild" ]; then
  compose up -d --build || die "docker compose failed"
else
  compose up -d || die "docker compose failed"
fi

wait_for_port 8080 web 90 || warn "web has not opened :8080 yet — check ./scripts/logs.sh web"

echo
ok "Factory Console is up."
cat <<EOF

   UI       http://localhost:8080
   Setup    http://localhost:8080/setup
   API      http://localhost:8080/api/health
   Logs     ./scripts/logs.sh          Stop  ./scripts/stop.sh

First run: open the UI and let the setup screen create the GitHub App, then
install it on your org and connect repositories from the Onboarding page.

EOF

if [ "$(env_value PUBLIC_ORIGIN)" = "http://localhost:8080" ]; then
  dim "Note: GitHub cannot reach localhost, so webhooks will not arrive. The"
  dim "Console still works — use 'Reconcile estate now' to pull updates, or"
  dim "expose it with a tunnel (cloudflared/ngrok) and set PUBLIC_ORIGIN to that URL."
fi
