"""Approval is matched on mandate_id, recorded in executor state, never inferred from chat."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from broker.contracts import CartMandate, CapacitySpec, isoformat_z, parse_iso
from broker.mandate import remint_mandate
from broker.scoring import RankedResult, ScoredPlan

APPROVE_RE = re.compile(r"APPROVE\s+(MND-[A-Z0-9]+)", re.IGNORECASE)


@dataclass
class PendingGate:
    mandate: CartMandate
    card: str
    winner: ScoredPlan
    spec: CapacitySpec
    spec_hash: str
    ranked: RankedResult
    approved: bool = False
    emitted: bool = False  # one-time use: a mandate is released to the Pilot at most once


@dataclass
class ApprovalOutcome:
    kind: Literal["approved", "mismatch", "expired_remint", "no_pending", "bare_yes", "already_sent"]
    message: str
    pending: PendingGate | None = None
    mandate_id: str | None = None


def parse_approve(text: str) -> str | None:
    match = APPROVE_RE.search(text or "")
    if not match:
        return None
    return match.group(1).upper()


def looks_like_bare_yes(text: str) -> bool:
    stripped = (text or "").strip().lower()
    return stripped in {"yes", "y", "ok", "okay", "approve", "approved", "lgtm"}


def evaluate_approval(
    pending: PendingGate | None,
    text: str,
    *,
    now: datetime | None = None,
    secret: str | None = None,
) -> ApprovalOutcome:
    mandate_id = parse_approve(text)
    if mandate_id is None:
        if looks_like_bare_yes(text):
            return ApprovalOutcome(
                kind="bare_yes",
                message="A bare yes does not resolve a mandate. Reply `APPROVE MND-…` with the id on the card.",
                pending=pending,
            )
        return ApprovalOutcome(kind="no_pending", message="no APPROVE command", pending=pending)

    if pending is None:
        return ApprovalOutcome(
            kind="no_pending",
            message=f"No parked mandate in this session. Cannot approve {mandate_id}.",
            mandate_id=mandate_id,
        )

    if mandate_id != pending.mandate.mandate_id:
        return ApprovalOutcome(
            kind="mismatch",
            message=(
                f"Approval names {mandate_id} but the parked mandate is "
                f"{pending.mandate.mandate_id}. Rejected as a mismatch."
            ),
            pending=pending,
            mandate_id=mandate_id,
        )

    if pending.emitted:
        return ApprovalOutcome(
            kind="already_sent",
            message=f"{mandate_id} was already released to the Pilot. A mandate is single-use.",
            pending=pending,
            mandate_id=mandate_id,
        )

    moment = now or datetime.now(timezone.utc)
    if parse_iso(pending.mandate.expires_at) <= moment:
        reminted = remint_mandate(
            pending.mandate,
            pending.winner,
            pending.spec.constraints,
            pending.spec_hash,
            ranked=pending.ranked,
            spec=pending.spec,
            secret=secret,
            now=moment,
        )
        if isinstance(reminted, dict) and reminted.get("error"):
            return ApprovalOutcome(
                kind="expired_remint",
                message=f"Mandate expired and remint refused: {reminted}",
                pending=pending,
                mandate_id=mandate_id,
            )
        from broker.card import render_approval_card

        pending.mandate = reminted  # type: ignore[assignment]
        pending.card = render_approval_card(pending.mandate)
        pending.approved = False
        return ApprovalOutcome(
            kind="expired_remint",
            message=(
                f"Mandate {mandate_id} expired. It was not extended. "
                f"Re-minted as {pending.mandate.mandate_id}. "
                f"Reply `APPROVE {pending.mandate.mandate_id}`."
            ),
            pending=pending,
            mandate_id=mandate_id,
        )

    pending.approved = True
    pending.mandate.approval.status = "approved"
    pending.mandate.approval.approver = "human"
    pending.mandate.approval.approved_at = isoformat_z(moment)
    return ApprovalOutcome(
        kind="approved",
        message=f"Recorded approval for {mandate_id}.",
        pending=pending,
        mandate_id=mandate_id,
    )
