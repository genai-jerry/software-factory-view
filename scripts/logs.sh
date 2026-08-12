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

# compose is a shell function (lib.sh), so it cannot be exec'd — call it directly.
if docker_up && compose ps --quiet 2>/dev/null | grep -q .; then
  if [ -n "$service" ]; then compose logs -f "$service"; exit $?; fi
  compose logs -f
  exit $?
fi

die "No logs found — is anything running? (./scripts/dev.sh or ./scripts/start.sh)"
