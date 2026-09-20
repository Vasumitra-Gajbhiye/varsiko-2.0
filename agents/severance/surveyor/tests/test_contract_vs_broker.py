import pytest

from broker.contracts import parse_capacity_spec_obj, SpecError
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
    assert isinstance(spec.current_cost.monthly_inr, int)
    assert spec.lockin_inventory


def test_missing_ceiling_is_broker_missing_ceiling():
    intake = parse_intake("https://github.com/acme/victim-app")
    result = run_pipeline(intake, offline=True)
    assert result.document is not None
    assert "ceiling_inr_monthly" not in result.document["constraints"]
    with pytest.raises(SpecError) as exc:
        parse_capacity_spec_obj(result.document)
    assert exc.value.code == "MISSING_CEILING"


def test_static_only_omits_current_cost():
    intake = parse_intake(
        "https://github.com/acme/unlinked-app ceiling_inr_monthly: 1500"
    )
    result = run_pipeline(intake, offline=True)
    assert result.mode == "static-only"
    assert result.document is not None
    assert "current_cost" not in result.document
