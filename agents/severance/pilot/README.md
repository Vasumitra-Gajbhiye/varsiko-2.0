# Severance Pilot (Agent 04)

Executes **one** signed, human-approved migration mandate. Holds no provider credentials. Spend authority lives in the MCP mandate gateway (`npm run gateway`).

> Pilot decides nothing. The guard and the gateway enforce the mandate.

Identity is `AgentCard.json` `name`: **severance-pilot**.

## Layout

| Path | Role |
|---|---|
| `src/pilot/` | Mandate, ledger, guard, runbook, candidate routing |
| `src/gateway/` | MCP mandate gateway (separate process; holds keys) |
| `src/cli/` | Operator commands + demo harness |
| `src/agent/` | Nasiko A2A server (`run.start` / `run.poll` / `run.cutover` / `run.candidates`) |
| `tool-rules.json` | Per-agent MCP stances for connector `varsiko-mandate-gateway` |
| `cloud-init/coolify.yaml` | Pinned bootstrap template |

## Local loop

```sh
npm install
npm test
npm run typecheck
npm run pilot                 # 19 offline scenarios
PILOT_OFFLINE=1 npm start     # A2A on :8000
```

Operator path (needs `.env` from `.env.example`):

```sh
npm run keygen
npm run gateway
npm run mandate -- --server-type cpx31 --location nbg1 --repo owner/name \
  --vercel-project prj_x --domain app.example.com --max-monthly 30 --approved-by you@example.com
```

## Nasiko

Deploy via [`../deploy-nasiko.sh`](../deploy-nasiko.sh). Default env is `PILOT_OFFLINE=1` so the demo cannot spend. Cart mandates from Broker are HMAC-verified with the shared `MANDATE_SIGNING_SECRET`; Pilot parks until an Ed25519 spend mandate arrives (Pilot never holds that private key).
