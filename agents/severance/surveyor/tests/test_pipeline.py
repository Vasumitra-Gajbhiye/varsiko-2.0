from surveyor.intake import parse_intake
from surveyor.pipeline import run_pipeline


def test_valid_spec_heavy_winner_path():
    intake = parse_intake("https://github.com/acme/victim-app ceiling ₹1500")
    result = run_pipeline(intake, offline=True)
    assert result.document["decision"]["verdict"] == "PROCEED_WITH_PORTER"
    assert result.document["surveyor"]["mode"] == "live"
    assert result.park is None
    assert "Surveyor result" in result.card
    assert result.document["constraints"]["ceiling_inr_monthly"] == 1500
    assert result.document["constraints"]["region_allowlist"]


def test_metrics_403_mode():
    intake = parse_intake("https://github.com/acme/victim-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True, force_metrics_403=True)
    assert result.document["surveyor"]["mode"] == "live-no-observability"
    assert result.document["decision"]["confidence"]["capacity"] == "low"
    assert any("OBSERVABILITY_PLUS_REQUIRED" in w for w in result.document["surveyor"]["warnings"])


def test_egress_conflict_warning():
    intake = parse_intake("https://github.com/acme/victim-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True, force_egress_conflict=True)
    assert result.document["surveyor"]["evidence_conflicts"]
    assert result.document["decision"]["confidence"]["capacity"] in {"medium", "low"}


def test_ambiguous_project_parks():
    intake = parse_intake("https://github.com/acme/ambiguous-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True)
    assert result.park == "project"
    assert len(result.candidates) == 2


def test_no_token_unlinked_is_static_only():
    intake = parse_intake("https://github.com/acme/unlinked-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True)
    assert result.mode == "static-only"
    assert result.document["decision"]["verdict"] in {"PROCEED", "PROCEED_WITH_PORTER", "NEEDS_INPUT", "BLOCKED"}


def test_nuxt_blocked():
    intake = parse_intake("https://github.com/acme/nuxt-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True)
    assert result.document["decision"]["verdict"] == "BLOCKED"
    assert "UNSUPPORTED_FRAMEWORK" in result.document["decision"]["blockers"]
