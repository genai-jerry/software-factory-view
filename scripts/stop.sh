#!/usr/bin/env bash
#
# Stop whatever is running — dev processes and/or the Docker stack.
#
# Usage:
#   ./scripts/stop.sh           # stop dev processes and docker services
#   ./scripts/stop.sh --volumes # also delete the database volume (destructive)
#
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

stopped_any=""

# Dev processes recorded by dev.sh
if [ -d "$RUN_DIR" ]; then
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -e "$pidfile" ] || continue
    name="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      ok "stopped dev process: $name (pid $pid)"
      stopped_any=1
    fi
    rm -f "$pidfile"
  done
fi

if docker_up; then
  if [ "${1:-}" = "--volumes" ]; then
    warn "Removing containers AND the database volume"
    compose down -v >/dev/null 2>&1 && { ok "docker stack down, volumes removed"; stopped_any=1; }
  else
    compose down >/dev/null 2>&1 && { ok "docker stack down"; stopped_any=1; }
  fi
fi

[ -n "$stopped_any" ] || dim "Nothing was running."
