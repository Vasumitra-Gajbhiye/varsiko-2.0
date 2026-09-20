"""FOCUS billing rows → project-attributed USD → INR at pinned FX."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from surveyor.fx import FxTable, load_fx_table, usd_to_inr

BILLABLE = {"Usage", "Purchase"}


@dataclass
class ServiceBreakdown:
    name: str
    usd: float
    consumed_quantity: float = 0.0
    consumed_unit: str = ""


@dataclass
class CostResult:
    usd: float
    monthly_inr: int
    billing_currency: str
    evidence: str
    includes_seats: bool
    fx_usd_inr: float
    fx_pinned_at: str
    by_service: list[ServiceBreakdown] = field(default_factory=list)
    bandwidth_gb: float | None = None

    def as_current_cost(self) -> dict[str, Any]:
        return {
            "monthly_inr": self.monthly_inr,
            "billing_currency": self.billing_currency,
            "evidence": self.evidence,
            "usd": round(self.usd, 2),
            "fx_usd_inr": self.fx_usd_inr,
            "fx_pinned_at": self.fx_pinned_at,
            "includes_seats": self.includes_seats,
            "source": "api:vercel/v1/billing/charges",
        }


def _tags(row: dict[str, Any]) -> dict[str, Any]:
    tags = row.get("Tags") or row.get("tags") or {}
    if isinstance(tags, dict):
        return tags
    return {}


def _project_id(tags: dict[str, Any]) -> str | None:
    for key in ("ProjectId", "projectId", "project_id"):
        if tags.get(key):
            return str(tags[key])
    return None


def parse_charges(payload: str | Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(payload, str):
        rows: list[dict[str, Any]] = []
        for line in payload.splitlines():
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
        return rows
    return list(payload)


def pull_cost(
    rows: Iterable[dict[str, Any]],
    project_id: str,
    *,
    window: str,
    fx: FxTable | None = None,
) -> CostResult:
    table = fx or load_fx_table()
    attributed: list[dict[str, Any]] = []
    for row in rows:
        tags = _tags(row)
        if _project_id(tags) != project_id:
            continue
        category = str(row.get("ChargeCategory") or row.get("chargeCategory") or "")
        if category not in BILLABLE:
            continue
        attributed.append(row)

    usd = 0.0
    services: dict[str, ServiceBreakdown] = {}
    bandwidth_gb = 0.0
    for row in attributed:
        amount = float(row.get("BilledCost") or row.get("billedCost") or 0)
        usd += amount
        name = str(row.get("ServiceName") or row.get("serviceName") or "unknown")
        qty = float(row.get("ConsumedQuantity") or row.get("consumedQuantity") or 0)
        unit = str(row.get("ConsumedUnit") or row.get("consumedUnit") or "")
        bucket = services.setdefault(name, ServiceBreakdown(name=name, usd=0.0))
        bucket.usd += amount
        bucket.consumed_quantity += qty
        bucket.consumed_unit = unit or bucket.consumed_unit
        lname = name.lower()
        if "bandwidth" in lname or "fast data" in lname or "data transfer" in lname:
            if unit.upper() in {"GB", "GIB"}:
                bandwidth_gb += qty
            elif unit.upper() in {"TB", "TIB"}:
                bandwidth_gb += qty * 1000.0
            elif unit.upper() in {"BYTE", "BYTES", "B"}:
                bandwidth_gb += qty / 1e9

    evidence = (
        f"vercel /v1/billing/charges, project-attributed, {window}, "
        f"ChargeCategory in Usage/Purchase"
    )
    return CostResult(
        usd=usd,
        monthly_inr=usd_to_inr(usd, table),
        billing_currency="USD",
        evidence=evidence,
        includes_seats=False,
        fx_usd_inr=table.usd_inr,
        fx_pinned_at=table.pinned_at,
        by_service=list(services.values()),
        bandwidth_gb=bandwidth_gb if bandwidth_gb else None,
    )
