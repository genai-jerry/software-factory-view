#!/usr/bin/env bash
set -euo pipefail

# One-shot VPS fix when sf.genaipeople.com serves factory-orchestrator JSON instead
# of the Console SPA. Run ON the Hostinger VPS (or via ssh user@host 'bash -s' < ...).
#
# Root cause: orchestrator PUBLIC_BASE_URL was set to the Console hostname, so Traefik
# routes sf.genaipeople.com to factory-orchestrator. The orchestrator only needs
# docker-internal access (http://factory-orchestrator:8080); it should not share the
# Console's public host.

CONSOLE_HOST="${CONSOLE_HOST:-sf.genaipeople.com}"
ORCHESTRATOR_TRAEFIK_HOST="${ORCHESTRATOR_TRAEFIK_HOST:-factory-orchestrator.internal}"

log() { echo "[fix-vps-host-routing] $*"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — run this on the VPS" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
else
  DC=(docker-compose)
fi

fix_orchestrator() {
  local dir="$HOME/factory-orchestrator"
  [[ -d "$dir" ]] || { log "skip orchestrator — $dir missing"; return 0; }
  cd "$dir"
  touch .env
  chmod 600 .env
  TMP="$(mktemp)"
  grep -v '^ORCHESTRATOR_HOST=' .env > "$TMP" || true
  printf 'ORCHESTRATOR_HOST=%s\n' "$ORCHESTRATOR_TRAEFIK_HOST" >> "$TMP"
  mv "$TMP" .env
  log "orchestrator ORCHESTRATOR_HOST=$ORCHESTRATOR_TRAEFIK_HOST"
  "${DC[@]}" up -d --remove-orphans
}

fix_console() {
  local dir="$HOME/factory-console"
  [[ -d "$dir" ]] || { log "skip console — $dir missing"; return 0; }
  cd "$dir"
  touch .env
  chmod 600 .env
  TMP="$(mktemp)"
  grep -v '^CONSOLE_HOST=' .env > "$TMP" || true
  printf 'CONSOLE_HOST=%s\n' "$CONSOLE_HOST" >> "$TMP"
  mv "$TMP" .env
  log "console CONSOLE_HOST=$CONSOLE_HOST"
  docker network inspect lighthouse-network >/dev/null 2>&1 || \
    docker network create lighthouse-network
  "${DC[@]}" up -d --remove-orphans
}

fix_orchestrator
fix_console

log "waiting for console api..."
for attempt in $(seq 1 30); do
  STATE=$(docker inspect -f '{{.State.Health.Status}}' factory-console-api-1 2>/dev/null || echo missing)
  if [[ "$STATE" == "healthy" ]]; then
    log "console api healthy"
    break
  fi
  [[ "$attempt" -eq 30 ]] && log "warn: api still $STATE — check docker compose logs api"
  sleep 3
done

ROOT="$(curl -fsS "https://${CONSOLE_HOST}/" 2>/dev/null || true)"
HEALTH="$(curl -fsS "https://${CONSOLE_HOST}/api/health" 2>/dev/null || true)"

if [[ "$ROOT" == *'"service":"factory-orchestrator"'* ]]; then
  log "ERROR: https://${CONSOLE_HOST}/ still serves orchestrator"
  log "Also update claude-software-factory production PUBLIC_BASE_URL away from ${CONSOLE_HOST}"
  exit 1
fi

if [[ "$HEALTH" != *'"service":"console-api"'* ]]; then
  log "ERROR: https://${CONSOLE_HOST}/api/health is not console-api: ${HEALTH:-<empty>}"
  exit 1
fi

log "OK — https://${CONSOLE_HOST}/ serves Compass"
