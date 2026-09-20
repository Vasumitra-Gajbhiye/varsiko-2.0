"""Predictions block. Hashed before anyone provisions. The Surveyor never reads Auditor output."""

from __future__ import annotations

import hashlib
from typing import Any

from surveyor.capacity import CapacityResult, MetricsBundle
from surveyor.contracts import canonical_dumps, isoformat_z
from surveyor.lockin_scan import ScanResult


def hash_predictions(payload: dict[str, Any]) -> str:
    body = {k: v for k, v in payload.items() if k != "prediction_hash"}
    digest = hashlib.sha256(canonical_dumps(body).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def build_predictions(
    capacity: CapacityResult,
    metrics: MetricsBundle | None,
    scan: ScanResult | None,
    *,
    committed_at: str | None = None,
) -> dict[str, Any]:
    bundle = metrics or MetricsBundle()
    p95_rps = bundle.p95_rps or 0
    peak_rps = bundle.peak_rps or p95_rps
    top_routes = bundle.top_routes or []
    cpu_util = 0.55
    mem_util = 0.6
    if capacity.vcpu:
        cpu_util = round(min(0.95, (capacity.p95_active_cores or 0) / max(capacity.vcpu, 1)), 2) or 0.55
    if capacity.ram_gb:
        mem_util = round(
            min(0.95, (capacity.p95_peak_mem_gb or 0) / max(capacity.ram_gb, 1)),
            2,
        ) or 0.6
    ts = committed_at or isoformat_z()
    payload = {
        "committed_at": ts,
        "load_profile": {
            "p95_rps": p95_rps,
            "peak_rps": peak_rps,
            "top_routes": top_routes,
        },
        "expected_on_floor_spec": {
            "cpu_util_at_p95_rps": cpu_util,
            "mem_util_at_p95_rps": mem_util,
        },
        "falsifiers": [
            "sustained CPU > 85% on the floor spec at p95_rps => capacity underestimated",
            "peak RSS > 90% of ram_gb at p95_rps => RAM underestimated",
            "any route in top_routes with p95 latency > 2x predicted",
        ],
    }
    payload["prediction_hash"] = hash_predictions(payload)
    return payload
