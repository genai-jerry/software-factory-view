#!/usr/bin/env bash
set -euo pipefail

# Smoke-test that PUBLIC_ORIGIN serves the Compass (nginx + api), not the
# LangGraph orchestrator. Run after deploy from CI or local-deploy.
#
# Usage: PUBLIC_ORIGIN=https://sf.genaipeople.com ./scripts/verify-public-origin.sh

ORIGIN="${PUBLIC_ORIGIN:-}"
if [[ -z "$ORIGIN" ]]; then
  echo "verify-public-origin: PUBLIC_ORIGIN is required" >&2
  exit 1
fi

ORIGIN="${ORIGIN%/}"
ROOT_BODY="$(curl -fsS "$ORIGIN/" || true)"
HEALTH_BODY="$(curl -fsS "$ORIGIN/api/health" || true)"

if [[ "$ROOT_BODY" == *'"service":"factory-orchestrator"'* ]]; then
  cat >&2 <<EOF
verify-public-origin: $ORIGIN is serving the LangGraph orchestrator, not the Console.

Traefik is routing this hostname to factory-orchestrator. The Console nginx SPA
should answer / with HTML; /api/health should return {"ok":true,"service":"console-api"}.

Fix on the VPS:
  1. In claude-software-factory GitHub Environment production, set
     PUBLIC_BASE_URL to a different host (e.g. https://factory.genaipeople.com)
     — never sf.genaipeople.com.
  2. SSH to the VPS and repoint the orchestrator Traefik rule:
       cd ~/factory-orchestrator
       # pick any hostname that is NOT the Console host; DNS is not required
       # for docker-internal routing — this only changes the Traefik Host() rule.
       sed -i 's/^ORCHESTRATOR_HOST=.*/ORCHESTRATOR_HOST=factory-orchestrator.internal/' .env
       docker compose up -d
  3. Redeploy the Console (./scripts/local-deploy.sh production or re-run Deploy).

Root response was: $ROOT_BODY
EOF
  exit 1
fi

if [[ "$HEALTH_BODY" != *'"service":"console-api"'* ]]; then
  cat >&2 <<EOF
verify-public-origin: $ORIGIN/api/health did not return console-api.

Expected: {"ok":true,"service":"console-api"}
Got:      ${HEALTH_BODY:-<empty or curl error>}

Check factory-console containers: cd ~/factory-console && docker compose ps
EOF
  exit 1
fi

echo "verify-public-origin: OK — $ORIGIN serves Compass"
