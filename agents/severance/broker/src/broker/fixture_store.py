from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PACKAGE_FIXTURES = Path(__file__).parent / "fixtures"


def fixture_dir() -> Path:
    return PACKAGE_FIXTURES


def load_json(name: str, directory: Path | None = None) -> Any:
    path = (directory or fixture_dir()) / name
    return json.loads(path.read_text(encoding="utf-8"))


def load_text(name: str, directory: Path | None = None) -> str:
    path = (directory or fixture_dir()) / name
    return path.read_text(encoding="utf-8")


def write_json(name: str, data: Any, directory: Path | None = None) -> None:
    path = (directory or fixture_dir()) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
