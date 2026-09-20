"""capacity_spec/v1 extras. Runtime does not import the Broker; tests do."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


SCHEMA_SPEC = "severance.capacity_spec/v1"
MUST_SUPPORT = ("docker", "cloud-init", "ipv4")
VERDICTS = ("PROCEED", "PROCEED_WITH_PORTER", "BLOCKED", "NEEDS_INPUT")
BLOCKERS = (
    "UNSUPPORTED_FRAMEWORK",
    "VERCEL_ONLY_PRODUCT",
    "NO_VERCEL_ACCESS",
    "REPO_TOO_LARGE",
)


class SpecError(Exception):
    def __init__(self, code: str, message: str, field: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.field = field

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"error": self.code, "message": self.message}
        if self.field:
            out["field"] = self.field
        return out


class CurrentCost(BaseModel):
    model_config = ConfigDict(extra="allow")

    monthly_inr: int
    billing_currency: str
    evidence: str
    usd: float | None = None
    fx_usd_inr: float | None = None
    fx_pinned_at: str | None = None
    includes_seats: bool = False


class Capacity(BaseModel):
    model_config = ConfigDict(extra="allow")

    vcpu: int
    ram_gb: int
    disk_gb: int
    egress_tb: float
    headroom_factor: float = 1.5
    derived_from: str = ""


class SpecFloor(BaseModel):
    vcpu: int
    ram_gb: int
    disk_gb: int
    egress_tb: float = 0


class Constraints(BaseModel):
    model_config = ConfigDict(extra="allow")

    ceiling_inr_monthly: int | None = None
    region_allowlist: list[str] = Field(default_factory=list)
    spec_floor: SpecFloor
    must_support: list[str] = Field(default_factory=lambda: list(MUST_SUPPORT))


class LockinFeature(BaseModel):
    feature: str
    breaks_on_selfhost: bool = False


class EvidenceHit(BaseModel):
    file: str
    line: int
    rule: str
    match: str


class LockinDetail(BaseModel):
    model_config = ConfigDict(extra="allow")

    feature: str
    severity: str
    breaks_on_selfhost: bool
    evidence: list[EvidenceHit] = Field(default_factory=list)
    env_corroboration: list[str] = Field(default_factory=list)
    porter_hint: str = ""
    capacity_impact: dict[str, Any] | None = None


class DecisionBlock(BaseModel):
    verdict: Literal["PROCEED", "PROCEED_WITH_PORTER", "BLOCKED", "NEEDS_INPUT"]
    blockers: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    confidence: dict[str, str] = Field(default_factory=dict)


class Predictions(BaseModel):
    model_config = ConfigDict(extra="allow")

    committed_at: str
    prediction_hash: str
    load_profile: dict[str, Any]
    expected_on_floor_spec: dict[str, Any]
    falsifiers: list[str]


def canonical_dumps(obj: Any) -> str:
    def convert(value: Any) -> Any:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                value = value.replace(tzinfo=timezone.utc)
            return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if isinstance(value, BaseModel):
            return convert(value.model_dump(mode="json", by_alias=True))
        if isinstance(value, dict):
            return {str(k): convert(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [convert(v) for v in value]
        return value

    return json.dumps(convert(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_z(dt: datetime | None = None) -> str:
    value = dt or utc_now()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
