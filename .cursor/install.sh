#!/usr/bin/env bash
#
# Cloud Agent install phase: durable, idempotent setup that is baked into the
# environment snapshot. Installs system services (Postgres + Redis), project
# dependencies, builds the workspace, and prepares .env. Per-boot service
# startup and migrations live in .cursor/start.sh instead.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Installing system packages (Postgres + Redis) if missing"
if ! command -v psql >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    postgresql postgresql-contrib redis-server
fi

echo "==> Enabling pnpm via corepack"
corepack enable >/dev/null 2>&1 || true

echo "==> Installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> Building all packages"
pnpm -r build

echo "==> Preparing .env"
if [ ! -f .env ]; then
  cp .env.example .env
fi
# Generate the one required secret if it is not already set.
if ! grep -q '^CONSOLE_MASTER_KEY=..' .env; then
  key="$(openssl rand -base64 32)"
  if grep -q '^CONSOLE_MASTER_KEY=' .env; then
    tmp="$(mktemp)"; grep -v '^CONSOLE_MASTER_KEY=' .env > "$tmp"
    printf 'CONSOLE_MASTER_KEY=%s\n' "$key" >> "$tmp"; mv "$tmp" .env
  else
    printf 'CONSOLE_MASTER_KEY=%s\n' "$key" >> .env
  fi
fi
# Dev-only: browse and exercise the UI without a real GitHub App.
if grep -q '^# *DEV_FAKE_LOGIN=' .env; then
  sed -i 's|^# *DEV_FAKE_LOGIN=.*|DEV_FAKE_LOGIN=1|' .env
elif ! grep -q '^DEV_FAKE_LOGIN=' .env; then
  printf 'DEV_FAKE_LOGIN=1\n' >> .env
fi
# Dev server (Vite) is reached on :5173.
if grep -q '^PUBLIC_ORIGIN=' .env; then
  sed -i 's|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=http://localhost:5173|' .env
fi

echo "==> install.sh complete"
