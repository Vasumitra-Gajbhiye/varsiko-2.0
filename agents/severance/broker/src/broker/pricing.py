"""Anakin URL Scraper: read what the price actually is. Only schema-numeric fields enter scoring."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

from broker.contracts import isoformat_z, utc_now
from broker.discovery import domain_allowed
from broker.fixture_store import load_json, write_json
from broker.injection import wrap_untrusted, scan_payload
from broker.providers import get_provider
from broker.scoring import PlanRow

ANAKIN_SCRAPE = "https://api.anakin.io/v1/url-scraper"

PLAN_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "plans": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "plan_name": {"type": "string"},
                    "vcpu": {"type": "number"},
                    "ram_gb": {"type": "number"},
                    "disk_gb": {"type": "number"},
                    "egress_tb": {"type": "number"},
                    "price": {"type": "number"},
                    "currency": {"type": "string"},
                    "period": {"type": "string", "enum": ["monthly", "hourly"]},
                    "regions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["plan_name", "vcpu", "ram_gb", "price", "currency", "period"],
            },
        }
    },
}


@dataclass
class FetchResult:
    provider_id: str
    url: str
    rows: list[PlanRow]
    unreachable: bool = False
    suspect: bool = False
    suspect_quote: str = ""
    detail: str = ""
    scraped_at: str = ""
    discovered_via: str = "anakin-search"


def _anakin_headers() -> dict[str, str]:
    key = os.environ.get("ANAKIN_API_KEY", "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-Key"] = key
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _extract_plans(payload: Any, *, _depth: int = 0) -> list[dict[str, Any]]:
    """Anakin returns plans as an object, a JSON string, or nested under generatedJson/data."""
    if _depth > 4 or payload is None:
        return []
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return []
    if isinstance(payload, list):
        return [p for p in payload if isinstance(p, dict)]
    if not isinstance(payload, dict):
        return []
    plans = payload.get("plans")
    if isinstance(plans, list):
        return [p for p in plans if isinstance(p, dict)]
    for key in ("generatedJson", "generated_json", "output", "data", "result"):
        nested = payload.get(key)
        if nested:
            found = _extract_plans(nested, _depth=_depth + 1)
            if found:
                return found
    return []


def _offline() -> bool:
    return os.environ.get("BROKER_OFFLINE", "1") not in {"0", "false", "False"}


def _rows_from_plans(
    provider_id: str,
    plans: list[dict[str, Any]],
    *,
    url: str,
    discovered_via: str,
    scraped_at: str,
    suspect: bool,
    suspect_quote: str,
) -> list[PlanRow]:
    rows: list[PlanRow] = []
    provider = get_provider(provider_id)
    for plan in plans:
        data = {
            **plan,
            "provider": provider_id,
            "plan_sku": plan.get("plan_sku") or plan.get("plan_name"),
            "capabilities": list(provider.capabilities),
            "source_url": url,
            "url_discovered_via": discovered_via,
            "scraped_at": scraped_at,
            "suspect": suspect,
            "suspect_quote": suspect_quote,
        }
        rows.append(PlanRow.from_dict(data, provider=provider_id))
    return rows


def fetch_pricing(
    provider_id: str,
    url: str,
    *,
    discovered_via: str = "anakin-search",
    client: httpx.Client | None = None,
    offline: bool | None = None,
    poll_interval: float = 1.0,
    poll_timeout: float = 90.0,
) -> FetchResult:
    provider = get_provider(provider_id)
    if not domain_allowed(url, provider.domains):
        return FetchResult(
            provider_id=provider_id,
            url=url,
            rows=[],
            detail="url rejected by domain allowlist",
        )

    use_offline = _offline() if offline is None else offline
    scraped_at = isoformat_z(utc_now())
    if use_offline:
        payload = load_json(f"scrape_{provider_id}.json")
        hit = scan_payload(payload)
        wrap_untrusted(str(payload), url)
        rows = _rows_from_plans(
            provider_id,
            _extract_plans(payload),
            url=url,
            discovered_via=discovered_via,
            scraped_at=scraped_at,
            suspect=hit is not None,
            suspect_quote=hit.quote if hit else "",
        )
        return FetchResult(
            provider_id=provider_id,
            url=url,
            rows=rows,
            suspect=hit is not None,
            suspect_quote=hit.quote if hit else "",
            scraped_at=scraped_at,
            discovered_via=discovered_via,
        )

    own_client = client is None
    http = client or httpx.Client()
    try:
        last_error = ""
        for attempt in range(2):
            try:
                response = http.post(
                    ANAKIN_SCRAPE,
                    headers=_anakin_headers(),
                    json={"url": url, "outputSchema": PLAN_OUTPUT_SCHEMA, "useBrowser": False},
                    timeout=30.0,
                )
            except httpx.HTTPError as exc:
                last_error = str(exc)
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                return _offline_fallback(provider_id, url, discovered_via, unreachable=True, detail=last_error)
            if response.status_code == 429:
                last_error = "429"
                if attempt == 0:
                    time.sleep(1.0)
                    continue
                return _offline_fallback(
                    provider_id, url, discovered_via, unreachable=True, detail="Anakin scrape 429 after retry"
                )
            if response.status_code >= 400:
                # Documented fallback: generateJson without outputSchema.
                response = http.post(
                    ANAKIN_SCRAPE,
                    headers=_anakin_headers(),
                    json={"url": url, "generateJson": True, "useBrowser": False},
                    timeout=30.0,
                )
                if response.status_code >= 400:
                    return _offline_fallback(
                        provider_id,
                        url,
                        discovered_via,
                        unreachable=True,
                        detail=f"HTTP {response.status_code}",
                    )
            body = response.json()
            job_id = body.get("jobId") or body.get("id")
            payload = body
            if job_id:
                payload = _poll_job(http, str(job_id), poll_interval, poll_timeout)
                if payload is None:
                    return _offline_fallback(
                        provider_id, url, discovered_via, unreachable=True, detail="scrape poll timeout"
                    )
            generated = payload.get("generatedJson") or payload
            plans = _extract_plans(generated) or _extract_plans(payload)
            if not plans:
                return _offline_fallback(
                    provider_id, url, discovered_via, detail="scrape yielded no plan rows"
                )
            if os.environ.get("BROKER_WRITE_FIXTURES") == "1":
                write_json(f"scrape_{provider_id}.json", {"plans": plans})
            hit = scan_payload(payload)
            wrap_untrusted(str(payload), url)
            rows = _rows_from_plans(
                provider_id,
                list(plans),
                url=url,
                discovered_via=discovered_via,
                scraped_at=scraped_at,
                suspect=hit is not None,
                suspect_quote=hit.quote if hit else "",
            )
            return FetchResult(
                provider_id=provider_id,
                url=url,
                rows=rows,
                suspect=hit is not None,
                suspect_quote=hit.quote if hit else "",
                scraped_at=scraped_at,
                discovered_via=discovered_via,
            )
        return _offline_fallback(provider_id, url, discovered_via, unreachable=True, detail=last_error)
    finally:
        if own_client:
            http.close()


def _poll_job(
    client: httpx.Client, job_id: str, interval: float, timeout: float
) -> dict[str, Any] | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(
            f"{ANAKIN_SCRAPE}/{job_id}",
            headers=_anakin_headers(),
            timeout=30.0,
        )
        if response.status_code >= 400:
            return None
        body = response.json()
        status = body.get("status")
        if status == "completed":
            return body
        if status == "failed":
            return None
        time.sleep(interval)
    return None


def _offline_fallback(
    provider_id: str,
    url: str,
    discovered_via: str,
    *,
    unreachable: bool = False,
    detail: str = "",
) -> FetchResult:
    try:
        payload = load_json(f"scrape_{provider_id}.json")
    except FileNotFoundError:
        return FetchResult(
            provider_id=provider_id,
            url=url,
            rows=[],
            unreachable=True,
            detail=detail or "no scrape fixture",
            discovered_via="fixture-fallback",
        )
    scraped_at = isoformat_z(utc_now())
    hit = scan_payload(payload)
    rows = _rows_from_plans(
        provider_id,
        _extract_plans(payload),
        url=url,
        discovered_via="fixture-fallback",
        scraped_at=scraped_at,
        suspect=hit is not None,
        suspect_quote=hit.quote if hit else "",
    )
    return FetchResult(
        provider_id=provider_id,
        url=url,
        rows=rows,
        unreachable=unreachable,
        suspect=hit is not None,
        suspect_quote=hit.quote if hit else "",
        detail=detail,
        scraped_at=scraped_at,
        discovered_via="fixture-fallback",
    )
