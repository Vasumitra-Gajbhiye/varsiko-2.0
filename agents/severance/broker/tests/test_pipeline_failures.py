"""Plan tests 3, 6, 7: the pipeline degrades honestly and never mints on thin evidence."""

import json

import pytest

from broker import pipeline
from broker.fixture_store import fixture_dir
from broker.pricing import FetchResult
from broker.discovery import DiscoveryResult


real_discover = pipeline.discover_pricing_pages
real_fetch = pipeline.fetch_pricing


def _patch_dead(monkeypatch, *dead):
    def discover(pid, **kw):
        if pid in dead:
            return DiscoveryResult(provider_id=pid, candidates=[], discovered_via="fixture-fallback", unreachable=True, detail="down")
        return real_discover(pid, **kw)

    monkeypatch.setattr(pipeline, "discover_pricing_pages", discover)


def test_one_provider_unreachable_still_mints_from_two(monkeypatch, spec):
    _patch_dead(monkeypatch, "vultr")
    result = pipeline.run_pipeline(spec, offline=True)
    assert result.mandate is not None
    assert result.unreachable == ["vultr"]
    assert sorted(result.usable_providers) == ["digitalocean", "hetzner"]


def test_two_providers_unreachable_mints_nothing(monkeypatch, spec):
    _patch_dead(monkeypatch, "vultr", "digitalocean")
    result = pipeline.run_pipeline(spec, offline=True)
    assert result.mandate is None
    assert result.error["error"] == "INSUFFICIENT_QUOTES"
    assert "single quote" in result.error["message"]


def test_scrape_with_no_rows_counts_as_unreachable(monkeypatch, spec):
    def fetch(pid, url, **kw):
        if pid != "hetzner":
            return FetchResult(provider_id=pid, url=url, rows=[], unreachable=True)
        return real_fetch(pid, url, **kw)

    monkeypatch.setattr(pipeline, "fetch_pricing", fetch)
    result = pipeline.run_pipeline(spec, offline=True)
    assert result.mandate is None and result.error["error"] == "INSUFFICIENT_QUOTES"


def test_missing_ceiling_never_touches_the_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no provider call before the spec is valid")

    monkeypatch.setattr(pipeline, "discover_pricing_pages", boom)
    monkeypatch.setattr(pipeline, "fetch_pricing", boom)
    result = pipeline.run_pipeline((fixture_dir() / "spec_no_ceiling.json").read_text(), offline=True)
    assert result.mandate is None and result.error["field"].endswith("ceiling_inr_monthly")


@pytest.mark.parametrize("bad", ["", "not json", "[]", '{"schema": "severance.capacity_spec/v1"}'])
def test_garbage_input_returns_error_object_not_exception(bad):
    result = pipeline.run_pipeline(bad, offline=True)
    assert result.mandate is None and result.error


def test_zero_or_negative_ceiling_is_rejected():
    for ceiling in (0, -5):
        raw = json.loads((fixture_dir() / "spec_valid.json").read_text())
        raw["constraints"]["ceiling_inr_monthly"] = ceiling
        result = pipeline.run_pipeline(raw, offline=True)
        assert result.mandate is None, f"minted a mandate at ceiling {ceiling}"


def test_inbound_data_part_is_shoppable():
    from broker.contracts import inbound_text, looks_like_spec, parse_capacity_spec
    from broker.fixture_store import load_json

    spec = load_json("spec_valid.json")
    combined = inbound_text("", {"parts": [{"data": spec}]})
    assert looks_like_spec(combined)
    parsed = parse_capacity_spec(combined)
    assert parsed.constraints.ceiling_inr_monthly == 1500


def test_fixture_fallback_provenance_lands_in_the_mandate(spec):
    result = pipeline.run_pipeline(spec, offline=True)
    assert result.mandate.decision.url_discovered_via == "fixture-fallback"
