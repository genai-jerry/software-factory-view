#!/usr/bin/env bash
# Shared helpers for the Console scripts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$REPO_ROOT/.run"
LOG_DIR="$RUN_DIR/logs"

c_reset=$'\033[0m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_blue=$'\033[34m'

say()  { printf '%s==>%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()   { printf '%s ✓%s %s\n' "$c_green" "$c_reset" "$*"; }
warn() { printf '%s ⚠%s %s\n' "$c_yellow" "$c_reset" "$*"; }
die()  { printf '%s ✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$c_dim" "$*" "$c_reset"; }

have() { command -v "$1" >/dev/null 2>&1; }

child_pids() { # child_pids PID -> direct children, one per line
  if have pgrep; then pgrep -P "$1" 2>/dev/null || true
  else ps -eo pid=,ppid= 2>/dev/null | awk -v p="$1" '$2 == p { print $1 }'
  fi
}

# Stop a service started by dev.sh, along with anything it spawned. Services
# started under setsid lead their own process group, so signalling -PID gets the
# lot. Without setsid (macOS) they share this script's group, which must not be
# signalled — so walk the descendants instead, deepest first: `tsc --watch` sits
# two levels down behind an `sh -c`, and killing only the direct child orphans it.
kill_tree() { # kill_tree PID
  local pid="$1" child
  kill -0 "$pid" 2>/dev/null || return 0
  if [ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" = "$pid" ]; then
    kill -- "-$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    return 0
  fi
  for child in $(child_pids "$pid"); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

# Load .env into the environment without clobbering anything already exported.
load_env() {
  [ -f "$REPO_ROOT/.env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    local key="${line%%=*}"
    [ -n "${!key:-}" ] && continue
    export "${key}=${line#*=}"
  done < "$REPO_ROOT/.env"
}

env_value() { # env_value KEY -> prints value from .env, empty if unset
  [ -f "$REPO_ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | head -1
}

set_env_value() { # set_env_value KEY VALUE (adds or replaces in .env)
  local key="$1" value="$2" file="$REPO_ROOT/.env"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    local tmp; tmp="$(mktemp)"
    grep -v "^${key}=" "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Is a TCP port accepting connections?
port_open() {
  local host="${2:-127.0.0.1}" port="$1"
  if have nc; then nc -z "$host" "$port" >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/$host/$port") >/dev/null 2>&1
  fi
}

wait_for_port() { # wait_for_port PORT LABEL [TIMEOUT]
  local port="$1" label="$2" timeout="${3:-45}" i=0
  while [ "$i" -lt "$timeout" ]; do
    port_open "$port" && return 0
    sleep 1; i=$((i+1))
  done
  return 1
}

find_free_port() { # find_free_port START -> first port nothing is listening on
  local p="$1" i=0
  while [ "$i" -lt 50 ]; do
    port_open "$p" || { echo "$p"; return 0; }
    p=$((p+1)); i=$((i+1))
  done
  return 1
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif have docker-compose; then docker-compose "$@"
  else return 1
  fi
}

docker_up() { docker info >/dev/null 2>&1; }

# Does our own compose service publish this host port? Used to tell "the port is
# busy because the Console is already running" apart from "the port is busy
# because something else owns it".
compose_owns_port() { # compose_owns_port SERVICE PORT
  local cid; cid="$(compose ps -q "$1" 2>/dev/null | head -1)" || return 1
  [ -n "$cid" ] || return 1
  docker port "$cid" 2>/dev/null | grep -q ":$2\$"
}

# ---------------------------------------------------------------- connections
#
# Host ports for Postgres and Redis. The Docker services publish these, and
# everything that runs on the host (migrations, dev servers) connects to them.
# They are overridable in .env because a machine with its own Postgres on 5432
# would otherwise collide — and connecting to that Postgres by accident is how
# you get "role \"console\" does not exist" halfway through setup.
db_port()    { local v="${DB_PORT:-}";    [ -n "$v" ] || v="$(env_value DB_PORT)";    echo "${v:-5432}"; }
redis_port() { local v="${REDIS_PORT:-}"; [ -n "$v" ] || v="$(env_value REDIS_PORT)"; echo "${v:-6379}"; }
db_password() { local v="${DB_PASSWORD:-}"; [ -n "$v" ] || v="$(env_value DB_PASSWORD)"; echo "${v:-console}"; }

urlencode() { # percent-encode a URL component (passwords may contain @ : / …)
  local s="${1-}" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out="$out$c" ;;
      *) out="$out$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# An explicit DATABASE_URL always wins; otherwise build one from DB_PASSWORD and
# the host port the Console's Postgres is published on.
db_url() {
  local u="${DATABASE_URL:-}"
  [ -n "$u" ] || u="$(env_value DATABASE_URL)"
  if [ -n "$u" ]; then echo "$u"; return 0; fi
  echo "postgres://console:$(urlencode "$(db_password)")@localhost:$(db_port)/console"
}

redis_url() {
  local u="${REDIS_URL:-}"
  [ -n "$u" ] || u="$(env_value REDIS_URL)"
  if [ -n "$u" ]; then echo "$u"; return 0; fi
  echo "redis://localhost:$(redis_port)"
}

# Run SQL against a locally-installed Postgres as a superuser, trying the ways a
# superuser is usually reachable: the current user (Homebrew/Postgres.app), the
# postgres role, then su postgres (Debian/Ubuntu packages). Prints rows; returns
# non-zero if no route connects.
super_sql() { # super_sql PORT SQL
  local port="$1" sql="$2"
  have psql || return 1
  psql -h localhost -p "$port" -d postgres -tAc "$sql" 2>/dev/null && return 0
  psql -h localhost -p "$port" -U postgres -d postgres -tAc "$sql" 2>/dev/null && return 0
  su postgres -c "psql -p $port -tAc \"$sql\"" 2>/dev/null && return 0
  return 1
}

# Make sure a locally-installed Postgres has the role and database the Console
# connects as. Returns non-zero (with an explanation) if it could not.
ensure_console_role() { # ensure_console_role PORT PASSWORD
  local port="$1" pw="$2"
  have psql || { warn "psql is not on PATH — cannot create the 'console' role automatically"; return 1; }
  super_sql "$port" 'SELECT 1' >/dev/null || {
    warn "Could not reach the Postgres on :$port as a superuser"
    return 1
  }
  super_sql "$port" "SELECT 1 FROM pg_roles WHERE rolname='console'" | grep -q 1 \
    || super_sql "$port" "CREATE ROLE console LOGIN PASSWORD '$pw' CREATEDB" >/dev/null \
    || { warn "Could not create the 'console' role on :$port"; return 1; }
  super_sql "$port" "SELECT 1 FROM pg_database WHERE datname='console'" | grep -q 1 \
    || super_sql "$port" "CREATE DATABASE console OWNER console" >/dev/null \
    || { warn "Could not create the 'console' database on :$port"; return 1; }
  return 0
}
