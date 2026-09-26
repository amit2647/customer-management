#!/usr/bin/env bash
#
# Boots the whole stack as a throwaway `cmtest` project, runs the integration
# tests against it, and removes it again — containers and volumes. The main
# stack and its data are never touched.
#
#   tests/run-integration.sh            # build, test, tear down
#   KEEP=1 tests/run-integration.sh     # leave the stack up afterwards
#
set -uo pipefail

cd "$(dirname "$0")/.."

PROJECT=cmtest
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.test.yml)

export TEST_KONG_PORT="${TEST_KONG_PORT:-18080}"
export TEST_FAKE_MODEL_PORT="${TEST_FAKE_MODEL_PORT:-18099}"

API="http://localhost:${TEST_KONG_PORT}/api"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

echo "==> Building and starting the $PROJECT stack"
"${COMPOSE[@]}" up -d --build || exit 1

# Ready means: the gateway routes to identity-service, and assistant-service
# (the last to start) is healthy. Polled rather than `up --wait`, because the
# one-shot migrate container exits by design.
echo "==> Waiting for the stack"
ready=0
for _ in $(seq 1 90); do
  login=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" \
    -H 'Content-Type: application/json' -d '{}' || true)
  assistant=$("${COMPOSE[@]}" ps assistant-service --format '{{.Health}}' 2>/dev/null || true)

  if [ "$login" = "400" ] || [ "$login" = "401" ]; then
    if [ "$assistant" = "healthy" ]; then
      ready=1
      break
    fi
  fi

  sleep 3
done

if [ "$ready" != "1" ]; then
  echo "!! Stack did not become ready"
  "${COMPOSE[@]}" ps
  "${COMPOSE[@]}" logs --tail 60
  exit 1
fi

echo "==> Running integration tests"
API_BASE="$API" FAKE_MODEL_URL="http://localhost:${TEST_FAKE_MODEL_PORT}" \
  node --test --test-concurrency=1 tests/integration/*.test.js
status=$?

if [ "$status" != "0" ]; then
  echo "!! Tests failed; recent service logs follow"
  "${COMPOSE[@]}" logs --tail 40 assistant-service identity-service lead-service fake-openrouter
fi

exit "$status"
