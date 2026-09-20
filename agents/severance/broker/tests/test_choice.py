"""The human picks the plan; the Broker re-verifies it before it signs anything."""

import json

import pytest

from broker.approval import PendingGate, evaluate_approval
from broker.choice import apply_choice, eligible_plans, parse_choose, select_plan
from broker.emit import emit_to_pilot
from broker.contracts import parse_capacity_spec_obj
from broker.fixture_store import fixture_dir
from broker.pipeline import run_pipeline
from broker.verify import verify_mandate


@pytest.fixture
def roomy_spec():
    """The shipped fixture ceiling leaves exactly one survivor, by design.

    Raising the human's budget is the only thing that widens the field: the plans,
    prices and regions are untouched. At this ceiling DigitalOcean clears the bar
    and Vultr is still refused on region, so there is a real choice to make.
    """
    raw = json.loads((fixture_dir() / "spec_valid.json").read_text())
    raw["constraints"]["ceiling_inr_monthly"] = 4200
    return parse_capacity_spec_obj(raw)


def gate_for(spec) -> PendingGate:
    result = run_pipeline(spec, offline=True)
    assert result.mandate is not None
    return PendingGate(
        mandate=result.mandate,
        card=result.card,
        winner=result.winner,
        spec=result.spec,
        spec_hash=result.spec_hash,
        ranked=result.ranked,
    )


def test_parse_choose():
    assert parse_choose("CHOOSE hetzner CX22") == ("hetzner", "CX22")
    assert parse_choose("choose DigitalOcean s-2vcpu-2gb") == ("digitalocean", "s-2vcpu-2gb")
    assert parse_choose("APPROVE MND-AA11BB") is None
    assert parse_choose("hello") is None


def test_default_ceiling_leaves_a_single_survivor(spec):
    """Guards the demo: at the shipped ceiling there is nothing to choose between."""
    gate = gate_for(spec)
    assert len(eligible_plans(gate.ranked)) == 1
    reasons = {r.reason for r in gate.ranked.rejected}
    assert "OVER_CEILING" in reasons and "REGION_NOT_ALLOWED" in reasons


def test_every_survivor_is_offered(roomy_spec):
    gate = gate_for(roomy_spec)
    plans = eligible_plans(gate.ranked)
    assert len(plans) >= 2, "a raised ceiling must open up a real choice"
    # The auto-winner is simply the first survivor: the human may pick any of them.
    assert plans[0].row.plan_sku == gate.ranked.winner.row.plan_sku


def test_choosing_the_runner_up_mints_for_that_plan(roomy_spec):
    gate = gate_for(roomy_spec)
    first_id = gate.mandate.mandate_id
    runner = gate.ranked.runner_up
    assert runner is not None

    outcome = apply_choice(gate, runner.row.provider, runner.row.plan_sku)

    assert outcome.kind == "chosen"
    assert gate.mandate.mandate_id != first_id, "a choice re-mints, it never edits in place"
    assert gate.mandate.decision.provider == runner.row.provider
    assert gate.mandate.decision.plan_sku == runner.row.plan_sku
    assert gate.mandate.decision.monthly_inr == runner.monthly_inr
    assert gate.approved is False and gate.emitted is False
    # The re-minted mandate is genuinely signed, not a copy with fields swapped.
    verify_mandate(gate.mandate, check_expiry=True)


def test_chosen_plan_stays_under_the_surveyor_ceiling(roomy_spec):
    gate = gate_for(roomy_spec)
    ceiling = gate.spec.constraints.ceiling_inr_monthly
    for plan in eligible_plans(gate.ranked):
        outcome = apply_choice(gate, plan.row.provider, plan.row.plan_sku)
        assert outcome.kind == "chosen"
        assert gate.mandate.decision.monthly_inr <= ceiling
        assert gate.mandate.constraints_applied.headroom_inr >= 0


def test_a_plan_the_session_never_offered_is_refused(spec):
    gate = gate_for(spec)
    before = gate.mandate.mandate_id

    outcome = apply_choice(gate, "hetzner", "CCX63-NOT-OFFERED")

    assert outcome.kind == "unknown_plan"
    assert gate.mandate.mandate_id == before, "a bad choice must not disturb the parked mandate"


def test_provider_and_sku_must_match_the_same_row(roomy_spec):
    gate = gate_for(roomy_spec)
    # A real SKU, but attributed to the wrong provider.
    other = next(
        p for p in eligible_plans(gate.ranked) if p.row.provider != gate.ranked.winner.row.provider
    )
    assert select_plan(gate.ranked, gate.ranked.winner.row.provider, other.row.plan_sku) is None


def test_choice_then_approve_releases_the_chosen_mandate(roomy_spec):
    gate = gate_for(roomy_spec)
    runner = gate.ranked.runner_up
    apply_choice(gate, runner.row.provider, runner.row.plan_sku)
    chosen_id = gate.mandate.mandate_id

    # The stale id from before the choice must not unlock the new mandate.
    stale = evaluate_approval(gate, "APPROVE MND-DEAD01")
    assert stale.kind == "mismatch"
    assert gate.approved is False

    outcome = evaluate_approval(gate, f"APPROVE {chosen_id}")
    assert outcome.kind == "approved"
    assert gate.mandate.approval.approver == "human"

    emitted = emit_to_pilot(gate.mandate, approved=True)
    assert "error" not in emitted, emitted
    assert emitted["mandate_id"] == chosen_id
