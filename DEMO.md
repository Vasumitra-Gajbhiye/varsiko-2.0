# Demo runbook

For whoever is driving the laptop on the day. Everything below runs against a real
local Nasiko; there is no staged mode to fall into by accident.

## Before the room

You need Docker, and Nasiko running at `http://localhost:8080` with
`AGENT_RUNTIME=docker`.

```sh
cd ../nasiko && cp .env.example .env && docker compose up -d
# wait for http://localhost:8080 to answer
```

Then put two keys in `agents/severance/broker/.env` (gitignored, created for you on
first deploy):

```
OPENAI_API_KEY=sk-...        # required; deploy refuses without it
ANAKIN_API_KEY=...           # present -> live vendor pricing; absent -> fixtures
```

Deploy and start the UI:

```sh
./agents/severance/deploy-nasiko.sh     # prints "anakin: live" or "NO KEY -- fixtures only"
python3 ui/serve.py                     # reads ui/.env automatically
```

Open <http://127.0.0.1:8788>. The pill in the top right must read **Nasiko · 4
agents** in green before you start. If it says unreachable, nothing else matters —
fix that first.

## The three beats

1. **Paste the repo, set the ceiling.** Keep the ceiling at ₹4200. Surveyor,
   Porter and Broker light up in order; the activity panel on the right is the
   real A2A status stream, not a progress animation.
2. **Choose a server.** Two or three vendors will have cleared the bar and one or
   two will have been refused, with the Broker's reason in plain words. Pick the
   one that is *not* marked "Best value" — that is the moment worth showing,
   because the mandate that gets signed is for the plan you clicked.
3. **Authorise.** The receipt shows `approved by: human`, the HMAC signature, the
   headroom left under your ceiling, and `committed spend: $0`.

## The line that lands

> Nothing here is a mock-up. The UI never writes an approval. It sends `CHOOSE` and
> `APPROVE` to the Broker on Nasiko, the Broker re-checks the plan against the same
> ceiling and signs it, and the Pilot verifies that signature before it parks.

## Things worth showing on Nasiko itself

Every agent id in the "Nasiko control plane" card links to that agent's session.
Open one mid-demo and show the same A2A trace from the control plane side. The
footer links to Sessions and the `severance-pipeline` workflow.

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Pill says "Nasiko unreachable" | control plane down | `docker compose up -d` in the nasiko checkout |
| "severance-surveyor / severance-broker not found" | agents not deployed | re-run `deploy-nasiko.sh` |
| Every card says `fixture-fallback` | no/invalid `ANAKIN_API_KEY`, or Anakin rate-limited | still a valid demo — say the prices are pinned; do not claim they are live |
| "No shopping result in this session" on Authorise | Broker container restarted between the two steps | survey again; the gate is in-memory per container |
| Only one plan to choose from | ceiling too low for a second vendor | raise the budget and survey again |

The Broker parks its mandate in the container's memory keyed by A2A context id, so
run **one** Broker replica. Two replicas will lose the gate between `CHOOSE` and
`APPROVE`.

## Prompt for Claude Code on the demo machine

Paste this into Claude Code in the `varsiko-2.0` checkout on the Docker box:

> Bring up the Severance demo and verify it end to end against the real local
> Nasiko. Steps:
>
> 1. Confirm Docker is running and Nasiko answers at `http://localhost:8080`. If it
>    does not, start it from the sibling `nasiko` checkout with `docker compose up -d`
>    and wait for it.
> 2. Confirm `agents/severance/broker/.env` has a non-empty `OPENAI_API_KEY` and
>    `ANAKIN_API_KEY`. Do not print either value.
> 3. Run `./agents/severance/deploy-nasiko.sh`. It must reach "anakin: live" and all
>    four builds must poll to success. If a build fails, show me its log and stop.
> 4. Start `python3 ui/serve.py` in the background and check
>    `curl -s http://127.0.0.1:8788/api/nasiko` reports `reachable: true` with four
>    severance agents.
> 5. Drive the real pipeline over HTTP, not the browser:
>    - `POST /api/survey/stream` with
>      `{"repo":"https://github.com/<a real public Next.js repo>","ceiling":4200}`
>    - From the `done` frame, report: how many choices came back, each one's
>      `discovered_via` (I need to know if Anakin actually went live), and every
>      rejection with its reason.
>    - `POST /api/authorize/stream` with that `run_id` and the provider/plan_sku of a
>      choice that is **not** `recommended`.
>    - Confirm the returned mandate's `decision.provider` matches what you asked
>      for, `approval.approver` is `human`, a `signature.value` is present, and the
>      pilot run reports `cost_committed_usd: 0`.
> 6. Then try to authorise a plan that run refused, and confirm it is rejected.
>
> Report exactly what happened, including anything that came back as
> `fixture-fallback` rather than `anakin-search`. Do not change any code to make a
> step pass — if something genuinely fails, tell me what and why.
