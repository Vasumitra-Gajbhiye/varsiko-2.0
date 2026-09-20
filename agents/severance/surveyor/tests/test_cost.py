from surveyor.cost import parse_charges, pull_cost
from surveyor.fixture_store import load_text
from surveyor.fx import FxTable


def test_project_attributed_usage_excludes_seats_and_credits():
    rows = parse_charges(load_text("vercel/charges.jsonl"))
    fx = FxTable(usd_inr=83.0, pinned_at="2026-09-20T12:00:00Z")
    cost = pull_cost(rows, "prj_victim", window="2026-08-20..2026-09-19", fx=fx)
    assert cost.usd == 41.6
    assert cost.monthly_inr == 3453
    assert cost.includes_seats is False
    assert cost.billing_currency == "USD"
    names = {s.name for s in cost.by_service}
    assert "Seats" not in names
    assert cost.bandwidth_gb == 700
