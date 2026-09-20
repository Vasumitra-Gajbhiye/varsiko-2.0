from surveyor.fixture_store import repo_fixture
from surveyor.lockin_rules import HEAVY_RULE_IDS
from surveyor.lockin_scan import rule_ids_fired, scan_lockin


def test_lockin_heavy_fires_every_non_blocked_rule():
    result = scan_lockin(repo_fixture("lockin_heavy"))
    fired = rule_ids_fired(result)
    missing = set(HEAVY_RULE_IDS) - fired
    assert not missing, f"missing rules: {missing}"
    assert result.framework == "next"
    assert all(d.evidence and d.evidence[0].file and d.evidence[0].line for d in result.details)


def test_clean_repo_has_empty_lockin():
    result = scan_lockin(repo_fixture("clean"))
    assert result.details == []
    assert result.inventory == []
    assert result.framework == "next"


def test_other_framework_is_blocked():
    result = scan_lockin(repo_fixture("other_framework"))
    assert "UNSUPPORTED_FRAMEWORK" in result.blocked_products


def test_sandbox_is_vercel_only_product():
    result = scan_lockin(repo_fixture("sandbox"))
    assert "VERCEL_ONLY_PRODUCT" in result.blocked_products


def test_declared_unused_env():
    result = scan_lockin(
        repo_fixture("clean"),
        env_inventory=[{"key": "BLOB_READ_WRITE_TOKEN", "maps_to": "@vercel/blob"}],
    )
    assert any(w.startswith("DECLARED_UNUSED") for w in result.warnings)


def test_used_missing_env():
    result = scan_lockin(repo_fixture("lockin_heavy"), env_inventory=[])
    assert any(w.startswith("USED_MISSING") for w in result.warnings)


def test_inventory_gap_isr_metric():
    result = scan_lockin(repo_fixture("clean"), metrics_flags={"isr_operations": 9})
    assert any("INVENTORY_GAP" in w for w in result.warnings)
