"""Strip secrets from JSON, logs, and exception text. Env inventory is keys only."""

from __future__ import annotations

import json
import re
from typing import Any

TOKEN_RES = [
    re.compile(r"vercel_[A-Za-z0-9_]{16,}", re.IGNORECASE),
    re.compile(r"github_pat_[A-Za-z0-9_]{16,}"),
    re.compile(r"ghp_[A-Za-z0-9]{16,}"),
    re.compile(r"gho_[A-Za-z0-9]{16,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)(vercel_token|github_token|authorization)\s*[:=]\s*\S+"),
]

CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def looks_like_secret(text: str) -> bool:
    if not text:
        return False
    return any(p.search(text) for p in TOKEN_RES)


def redact_text(text: str) -> str:
    if not text:
        return text
    out = text
    for pat in TOKEN_RES:
        out = pat.sub("[REDACTED]", out)
    return out


def sanitize_snippet(text: str, limit: int = 80) -> str:
    cleaned = CONTROL_RE.sub("", text or "").replace("\n", " ").strip()
    if len(cleaned) > limit:
        cleaned = cleaned[: limit - 1] + "…"
    return cleaned


def redact_obj(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {str(k): redact_obj(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_obj(v) for v in value]
    return value


def redact_json(value: Any) -> str:
    return json.dumps(redact_obj(value), default=str)
