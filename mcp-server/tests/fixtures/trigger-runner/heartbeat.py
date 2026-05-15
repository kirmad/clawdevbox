import json, os, sys, urllib.request

env = json.loads(sys.stdin.read())
secret = os.environ.get("CLAWDEVBOX_MCP_SECRET", "")
req = urllib.request.Request(
    env["callback_url"],
    data=json.dumps({"prompt": "python tick", "context": {"run_id": env["run_id"]}}).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
    method="POST",
)
with urllib.request.urlopen(req) as r:
    if r.status != 200:
        sys.stderr.write(f"status {r.status}\n"); sys.exit(1)
sys.stdout.write(json.dumps({"state": {"python": True}}))
