#!/usr/bin/env bash
# Captures the actual stdin envelope sent to the trigger script and the actual
# stdout it returns. Uses real ADO credentials from test-config.json.
set -euo pipefail
cd "$(dirname "$0")"

PR_ID=$(python3 -c "import json;print(json.load(open('test-config.json'))['pr_id'])")
REPO=$(python3 -c "import json;print(json.load(open('test-config.json'))['repo'])")
ORG_FULL=$(python3 -c "import json;print(json.load(open('test-config.json'))['trigger_ado_org'])")
TOKEN=$(python3 -c "import json;print(json.load(open('test-config.json'))['ado_bearer_token'])")
USER=$(python3 -c "import json;print(json.load(open('test-config.json'))['az_user'])")

ENVELOPE=$(python3 - <<EOF
import json, os, time
print(json.dumps({
  "trigger_event_name": "TriggerFired",
  "trigger_id": "demo-capture",
  "run_id": f"capture-{int(time.time())}",
  "fired_by": "cron",
  "fired_at": int(time.time() * 1000),
  "cwd": os.getcwd(),
  "project_dir": os.getcwd(),
  "trigger_data_dir": os.path.join(os.getcwd(), ".clawdevbox/triggers/demo-capture/data"),
  "subscriber_thread_id": "thr_DEMO",
  "callback_url": "http://localhost:5201/callback/threads/thr_DEMO/resume",
  "state": {
    "prId": $PR_ID,
    "repo": "$REPO",
    "lastCommentId": 0,
    "selfUser": "$USER"
  },
  "payload": None
}, indent=2))
EOF
)

echo "================ STDIN (envelope to script) ================"
echo "$ENVELOPE"
echo ""
echo "================ STDOUT (response from script) ================"
echo "$ENVELOPE" | \
  ADO_ORG="$ORG_FULL" \
  ADO_BEARER_TOKEN="$TOKEN" \
  npx --yes tsx ../ado-comment-watcher.ts | python3 -m json.tool

echo ""
echo "================ STDERR (any errors) ================"
# rerun and capture stderr separately so we don't merge it into stdout above
echo "$ENVELOPE" | \
  ADO_ORG="$ORG_FULL" \
  ADO_BEARER_TOKEN="$TOKEN" \
  npx --yes tsx ../ado-comment-watcher.ts 2>&1 1>/dev/null || true
