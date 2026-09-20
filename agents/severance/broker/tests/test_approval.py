from datetime import datetime, timedelta, timezone

from broker.approval import PendingGate, evaluate_approval, parse_approve
from broker.card import render_approval_card
from broker.emit import emit_to_pilot
from broker.mandate import constraints_hash, mint_mandate
from broker.pipeline import run_pipeline


def test_parse_approve_requires_mandate_id():
    assert parse_approve("APPROVE MND-7F3A2C") == "MND-7F3A2C"
    assert parse_approve("please APPROVE MND-AA11BB now") == "MND-AA11BB"
    assert parse_approve("yes") is None
    assert parse_approve("approve") is None


def test_emit_before_approve_refused(spec):
    result = run_pipeline(spec, offline=True)
    assert result.mandate is not None
    out = emit_to_pilot(result.mandate, approved=False)
    assert out["error"] == "REFUSED"
    assert out["reason"] == "NOT_APPROVED"


def test_wrong_mandate_id_is_mismatch(spec):
    result = run_pipeline(spec, offline=True)
    gate = PendingGate(
        mandate=result.mandate,
        card=result.card,
        winner=result.winner,
        spec=result.spec,
        spec_hash=result.spec_hash,
        ranked=result.ranked,
    )
    outcome = evaluate_approval(gate, "APPROVE MND-DEAD01")
    assert outcome.kind == "mismatch"
    assert gate.approved is False


def test_expired_approval_remints_does_not_extend(spec):
    now = datetime(2026, 9, 20, 13, 0, tzinfo=timezone.utc)
    result = run_pipeline(spec, offline=True)
    minted = mint_mandate(
        result.winner,
        spec.constraints,
        result.spec_hash,
        ranked=result.ranked,
        spec=spec,
        now=now,
        ttl_seconds=900,
        mandate_id="MND-OLD001",
    )
    gate = PendingGate(
        mandate=minted,
        card=render_approval_card(minted),
        winner=result.winner,
        spec=spec,
        spec_hash=result.spec_hash,
        ranked=result.ranked,
    )
    later = now + timedelta(minutes=20)
    outcome = evaluate_approval(gate, "APPROVE MND-OLD001", now=later)
    assert outcome.kind == "expired_remint"
    assert outcome.pending.mandate.mandate_id != "MND-OLD001"
    assert minted.expires_at == "2026-09-20T13:15:00Z"
    assert outcome.pending.mandate.expires_at != minted.expires_at
    assert not outcome.pending.approved


def test_matching_approve_records_state_then_emit_stubs(spec):
    result = run_pipeline(spec, offline=True)
    gate = PendingGate(
        mandate=result.mandate,
        card=result.card,
        winner=result.winner,
        spec=result.spec,
        spec_hash=result.spec_hash,
        ranked=result.ranked,
    )
    outcome = evaluate_approval(gate, f"APPROVE {result.mandate.mandate_id}")
    assert outcome.kind == "approved"
    assert outcome.pending.approved is True
    assert outcome.pending.mandate.approval.status == "approved"
    emitted = emit_to_pilot(outcome.pending.mandate, approved=True)
    assert emitted.get("status") == "stubbed"
    assert emitted.get("mandate_id") == result.mandate.mandate_id


def test_replayed_approval_after_release_is_refused(spec):
    from broker.approval import evaluate_approval
    from broker.pipeline import run_pipeline
    from broker.approval import PendingGate

    r = run_pipeline(spec, offline=True)
    gate = PendingGate(mandate=r.mandate, card=r.card, winner=r.winner, spec=r.spec,
                       spec_hash=r.spec_hash, ranked=r.ranked)
    first = evaluate_approval(gate, f"APPROVE {r.mandate.mandate_id}")
    assert first.kind == "approved"
    gate.emitted = True
    second = evaluate_approval(gate, f"APPROVE {r.mandate.mandate_id}")
    assert second.kind == "already_sent"
