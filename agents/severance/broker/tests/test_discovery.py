from broker.discovery import domain_allowed, filter_search_results, discover_pricing_pages
from broker.fixture_store import load_json
from broker.providers import get_provider


def test_lookalike_domain_discarded_never_fetched():
    payload = load_json("search_poisoned.json")
    provider = get_provider("hetzner")
    kept, discarded = filter_search_results(payload["results"], provider.domains)
    urls = [item["url"] for item in kept]
    assert "https://hetzner-deals.example.com/cheap" in discarded
    assert all("hetzner-deals.example.com" not in u for u in urls)
    assert any("hetzner.com" in u for u in urls)
    assert not domain_allowed("https://hetzner-deals.example.com/cheap", provider.domains)
    assert domain_allowed("https://www.hetzner.com/cloud/", provider.domains)
    assert domain_allowed("https://docs.hetzner.com/cloud/", provider.domains)


def test_snippet_is_not_used_as_price():
    payload = load_json("search_poisoned.json")
    cheap = next(r for r in payload["results"] if "hetzner-deals" in r["url"])
    assert "50" in cheap["snippet"]
    # Discovery returns URLs only; snippet is not a field on CandidateUrl used for scoring.
    result = discover_pricing_pages("hetzner", offline=True)
    assert all(hasattr(c, "url") and not hasattr(c, "price") for c in result.candidates)


def test_offline_discover_uses_fixture_fallback():
    result = discover_pricing_pages("hetzner", offline=True)
    assert result.candidates
    assert result.discovered_via == "fixture-fallback"
    assert all("hetzner.com" in c.url for c in result.candidates)


def test_fetch_rejects_non_allowlisted_url():
    from broker.pricing import fetch_pricing

    result = fetch_pricing("hetzner", "https://hetzner-deals.example.com/cheap", offline=True)
    assert result.rows == []
    assert "allowlist" in result.detail
