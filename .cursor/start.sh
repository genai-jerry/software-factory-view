#!/usr/bin/env bash
#
# Cloud Agent start phase: per-boot reconciliation. Starts Postgres and Redis,
# ensures the console role/database exist, and applies migrations. Idempotent
# and safe to run on every boot. Returns once services are ready; the dev
# servers themselves run as a named terminal (see .cursor/environment.json).
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_URL="postgres://console:console@localhost:5432/console"

echo "==> Starting Postgres"
sudo pg_ctlcluster 16 main start 2>/dev/null || sudo pg_ctlcluster 16 main restart 2>/dev/null || true

echo "==> Starting Redis"
sudo redis-server /etc/redis/redis.conf --daemonize yes 2>/dev/null || true

echo "==> Waiting for Postgres on :5432"
for i in $(seq 1 30); do
  if sudo -u postgres pg_isready -q 2>/dev/null; then break; fi
  sleep 1
done

echo "==> Ensuring console role and database"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='console'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE console LOGIN PASSWORD 'console' CREATEDB;"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='console'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE console OWNER console;"

echo "==> Applying database migrations"
DATABASE_URL="$DB_URL" node packages/db/dist/migrate-cli.js

echo "==> start.sh complete — Postgres + Redis ready, schema migrated"
