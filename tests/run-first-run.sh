#!/usr/bin/env bash
#
# First-run setup, end to end: boots a stack with no admin configured (project
# `cmfirst`, its own ports, so it never meets cmtest or the dev stack), reads
# the one-time setup code from the migrate log the way an installer would, and
# drives the setup screen in a browser. Tears the stack down afterwards.
#
#   tests/run-first-run.sh
#   KEEP=1 tests/run-first-run.sh      # leave the stack up
#
set -uo pipefail

cd "$(dirname "$0")/.."

PROJECT=cmfirst
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.firstrun.yml --profile ui)

export TEST_KONG_PORT="${FIRST_RUN_KONG_PORT:-28080}"
export TEST_UI_PORT="${FIRST_RUN_UI_PORT:-23000}"
export TEST_FAKE_MODEL_PORT="${FIRST_RUN_FAKE_MODEL_PORT:-28099}"
export TEST_MAIL_PORT="${FIRST_RUN_MAIL_PORT:-28025}"
export TEST_GREENMAIL_SMTP_PORT="${FIRST_RUN_GREENMAIL_SMTP_PORT:-23025}"

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# Start from empty volumes: a run that was killed before its trap fired
# (a stopped terminal, a closed session) leaves this project's database
# behind, and `up` would reuse it — the browser suite's CA install then
# showed up in the integration suite's bundle-free organization.
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1

echo "==> Building and starting the $PROJECT stack (nothing configured)"
"${COMPOSE[@]}" up -d --build || exit 1

echo "==> Waiting for the gateway and the UI"
ready=0
for _ in $(seq 1 100); do
  setup=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${TEST_KONG_PORT}/api/setup/status" || true)
  ui=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${TEST_UI_PORT}/" || true)

  if [ "$setup" = "200" ] && [ "$ui" = "200" ]; then
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

# What an installer does: read the code the migrate container printed.
code=$("${COMPOSE[@]}" logs migrate 2>/dev/null | grep -oE '[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}' | tail -1)

if [ -z "$code" ]; then
  echo "!! migrate printed no setup code"
  "${COMPOSE[@]}" logs migrate | tail -30
  exit 1
fi

echo "==> Running the first-run browser test"
mkdir -p tests/e2e/screenshots

docker run --rm --network host --ipc host \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  -e UI_BASE="http://localhost:${TEST_UI_PORT}" \
  -e API_BASE="http://localhost:${TEST_KONG_PORT}/api" \
  -e SETUP_CODE="$code" \
  -v "$PWD/tests/e2e":/e2e -w /e2e \
  "$PLAYWRIGHT_IMAGE" \
  sh -c 'npm ci --no-audit --no-fund --loglevel=error && npx playwright test --config playwright.first-run.config.js'
status=$?

echo "==> Screenshots: tests/e2e/screenshots (setup-*)"
exit "$status"
