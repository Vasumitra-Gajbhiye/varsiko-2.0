"""Parse a Surveyor request. Regex, not the LLM. Never infer a ceiling."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from typing import Any

from surveyor.redact import looks_like_secret, redact_text

GITHUB_RE = re.compile(
    r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:\.git)?"
    r"(?:/tree/([^/\s]+)(?:/(\S+))?)?",
    re.IGNORECASE,
)
CEILING_KEY_RE = re.compile(
    r"ceiling_inr_monthly\s*[:=]\s*(\d+)",
    re.IGNORECASE,
)
CEILING_WORD_RE = re.compile(
    r"(?:ceiling|budget|cap)\s*(?:of|is|=|:)?\s*(?:₹|inr\s*)?(\d{3,})",
    re.IGNORECASE,
)
RUPEE_RE = re.compile(r"₹\s*(\d{3,})")
BARE_INT_RE = re.compile(r"^\s*(\d{3,6})\s*$")
VERCEL_PROJECT_RE = re.compile(r"vercel_project\s*[:=]\s*([A-Za-z0-9_-]+)", re.IGNORECASE)
VERCEL_TEAM_RE = re.compile(r"vercel_team\s*[:=]\s*([A-Za-z0-9_-]+)", re.IGNORECASE)
JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


@dataclass
class Intake:
    repo_url: str | None = None
    owner: str | None = None
    name: str | None = None
    ref: str | None = None
    subdir: str | None = None
    ceiling_inr_monthly: int | None = None
    region_allowlist: list[str] | None = None
    region_source: str = "user"
    vercel_team: str | None = None
    vercel_project: str | None = None
    window_days: int = 14
    pasted_secret: bool = False
    raw_text: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def repo_slug(self) -> str | None:
        if self.owner and self.name:
            return f"{self.owner}/{self.name}"
        return None


def _load_json_blob(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if not stripped:
        return None
    try:
        data = json.loads(stripped)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        match = JSON_OBJECT_RE.search(stripped)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None


def parse_intake(text: str, *, allow_bare_ceiling: bool = False) -> Intake:
    raw = text or ""
    pasted = looks_like_secret(raw)
    safe = redact_text(raw) if pasted else raw
    intake = Intake(raw_text=safe, pasted_secret=pasted)
    if pasted:
        return intake

    blob = _load_json_blob(raw)
    if blob:
        _apply_json(intake, blob)

    match = GITHUB_RE.search(raw)
    if match and not intake.repo_url:
        owner, name, ref, subdir = match.groups()
        name = name.rstrip("./")
        if name.endswith(".git"):
            name = name[:-4]
        intake.owner = owner
        intake.name = name
        intake.ref = ref
        intake.subdir = subdir
        intake.repo_url = f"https://github.com/{owner}/{name}"

    if intake.ceiling_inr_monthly is None:
        key = CEILING_KEY_RE.search(raw)
        word = CEILING_WORD_RE.search(raw)
        if key:
            intake.ceiling_inr_monthly = int(key.group(1))
        elif word:
            intake.ceiling_inr_monthly = int(word.group(1))
        elif allow_bare_ceiling:
            bare = BARE_INT_RE.match(raw)
            if bare:
                intake.ceiling_inr_monthly = int(bare.group(1))

    if not intake.vercel_project:
        proj = VERCEL_PROJECT_RE.search(raw)
        if proj:
            intake.vercel_project = proj.group(1)
    if not intake.vercel_team:
        team = VERCEL_TEAM_RE.search(raw)
        if team:
            intake.vercel_team = team.group(1)

    return intake


def merge_intake(base: Intake, update: Intake) -> Intake:
    merged = replace(base)
    if update.pasted_secret:
        merged.pasted_secret = True
        return merged
    if update.repo_url:
        merged.repo_url = update.repo_url
        merged.owner = update.owner
        merged.name = update.name
        merged.ref = update.ref or merged.ref
        merged.subdir = update.subdir or merged.subdir
    if update.ceiling_inr_monthly is not None:
        merged.ceiling_inr_monthly = update.ceiling_inr_monthly
    if update.region_allowlist:
        merged.region_allowlist = update.region_allowlist
        merged.region_source = "user"
    if update.vercel_team:
        merged.vercel_team = update.vercel_team
    if update.vercel_project:
        merged.vercel_project = update.vercel_project
    if update.window_days != 14:
        merged.window_days = update.window_days
    return merged


def looks_like_survey(text: str) -> bool:
    if not text:
        return False
    if looks_like_secret(text):
        return True
    if GITHUB_RE.search(text):
        return True
    blob = _load_json_blob(text)
    if blob and (blob.get("repo") or blob.get("repo_url")):
        return True
    return False


def _apply_json(intake: Intake, blob: dict[str, Any]) -> None:
    repo = blob.get("repo") or blob.get("repo_url")
    if isinstance(repo, str) and repo:
        nested = parse_intake(repo)
        if nested.repo_url:
            intake.repo_url = nested.repo_url
            intake.owner = nested.owner
            intake.name = nested.name
            intake.ref = nested.ref
            intake.subdir = nested.subdir
    if blob.get("ceiling_inr_monthly") is not None:
        intake.ceiling_inr_monthly = int(blob["ceiling_inr_monthly"])
    constraints = blob.get("constraints")
    if isinstance(constraints, dict) and constraints.get("ceiling_inr_monthly") is not None:
        intake.ceiling_inr_monthly = int(constraints["ceiling_inr_monthly"])
        allow = constraints.get("region_allowlist")
        if isinstance(allow, list) and allow:
            intake.region_allowlist = [str(x) for x in allow]
            intake.region_source = "user"
    allow = blob.get("region_allowlist")
    if isinstance(allow, list) and allow:
        intake.region_allowlist = [str(x) for x in allow]
        intake.region_source = "user"
    if blob.get("vercel_team"):
        intake.vercel_team = str(blob["vercel_team"])
    if blob.get("vercel_project"):
        intake.vercel_project = str(blob["vercel_project"])
    if blob.get("window_days"):
        intake.window_days = int(blob["window_days"])
    if blob.get("ref"):
        intake.ref = str(blob["ref"])
