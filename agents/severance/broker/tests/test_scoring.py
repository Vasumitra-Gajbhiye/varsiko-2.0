from broker.contracts import Constraints, SpecFloor
from broker.fx import FxTable, to_monthly_inr
from broker.scoring import (
    OVER_CEILING,
    REGION_NOT_ALLOWED,
    UNDER_SPEC_FLOOR,
    PlanRow,
    score_candidates,
)

FX = FxTable(eur_inr=94.2, usd_inr=83.0, pinned_at="2026-09-20T12:00:00Z")


def _constraints(ceiling: int = 1500) -> Constraints:
    return Constraints(
        ceiling_inr_monthly=ceiling,
        region_allowlist=["in-blr", "sg-sin", "ap-south"],
        spec_floor=SpecFloor(vcpu=4, ram_gb=8, disk_gb=80, egress_tb=1),
        must_support=["docker", "cloud-init", "ipv4"],
    )


def _rows() -> list[PlanRow]:
    caps = ["docker", "cloud-init", "ipv4"]
    return [
        PlanRow(
            provider="hetzner",
            plan_sku="cpx31",
            vcpu=4,
            ram_gb=8,
            disk_gb=80,
            egress_tb=20,
            price=10.99,
            currency="EUR",
            period="monthly",
            regions=["sin", "fsn1"],
            capabilities=caps,
            source_url="https://www.hetzner.com/cloud/",
        ),
        PlanRow(
            provider="hetzner",
            plan_sku="CPX21",
            vcpu=3,
            ram_gb=4,
            disk_gb=80,
            egress_tb=20,
            price=7.59,
            currency="EUR",
            period="monthly",
            regions=["sin"],
            capabilities=caps,
        ),
        PlanRow(
            provider="digitalocean",
            plan_sku="s-4vcpu-8gb",
            vcpu=4,
            ram_gb=8,
            disk_gb=160,
            egress_tb=5,
            price=48,
            currency="USD",
            period="monthly",
            regions=["sgp1", "blr1"],
            capabilities=caps,
        ),
        PlanRow(
            provider="vultr",
            plan_sku="vc2-4c-8gb",
            vcpu=4,
            ram_gb=8,
            disk_gb=100,
            egress_tb=4,
            price=24,
            currency="USD",
            period="monthly",
            regions=["fra"],
            capabilities=caps,
        ),
    ]


def test_hetzner_wins_two_distinct_rejection_reasons():
    ranked = score_candidates(_rows(), _constraints(), FX)
    assert ranked.winner is not None
    assert ranked.winner.row.provider == "hetzner"
    assert ranked.winner.row.plan_sku == "cpx31"
    reasons = {r.reason for r in ranked.rejected}
    assert OVER_CEILING in reasons
    assert REGION_NOT_ALLOWED in reasons
    assert UNDER_SPEC_FLOOR in reasons
    do = next(r for r in ranked.rejected if r.provider == "digitalocean")
    assert do.reason == OVER_CEILING
    vultr = next(r for r in ranked.rejected if r.provider == "vultr")
    assert vultr.reason == REGION_NOT_ALLOWED
    dumped = ranked.as_dict()
    assert dumped["winner"]["source_url"] == "https://www.hetzner.com/cloud/"
    assert dumped["survivors"]
    assert dumped["survivors"][0]["provider"] == "hetzner"


def test_ceiling_400_no_winner_reports_smallest_change():
    ranked = score_candidates(_rows(), _constraints(400), FX)
    assert ranked.winner is None
    assert ranked.smallest_change is not None
    hetzner_inr = to_monthly_inr(10.99, "EUR", "monthly", FX)
    assert ranked.smallest_change.raise_ceiling_to == hetzner_inr
    assert "cpx31" in ranked.smallest_change.description


def test_under_spec_floor():
    ranked = score_candidates(_rows(), _constraints(), FX)
    cpx21 = next(r for r in ranked.rejected if r.plan_sku == "CPX21")
    assert cpx21.reason == UNDER_SPEC_FLOOR


def test_tie_break_higher_egress_then_provider_order():
    caps = ["docker", "cloud-init", "ipv4"]
    rows = [
        PlanRow(
            provider="digitalocean",
            plan_sku="cheap-a",
            vcpu=4,
            ram_gb=8,
            disk_gb=80,
            egress_tb=2,
            price=10,
            currency="USD",
            period="monthly",
            regions=["sgp1"],
            capabilities=caps,
        ),
        PlanRow(
            provider="hetzner",
            plan_sku="cheap-b",
            vcpu=4,
            ram_gb=8,
            disk_gb=80,
            egress_tb=8,
            price=10,
            currency="USD",
            period="monthly",
            regions=["sin"],
            capabilities=caps,
        ),
    ]
    ranked = score_candidates(rows, _constraints(ceiling=100000), FX)
    assert ranked.winner is not None
    assert ranked.winner.row.plan_sku == "cheap-b"
    assert ranked.runner_up is not None
    assert ranked.runner_up.row.plan_sku == "cheap-a"


def test_missing_disk_and_egress_do_not_fail_the_floor():
    caps = ["docker", "cloud-init", "ipv4"]
    row = PlanRow(
        provider="hetzner",
        plan_sku="cpx31",
        vcpu=4,
        ram_gb=8,
        disk_gb=None,
        egress_tb=None,
        price=10.99,
        currency="EUR",
        period="monthly",
        regions=["sin"],
        capabilities=caps,
    )
    ranked = score_candidates([row], _constraints(), FX)
    assert ranked.winner is not None
    assert ranked.winner.row.plan_sku == "cpx31"


def test_empty_regions_use_provider_defaults():
    row = PlanRow.from_dict(
        {
            "provider": "hetzner",
            "plan_name": "cpx31",
            "vcpu": 4,
            "ram_gb": 8,
            "disk_gb": 80,
            "egress_tb": 20,
            "price": 10.99,
            "currency": "EUR",
            "period": "monthly",
        }
    )
    assert "sin" in row.regions
    ranked = score_candidates([row], _constraints(), FX)
    assert ranked.winner is not None


def test_hourly_converted_with_730():
    row = PlanRow(
        provider="hetzner",
        plan_sku="hourly",
        vcpu=4,
        ram_gb=8,
        disk_gb=80,
        egress_tb=2,
        price=0.015,
        currency="EUR",
        period="hourly",
        regions=["sin"],
        capabilities=["docker", "cloud-init", "ipv4"],
    )
    ranked = score_candidates([row], _constraints(ceiling=100000), FX)
    assert ranked.winner is not None
    assert ranked.winner.monthly_inr == to_monthly_inr(0.015, "EUR", "hourly", FX)
