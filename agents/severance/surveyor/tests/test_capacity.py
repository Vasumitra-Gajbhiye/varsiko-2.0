from surveyor.capacity import MetricsBundle, derive_capacity, percentile
from surveyor.fixture_store import load_json, repo_fixture
from surveyor.lockin_scan import scan_lockin


def test_percentile_nearest_rank():
    assert percentile([1, 2, 3, 4], 1.0) == 4
    assert percentile([1.0] * 20, 0.95) == 1.0


def test_golden_series_capacity_and_floor():
    bundle = MetricsBundle.from_dict(load_json("vercel/metrics_bundle.json"))
    scan = scan_lockin(repo_fixture("lockin_heavy"))
    result = derive_capacity(bundle, scan.details, observability=True)
    assert result.vcpu == 3
    assert result.ram_gb == 4
    assert result.disk_gb == 60
    assert result.egress_tb == 1.5
    assert result.spec_floor["vcpu"] == 5
    assert result.spec_floor["ram_gb"] == 6
    assert result.spec_floor["disk_gb"] == 90
    assert result.spec_floor["egress_tb"] == 2.25
    assert isinstance(result.vcpu, int)
    assert isinstance(result.ram_gb, int)
    assert isinstance(result.disk_gb, int)
    assert isinstance(result.egress_tb, float)


def test_observability_missing_is_low_confidence():
    result = derive_capacity(
        {"available": [], "unavailable": ["observability_plus_required"]},
        [],
        observability=False,
    )
    assert result.confidence == "low"
    assert "OBSERVABILITY_PLUS_REQUIRED" in result.warnings
    assert result.spec_floor["vcpu"] >= 2
    assert result.spec_floor["ram_gb"] >= 4
    assert result.spec_floor["disk_gb"] >= 40


def test_egress_conflict_drops_confidence():
    bundle = MetricsBundle.from_dict(load_json("vercel/metrics_bundle.json"))
    result = derive_capacity(bundle, [], billing_bandwidth_tb=0.4)
    assert result.evidence_conflicts
    assert result.confidence in {"medium", "low"}
