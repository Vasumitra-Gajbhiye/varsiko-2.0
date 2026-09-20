from surveyor.capacity import static_default_capacity
from surveyor.intake import parse_intake
from surveyor.lockin_scan import scan_lockin
from surveyor.fixture_store import repo_fixture
from surveyor.verdict import decide


def test_missing_ceiling_is_needs_input():
    intake = parse_intake("https://github.com/acme/victim-app")
    v = decide(intake=intake, scan=None, capacity=None, mode="live")
    assert v.verdict == "NEEDS_INPUT"
    assert "never inferred" in v.reasons[0]


def test_clean_is_proceed():
    intake = parse_intake("https://github.com/acme/clean-app ceiling_inr_monthly: 1500")
    scan = scan_lockin(repo_fixture("clean"))
    v = decide(intake=intake, scan=scan, capacity=static_default_capacity(), mode="static-only")
    assert v.verdict == "PROCEED"


def test_heavy_is_proceed_with_porter():
    intake = parse_intake("https://github.com/acme/lockin-heavy ceiling_inr_monthly: 1500")
    scan = scan_lockin(repo_fixture("lockin_heavy"))
    v = decide(intake=intake, scan=scan, capacity=static_default_capacity(), mode="live")
    assert v.verdict == "PROCEED_WITH_PORTER"


def test_nuxt_is_blocked_unsupported():
    intake = parse_intake("https://github.com/acme/nuxt-app ceiling_inr_monthly: 1500")
    scan = scan_lockin(repo_fixture("other_framework"))
    v = decide(intake=intake, scan=scan, capacity=static_default_capacity(), mode="static-only")
    assert v.verdict == "BLOCKED"
    assert "UNSUPPORTED_FRAMEWORK" in v.blockers


def test_sandbox_is_blocked_product():
    intake = parse_intake("https://github.com/acme/sandbox-app ceiling_inr_monthly: 1500")
    scan = scan_lockin(repo_fixture("sandbox"))
    v = decide(intake=intake, scan=scan, capacity=static_default_capacity(), mode="live")
    assert v.verdict == "BLOCKED"
    assert "VERCEL_ONLY_PRODUCT" in v.blockers
