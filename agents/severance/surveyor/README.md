# Severance Surveyor (Agent 01)

Give it a GitHub link. It finds the live Vercel project, inventories lock-in, derives a capacity spec, and writes **one** `severance.capacity_spec/v1` JSON file. It is read-only. It cannot spend, deploy, or run the target repo.

> The LLM narrates. Code decides.

The ceiling is **never** inferred. Missing `ceiling_inr_monthly` parks the task in `input-required`.

## Layout

`agents/severance/surveyor/` — identity is `AgentCard.json` `name`: **severance-surveyor**.

Pure modules (no network, no LLM): `intake.py`, `lockin_scan.py`, `capacity.py`, `cost.py`, `predict.py`, `verdict.py`, `emit.py`.

## Config

Copy `.env.example` to `.env`. The ceiling is **not** configured here — it arrives in the message.

| Name | What |
|---|---|
| `VERCEL_TOKEN` | Read-only Vercel token. Prefer Billing/Viewer. |
| `GITHUB_TOKEN` | Private repos only. Public tarballs work without it. |
| `FX_USD_INR` / `FX_PINNED_AT` | Pinned FX. Same as the Broker. |
| `SURVEYOR_OFFLINE=1` | Skip live APIs; use fixtures. |
| `OPENAI_API_KEY` | Required. Official OpenAI key (`sk-…`). Narrator uses `gpt-4o-mini` unless `MODEL` is set. |
| `OPENAI_BASE_URL` | Default `https://api.openai.com/v1`. |

### Secrets on the cluster

```sh
nasiko secrets set VERCEL_TOKEN  <token>  --agent severance-surveyor
nasiko secrets set GITHUB_TOKEN  <token>  --agent severance-surveyor
nasiko restart severance-surveyor
```

The deployed container does **not** inherit your local `.env`. If a token is pasted in chat, the agent refuses it.

Constants in `surveyor.method.constants` are heuristics. A failed Auditor load test invalidates a named assumption, not a vibe.

## Local loop

```sh
cd agents/severance/surveyor
python -m pytest tests/ -q
PYTHONPATH=src python src/__main__.py --host 127.0.0.1 --port 8000
```

Paste a GitHub URL plus a ceiling, or send JSON. Missing ceiling parks the task; resume on the same `contextId`.

## Modes

| Mode | When |
|---|---|
| `live` | Project resolved, metrics + billing available |
| `live-no-observability` | Billing OK, metrics 403 |
| `static-only` | No Vercel token / repo not linked |
| `needs-input` | Ceiling missing or ambiguous project |
