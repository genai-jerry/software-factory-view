#!/usr/bin/env bash
#
# Start the Console in development: API, worker and the Vite dev server, with
# rebuilds on change. Logs stream to .run/logs/ and Ctrl-C stops everything.
#
# Usage:
#   ./scripts/dev.sh              # all three services
#   ./scripts/dev.sh api worker   # a subset
#
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

WANTED=("$@")
[ ${#WANTED[@]} -eq 0 ] && WANTED=(api worker web)

wants() { for w in "${WANTED[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

[ -f .env ] || die "No .env — run ./scripts/setup.sh first"

# In dev the browser talks to Vite (:5173), which proxies to the API — so OAuth
# callbacks and the App's webhook URL must point at Vite's origin, not at the
# :8080 value .env carries for the Docker layout. An explicitly exported
# PUBLIC_ORIGIN still wins, which is how you point dev at a public tunnel.
SHELL_PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-}"
load_env
: "${DATABASE_URL:=postgres://console:console@localhost:5432/console}"
: "${REDIS_URL:=redis://localhost:6379}"
: "${API_PORT:=8787}"
export DATABASE_URL REDIS_URL API_PORT
export PUBLIC_ORIGIN="${SHELL_PUBLIC_ORIGIN:-http://localhost:5173}"

[ -n "${CONSOLE_MASTER_KEY:-}" ] || warn "CONSOLE_MASTER_KEY is unset — sign-in and setup will be disabled (run ./scripts/setup.sh)"

port_open 5432 || die "Postgres is not running on :5432 — run ./scripts/setup.sh"
port_open 6379 || warn "Redis is not running on :6379 — the worker will retry until it is"

mkdir -p "$LOG_DIR"
PIDS=()

cleanup() {
  echo
  say "Stopping…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
    # Kill the whole process group: tsc --watch spawns children.
    kill -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  ok "Stopped."
}
trap cleanup INT TERM EXIT

start() { # start NAME COMMAND...
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  : > "$log"
  setsid "$@" >>"$log" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  echo "$pid" > "$RUN_DIR/$name.pid"
  ok "$name started (pid $pid) → $log"
}

say "Building packages once before watching"
pnpm -r --filter '@console/core' --filter '@console/db' --filter '@console/insight' build >/dev/null
ok "packages built"

if wants api; then
  start api node --watch apps/api/dist/index.js
  start api-tsc npx tsc -p apps/api/tsconfig.json --watch --preserveWatchOutput
fi
if wants worker; then
  start worker node --watch apps/worker/dist/index.js
  start worker-tsc npx tsc -p apps/worker/tsconfig.json --watch --preserveWatchOutput
fi
if wants web; then
  start web pnpm --filter @console/web dev
fi

if wants api; then
  wait_for_port "$API_PORT" api 30 && ok "api listening on :$API_PORT" || warn "api has not opened :$API_PORT yet — check $LOG_DIR/api.log"
fi
if wants web; then
  wait_for_port 5173 web 30 >/dev/null || true
fi

echo
say "Factory Console (dev)"
wants web && echo "   UI       http://localhost:5173"
wants api && echo "   API      http://localhost:$API_PORT/api/health"
echo "   Setup    http://localhost:5173/setup"
echo "   Logs     tail -f $LOG_DIR/*.log      (or ./scripts/logs.sh)"
echo
dim "Ctrl-C stops everything."
wait
