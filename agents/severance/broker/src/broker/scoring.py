"""Hard filters + rank. No network. No LLM."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from broker.contracts import Constraints, SpecFloor
from broker.fx import FxTable, load_fx_table, to_monthly_inr
from broker.providers import get_provider, provider_index, regions_overlap_allowlist

OVER_CEILING = "OVER_CEILING"
REGION_NOT_ALLOWED = "REGION_NOT_ALLOWED"
UNDER_SPEC_FLOOR = "UNDER_SPEC_FLOOR"
MISSING_CAPABILITY = "MISSING_CAPABILITY"


def _optional_float(data: dict[str, Any], key: str) -> float | None:
    if key not in data or data[key] is None or data[key] == "":
        return None
    return float(data[key])


@dataclass
class PlanRow:
    provider: str
    plan_sku: str
    vcpu: float
    ram_gb: float
    price: float
    currency: str
    period: str
    disk_gb: float | None = None
    egress_tb: float | None = None
    regions: list[str] = field(default_factory=list)
    capabilities: list[str] = field(default_factory=list)
    source_url: str = ""
    url_discovered_via: str = "anakin-search"
    scraped_at: str = ""
    suspect: bool = False
    suspect_quote: str = ""
    listed_name: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any], *, provider: str | None = None) -> PlanRow:
        pid = provider or str(data.get("provider") or "")
        sku = str(data.get("plan_sku") or data.get("plan_name") or "")
        caps = data.get("capabilities")
        if not caps:
            try:
                caps = list(get_provider(pid).capabilities)
            except KeyError:
                caps = []
        regions = [str(r) for r in (data.get("regions") or [])]
        if not regions:
            try:
                regions = list(get_provider(pid).default_regions)
            except KeyError:
                regions = []
        return cls(
            provider=pid,
            plan_sku=sku,
            listed_name=str(data.get("plan_name") or sku),
            vcpu=float(data.get("vcpu") or 0),
            ram_gb=float(data.get("ram_gb") or 0),
            disk_gb=_optional_float(data, "disk_gb"),
            egress_tb=_optional_float(data, "egress_tb"),
            price=float(data.get("price") or 0),
            currency=str(data.get("currency") or "USD"),
            period=str(data.get("period") or "monthly"),
            regions=regions,
            capabilities=[str(c) for c in caps],
            source_url=str(data.get("source_url") or ""),
            url_discovered_via=str(data.get("url_discovered_via") or "anakin-search"),
            scraped_at=str(data.get("scraped_at") or ""),
            suspect=bool(data.get("suspect") or False),
            suspect_quote=str(data.get("suspect_quote") or ""),
        )


@dataclass
class ScoredPlan:
    row: PlanRow
    monthly_inr: int
    fx_rate: float
    fx_pinned_at: str
    matched_region: str | None = None


@dataclass
class RejectedPlan:
    provider: str
    plan_sku: str
    reason: str
    detail: str
    monthly_inr: int | None = None


@dataclass
class SmallestChange:
    description: str
    raise_ceiling_to: int | None = None
    provider: str | None = None
    plan_sku: str | None = None


@dataclass
class RankedResult:
    winner: ScoredPlan | None
    runner_up: ScoredPlan | None
    rejected: list[RejectedPlan]
    survivors: list[ScoredPlan]
    smallest_change: SmallestChange | None = None

    def as_dict(self) -> dict[str, Any]:
        def dump_scored(item: ScoredPlan | None) -> dict[str, Any] | None:
            if item is None:
                return None
            return {
                "provider": item.row.provider,
                "plan_sku": item.row.plan_sku,
                "monthly_inr": item.monthly_inr,
                "region": item.matched_region,
                "vcpu": item.row.vcpu,
                "ram_gb": item.row.ram_gb,
                "disk_gb": item.row.disk_gb,
                "egress_tb": item.row.egress_tb,
                "listed_price": {"amount": item.row.price, "currency": item.row.currency},
                "fx_rate": item.fx_rate,
                "fx_pinned_at": item.fx_pinned_at,
                "source_url": item.row.source_url,
                "url_discovered_via": item.row.url_discovered_via,
                "scraped_at": item.row.scraped_at,
                "period": item.row.period,
                "suspect": item.row.suspect,
                "suspect_quote": item.row.suspect_quote,
            }

        out: dict[str, Any] = {
            "winner": dump_scored(self.winner),
            "runner_up": dump_scored(self.runner_up),
            "survivors": [dump_scored(item) for item in self.survivors],
            "rejected": [
                {
                    "provider": r.provider,
                    "plan_sku": r.plan_sku,
                    "reason": r.reason,
                    "detail": r.detail,
                }
                for r in self.rejected
            ],
        }
        if self.smallest_change:
            out["smallest_change"] = {
                "description": self.smallest_change.description,
                "raise_ceiling_to": self.smallest_change.raise_ceiling_to,
                "provider": self.smallest_change.provider,
                "plan_sku": self.smallest_change.plan_sku,
            }
        return out


def _under_floor(row: PlanRow, floor: SpecFloor) -> str | None:
    checks = (
        ("vcpu", row.vcpu, floor.vcpu),
        ("ram_gb", row.ram_gb, floor.ram_gb),
        ("disk_gb", row.disk_gb, floor.disk_gb),
        ("egress_tb", row.egress_tb, floor.egress_tb),
    )
    failed = []
    for name, actual, need in checks:
        if actual is None:
            continue
        if actual < need:
            failed.append(f"{name} {actual} < {need}")
    if failed:
        return "; ".join(failed)
    return None


def _missing_caps(row: PlanRow, required: list[str]) -> str | None:
    have = {c.lower() for c in row.capabilities}
    missing = [c for c in required if c.lower() not in have]
    if missing:
        return "missing " + ", ".join(missing)
    return None


def score_candidates(
    rows: list[PlanRow] | list[dict[str, Any]],
    constraints: Constraints | dict[str, Any],
    fx: FxTable | None = None,
) -> RankedResult:
    table = fx or load_fx_table()
    if isinstance(constraints, dict):
        constraints = Constraints.model_validate(constraints)

    parsed: list[PlanRow] = [
        r if isinstance(r, PlanRow) else PlanRow.from_dict(r) for r in rows
    ]

    rejected: list[RejectedPlan] = []
    otherwise_valid: list[ScoredPlan] = []
    survivors: list[ScoredPlan] = []

    for row in parsed:
        monthly = to_monthly_inr(row.price, row.currency, row.period, table)
        try:
            fx_rate = table.rate_for(row.currency)
        except ValueError as exc:
            rejected.append(
                RejectedPlan(row.provider, row.plan_sku, "UNSUPPORTED_CURRENCY", str(exc), monthly)
            )
            continue

        floor_fail = _under_floor(row, constraints.spec_floor)
        if floor_fail:
            rejected.append(
                RejectedPlan(row.provider, row.plan_sku, UNDER_SPEC_FLOOR, floor_fail, monthly)
            )
            continue

        cap_fail = _missing_caps(row, constraints.must_support)
        if cap_fail:
            rejected.append(
                RejectedPlan(row.provider, row.plan_sku, MISSING_CAPABILITY, cap_fail, monthly)
            )
            continue

        ok_region, matched = regions_overlap_allowlist(row.regions, constraints.region_allowlist)
        if not ok_region:
            offered = ",".join(row.regions) or "(none)"
            rejected.append(
                RejectedPlan(
                    row.provider,
                    row.plan_sku,
                    REGION_NOT_ALLOWED,
                    f"{offered} not in allowlist",
                    monthly,
                )
            )
            continue

        scored = ScoredPlan(
            row=row,
            monthly_inr=monthly,
            fx_rate=fx_rate,
            fx_pinned_at=table.pinned_at,
            matched_region=matched,
        )
        otherwise_valid.append(scored)
        if monthly > constraints.ceiling_inr_monthly:
            rejected.append(
                RejectedPlan(
                    row.provider,
                    row.plan_sku,
                    OVER_CEILING,
                    f"{monthly} > {constraints.ceiling_inr_monthly}",
                    monthly,
                )
            )
            continue
        survivors.append(scored)

    survivors.sort(
        key=lambda s: (
            s.monthly_inr,
            -(s.row.egress_tb or 0),
            provider_index(s.row.provider),
            s.row.plan_sku,
        )
    )
    winner = survivors[0] if survivors else None
    runner_up = survivors[1] if len(survivors) > 1 else None

    smallest: SmallestChange | None = None
    if winner is None:
        ceiling_only = [s for s in otherwise_valid if s.monthly_inr > constraints.ceiling_inr_monthly]
        # otherwise_valid includes both over-ceiling and survivors; survivors is empty here
        # so ceiling_only is plans that passed spec+region+caps but not ceiling.
        if ceiling_only:
            cheapest = min(ceiling_only, key=lambda s: s.monthly_inr)
            smallest = SmallestChange(
                description=(
                    f"raise constraints.ceiling_inr_monthly from "
                    f"{constraints.ceiling_inr_monthly} to {cheapest.monthly_inr} "
                    f"to admit {cheapest.row.provider} {cheapest.row.plan_sku}"
                ),
                raise_ceiling_to=cheapest.monthly_inr,
                provider=cheapest.row.provider,
                plan_sku=cheapest.row.plan_sku,
            )
        elif rejected:
            smallest = SmallestChange(
                description="no plan meets region allowlist, spec floor, and required capabilities"
            )

    return RankedResult(
        winner=winner,
        runner_up=runner_up,
        rejected=rejected,
        survivors=survivors,
        smallest_change=smallest,
    )
