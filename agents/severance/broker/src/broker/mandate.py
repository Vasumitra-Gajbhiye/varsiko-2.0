"""Mint + HMAC-sign a cart mandate. Re-checks every constraint independently of scoring."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from broker.contracts import (
    SCHEMA_MANDATE,
    SIGNATURE_ALG,
    SIGNATURE_KID,
    Approval,
    CapacitySpec,
    CartMandate,
    Constraints,
    ConstraintsApplied,
    Decision,
    ListedPrice,
    Rejection,
    RunnerUp,
    Signature,
    SuspectFlag,
    canonical_dumps,
    isoformat_z,
    mandate_ttl_seconds,
    parse_iso,
)
from broker.fx import FxTable, load_fx_table, to_monthly_inr
from broker.providers import regions_overlap_allowlist
from broker.scoring import (
    MISSING_CAPABILITY,
    OVER_CEILING,
    REGION_NOT_ALLOWED,
    UNDER_SPEC_FLOOR,
    RankedResult,
    ScoredPlan,
    _missing_caps,
    _under_floor,
)


def signing_key(secret: str | None = None) -> bytes:
    raw = secret if secret is not None else os.environ.get("MANDATE_SIGNING_SECRET", "")
    if not raw:
        raise RuntimeError("MANDATE_SIGNING_SECRET is not set")
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        key = raw.encode("utf-8")
    if len(key) < 16:
        raise RuntimeError("MANDATE_SIGNING_SECRET must be at least 16 bytes")
    return key


def constraints_hash(constraints: Constraints) -> str:
    payload = canonical_dumps(constraints.model_dump(mode="json"))
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def _sign_payload(payload: dict[str, Any], key: bytes) -> str:
    body = canonical_dumps(payload)
    return hmac.new(key, body.encode("utf-8"), hashlib.sha256).hexdigest()


def _recheck(winner: ScoredPlan, constraints: Constraints, fx: FxTable) -> dict[str, str] | None:
    monthly = to_monthly_inr(winner.row.price, winner.row.currency, winner.row.period, fx)
    if monthly > constraints.ceiling_inr_monthly:
        return {
            "error": "REFUSED",
            "reason": OVER_CEILING,
            "detail": f"{monthly} > {constraints.ceiling_inr_monthly}",
        }
    floor_fail = _under_floor(winner.row, constraints.spec_floor)
    if floor_fail:
        return {"error": "REFUSED", "reason": UNDER_SPEC_FLOOR, "detail": floor_fail}
    cap_fail = _missing_caps(winner.row, constraints.must_support)
    if cap_fail:
        return {"error": "REFUSED", "reason": MISSING_CAPABILITY, "detail": cap_fail}
    ok, _matched = regions_overlap_allowlist(winner.row.regions, constraints.region_allowlist)
    if not ok:
        offered = ",".join(winner.row.regions) or "(none)"
        return {
            "error": "REFUSED",
            "reason": REGION_NOT_ALLOWED,
            "detail": f"{offered} not in allowlist",
        }
    return None


def _new_mandate_id() -> str:
    return "MND-" + secrets.token_hex(3).upper()


def mint_mandate(
    winner: ScoredPlan | dict[str, Any],
    constraints: Constraints | dict[str, Any],
    spec_hash: str,
    *,
    ranked: RankedResult | None = None,
    spec: CapacitySpec | None = None,
    current_cost_inr: int = 0,
    secret: str | None = None,
    now: datetime | None = None,
    mandate_id: str | None = None,
    nonce: str | None = None,
    ttl_seconds: int | None = None,
    fx: FxTable | None = None,
) -> CartMandate | dict[str, Any]:
    if isinstance(constraints, dict):
        constraints = Constraints.model_validate(constraints)
    if isinstance(winner, dict):
        from broker.scoring import PlanRow

        row = PlanRow.from_dict(winner)
        table = fx or load_fx_table()
        monthly = to_monthly_inr(row.price, row.currency, row.period, table)
        winner = ScoredPlan(
            row=row,
            monthly_inr=monthly,
            fx_rate=table.rate_for(row.currency),
            fx_pinned_at=table.pinned_at,
            matched_region=winner.get("region"),
        )

    table = fx or load_fx_table()
    refusal = _recheck(winner, constraints, table)
    if refusal:
        return refusal

    ok, matched = regions_overlap_allowlist(winner.row.regions, constraints.region_allowlist)
    region = winner.matched_region or matched or (winner.row.regions[0] if winner.row.regions else "")
    if not ok:
        return {
            "error": "REFUSED",
            "reason": REGION_NOT_ALLOWED,
            "detail": f"{region} not in allowlist",
        }

    monthly = to_monthly_inr(winner.row.price, winner.row.currency, winner.row.period, table)
    issued = now or datetime.now(timezone.utc)
    ttl = ttl_seconds if ttl_seconds is not None else mandate_ttl_seconds()
    expires = issued + timedelta(seconds=ttl)
    current = current_cost_inr
    if spec is not None:
        current = spec.current_cost.monthly_inr

    via = winner.row.url_discovered_via
    if via not in ("anakin-search", "fixture-fallback"):
        via = "fixture-fallback"

    runner = None
    rejected: list[Rejection] = []
    if ranked is not None:
        if ranked.runner_up is not None:
            runner = RunnerUp(
                provider=ranked.runner_up.row.provider,
                plan_sku=ranked.runner_up.row.plan_sku,
                monthly_inr=ranked.runner_up.monthly_inr,
            )
        rejected = [
            Rejection(
                provider=r.provider,
                plan_sku=r.plan_sku,
                reason=r.reason,
                detail=r.detail,
            )
            for r in ranked.rejected
        ]

    suspect_flags: list[SuspectFlag] = []
    if winner.row.suspect and winner.row.suspect_quote:
        suspect_flags.append(
            SuspectFlag(provider=winner.row.provider, quote=winner.row.suspect_quote)
        )
    if ranked is not None:
        seen = {s.provider for s in suspect_flags}
        for item in [ranked.winner, ranked.runner_up, *()]:
            if item and item.row.suspect and item.row.provider not in seen:
                suspect_flags.append(
                    SuspectFlag(provider=item.row.provider, quote=item.row.suspect_quote)
                )
                seen.add(item.row.provider)
        for row in (s.row for s in ranked.survivors):
            if row.suspect and row.provider not in seen:
                suspect_flags.append(SuspectFlag(provider=row.provider, quote=row.suspect_quote))
                seen.add(row.provider)

    unsigned = {
        "schema": SCHEMA_MANDATE,
        "mandate_id": mandate_id or _new_mandate_id(),
        "nonce": nonce or secrets.token_hex(16),
        "issued_at": isoformat_z(issued),
        "expires_at": isoformat_z(expires),
        "spec_hash": spec_hash,
        "decision": Decision(
            provider=winner.row.provider,
            plan_sku=winner.row.plan_sku,
            region=region,
            monthly_inr=monthly,
            setup_inr=0,
            listed_price=ListedPrice(amount=winner.row.price, currency=winner.row.currency.upper()),
            fx_rate=table.rate_for(winner.row.currency),
            fx_pinned_at=table.pinned_at,
            source_url=winner.row.source_url,
            url_discovered_via=via,  # type: ignore[arg-type]
            scraped_at=winner.row.scraped_at or isoformat_z(issued),
        ).model_dump(mode="json"),
        "constraints_applied": ConstraintsApplied(
            ceiling_inr_monthly=constraints.ceiling_inr_monthly,
            headroom_inr=constraints.ceiling_inr_monthly - monthly,
            region_allowlist=list(constraints.region_allowlist),
            spec_floor=constraints.spec_floor,
        ).model_dump(mode="json"),
        "runner_up": runner.model_dump(mode="json") if runner else None,
        "rejected": [r.model_dump(mode="json") for r in rejected],
        "savings_vs_current_inr": current - monthly,
        "lockin_inventory": (
            [item.model_dump(mode="json") for item in spec.lockin_inventory] if spec else []
        ),
        "suspect": [s.model_dump(mode="json") for s in suspect_flags],
    }

    key = signing_key(secret)
    signature = Signature(alg=SIGNATURE_ALG, kid=SIGNATURE_KID, value=_sign_payload(unsigned, key))
    return CartMandate.model_validate(
        {
            **unsigned,
            "approval": Approval().model_dump(mode="json"),
            "signature": signature.model_dump(mode="json"),
        }
    )


def remint_mandate(
    mandate: CartMandate,
    winner: ScoredPlan,
    constraints: Constraints,
    spec_hash: str,
    *,
    ranked: RankedResult | None = None,
    spec: CapacitySpec | None = None,
    secret: str | None = None,
    now: datetime | None = None,
    ttl_seconds: int | None = None,
    fx: FxTable | None = None,
) -> CartMandate | dict[str, Any]:
    """Issue a new mandate for the same winner. Never extends the old expiry."""
    return mint_mandate(
        winner,
        constraints,
        spec_hash,
        ranked=ranked,
        spec=spec,
        secret=secret,
        now=now,
        ttl_seconds=ttl_seconds,
        fx=fx,
        mandate_id=None,
        nonce=None,
    )


def is_expired(mandate: CartMandate, now: datetime | None = None) -> bool:
    moment = now or datetime.now(timezone.utc)
    return parse_iso(mandate.expires_at) <= moment
