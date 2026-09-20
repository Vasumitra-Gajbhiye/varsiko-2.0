from datetime import datetime, timedelta, timezone

from broker.contracts import parse_capacity_spec, SpecError
from broker.fixture_store import fixture_dir
from broker.mandate import constraints_hash, is_expired, mint_mandate, remint_mandate
from broker.scoring import score_candidates
from broker.verify import verify_signature


def _winner(spec, fx=None):
    from broker.fx import load_fx_table
    from broker.pricing import fetch_pricing
    from broker.providers import PROVIDER_ORDER
    from broker.discovery import discover_pricing_pages

    rows = []
    for pid in PROVIDER_ORDER:
        disc = discover_pricing_pages(pid, offline=True)
        fetched = fetch_pricing(pid, disc.candidates[0].url, offline=True)
        rows.extend(fetched.rows)
    ranked = score_candidates(rows, spec.constraints)
    return ranked


def test_missing_ceiling_is_hard_stop():
    text = (fixture_dir() / "spec_no_ceiling.json").read_text()
    try:
        parse_capacity_spec(text)
        raise AssertionError("should have failed")
    except SpecError as exc:
        assert exc.code == "MISSING_CEILING"
        assert "ceiling_inr_monthly" in (exc.field or "")


def test_refuses_over_ceiling(spec, secret):
    ranked = _winner(spec)
    winner = ranked.winner
    assert winner is not None
    tight = spec.constraints.model_copy(update={"ceiling_inr_monthly": 1})
    result = mint_mandate(
        winner, tight, constraints_hash(tight), ranked=ranked, spec=spec, secret=secret
    )
    assert result["error"] == "REFUSED"
    assert result["reason"] == "OVER_CEILING"


def test_signature_verifies(spec, secret):
    ranked = _winner(spec)
    minted = mint_mandate(
        ranked.winner,
        spec.constraints,
        constraints_hash(spec.constraints),
        ranked=ranked,
        spec=spec,
        secret=secret,
    )
    assert not isinstance(minted, dict)
    verify_signature(minted, secret)
    assert minted.mandate_id.startswith("MND-")
    assert minted.decision.provider == "hetzner"


def test_expired_is_reminted_never_extended(spec, secret):
    ranked = _winner(spec)
    now = datetime(2026, 9, 20, 13, 0, tzinfo=timezone.utc)
    minted = mint_mandate(
        ranked.winner,
        spec.constraints,
        constraints_hash(spec.constraints),
        ranked=ranked,
        spec=spec,
        secret=secret,
        now=now,
        ttl_seconds=900,
    )
    later = now + timedelta(minutes=20)
    assert is_expired(minted, later)
    reminted = remint_mandate(
        minted,
        ranked.winner,
        spec.constraints,
        constraints_hash(spec.constraints),
        ranked=ranked,
        spec=spec,
        secret=secret,
        now=later,
        ttl_seconds=900,
    )
    assert reminted.mandate_id != minted.mandate_id
    assert reminted.expires_at != minted.expires_at
    assert reminted.nonce != minted.nonce
    assert not is_expired(reminted, later)
    # old expiry was not pushed out
    assert minted.expires_at == "2026-09-20T13:15:00Z"


def test_spec_hash_embedded(spec, secret):
    ranked = _winner(spec)
    digest = constraints_hash(spec.constraints)
    minted = mint_mandate(
        ranked.winner, spec.constraints, digest, ranked=ranked, spec=spec, secret=secret
    )
    assert minted.spec_hash == digest


def test_missing_or_short_signing_secret_fails_closed(monkeypatch, spec):
    import pytest
    from broker.pipeline import run_pipeline

    monkeypatch.delenv("MANDATE_SIGNING_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        run_pipeline(spec, offline=True)
    monkeypatch.setenv("MANDATE_SIGNING_SECRET", "short")
    with pytest.raises(RuntimeError):
        run_pipeline(spec, offline=True)
