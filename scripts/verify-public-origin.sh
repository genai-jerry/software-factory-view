#!/usr/bin/env bash
set -euo pipefail

# Smoke-test that PUBLIC_ORIGIN serves the Factory Console (nginx + api), not the
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

ORCH_ORIGIN="${ORCHESTRATOR_PUBLIC_ORIGIN:-https://factory.genaipeople.com}"
ORCH_ORIGIN="${ORCH_ORIGIN%/}"
if [[ "$ORCH_ORIGIN" != "$ORIGIN" ]]; then
  RUN_PATH="/runs/verify-placeholder"
  HEADERS="$(curl -sS -D - -o /dev/null --max-time 15 "$ORCH_ORIGIN$RUN_PATH" || true)"
  LOCATION="$(printf '%s' "$HEADERS" | awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/\r$/,""); print $2; exit}')"
  EXPECTED="$ORIGIN$RUN_PATH"
  if [[ "$LOCATION" != "$EXPECTED" && "$LOCATION" != "$EXPECTED/" ]]; then
    cat >&2 <<EOF
verify-public-origin: $ORCH_ORIGIN$RUN_PATH did not redirect to the Console run page.

GitHub comments link the orchestrator host /runs/{id}, which is JSON. Traefik on
the Console web container must redirect PathPrefix(/runs) on that host to
$ORIGIN/runs/{id}.

Got Location: ${LOCATION:-<none>}
Response: $(printf '%s' "$HEADERS" | head -n 5)
EOF
    exit 1
  fi
fi

echo "verify-public-origin: OK — $ORIGIN serves Factory Console"
