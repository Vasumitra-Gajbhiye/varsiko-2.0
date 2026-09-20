import asyncio

from agent import SurveyorAgent


def test_openai_key_selects_openai_client(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    agent = SurveyorAgent()
    assert agent._openai is not None
    assert agent._anthropic is None
    assert agent.model == "gpt-4o-mini"


def test_missing_keys_do_not_invent_a_client(monkeypatch):
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    agent = SurveyorAgent()
    assert agent._openai is None
    assert agent._anthropic is None


def test_narrate_without_client_returns_facts(monkeypatch):
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    agent = SurveyorAgent()
    assert asyncio.run(agent.narrate("survey this", "static-only")) == "static-only"
