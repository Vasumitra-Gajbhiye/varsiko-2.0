#!/usr/bin/env bash
# Upload Surveyor + Porter + Broker + Pilot to a running Nasiko control plane.
# Default: http://localhost:8080 with the compose bootstrap admin.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NASIKO_URL="${NASIKO_URL:-http://localhost:8080}"
NASIKO_USER="${NASIKO_USER:-admin}"
NASIKO_PASSWORD="${NASIKO_PASSWORD:-changeme}"
VERSION="${VERSION:-0.1.5}"

SURVEYOR_DIR="$ROOT/agents/severance/surveyor"
BROKER_DIR="$ROOT/agents/severance/broker"
PORTER_DIR="$ROOT/agents/severance/porter"
PILOT_DIR="$ROOT/agents/severance/pilot"
WORK="$ROOT/.nasiko-deploy"
mkdir -p "$WORK"

need() { command -v "$1" >/dev/null || { echo "need $1 on PATH"; exit 1; }; }
need curl
need zip
need python3

login() {
  curl -sS -X POST "$NASIKO_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$NASIKO_USER\",\"password\":\"$NASIKO_PASSWORD\"}"
}

zip_python_agent() {
  local dir="$1" out="$2"
  rm -f "$out"
  (
    cd "$dir"
    zip -qr "$out" AgentCard.json Dockerfile pyproject.toml skill.json src \
      -x '*.pyc' '*__pycache__*' '*.DS_Store'
  )
}

zip_porter() {
  local out="$1"
  rm -f "$out"
  (
    cd "$PORTER_DIR"
    zip -qr "$out" AgentCard.json Dockerfile skill.json package.json package-lock.json \
      tsconfig.json src templates fixtures \
      -x '*/node_modules/*' '*/dist/*' '*.DS_Store' 'fixtures/victim-app/node_modules/*'
  )
}

zip_pilot() {
  local out="$1"
  rm -f "$out"
  (
    cd "$PILOT_DIR"
    zip -qr "$out" AgentCard.json Dockerfile skill.json package.json package-lock.json \
      tsconfig.json src cloud-init \
      -x '*/node_modules/*' '*.DS_Store' 'test/*' 'tool-rules.json'
  )
}

upload() {
  local name="$1" zipfile="$2" envjson="$3"
  curl -sS -X POST "$NASIKO_URL/api/agents/upload" \
    -H "Authorization: Bearer $TOKEN" \
    -F "name=$name" \
    -F "version_tag=$VERSION" \
    -F "ports=8000" \
    -F "inbound_format=openai" \
    -F "env=$envjson" \
    -F "file=@$zipfile;type=application/zip"
}

poll_build() {
  local build_id="$1" label="$2"
  echo "waiting for $label build $build_id"
  for _ in $(seq 1 90); do
    body="$(curl -sS "$NASIKO_URL/api/builds/$build_id" -H "Authorization: Bearer $TOKEN" || true)"
    status="$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print((d.get("data") or d).get("status") or "")' <<<"$body")"
    echo "  $label: ${status:-unknown}"
    if [[ "$status" == "success" || "$status" == "succeeded" || "$status" == "completed" ]]; then
      return 0
    fi
    if [[ "$status" == "failed" || "$status" == "error" ]]; then
      echo "$body"
      return 1
    fi
    sleep 4
  done
  echo "timed out waiting for $label"
  echo "$body"
  return 1
}

echo "logging in to $NASIKO_URL as $NASIKO_USER"
LOGIN_JSON="$(login)"
TOKEN="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("token") or "")' <<<"$LOGIN_JSON")"
if [[ -z "$TOKEN" ]]; then
  echo "login failed: $LOGIN_JSON"
  exit 1
fi

if [[ ! -f "$BROKER_DIR/.env" ]]; then
  SIGNING="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  cat > "$BROKER_DIR/.env" <<EOF
BROKER_OFFLINE=1
FX_EUR_INR=94.2
FX_USD_INR=83.0
FX_PINNED_AT=2026-09-20T12:00:00Z
MANDATE_TTL_SECONDS=900
MANDATE_SIGNING_SECRET=$SIGNING
EOF
  echo "wrote $BROKER_DIR/.env (gitignored)"
fi

SIGNING="$(python3 -c '
from pathlib import Path
for line in Path("'"$BROKER_DIR"'/.env").read_text().splitlines():
    if line.startswith("MANDATE_SIGNING_SECRET="):
        print(line.split("=",1)[1]); break
')"

SURVEYOR_ENV='{"SURVEYOR_OFFLINE":"1","FX_USD_INR":"83.0","FX_PINNED_AT":"2026-09-20T12:00:00Z"}'
PORTER_ENV='{"PORTER_OFFLINE":"1"}'
BROKER_ENV="$(python3 -c 'import json; print(json.dumps({
  "BROKER_OFFLINE":"1",
  "FX_EUR_INR":"94.2",
  "FX_USD_INR":"83.0",
  "FX_PINNED_AT":"2026-09-20T12:00:00Z",
  "MANDATE_TTL_SECONDS":"900",
  "MANDATE_SIGNING_SECRET":"'"$SIGNING"'"
}))')"
PILOT_ENV="$(python3 -c 'import json; print(json.dumps({
  "PILOT_OFFLINE":"1",
  "MANDATE_SIGNING_SECRET":"'"$SIGNING"'",
  "DATA_DIR":"/tmp/pilot-data"
}))')"

echo "zipping agents"
zip_python_agent "$SURVEYOR_DIR" "$WORK/severance-surveyor.zip"
zip_porter "$WORK/severance-porter.zip"
zip_python_agent "$BROKER_DIR" "$WORK/severance-broker.zip"
zip_pilot "$WORK/severance-pilot.zip"

echo "uploading severance-surveyor"
SURVEYOR_UP="$(upload severance-surveyor "$WORK/severance-surveyor.zip" "$SURVEYOR_ENV")"
echo "$SURVEYOR_UP"
echo "uploading severance-porter"
PORTER_UP="$(upload severance-porter "$WORK/severance-porter.zip" "$PORTER_ENV")"
echo "$PORTER_UP"
echo "uploading severance-broker"
BROKER_UP="$(upload severance-broker "$WORK/severance-broker.zip" "$BROKER_ENV")"
echo "$BROKER_UP"
echo "uploading severance-pilot"
PILOT_UP="$(upload severance-pilot "$WORK/severance-pilot.zip" "$PILOT_ENV")"
echo "$PILOT_UP"

python3 - "$SURVEYOR_UP" "$PORTER_UP" "$BROKER_UP" "$PILOT_UP" "$WORK/ids.json" <<'PY'
import json, sys
from pathlib import Path

def ids(raw, label):
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{label} upload did not return JSON: {raw[:400]}") from e
    payload = d.get("data") or d
    if not isinstance(payload, dict) or not payload.get("build_id"):
        raise SystemExit(f"{label} upload failed: {raw[:400]}")
    return {
        "agent_id": payload.get("agent_id"),
        "build_id": payload.get("build_id"),
        "agent_name": payload.get("agent_name"),
        "status": payload.get("status"),
    }
out = {
    "surveyor": ids(sys.argv[1], "surveyor"),
    "porter": ids(sys.argv[2], "porter"),
    "broker": ids(sys.argv[3], "broker"),
    "pilot": ids(sys.argv[4], "pilot"),
}
Path(sys.argv[5]).write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=2))
PY

for label in surveyor porter broker pilot; do
  BUILD="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/ids.json"))["'"$label"'"]["build_id"] or "")')"
  [[ -n "$BUILD" ]] || { echo "upload did not return build id for $label"; exit 1; }
  poll_build "$BUILD" "$label"
done

SURVEYOR_ID="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/ids.json"))["surveyor"]["agent_id"])')"
PORTER_ID="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/ids.json"))["porter"]["agent_id"])')"
BROKER_ID="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/ids.json"))["broker"]["agent_id"])')"
PILOT_ID="$(python3 -c 'import json; print(json.load(open("'"$WORK"'/ids.json"))["pilot"]["agent_id"])')"

# Best-effort: publish Pilot tool-rules onto an existing mandate-gateway connector.
if [[ -f "$PILOT_DIR/tool-rules.json" ]]; then
  echo "best-effort: applying Pilot tool-rules to varsiko-mandate-gateway (ignored if connector missing)"
  python3 - "$NASIKO_URL" "$TOKEN" "$PILOT_ID" "$PILOT_DIR/tool-rules.json" <<'PY' || true
import json, sys, urllib.error, urllib.request
url, token, agent_id, rules_path = sys.argv[1:5]
rules = json.loads(open(rules_path).read())
connector = rules.get("varsiko-mandate-gateway")
if not isinstance(connector, dict):
    raise SystemExit(0)
body = json.dumps({"enabled": connector.get("enabled", True), "tool_rules": connector.get("tool_rules", [])}).encode()
for path in (
    f"/api/mcp/agents/{agent_id}/connectors/varsiko-mandate-gateway",
    f"/api/agents/{agent_id}/connectors/varsiko-mandate-gateway",
):
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=body,
        method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"tool-rules PUT {path}: {resp.status}")
            break
    except urllib.error.HTTPError as e:
        print(f"tool-rules PUT {path}: HTTP {e.code} (skipped)")
    except Exception as e:
        print(f"tool-rules PUT {path}: {e} (skipped)")
PY
fi

echo "upserting MAF workflow severance-pipeline"
MAF="$(python3 - "$NASIKO_URL" "$TOKEN" "$SURVEYOR_ID" "$PORTER_ID" "$BROKER_ID" "$PILOT_ID" "$WORK/ids.json" <<'PY'
import json, sys, urllib.request

url, token, surveyor_id, porter_id, broker_id, pilot_id, ids_path = sys.argv[1:8]
name = "severance-pipeline"
description = (
    "Surveyor sizes the job; Porter dry-runs a lock-in rewrite; Broker shops VPS plans; "
    "Pilot verifies a cart mandate and parks (no purchase in the MAF hop)."
)
steps_create = [
    {
        "task_description": (
            "Survey the GitHub repo, inventory Vercel lock-in, and emit severance.capacity_spec/v1. "
            "Never infer a ceiling."
        ),
        "agent_id": surveyor_id,
    },
    {
        "task_description": (
            "Given the Surveyor capacity spec, dry-run a Porter rewrite of Vercel lock-in. "
            "Emit severance.port_plan/v1 plus the forwarded spec. Do not push branches."
        ),
        "agent_id": porter_id,
    },
    {
        "task_description": (
            "Shop Hetzner/DigitalOcean/Vultr against the Surveyor spec and return ranked VPS "
            "suggestions with pricing-page links. Do not purchase."
        ),
        "agent_id": broker_id,
    },
    {
        "task_description": (
            "Accept a cart mandate or spend mandate. Verify, route the lane, and park. "
            "Do not complete a full migration in this hop (flow guard is 120s)."
        ),
        "agent_id": pilot_id,
    },
]
steps_update = [{**s, "step_index": i} for i, s in enumerate(steps_create)]


def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        url.rstrip("/") + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.loads(resp.read().decode())


def items(payload):
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, dict) and "data" in data:
        data = data["data"]
    if isinstance(data, list):
        return data
    return []


listed = req("GET", "/api/maf/workflows?limit=50")
existing = next((m for m in items(listed) if m.get("name") == name), None)
if existing:
    out = req(
        "PUT",
        f"/api/maf/workflow/{existing['id']}",
        {"name": name, "description": description, "steps": steps_update},
    )
else:
    out = req(
        "POST",
        "/api/maf/workflows",
        {"name": name, "description": description, "steps": steps_create},
    )
print(json.dumps(out, indent=2))
payload = out.get("data") or out
ids = json.loads(open(ids_path).read())
ids["maf"] = {"id": payload.get("id"), "name": payload.get("name")}
open(ids_path, "w").write(json.dumps(ids, indent=2) + "\n")
PY
)"
echo "$MAF"

echo
echo "dashboard: $NASIKO_URL"
echo "surveyor agent_id: $SURVEYOR_ID"
echo "porter agent_id:   $PORTER_ID"
echo "broker agent_id:   $BROKER_ID"
echo "pilot agent_id:    $PILOT_ID"
echo "ids written to $WORK/ids.json"
echo "note: set Broker PILOT_A2A_URL / PILOT_AGENT_ID after containers are reachable if emit_to_pilot should leave stub mode"
