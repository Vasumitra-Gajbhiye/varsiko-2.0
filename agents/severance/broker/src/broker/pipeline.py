"""Code pipeline. The LLM never picks the winner."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from broker.card import render_approval_card
from broker.contracts import (
    CapacitySpec,
    CartMandate,
    SpecError,
    parse_capacity_spec,
    parse_capacity_spec_obj,
)
from broker.discovery import discover_pricing_pages
from broker.fx import load_fx_table
from broker.mandate import constraints_hash, mint_mandate
from broker.providers import PROVIDER_ORDER
from broker.pricing import fetch_pricing
from broker.scoring import PlanRow, RankedResult, score_candidates


@dataclass
class PipelineResult:
    spec: CapacitySpec | None = None
    spec_hash: str | None = None
    ranked: RankedResult | None = None
    mandate: CartMandate | None = None
    card: str | None = None
    winner: Any = None
    error: dict[str, Any] | None = None
    unreachable: list[str] = field(default_factory=list)
    usable_providers: list[str] = field(default_factory=list)
    url_discovered_via: dict[str, str] = field(default_factory=dict)

    def as_narration(self) -> str:
        if self.error:
            parts = [f"{self.error.get('error')}: {self.error.get('message') or self.error}"]
            if self.error.get("field"):
                parts.append(f"Missing field: {self.error['field']}")
            if self.ranked and self.ranked.smallest_change:
                parts.append(self.ranked.smallest_change.description)
            if self.ranked:
                for r in self.ranked.rejected:
                    parts.append(f"- {r.provider} {r.plan_sku}: {r.reason} ({r.detail})")
            return "\n".join(parts)
        if self.card:
            return self.card
        return "No mandate."


def run_pipeline(
    spec: CapacitySpec | str | dict[str, Any],
    *,
    offline: bool | None = None,
    secret: str | None = None,
) -> PipelineResult:
    if isinstance(spec, str):
        try:
            spec = parse_capacity_spec(spec)
        except SpecError as exc:
            return PipelineResult(error=exc.to_dict())
    elif isinstance(spec, dict):
        try:
            spec = parse_capacity_spec_obj(spec)
        except SpecError as exc:
            return PipelineResult(error=exc.to_dict())

    spec_hash = constraints_hash(spec.constraints)
    rows: list[PlanRow] = []
    unreachable: list[str] = []
    usable: list[str] = []
    via: dict[str, str] = {}

    for provider_id in PROVIDER_ORDER:
        discovery = discover_pricing_pages(provider_id, offline=offline)
        if discovery.unreachable and not discovery.candidates:
            unreachable.append(provider_id)
            continue
        urls = [c.url for c in discovery.candidates]
        if not urls:
            unreachable.append(provider_id)
            continue
        fetched = None
        for candidate in discovery.candidates:
            fetched = fetch_pricing(
                provider_id,
                candidate.url,
                discovered_via=discovery.discovered_via,
                offline=offline,
            )
            if fetched.rows:
                break
        if fetched is None or not fetched.rows:
            unreachable.append(provider_id)
            continue
        via[provider_id] = fetched.discovered_via
        usable.append(provider_id)
        if discovery.suspect:
            for row in fetched.rows:
                row.suspect = True
                row.suspect_quote = row.suspect_quote or discovery.suspect_quote
        rows.extend(fetched.rows)

    if len(usable) < 2:
        return PipelineResult(
            spec=spec,
            spec_hash=spec_hash,
            error={
                "error": "INSUFFICIENT_QUOTES",
                "message": (
                    "No mandate on a single quote. "
                    f"Usable providers: {usable or '(none)'}. Unreachable: {unreachable}."
                ),
            },
            unreachable=unreachable,
            usable_providers=usable,
            url_discovered_via=via,
        )

    fx = load_fx_table()
    ranked = score_candidates(rows, spec.constraints, fx)
    if ranked.winner is None:
        return PipelineResult(
            spec=spec,
            spec_hash=spec_hash,
            ranked=ranked,
            error={
                "error": "NO_ELIGIBLE_PLAN",
                "message": "No candidate passed hard filters. No mandate minted.",
                "smallest_change": (
                    ranked.smallest_change.description if ranked.smallest_change else None
                ),
                "rejected": [
                    {
                        "provider": r.provider,
                        "plan_sku": r.plan_sku,
                        "reason": r.reason,
                        "detail": r.detail,
                    }
                    for r in ranked.rejected
                ],
            },
            unreachable=unreachable,
            usable_providers=usable,
            url_discovered_via=via,
        )

    minted = mint_mandate(
        ranked.winner,
        spec.constraints,
        spec_hash,
        ranked=ranked,
        spec=spec,
        secret=secret,
        fx=fx,
    )
    if isinstance(minted, dict) and minted.get("error"):
        return PipelineResult(
            spec=spec,
            spec_hash=spec_hash,
            ranked=ranked,
            winner=ranked.winner,
            error=minted,
            unreachable=unreachable,
            usable_providers=usable,
            url_discovered_via=via,
        )

    card = render_approval_card(minted)
    return PipelineResult(
        spec=spec,
        spec_hash=spec_hash,
        ranked=ranked,
        mandate=minted,
        card=card,
        winner=ranked.winner,
        unreachable=unreachable,
        usable_providers=usable,
        url_discovered_via=via,
    )
