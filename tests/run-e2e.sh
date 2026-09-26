#!/usr/bin/env bash
#
# Browser tests. Boots the throwaway `cmtest` stack with the UI, runs
# Playwright from Microsoft's image (so no browser is installed on this
# machine), and tears the stack down. Screenshots land in tests/e2e/screenshots.
#
#   tests/run-e2e.sh
#   KEEP=1 tests/run-e2e.sh      # leave the stack up
#
set -uo pipefail

cd "$(dirname "$0")/.."

PROJECT=cmtest
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.test.yml --profile ui)

export TEST_KONG_PORT="${TEST_KONG_PORT:-18080}"
export TEST_UI_PORT="${TEST_UI_PORT:-13000}"
export TEST_FAKE_MODEL_PORT="${TEST_FAKE_MODEL_PORT:-18099}"
export TEST_MAIL_PORT="${TEST_MAIL_PORT:-18025}"
export TEST_GREENMAIL_SMTP_PORT="${TEST_GREENMAIL_SMTP_PORT:-13025}"

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

echo "==> Building and starting the $PROJECT stack with the UI"
"${COMPOSE[@]}" up -d --build || exit 1

echo "==> Waiting for the gateway and the UI"
ready=0
for _ in $(seq 1 100); do
  login=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:${TEST_KONG_PORT}/api/auth/login" \
    -H 'Content-Type: application/json' -d '{}' || true)
  ui=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${TEST_UI_PORT}/" || true)
  assistant=$("${COMPOSE[@]}" ps assistant-service --format '{{.Health}}' 2>/dev/null || true)

  if { [ "$login" = "400" ] || [ "$login" = "401" ]; } && [ "$ui" = "200" ] && [ "$assistant" = "healthy" ]; then
    ready=1
    break
  fi

  sleep 3
done

if [ "$ready" != "1" ]; then
  echo "!! Stack did not become ready"
  "${COMPOSE[@]}" ps
  exit 1
fi

echo "==> Running browser tests"
mkdir -p tests/e2e/screenshots

# --network host: the browser reaches the UI and gateway on localhost, as a
# person would. Runs as the invoking user so the screenshots stay editable.
docker run --rm --network host --ipc host \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  -e UI_BASE="http://localhost:${TEST_UI_PORT}" \
  -e API_BASE="http://localhost:${TEST_KONG_PORT}/api" \
  -v "$PWD/tests/e2e":/e2e -w /e2e \
  "$PLAYWRIGHT_IMAGE" \
  sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx playwright test'
status=$?

echo "==> Screenshots: tests/e2e/screenshots"
exit "$status"
