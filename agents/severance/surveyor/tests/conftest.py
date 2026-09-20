import os

os.environ.setdefault("SURVEYOR_OFFLINE", "1")
os.environ.setdefault("BROKER_OFFLINE", "1")
os.environ.setdefault("MANDATE_SIGNING_SECRET", "aa" * 32)
os.environ.setdefault("FX_USD_INR", "83.0")
os.environ.setdefault("FX_EUR_INR", "94.2")
os.environ.setdefault("FX_PINNED_AT", "2026-09-20T12:00:00Z")

from pathlib import Path

import pytest

from surveyor.fixture_store import fixture_dir, repo_fixture


@pytest.fixture
def fixtures() -> Path:
    return fixture_dir()


@pytest.fixture
def heavy() -> Path:
    return repo_fixture("lockin_heavy")


@pytest.fixture
def clean() -> Path:
    return repo_fixture("clean")


@pytest.fixture
def poisoned() -> Path:
    return repo_fixture("poisoned")
