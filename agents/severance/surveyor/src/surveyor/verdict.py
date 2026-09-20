"""Verdict is a pure function over inventory + capacity + inputs. Never the model."""

from __future__ import annotations

from dataclasses import dataclass, field

from surveyor.capacity import CapacityResult
from surveyor.intake import Intake
from surveyor.lockin_scan import ScanResult


@dataclass
class Verdict:
    verdict: str
    blockers: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    confidence: dict[str, str] = field(default_factory=dict)


def decide(
    *,
    intake: Intake,
    scan: ScanResult | None,
    capacity: CapacityResult | None,
    mode: str,
    repo_too_large: bool = False,
    no_static_fallback: bool = False,
) -> Verdict:
    blockers: list[str] = []
    reasons: list[str] = []
    confidence = {
        "capacity": (capacity.confidence if capacity else "low"),
        "inventory": "high" if scan else "low",
        "cost": "high" if mode in {"live", "live-no-observability"} else "low",
    }
    if mode == "live-no-observability":
        confidence["capacity"] = "low"
    if mode == "static-only":
        confidence["capacity"] = "low"
        confidence["cost"] = "low"

    if intake.ceiling_inr_monthly is None:
        reasons.append("constraints.ceiling_inr_monthly is missing and is never inferred")
        return Verdict(
            verdict="NEEDS_INPUT",
            blockers=[],
            reasons=reasons,
            confidence=confidence,
        )

    if repo_too_large:
        blockers.append("REPO_TOO_LARGE")
        reasons.append("repo exceeded size/file caps")
        return Verdict("BLOCKED", blockers, reasons, confidence)

    if scan and "UNSUPPORTED_FRAMEWORK" in scan.blocked_products:
        blockers.append("UNSUPPORTED_FRAMEWORK")
        reasons.append("v1 is Next.js only")
        return Verdict("BLOCKED", blockers, reasons, confidence)

    if scan and "VERCEL_ONLY_PRODUCT" in scan.blocked_products:
        blockers.append("VERCEL_ONLY_PRODUCT")
        reasons.append("@vercel/sandbox, Workflow, or Queues with no drop-in")
        return Verdict("BLOCKED", blockers, reasons, confidence)

    if no_static_fallback:
        blockers.append("NO_VERCEL_ACCESS")
        reasons.append("no Vercel access and no static fallback possible")
        return Verdict("BLOCKED", blockers, reasons, confidence)

    breaking = []
    if scan:
        breaking = [d.feature for d in scan.details if d.breaks_on_selfhost]
    if breaking:
        reasons.append(f"{len(breaking)} lock-ins need rewrite: {', '.join(breaking[:8])}")
        if capacity:
            reasons.append(
                f"capacity fits floor {capacity.spec_floor['vcpu']}/{capacity.spec_floor['ram_gb']}/{capacity.spec_floor['disk_gb']}"
            )
        return Verdict("PROCEED_WITH_PORTER", [], reasons, confidence)

    reasons.append("no breaking lock-in; proceed")
    return Verdict("PROCEED", [], reasons, confidence)
