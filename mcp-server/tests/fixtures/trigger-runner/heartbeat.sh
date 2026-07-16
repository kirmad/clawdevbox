#!/usr/bin/env bash
set -euo pipefail
BODY=$(cat)
URL=$(printf '%s' "$BODY" | python -c "import sys,json; print(json.load(sys.stdin)['spawn_url'])")
RUN=$(printf '%s' "$BODY" | python -c "import sys,json; print(json.load(sys.stdin)['run_id'])")
curl -fsS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"bash tick\",\"context\":{\"run_id\":\"${RUN}\"}}" >/dev/null
echo '{"state":{"bash":true}}'
