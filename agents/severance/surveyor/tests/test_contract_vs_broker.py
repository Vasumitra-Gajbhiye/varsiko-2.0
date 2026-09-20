import pytest

from broker.contracts import parse_capacity_spec_obj, SpecError
from broker.pipeline import run_pipeline as broker_run
from surveyor.intake import parse_intake
from surveyor.pipeline import run_pipeline


def test_live_fixture_output_parses_as_broker_spec():
    intake = parse_intake(
        "https://github.com/acme/victim-app ceiling_inr_monthly: 1500"
    )
    result = run_pipeline(intake, offline=True)
    assert result.document is not None
    spec = parse_capacity_spec_obj(result.document)
    assert spec.constraints.ceiling_inr_monthly == 1500
    assert spec.capacity.vcpu >= 1
    assert spec.current_cost is not None
    assert isinstance(spec.current_cost.monthly_inr, int)
    assert spec.lockin_inventory


def test_live_fixture_output_mints_a_broker_mandate():
    intake = parse_intake(
        "https://github.com/acme/victim-app ceiling_inr_monthly: 1500"
    )
    surveyed = run_pipeline(intake, offline=True)
    shopped = broker_run(surveyed.document, offline=True)
    assert shopped.error is None, shopped.error
    assert shopped.mandate is not None
    assert shopped.mandate.decision.provider == "hetzner"
    assert shopped.mandate.signature.value


def test_missing_ceiling_is_broker_missing_ceiling():
    intake = parse_intake("https://github.com/acme/victim-app")
    result = run_pipeline(intake, offline=True)
    assert result.document is not None
    assert "ceiling_inr_monthly" not in result.document["constraints"]
    with pytest.raises(SpecError) as exc:
        parse_capacity_spec_obj(result.document)
    assert exc.value.code in {"MISSING_CEILING", "SURVEY_NEEDS_INPUT"}


def test_static_only_omits_current_cost_and_is_still_shoppable():
    intake = parse_intake(
        "https://github.com/acme/unlinked-app ceiling_inr_monthly: 1500"
    )
    result = run_pipeline(intake, offline=True)
    assert result.mode == "static-only"
    assert result.document is not None
    assert "current_cost" not in result.document
    spec = parse_capacity_spec_obj(result.document)
    assert spec.current_cost is None
    shopped = broker_run(result.document, offline=True)
    assert shopped.error is None, shopped.error
    assert shopped.mandate is not None


def test_blocked_framework_is_not_shoppable():
    intake = parse_intake("https://github.com/acme/nuxt-app ceiling_inr_monthly: 1500")
    result = run_pipeline(intake, offline=True)
    assert result.document["decision"]["verdict"] == "BLOCKED"
    with pytest.raises(SpecError) as exc:
        parse_capacity_spec_obj(result.document)
    assert exc.value.code == "SURVEY_BLOCKED"
