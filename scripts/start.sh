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

# The browser reaches the stack on WEB_HOST_PORT (default 8080), so OAuth and
# webhook URLs must agree.
origin="$(env_value PUBLIC_ORIGIN)"
if [ -z "$origin" ]; then
  set_env_value PUBLIC_ORIGIN "http://localhost:8080"
  ok "PUBLIC_ORIGIN defaulted to http://localhost:8080"
fi

# Host ports: keep what is ours, move off what belongs to something else.
# Postgres/Redis are published for dev-mode and the orchestrator; :8080 is
# shared with the factory orchestrator's own dev server, so the web port
# moves too — and PUBLIC_ORIGIN follows it when it names the local stack.
DB_HOST_PORT="$(env_value DB_HOST_PORT)"; DB_HOST_PORT="${DB_HOST_PORT:-5432}"
REDIS_HOST_PORT="$(env_value REDIS_HOST_PORT)"; REDIS_HOST_PORT="${REDIS_HOST_PORT:-6379}"
ensure_host_port DB_HOST_PORT postgres DB_HOST_PORT
ensure_host_port REDIS_HOST_PORT redis REDIS_HOST_PORT

WEB_HOST_PORT="$(env_value WEB_HOST_PORT)"; WEB_HOST_PORT="${WEB_HOST_PORT:-8080}"
was_web_port="$WEB_HOST_PORT"
ensure_host_port WEB_HOST_PORT web WEB_HOST_PORT
web_port="$WEB_HOST_PORT"
if [ "$web_port" != "$was_web_port" ] && [ "$(env_value PUBLIC_ORIGIN)" = "http://localhost:$was_web_port" ]; then
  set_env_value PUBLIC_ORIGIN "http://localhost:$web_port"
  ok "PUBLIC_ORIGIN follows the web port: http://localhost:$web_port"
fi

# Production joins the VPS Traefik network (external: true). Create it locally
# so `docker compose up` does not fail when that network is absent.
if ! docker network inspect lighthouse-network >/dev/null 2>&1; then
  docker network create lighthouse-network >/dev/null
  ok "Created docker network lighthouse-network"
fi

# A stale image serves the SPA bundle from the last build, which looks like
# "my change did not land" rather than "nothing was rebuilt" — so an argument
# we do not understand is an error, never a silent no-op.
build_args=()
case "${1:-}" in
  "") ;;
  --rebuild|-r|rebuild) build_args+=(--build) ;;
  *) die "Unknown argument '$1' — usage: ./scripts/start.sh [--rebuild]" ;;
esac

say "Starting the stack"
# ${arr[@]+...} guard: bash < 4.4 (macOS's 3.2) treats an empty array as unbound under set -u.
compose up -d ${build_args[@]+"${build_args[@]}"} || die "docker compose failed"

wait_for_port "$web_port" web 90 || warn "web has not opened :$web_port yet — check ./scripts/logs.sh web"

echo
ok "Factory Console is up."
cat <<EOF

   UI       http://localhost:$web_port
   Setup    http://localhost:$web_port/setup
   API      http://localhost:$web_port/api/health
   Logs     ./scripts/logs.sh          Stop  ./scripts/stop.sh

First run: open the UI. Sign in with GitHub, then connect an organisation
and tick repositories. The GitHub App is a platform secret, not a user step.

EOF

if [ "$(env_value PUBLIC_ORIGIN)" = "http://localhost:8080" ]; then
  dim "Note: GitHub cannot reach localhost, so webhooks will not arrive. The"
  dim "Console still works — use 'Reconcile this organisation now' to pull updates, or"
  dim "expose it with a tunnel (cloudflared/ngrok) and set PUBLIC_ORIGIN to that URL."
fi
