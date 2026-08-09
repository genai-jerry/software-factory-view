#!/usr/bin/env bash
#
# Tail logs from whichever mode is running.
#
# Usage:
#   ./scripts/logs.sh          # everything
#   ./scripts/logs.sh api      # one service (api | worker | web)
#
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

service="${1:-}"

if [ -d "$LOG_DIR" ] && compgen -G "$LOG_DIR/*.log" >/dev/null; then
  if [ -n "$service" ]; then
    exec tail -f "$LOG_DIR/$service.log"
  fi
  exec tail -f "$LOG_DIR"/*.log
fi

if docker_up && compose ps --quiet 2>/dev/null | grep -q .; then
  if [ -n "$service" ]; then exec compose logs -f "$service"; fi
  exec compose logs -f
fi

die "No logs found — is anything running? (./scripts/dev.sh or ./scripts/start.sh)"
