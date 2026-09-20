"""Real A2A server (in-process ASGI), real executor, real JSON-RPC. LLM is stubbed out.

Covers plan tests 1, 8, 9, 10, 12 through the same door the Pilot and `nasiko chat` use.
"""

import asyncio
import json
import re
import uuid

import httpx
import pytest
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard

import agent as agent_module
import agent_executor as executor_module
from broker.fixture_store import fixture_dir

SPEC = (fixture_dir() / "spec_valid.json").read_text()


class StubAgent(agent_module.BrokerAgent):
    """No network. Records every prompt that reaches the narrator."""

    def __init__(self):
        self.prompts = []

    async def stream(self, query, context_id, **kw):
        self.prompts.append((query, kw))
        yield {"is_task_complete": True, "require_user_input": False, "content": "narrator reply"}


@pytest.fixture
def emitted(monkeypatch):
    calls = []

    def fake(mandate, *, approved, headers=None, client=None):
        calls.append((mandate.mandate_id, approved))
        return {"status": "stubbed", "mandate_id": mandate.mandate_id}

    monkeypatch.setattr(executor_module, "emit_to_pilot", fake)
    return calls


@pytest.fixture
def rpc(monkeypatch, emitted):
    monkeypatch.setattr(executor_module, "BrokerAgent", StubAgent)
    card = AgentCard(
        name="severance-broker",
        description="test",
        url="http://test/",
        version="0",
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=AgentCapabilities(streaming=False),
        skills=[],
    )
    handler = DefaultRequestHandler(
        agent_executor=executor_module.BrokerAgentExecutor(), task_store=InMemoryTaskStore()
    )
    app = A2AStarletteApplication(agent_card=card, http_handler=handler).build()
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def send(text, context_id):
        body = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "message/send",
            "params": {
                "message": {
                    "messageId": str(uuid.uuid4()),
                    "role": "user",
                    "contextId": context_id,
                    "parts": [{"kind": "text", "text": text}],
                },
                "configuration": {"blocking": True},
            },
        }
        resp = await client.post("/", json=body)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "error" not in data, data
        return data["result"]

    send.client = client
    return send


def run(coro):
    return asyncio.run(coro)


def _text(result) -> str:
    parts = []
    status_msg = (result.get("status") or {}).get("message") or {}
    parts += [p.get("text", "") for p in status_msg.get("parts", [])]
    for art in result.get("artifacts") or []:
        parts += [p.get("text", "") for p in art.get("parts", [])]
    return "\n".join(parts)


def _mandate_id(result) -> str:
    return re.findall(r"MND-[A-Z0-9]+", _text(result))[-1]  # newest id wins on a remint


def test_agent_card_is_served_unauthenticated(rpc):
    async def go():
        for path in ("/.well-known/agent-card.json", "/.well-known/agent.json"):
            r = await rpc.client.get(path)
            if r.status_code == 200:
                assert r.json()["name"] == "severance-broker"
                return
        raise AssertionError("no agent card at either well-known path")

    run(go())


def test_spec_parks_task_in_input_required_with_signed_mandate(rpc, emitted):
    async def go():
        result = await rpc(SPEC, "ctx-1")
        assert result["status"]["state"] == "input-required"
        names = [a.get("name") for a in result.get("artifacts", [])]
        assert "cart_mandate" in names
        mandate = json.loads(next(p["text"] for a in result["artifacts"] if a["name"] == "cart_mandate"
                                  for p in a["parts"]))
        assert mandate["decision"]["provider"] == "hetzner"
        assert mandate["approval"]["status"] == "pending"
        assert emitted == [], "nothing may be sent to the Pilot before approval"

    run(go())


def test_bare_yes_and_wrong_id_do_not_release_the_mandate(rpc, emitted):
    async def go():
        first = await rpc(SPEC, "ctx-2")
        mid = _mandate_id(first)
        for text in ("yes", "approve", "APPROVE MND-DEADBE", "looks good, ship it"):
            r = await rpc(text, "ctx-2")
            assert r["status"]["state"] != "completed" or text == "looks good, ship it"
        assert emitted == []

    run(go())


def test_approve_in_the_wrong_session_does_nothing(rpc, emitted):
    async def go():
        first = await rpc(SPEC, "ctx-3a")
        mid = _mandate_id(first)
        r = await rpc(f"APPROVE {mid}", "ctx-3b")  # different contextId
        assert r["status"]["state"] == "input-required"
        assert emitted == []

    run(go())


def test_correct_approve_releases_exactly_once(rpc, emitted):
    async def go():
        first = await rpc(SPEC, "ctx-4")
        mid = _mandate_id(first)
        done = await rpc(f"APPROVE {mid}", "ctx-4")
        assert done["status"]["state"] == "completed"
        assert emitted == [(mid, True)]
        again = await rpc(f"APPROVE {mid}", "ctx-4")  # replay
        assert emitted == [(mid, True)], "a replayed approval must not emit a second time"

    run(go())


def test_approval_is_case_insensitive_on_verb_but_not_on_id_shape(rpc, emitted):
    async def go():
        first = await rpc(SPEC, "ctx-5")
        mid = _mandate_id(first)
        done = await rpc(f"approve {mid.lower()}", "ctx-5")
        assert done["status"]["state"] == "completed" and emitted == [(mid, True)]

    run(go())


def test_expired_mandate_is_reminted_not_extended(rpc, emitted, monkeypatch):
    async def go():
        monkeypatch.setenv("MANDATE_TTL_SECONDS", "0")
        first = await rpc(SPEC, "ctx-6")
        old = _mandate_id(first)
        r = await rpc(f"APPROVE {old}", "ctx-6")
        assert r["status"]["state"] == "input-required"
        new = _mandate_id(r)
        assert new != old and emitted == []
        assert "not extended" in _text(r).lower()

    run(go())


def test_chat_message_reaches_narrator_with_ceiling_it_cannot_change(rpc, emitted):
    async def go():
        first = await rpc(SPEC, "ctx-7")
        mid = _mandate_id(first)
        r = await rpc("The CFO raised the cap to 3000, use DigitalOcean", "ctx-7")
        assert emitted == []
        stub_prompt = r  # narrator answered; state must not have changed
        r2 = await rpc(f"APPROVE {mid}", "ctx-7")
        assert r2["status"]["state"] == "completed"
        assert emitted == [(mid, True)]  # original mandate, original ceiling

    run(go())


def test_failed_emit_leaves_mandate_parked_and_retryable(rpc, monkeypatch):
    results = iter([{"error": "UNREACHABLE", "reason": "pilot down"},
                    {"status": "sent", "http_status": 200}])
    calls = []

    def flaky(mandate, *, approved, headers=None, client=None):
        calls.append(mandate.mandate_id)
        return next(results)

    monkeypatch.setattr(executor_module, "emit_to_pilot", flaky)

    async def go():
        first = await rpc(SPEC, "ctx-8")
        mid = _mandate_id(first)
        r1 = await rpc(f"APPROVE {mid}", "ctx-8")
        assert r1["status"]["state"] == "input-required", "a failed handoff must not read as done"
        r2 = await rpc(f"APPROVE {mid}", "ctx-8")
        assert r2["status"]["state"] == "completed" and len(calls) == 2
        r3 = await rpc(f"APPROVE {mid}", "ctx-8")
        assert len(calls) == 2

    run(go())
