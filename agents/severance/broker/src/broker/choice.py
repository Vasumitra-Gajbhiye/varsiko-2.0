"""Human plan choice. The UI sends an identifier; the price comes from our own scored set.

The Broker already scored every eligible plan and kept the `RankedResult` on the
parked gate. `CHOOSE` picks one of those `ScoredPlan` objects by identifier and
re-mints. Nothing about the plan -- price, currency, specs, source url -- is ever
read back from the caller, so a tampered UI can only name a plan the Broker itself
already published, and `mint_mandate` re-checks ceiling, floor, capabilities and
region against that plan before it signs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from broker.card import render_approval_card
from broker.mandate import mint_mandate
from broker.scoring import RankedResult, ScoredPlan

# CHOOSE <provider> <plan_sku>. Plan SKUs carry dots, dashes and underscores.
CHOOSE_RE = re.compile(r"CHOOSE\s+([A-Za-z0-9_-]+)\s+([A-Za-z0-9._-]+)", re.IGNORECASE)


@dataclass
class ChoiceOutcome:
    kind: Literal["chosen", "unknown_plan", "refused", "no_pending"]
    message: str
    plan: ScoredPlan | None = None
    mandate_id: str | None = None


def parse_choose(text: str) -> tuple[str, str] | None:
    match = CHOOSE_RE.search(text or "")
    if not match:
        return None
    return match.group(1).lower(), match.group(2)


def eligible_plans(ranked: RankedResult | None) -> list[ScoredPlan]:
    """Every plan the human is allowed to pick, in the Broker's own ranking order."""
    if ranked is None:
        return []
    return list(ranked.survivors)


def select_plan(
    ranked: RankedResult | None,
    provider: str,
    plan_sku: str,
) -> ScoredPlan | None:
    for item in eligible_plans(ranked):
        if item.row.provider.lower() == provider.lower() and item.row.plan_sku == plan_sku:
            return item
    # SKUs are compared case-insensitively only as a fallback, never across providers.
    for item in eligible_plans(ranked):
        if (
            item.row.provider.lower() == provider.lower()
            and item.row.plan_sku.lower() == plan_sku.lower()
        ):
            return item
    return None


def apply_choice(
    pending,  # broker.approval.PendingGate -- imported lazily to keep this module leaf-level
    provider: str,
    plan_sku: str,
    *,
    secret: str | None = None,
    now: datetime | None = None,
) -> ChoiceOutcome:
    """Re-mint the parked gate for a plan the human picked.

    A choice never widens what was authorised: `mint_mandate` re-runs every hard
    check against the same `constraints` the Surveyor set, so picking a costlier
    plan is refused here rather than at the Pilot.
    """
    if pending is None:
        return ChoiceOutcome(
            kind="no_pending",
            message="No shopping result in this session. Send a capacity spec first.",
        )

    chosen = select_plan(pending.ranked, provider, plan_sku)
    if chosen is None:
        offered = ", ".join(
            f"{p.row.provider} {p.row.plan_sku}" for p in eligible_plans(pending.ranked)
        )
        return ChoiceOutcome(
            kind="unknown_plan",
            message=(
                f"{provider} {plan_sku} is not one of the plans this session offered. "
                f"Eligible: {offered or '(none)'}."
            ),
        )

    minted = mint_mandate(
        chosen,
        pending.spec.constraints,
        pending.spec_hash,
        ranked=pending.ranked,
        spec=pending.spec,
        secret=secret,
        now=now,
    )
    if isinstance(minted, dict) and minted.get("error"):
        return ChoiceOutcome(
            kind="refused",
            message=(
                f"{chosen.row.provider} {chosen.row.plan_sku} was refused: "
                f"{minted.get('reason')} ({minted.get('detail')}). No mandate minted."
            ),
            plan=chosen,
        )

    # A new mandate id and nonce: the previously parked one is abandoned, not extended.
    pending.mandate = minted
    pending.card = render_approval_card(minted)
    pending.winner = chosen
    pending.approved = False
    pending.emitted = False
    return ChoiceOutcome(
        kind="chosen",
        message=(
            f"Minted {minted.mandate_id} for {chosen.row.provider} {chosen.row.plan_sku} "
            f"at ₹{chosen.monthly_inr}/mo. Reply `APPROVE {minted.mandate_id}` to authorise."
        ),
        plan=chosen,
        mandate_id=minted.mandate_id,
    )
