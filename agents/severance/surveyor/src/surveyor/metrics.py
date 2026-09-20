"""Observability metrics via REST. 403 is data, not an exception."""

from __future__ import annotations

import os
from typing import Any

import httpx

from surveyor.capacity import HourlyPoint, MetricSeries, MetricsBundle
from surveyor.fixture_store import load_json, write_json
from surveyor.redact import redact_text
from surveyor.vercel_client import API, VercelError

LOGICAL_LABELS = {
    "active_cpu_s": ("active cpu", "active_cpu"),
    "provisioned_mem_gb": ("provisioned memory", "provisioned_mem"),
    "peak_mem_gb": ("peak memory", "peak_mem"),
    "fdt_out": ("fast data transfer", "outgoing"),
    "fot_out": ("fast origin transfer", "outgoing"),
    "image_duration": ("image transformation", "duration"),
    "isr_ops": ("isr", "operation"),
    "requests": ("request", "count"),
}


def _offline() -> bool:
    return os.environ.get("SURVEYOR_OFFLINE", "").strip() not in {"", "0", "false", "False"}


def resolve_metric_id(schema: dict[str, Any], *needles: str) -> str | None:
    metrics = schema.get("metrics") or []
    lowered = [n.lower() for n in needles]
    for item in metrics:
        blob = f"{item.get('id', '')} {item.get('description', '')} {item.get('name', '')}".lower()
        if all(n in blob for n in lowered):
            return str(item.get("id"))
        if any(n in blob for n in lowered) and len(lowered) == 1:
            return str(item.get("id"))
    for item in metrics:
        blob = f"{item.get('id', '')} {item.get('description', '')}".lower()
        if lowered[0] in blob:
            return str(item.get("id"))
    return None


def pull_metrics(
    project_id: str,
    team: str | None,
    *,
    start: str,
    end: str,
    window_days: int = 14,
    token: str | None = None,
    offline: bool | None = None,
    client: httpx.Client | None = None,
    force_403: bool = False,
) -> MetricsBundle:
    if force_403:
        return MetricsBundle(
            available=[],
            unavailable=["observability_plus_required"],
            window_days=window_days,
        )
    use_offline = _offline() if offline is None else offline
    if use_offline:
        data = load_json("vercel/metrics_bundle.json")
        return MetricsBundle.from_dict(data)

    tok = token if token is not None else os.environ.get("VERCEL_TOKEN", "")
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    http = client or httpx.Client(timeout=60.0)
    own = client is None
    try:
        schema_resp = http.get(f"{API}/v2/observability/schema", headers=headers, params={"teamId": team} if team else None)
        if schema_resp.status_code == 403:
            return MetricsBundle(
                available=[],
                unavailable=["observability_plus_required"],
                window_days=window_days,
            )
        if schema_resp.status_code >= 400:
            raise VercelError("METRICS_SCHEMA_FAILED", f"HTTP {schema_resp.status_code}", schema_resp.status_code)
        schema = schema_resp.json()
        write_json("vercel/metrics_schema.json", schema)
        available: list[str] = []
        unavailable: list[str] = []
        series: dict[str, MetricSeries] = {}
        extras: dict[str, float] = {}

        def query(logical: str, metric_id: str, aggregation: str = "sum") -> dict[str, Any] | None:
            body = {
                "scope": {
                    "type": "project",
                    "ownerId": team,
                    "projectIds": [project_id],
                },
                "metric": metric_id,
                "aggregation": aggregation,
                "startTime": start,
                "endTime": end,
                "granularity": {"minutes": 60} if False else "1h",
            }
            resp = http.post(f"{API}/v2/observability/query", headers=headers, json=body)
            if resp.status_code == 403:
                unavailable.append(f"{logical}:observability_plus_required")
                return None
            if resp.status_code >= 400:
                unavailable.append(f"{logical}:http_{resp.status_code}")
                return None
            payload = resp.json()
            write_json(f"vercel/metrics_{logical}.json", payload)
            available.append(logical)
            return payload

        for logical, needles in LOGICAL_LABELS.items():
            mid = resolve_metric_id(schema, *needles)
            if not mid:
                unavailable.append(f"{logical}:unresolved")
                continue
            payload = query(logical, mid)
            if not payload:
                continue
            hourly = _hourly_from_payload(payload)
            series[logical] = MetricSeries(label=logical, hourly=hourly, total=sum(p.value for p in hourly))
            extras[logical] = series[logical].total

        bundle = MetricsBundle(
            available=available,
            unavailable=unavailable,
            series=_normalize_series(series),
            window_days=window_days,
            fdt_out_bytes=_as_bytes(series.get("fdt_out")),
            fot_out_bytes=_as_bytes(series.get("fot_out")),
            image_duration_s=float(extras.get("image_duration") or 0),
            isr_operations=float(extras.get("isr_ops") or 0),
        )
        if "requests" in series and series["requests"].hourly:
            vals = series["requests"].values()
            bundle.p95_rps = sorted(vals)[max(0, int(round(0.95 * len(vals))) - 1)]
            bundle.peak_rps = max(vals)
        return bundle
    except httpx.HTTPError as exc:
        raise VercelError("METRICS_NETWORK", redact_text(str(exc))) from exc
    finally:
        if own:
            http.close()


def _hourly_from_payload(payload: dict[str, Any]) -> list[HourlyPoint]:
    rows = payload.get("data") or payload.get("summary") or []
    points: list[HourlyPoint] = []
    for row in rows:
        ts = str(row.get("time") or row.get("ts") or row.get("bucket") or "")
        value = row.get("value")
        if value is None:
            for k, v in row.items():
                if k not in {"time", "ts", "bucket"} and isinstance(v, (int, float)):
                    value = v
                    break
        if value is None:
            continue
        points.append(HourlyPoint(ts=ts, value=float(value)))
    return points


def _as_bytes(series: MetricSeries | None) -> float:
    if not series:
        return 0.0
    return series.total


def _normalize_series(series: dict[str, MetricSeries]) -> dict[str, MetricSeries]:
    out = dict(series)
    if "active_cpu_s" not in out and "active_cpu" in out:
        out["active_cpu_s"] = out["active_cpu"]
    return out
