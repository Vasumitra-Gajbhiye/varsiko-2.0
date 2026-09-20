# varsiko-2.0

Nasiko-native agents for Severance. They run as Docker containers on the Nasiko control plane (A2A), not as AWS Bedrock agents.

- Agent 01 — The Surveyor: [`agents/severance/surveyor`](agents/severance/surveyor)
- Agent 02 — The Broker: [`agents/severance/broker`](agents/severance/broker)
- Agent 04 — The Pilot / Estimator / Gateway: [`src/`](src/) (operator CLI + MCP gateway)
- Later: Porter (rewrite for VPS) — extra step on the same workflow

## Where they run

Nasiko is the host. Locally that is `http://localhost:8080` with `AGENT_RUNTIME=docker`. Each agent is a container Nasiko builds from `AgentCard.json` + `Dockerfile`.

There is **one** workflow, `severance-pipeline` (Surveyor → Broker). Two agents do not mean two workflows.

## Demo UI

With Nasiko up and the agents deployed:

```sh
./agents/severance/deploy-nasiko.sh
python3 ui/serve.py
```

Open [http://127.0.0.1:8788](http://127.0.0.1:8788), paste a GitHub URL. The page calls Nasiko A2A (`/api/orchestrator/a2a`) so traces show up under Sessions. The form injects a default ceiling of ₹1500; Surveyor still never infers one.

Offline fixtures are on by default (`SURVEYOR_OFFLINE=1`, `BROKER_OFFLINE=1`).
