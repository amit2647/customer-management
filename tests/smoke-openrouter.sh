#!/usr/bin/env bash
#
# MANUAL ONLY — never run in CI. Asks the REAL model one question through your
# running dev stack, to check the configured OpenRouter model still calls
# tools properly. Spends a small amount of OpenRouter credit.
#
# Everything else in the test suite uses the scripted fake model, so this is
# the one check of real model behaviour. Run it after changing
# OPENROUTER_MODEL, or before a release.
#
#   tests/smoke-openrouter.sh
#   ADMIN_EMAIL=... ADMIN_PASSWORD=... tests/smoke-openrouter.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

API="${API_BASE:-http://localhost:${KONG_HOST_PORT:-8080}/api}"
# No built-in login: pass one, or set BOOTSTRAP_ADMIN_* in .env.
env_value() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }
EMAIL="${ADMIN_EMAIL:-$(env_value BOOTSTRAP_ADMIN_EMAIL)}"
PASSWORD="${ADMIN_PASSWORD:-$(env_value BOOTSTRAP_ADMIN_PASSWORD)}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "Set ADMIN_EMAIL and ADMIN_PASSWORD (an admin of the dev stack)." >&2
  exit 1
fi

token=$(curl -sf -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

conversation=$(python3 -c 'import uuid;print(uuid.uuid4())')
message=$(python3 -c 'import uuid;print(uuid.uuid4())')

echo "==> Asking the real model: How many leads do I have?"
reply=$(curl -s -X POST "$API/assistant/conversations/$conversation/messages" \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  -d "{\"clientMessageId\":\"$message\",\"content\":\"How many leads do I have? Answer with the number.\"}")

answer=$(echo "$reply" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("error") or d["messages"][-1]["content"])')
echo "    $answer"

# Did the model actually fetch the data, or answer from nothing?
used=$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$0"' \
  "SELECT count(*) FROM assistant_messages, jsonb_array_elements(tool_calls) c
    WHERE conversation_id = '$conversation' AND c->'function'->>'name' = 'list_leads'")

curl -s -o /dev/null -X DELETE "$API/assistant/conversations/$conversation" -H "Authorization: Bearer $token"

if [ "$used" -ge 1 ]; then
  echo "==> OK: the model called list_leads before answering"
else
  echo "!! The model answered without calling list_leads — check OPENROUTER_MODEL"
  exit 1
fi
