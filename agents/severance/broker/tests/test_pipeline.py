from broker.discovery import DiscoveryResult, CandidateUrl
from broker.fixture_store import fixture_dir
from broker.pipeline import run_pipeline
from broker.scoring import OVER_CEILING, REGION_NOT_ALLOWED


def test_valid_spec_hetzner_wins_signed_two_reasons(spec):
    result = run_pipeline(spec, offline=True)
    assert result.error is None
    assert result.mandate is not None
    assert result.mandate.decision.provider == "hetzner"
    assert result.mandate.signature.value
    reasons = {r.reason for r in result.mandate.rejected}
    assert OVER_CEILING in reasons
    assert REGION_NOT_ALLOWED in reasons
    assert result.card is not None
    assert result.mandate.mandate_id in result.card
    assert "₹" in result.card or "Ceiling" in result.card


def test_missing_ceiling_mints_nothing():
    text = (fixture_dir() / "spec_no_ceiling.json").read_text()
    result = run_pipeline(text, offline=True)
    assert result.mandate is None
    assert result.error is not None
    assert result.error["error"] == "MISSING_CEILING"


def test_ceiling_400_no_mandate(spec):
    tight = spec.model_copy(
        update={"constraints": spec.constraints.model_copy(update={"ceiling_inr_monthly": 400})}
    )
    result = run_pipeline(tight, offline=True)
    assert result.mandate is None
    assert result.error["error"] == "NO_ELIGIBLE_PLAN"
    assert result.error.get("smallest_change")


def test_single_quote_no_mandate(spec, monkeypatch):
    def fake_discover(provider_id, **kwargs):
        if provider_id == "hetzner":
            return DiscoveryResult(
                provider_id="hetzner",
                candidates=[CandidateUrl(url="https://www.hetzner.com/cloud/")],
                discovered_via="fixture-fallback",
            )
        return DiscoveryResult(
            provider_id=provider_id,
            candidates=[],
            discovered_via="fixture-fallback",
            unreachable=True,
            detail="down",
        )

    monkeypatch.setattr("broker.pipeline.discover_pricing_pages", fake_discover)
    result = run_pipeline(spec, offline=True)
    assert result.mandate is None
    assert result.error["error"] == "INSUFFICIENT_QUOTES"


def test_on_progress_emits_providers(spec):
    seen = []
    run_pipeline(spec, offline=True, on_progress=lambda p, a: seen.append((p, a)))
    actions = [a for _, a in seen]
    assert "discovering" in actions
    assert "scoring" in actions
    assert {p for p, _ in seen if p} >= {"hetzner", "digitalocean", "vultr"}
