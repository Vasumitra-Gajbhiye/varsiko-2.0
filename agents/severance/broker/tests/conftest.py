import os

os.environ.setdefault("BROKER_OFFLINE", "1")
os.environ.setdefault("MANDATE_SIGNING_SECRET", "aa" * 32)
os.environ.setdefault("FX_EUR_INR", "94.2")
os.environ.setdefault("FX_USD_INR", "83.0")
os.environ.setdefault("FX_PINNED_AT", "2026-09-20T12:00:00Z")
os.environ.setdefault("MANDATE_TTL_SECONDS", "900")

from pathlib import Path

import pytest

from broker.contracts import parse_capacity_spec
from broker.fixture_store import fixture_dir


@pytest.fixture
def spec():
    return parse_capacity_spec((fixture_dir() / "spec_valid.json").read_text())


@pytest.fixture
def secret():
    return os.environ["MANDATE_SIGNING_SECRET"]


@pytest.fixture
def tests_fixtures() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def no_sleep(monkeypatch):
    import time

    monkeypatch.setattr(time, "sleep", lambda *_: None)
