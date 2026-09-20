# varsiko-2.0

Nasiko-native agents for Severance. They run as Docker containers on the Nasiko control plane (A2A), not as AWS Bedrock agents.

- Agent 01 — The Surveyor: [`agents/severance/surveyor`](agents/severance/surveyor)
- Agent 02 — The Broker: [`agents/severance/broker`](agents/severance/broker)
- Agent 03 — The Porter: [`agents/severance/porter`](agents/severance/porter)
- Agent 04 — The Pilot: [`agents/severance/pilot`](agents/severance/pilot) (A2A agent + operator CLI + MCP mandate gateway)

## Where they run

Nasiko is the host. Locally that is `http://localhost:8080` with `AGENT_RUNTIME=docker`. Each agent is a container Nasiko builds from `AgentCard.json` + `Dockerfile`.

There is **one** workflow, `severance-pipeline` (Surveyor → Porter → Broker → Pilot). Porter dry-runs a rewrite; Pilot parks on a cart mandate and does not complete a purchase inside the MAF hop.

## Demo UI

With Nasiko up and the agents deployed:

```sh
./agents/severance/deploy-nasiko.sh
python3 ui/serve.py
```

Open [http://127.0.0.1:8788](http://127.0.0.1:8788), paste a GitHub URL. The page calls Nasiko A2A (`/api/orchestrator/a2a`) so traces show up under Sessions. The form injects a default ceiling of ₹1500; Surveyor still never infers one.

Shopping/survey data still uses offline fixtures by default (`SURVEYOR_OFFLINE=1`, `BROKER_OFFLINE=1`, `PORTER_OFFLINE=1`, `PILOT_OFFLINE=1`). The Surveyor and Broker narrators call OpenAI: put `OPENAI_API_KEY` in `agents/severance/broker/.env` (gitignored). `./agents/severance/deploy-nasiko.sh` refuses to upload without it.

## Local agent loops

```sh
# Surveyor / Broker
cd agents/severance/surveyor && PYTHONPATH=src python -m pytest
cd agents/severance/broker && PYTHONPATH=src python -m pytest

# Porter
cd agents/severance/porter && npm test && npm run demo

# Pilot (runbook + gateway CLIs)
cd agents/severance/pilot && npm test && npm run pilot
```
