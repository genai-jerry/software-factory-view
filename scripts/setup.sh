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
load_env
say "Starting Postgres and Redis"
started=""
if docker_up; then
  # Both services are published on the host, because the migration runner and
  # the dev servers connect from there. If another process already owns a
  # default port — a Postgres you installed yourself, most likely — publish
  # ours somewhere free rather than letting the host port point at a stranger's
  # database. That is exactly how migrations end up running against a Postgres
  # with no 'console' role.
  for svc_var_port in "postgres DB_PORT 5432" "redis REDIS_PORT 6379"; do
    # shellcheck disable=SC2086
    set -- $svc_var_port
    svc="$1"; var="$2"; default_port="$3"
    eval "want=\${$var:-}"   # eval, not ${!var}: portable back to bash 3.2
    [ -n "$want" ] || want="$(env_value "$var")"
    [ -n "$want" ] || want="$default_port"
    if port_open "$want" && ! compose_owns_port "$svc" "$want"; then
      free="$(find_free_port $((want + 1)))" || die "No free port near $want for $svc"
      warn "Something else is already listening on :$want — publishing $svc on :$free instead"
      set_env_value "$var" "$free"
      want="$free"
    fi
    export "$var=$want"
  done

  if compose up -d postgres redis >/dev/null 2>&1; then
    started="docker"
    ok "postgres (:$DB_PORT) + redis (:$REDIS_PORT) running (docker compose)"
  else
    warn "docker compose could not start postgres/redis"
  fi
fi

if [ -z "$started" ]; then
  dim "Docker unavailable — trying local services"
  export DB_PORT="$(db_port)" REDIS_PORT="$(redis_port)"
  if have pg_ctlcluster || [ -d /etc/postgresql ]; then
    service postgresql start >/dev/null 2>&1 || sudo service postgresql start >/dev/null 2>&1 || true
  fi
  have redis-server && (redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes >/dev/null 2>&1) || true

  if port_open "$DB_PORT"; then
    started="local"
    # A local Postgres has none of the Console's own setup — create the role and
    # database it connects as, or say plainly that we could not.
    ensure_console_role "$DB_PORT" "$(db_password)" \
      || warn "Create them yourself, then re-run: CREATE ROLE console LOGIN PASSWORD '$(db_password)' CREATEDB; CREATE DATABASE console OWNER console;"
    ok "postgres + redis running (local services)"
  fi
fi
[ -n "$started" ] || die "Could not start Postgres. Start Docker, or install postgresql + redis, then re-run."

wait_for_port "$DB_PORT" postgres || die "Postgres did not come up on :$DB_PORT"
port_open "$REDIS_PORT" || warn "Redis is not answering on :$REDIS_PORT — the worker queue will not run"

# ---------------------------------------------------------------- migrate
say "Applying database migrations"
DATABASE_URL="$(db_url)" node packages/db/dist/migrate-cli.js \
  || die "Migrations failed — see the diagnosis above."
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
