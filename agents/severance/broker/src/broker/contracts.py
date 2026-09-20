"""capacity_spec/v1 and cart_mandate/v1. Constraints are not negotiable by the model."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError


SCHEMA_SPEC = "severance.capacity_spec/v1"
SCHEMA_MANDATE = "severance.cart_mandate/v1"
SIGNATURE_KID = "severance-2026"
SIGNATURE_ALG = "HMAC-SHA256"


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


class Capacity(BaseModel):
    model_config = ConfigDict(extra="allow")

    vcpu: int
    ram_gb: int
    disk_gb: int
    egress_tb: float
    headroom_factor: float = 1.0
    derived_from: str = ""


class SpecFloor(BaseModel):
    model_config = ConfigDict(extra="allow")

    vcpu: int
    ram_gb: int
    disk_gb: int
    egress_tb: float = 0


class Constraints(BaseModel):
    model_config = ConfigDict(extra="allow")

    ceiling_inr_monthly: int = Field(gt=0)
    region_allowlist: list[str] = Field(default_factory=list)
    spec_floor: SpecFloor
    must_support: list[str] = Field(default_factory=list)


class LockinFeature(BaseModel):
    feature: str
    breaks_on_selfhost: bool = False


class CapacitySpec(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_name: Literal["severance.capacity_spec/v1"] = Field(
        alias="schema", default=SCHEMA_SPEC
    )
    generated_at: str
    source_project: str
    current_cost: CurrentCost | None = None
    capacity: Capacity
    constraints: Constraints
    lockin_inventory: list[LockinFeature] = Field(default_factory=list)
    decision: dict[str, Any] | None = None

    def constraints_payload(self) -> dict[str, Any]:
        return self.constraints.model_dump(mode="json")


class ListedPrice(BaseModel):
    amount: float
    currency: str


class Decision(BaseModel):
    provider: str
    plan_sku: str
    region: str
    monthly_inr: int
    setup_inr: int = 0
    listed_price: ListedPrice
    fx_rate: float
    fx_pinned_at: str
    source_url: str
    url_discovered_via: Literal["anakin-search", "fixture-fallback"]
    scraped_at: str


class ConstraintsApplied(BaseModel):
    ceiling_inr_monthly: int
    headroom_inr: int
    region_allowlist: list[str]
    spec_floor: SpecFloor


class RunnerUp(BaseModel):
    provider: str
    plan_sku: str
    monthly_inr: int


class Rejection(BaseModel):
    provider: str
    plan_sku: str
    reason: str
    detail: str


class Approval(BaseModel):
    status: Literal["pending", "approved", "rejected"] = "pending"
    approver: str | None = None
    approved_at: str | None = None


class Signature(BaseModel):
    alg: str = SIGNATURE_ALG
    kid: str = SIGNATURE_KID
    value: str


class SuspectFlag(BaseModel):
    provider: str
    quote: str


class CartMandate(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_name: Literal["severance.cart_mandate/v1"] = Field(
        alias="schema", default=SCHEMA_MANDATE
    )
    mandate_id: str
    nonce: str
    issued_at: str
    expires_at: str
    spec_hash: str
    decision: Decision
    constraints_applied: ConstraintsApplied
    runner_up: RunnerUp | None = None
    rejected: list[Rejection] = Field(default_factory=list)
    savings_vs_current_inr: int
    lockin_inventory: list[LockinFeature] = Field(default_factory=list)
    approval: Approval = Field(default_factory=Approval)
    signature: Signature
    suspect: list[SuspectFlag] = Field(default_factory=list)

    def unsigned_payload(self) -> dict[str, Any]:
        data = self.model_dump(mode="json", by_alias=True)
        data.pop("signature", None)
        data.pop("approval", None)
        return data


def canonical_dumps(obj: Any) -> str:
    """Sorted-keys, no-whitespace JSON. Datetimes become Zulu ISO-8601."""

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


_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)


def _load_json_text(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if not stripped:
        raise SpecError("INVALID_SPEC", "empty input")
    path = Path(stripped)
    if len(stripped) < 512 and path.is_file():
        stripped = path.read_text(encoding="utf-8")
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = _JSON_OBJECT_RE.search(stripped)
        if not match:
            raise SpecError("INVALID_SPEC", "input is not JSON and is not a readable path")
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise SpecError("INVALID_SPEC", f"could not parse JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SpecError("INVALID_SPEC", "spec must be a JSON object")
    return data


def parse_capacity_spec(text: str) -> CapacitySpec:
    data = _load_json_text(text)
    return parse_capacity_spec_obj(data)


def parse_capacity_spec_obj(data: dict[str, Any]) -> CapacitySpec:
    constraints = data.get("constraints")
    if not isinstance(constraints, dict):
        raise SpecError(
            "MISSING_CEILING",
            "constraints.ceiling_inr_monthly is required and is never inferred",
            "constraints.ceiling_inr_monthly",
        )
    if constraints.get("ceiling_inr_monthly") is None or "ceiling_inr_monthly" not in constraints:
        raise SpecError(
            "MISSING_CEILING",
            "constraints.ceiling_inr_monthly is required and is never inferred",
            "constraints.ceiling_inr_monthly",
        )
    decision = data.get("decision")
    if isinstance(decision, dict):
        verdict = decision.get("verdict")
        if verdict == "BLOCKED":
            blockers = ", ".join(decision.get("blockers") or []) or "unspecified"
            raise SpecError(
                "SURVEY_BLOCKED",
                f"Surveyor verdict is BLOCKED ({blockers}); the Broker will not shop.",
                "decision.verdict",
            )
        if verdict == "NEEDS_INPUT":
            raise SpecError(
                "SURVEY_NEEDS_INPUT",
                "Surveyor parked this spec as NEEDS_INPUT. Complete the survey before shopping.",
                "decision.verdict",
            )
    try:
        return CapacitySpec.model_validate(data)
    except ValidationError as exc:
        raise SpecError("INVALID_SPEC", str(exc)) from exc


def looks_like_spec(text: str) -> bool:
    stripped = text.strip()
    if SCHEMA_SPEC in stripped:
        return True
    path = Path(stripped)
    if len(stripped) < 512 and path.is_file():
        try:
            return SCHEMA_SPEC in path.read_text(encoding="utf-8")
        except OSError:
            return False
    return False


def _part_payload(part: Any) -> tuple[str | None, Any]:
    root = getattr(part, "root", part)
    if isinstance(part, dict):
        root = part.get("root", part)
    if isinstance(root, dict):
        return (
            root.get("text") if isinstance(root.get("text"), str) else None,
            root.get("data"),
        )
    text = getattr(root, "text", None)
    data = getattr(root, "data", None)
    return (text if isinstance(text, str) else None, data)


def inbound_text(query: str, message: Any = None) -> str:
    """Merge A2A text parts and DataPart JSON so a Surveyor artifact is shoppable."""
    chunks: list[str] = []
    if query and str(query).strip():
        chunks.append(str(query))
    parts: list[Any] = []
    if message is not None:
        parts = list(getattr(message, "parts", None) or [])
        if not parts and isinstance(message, dict):
            parts = list(message.get("parts") or [])
    for part in parts:
        text, data = _part_payload(part)
        if isinstance(data, dict):
            dumped = json.dumps(data)
            if dumped not in chunks:
                chunks.append(dumped)
        if text and text not in chunks:
            chunks.append(text)
    return "\n".join(chunks)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def mandate_ttl_seconds() -> int:
    return int(os.environ.get("MANDATE_TTL_SECONDS", "900"))
