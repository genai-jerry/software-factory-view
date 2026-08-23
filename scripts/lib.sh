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

# Load .env into the environment without clobbering anything already exported.
# When a key appears more than once in the file, the LAST occurrence wins —
# matching docker compose's dotenv semantics, so the scripts and compose can
# never read two different values from the same file (an appended
# `KEY=value` line behaves the same everywhere).
load_env() {
  [ -f "$REPO_ROOT/.env" ] || return 0
  local key
  while IFS= read -r key; do
    [ -n "${!key:-}" ] && continue
    export "${key}=$(env_value "$key")"
  done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$REPO_ROOT/.env" | sort -u)
}

env_value() { # env_value KEY -> prints value from .env, empty if unset (last occurrence wins)
  [ -f "$REPO_ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | tail -1
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

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif have docker-compose; then docker-compose "$@"
  else return 1
  fi
}

docker_up() { docker info >/dev/null 2>&1; }
