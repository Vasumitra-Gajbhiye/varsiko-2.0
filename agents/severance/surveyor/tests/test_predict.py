from surveyor.capacity import MetricsBundle, derive_capacity
from surveyor.fixture_store import load_json, repo_fixture
from surveyor.lockin_scan import scan_lockin
from surveyor.predict import build_predictions, hash_predictions


def test_prediction_hash_stable_and_sensitive():
    bundle = MetricsBundle.from_dict(load_json("vercel/metrics_bundle.json"))
    scan = scan_lockin(repo_fixture("lockin_heavy"))
    cap = derive_capacity(bundle, scan.details)
    a = build_predictions(cap, bundle, scan, committed_at="2026-09-20T12:34:56Z")
    b = build_predictions(cap, bundle, scan, committed_at="2026-09-20T12:34:56Z")
    assert a["prediction_hash"] == b["prediction_hash"]
    assert a["prediction_hash"].startswith("sha256:")
    mutated = dict(a)
    mutated["load_profile"] = dict(a["load_profile"])
    mutated["load_profile"]["p95_rps"] = 99
    assert hash_predictions(mutated) != a["prediction_hash"]
