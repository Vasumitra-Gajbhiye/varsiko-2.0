"""In-process A2A. LLM stubbed."""

import asyncio
import json
import uuid

import httpx
import pytest
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard

import agent as agent_module
import agent_executor as executor_module


class StubAgent(agent_module.SurveyorAgent):
    def __init__(self):
        self.prompts = []

    async def stream(self, query, context_id, **kw):
        self.prompts.append((query, kw))
        yield {"is_task_complete": True, "require_user_input": False, "content": "narrator reply"}


@pytest.fixture
def rpc(monkeypatch):
    monkeypatch.setattr(executor_module, "SurveyorAgent", StubAgent)
    card = AgentCard(
        name="severance-surveyor",
        description="test",
        url="http://test/",
        version="0",
        default_input_modes=["text"],
        default_output_modes=["text"],
        capabilities=AgentCapabilities(streaming=False),
        skills=[],
    )
    handler = DefaultRequestHandler(
        agent_executor=executor_module.SurveyorAgentExecutor(),
        task_store=InMemoryTaskStore(),
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


def _state(result) -> str:
    return (result.get("status") or {}).get("state")


def _text(result) -> str:
    parts = []
    status_msg = (result.get("status") or {}).get("message") or {}
    parts += [p.get("text", "") for p in status_msg.get("parts", [])]
    for art in result.get("artifacts") or []:
        parts += [p.get("text", "") for p in art.get("parts", [])]
    return "\n".join(parts)


def test_missing_ceiling_parks_and_resume_completes(rpc):
    async def go():
        first = await rpc("https://github.com/acme/victim-app", "ctx-ceil")
        assert _state(first) == "input-required"
        assert "never inferred" in _text(first).lower() or "ceiling" in _text(first).lower()
        done = await rpc("ceiling_inr_monthly: 1500", "ctx-ceil")
        assert _state(done) == "completed"
        names = [a.get("name") for a in done.get("artifacts") or []]
        assert "surveyor_result.json" in names

    run(go())


def test_ambiguous_project_parks_then_override(rpc):
    async def go():
        first = await rpc(
            "https://github.com/acme/ambiguous-app ceiling_inr_monthly: 1500",
            "ctx-amb",
        )
        assert _state(first) == "input-required"
        done = await rpc("vercel_project: prj_victim", "ctx-amb")
        assert _state(done) == "completed"

    run(go())


def test_full_survey_completes_with_artifact(rpc):
    async def go():
        result = await rpc(
            "https://github.com/acme/victim-app ceiling_inr_monthly: 1500",
            "ctx-full",
        )
        assert _state(result) == "completed"
        names = [a.get("name") for a in result.get("artifacts") or []]
        assert "surveyor_result.json" in names

    run(go())


def test_chat_without_repo_hits_narrator(rpc):
    async def go():
        result = await rpc("Did you buy it?", "ctx-chat")
        assert "narrator reply" in _text(result) or _state(result) == "completed"

    run(go())
