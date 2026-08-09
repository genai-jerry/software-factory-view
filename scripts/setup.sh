#!/usr/bin/env bash
#
# One-time setup: check the toolchain, create .env with a generated encryption
# key, install dependencies, build, start Postgres/Redis and migrate.
#
# The only secret this creates is CONSOLE_MASTER_KEY. Everything about the
# GitHub App — app id, private key, webhook secret, OAuth pair — is registered
# from the Console's own /setup screen, and repositories are chosen in the UI.
#
# Usage: ./scripts/setup.sh
#
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

say "Checking the toolchain"
have node || die "Node.js 20.19+ is required (https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node $(node -v) is too old — 20.19+ required"
ok "node $(node -v)"

if ! have pnpm; then
  say "pnpm not found — enabling via corepack"
  corepack enable >/dev/null 2>&1 || die "install pnpm: npm i -g pnpm"
fi
ok "pnpm $(pnpm -v)"

# ---------------------------------------------------------------- .env
if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  ok ".env created"
else
  dim ".env already exists — leaving it alone"
fi

if [ -z "$(env_value CONSOLE_MASTER_KEY)" ]; then
  say "Generating CONSOLE_MASTER_KEY (encrypts tokens and cached repo content at rest)"
  if have openssl; then key="$(openssl rand -base64 32)"
  else key="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"
  fi
  set_env_value CONSOLE_MASTER_KEY "$key"
  ok "CONSOLE_MASTER_KEY written to .env"
  warn "Back this up. Losing it means every stored OAuth token must be re-issued."
else
  ok "CONSOLE_MASTER_KEY already set"
fi

# ---------------------------------------------------------------- deps
say "Installing dependencies"
pnpm install --silent
ok "dependencies installed"

say "Building packages"
pnpm -r build >/dev/null
ok "build complete"

# ---------------------------------------------------------------- infra
say "Starting Postgres and Redis"
started=""
if docker_up && compose up -d postgres redis >/dev/null 2>&1; then
  started="docker"
  ok "postgres + redis running (docker compose)"
else
  dim "Docker unavailable — trying local services"
  if have pg_ctlcluster || [ -d /etc/postgresql ]; then
    service postgresql start >/dev/null 2>&1 || sudo service postgresql start >/dev/null 2>&1 || true
  fi
  have redis-server && (redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null 2>&1) || true

  if port_open 5432; then
    started="local"
    # Make sure the console role/database exist.
    if have psql; then
      su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='console'\"" 2>/dev/null | grep -q 1 \
        || su postgres -c "psql -c \"CREATE ROLE console LOGIN PASSWORD 'console' CREATEDB;\"" >/dev/null 2>&1 || true
      su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='console'\"" 2>/dev/null | grep -q 1 \
        || su postgres -c "psql -c 'CREATE DATABASE console OWNER console;'" >/dev/null 2>&1 || true
    fi
    ok "postgres + redis running (local services)"
  fi
fi
[ -n "$started" ] || die "Could not start Postgres. Start Docker, or install postgresql + redis, then re-run."

wait_for_port 5432 postgres || die "Postgres did not come up on :5432"
port_open 6379 || warn "Redis is not answering on :6379 — the worker queue will not run"

# ---------------------------------------------------------------- migrate
say "Applying database migrations"
load_env
DATABASE_URL="${DATABASE_URL:-postgres://console:console@localhost:5432/console}" \
  node packages/db/dist/migrate-cli.js
ok "database ready"

echo
ok "Setup complete."
cat <<'EOF'

Next:
  ./scripts/dev.sh        start api + worker + web in dev mode  (http://localhost:5173)
  ./scripts/start.sh      start everything in Docker            (http://localhost:8080)

Then open the app and follow the setup screen: it creates the Console's GitHub
App for you (two clicks, nothing to copy), and you pick the org and repos to
connect from the Onboarding page.

EOF
