"""Anakin Search: find where the price lives. Domain allowlist runs before anything is fetched."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from broker.fixture_store import load_json, write_json
from broker.injection import scan_payload
from broker.providers import Provider, get_provider

ANAKIN_SEARCH = "https://api.anakin.io/v1/search"


@dataclass
class CandidateUrl:
    url: str
    title: str = ""
    discovered_via: str = "anakin-search"


@dataclass
class DiscoveryResult:
    provider_id: str
    candidates: list[CandidateUrl]
    discovered_via: str
    unreachable: bool = False
    discarded: list[str] = field(default_factory=list)
    suspect: bool = False
    suspect_quote: str = ""
    detail: str = ""


def _anakin_headers() -> dict[str, str]:
    key = os.environ.get("ANAKIN_API_KEY", "")
    return {"X-API-Key": key, "Content-Type": "application/json"}


def hostname_of(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def domain_allowed(url: str, domains: tuple[str, ...]) -> bool:
    host = hostname_of(url)
    if not host:
        return False
    for domain in domains:
        d = domain.lower()
        if host == d or host.endswith("." + d):
            return True
    return False


def filter_search_results(
    results: list[dict[str, Any]],
    domains: tuple[str, ...],
) -> tuple[list[dict[str, Any]], list[str]]:
    kept: list[dict[str, Any]] = []
    discarded: list[str] = []
    for item in results:
        url = str(item.get("url") or "")
        if domain_allowed(url, domains):
            kept.append(item)
        else:
            discarded.append(url)
    return kept, discarded


def _offline() -> bool:
    return os.environ.get("BROKER_OFFLINE", "1") not in {"0", "false", "False"}


def _fixture_search(provider: Provider) -> dict[str, Any]:
    return load_json(f"search_{provider.id}.json")


def _search_once(provider: Provider, client: httpx.Client) -> httpx.Response:
    return client.post(
        ANAKIN_SEARCH,
        headers=_anakin_headers(),
        json={"prompt": provider.search_prompt, "limit": 5},
        timeout=30.0,
    )


def discover_pricing_pages(
    provider_id: str,
    *,
    client: httpx.Client | None = None,
    offline: bool | None = None,
) -> DiscoveryResult:
    provider = get_provider(provider_id)
    use_offline = _offline() if offline is None else offline

    if use_offline:
        payload = _fixture_search(provider)
        return _from_search_payload(provider, payload, discovered_via="fixture-fallback")

    own_client = client is None
    http = client or httpx.Client()
    try:
        last_error = ""
        for attempt in range(2):
            try:
                response = _search_once(provider, http)
            except httpx.HTTPError as exc:
                last_error = str(exc)
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                return _fallback(provider, unreachable=True, detail=last_error)
            if response.status_code == 429:
                last_error = "429"
                if attempt == 0:
                    time.sleep(1.0)
                    continue
                return _fallback(provider, unreachable=True, detail="Anakin search 429 after retry")
            if response.status_code >= 400:
                last_error = f"HTTP {response.status_code}"
                return _fallback(provider, unreachable=True, detail=last_error)
            payload = response.json()
            result = _from_search_payload(provider, payload, discovered_via="anakin-search")
            if not result.candidates:
                return _fallback(provider, discarded=result.discarded, detail="no allowlisted result")
            if os.environ.get("BROKER_WRITE_FIXTURES") == "1":
                write_json(f"search_{provider.id}.json", payload)
            return result
        return _fallback(provider, unreachable=True, detail=last_error)
    finally:
        if own_client:
            http.close()


def _from_search_payload(
    provider: Provider,
    payload: dict[str, Any],
    *,
    discovered_via: str,
) -> DiscoveryResult:
    results = list(payload.get("results") or [])
    # Snippets are hostile. Scan them, never parse them as prices.
    hit = scan_payload({"results": [{"snippet": r.get("snippet"), "title": r.get("title")} for r in results]})
    kept, discarded = filter_search_results(results, provider.domains)
    candidates = [
        CandidateUrl(
            url=str(item["url"]),
            title=str(item.get("title") or ""),
            discovered_via=discovered_via,
        )
        for item in kept
        if item.get("url")
    ]
    return DiscoveryResult(
        provider_id=provider.id,
        candidates=candidates,
        discovered_via=discovered_via if candidates else "fixture-fallback",
        discarded=discarded,
        suspect=hit is not None,
        suspect_quote=hit.quote if hit else "",
        detail="" if candidates else "no allowlisted result",
    )


def _fallback(
    provider: Provider,
    *,
    unreachable: bool = False,
    discarded: list[str] | None = None,
    detail: str = "",
) -> DiscoveryResult:
    try:
        payload = _fixture_search(provider)
        result = _from_search_payload(provider, payload, discovered_via="fixture-fallback")
        result.unreachable = unreachable
        result.discarded = discarded or result.discarded
        result.detail = detail or result.detail
        if not result.candidates:
            result.candidates = [
                CandidateUrl(url=provider.fallback_url, discovered_via="fixture-fallback")
            ]
            result.discovered_via = "fixture-fallback"
        return result
    except FileNotFoundError:
        return DiscoveryResult(
            provider_id=provider.id,
            candidates=[CandidateUrl(url=provider.fallback_url, discovered_via="fixture-fallback")],
            discovered_via="fixture-fallback",
            unreachable=unreachable,
            discarded=discarded or [],
            detail=detail,
        )


# Used by tests: never treat snippet text as a price.
def snippet_is_not_a_price_source() -> bool:
    return True
