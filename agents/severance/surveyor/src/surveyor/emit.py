"""Assemble + validate the one JSON file. Render a deterministic text card."""

from __future__ import annotations

from typing import Any

from surveyor.capacity import CapacityResult
from surveyor.contracts import SCHEMA_SPEC, MUST_SUPPORT, isoformat_z
from surveyor.cost import CostResult
from surveyor.intake import Intake
from surveyor.lockin_scan import ScanResult
from surveyor.redact import redact_obj, sanitize_snippet
from surveyor.verdict import Verdict


def _thin_inventory(scan: ScanResult | None) -> list[dict[str, Any]]:
    if not scan:
        return []
    return [
        {"feature": i.feature, "breaks_on_selfhost": i.breaks_on_selfhost}
        for i in scan.inventory
    ]


def _lockin_detail(scan: ScanResult | None) -> list[dict[str, Any]]:
    if not scan:
        return []
    out = []
    for d in scan.details:
        evidence = []
        for hit in d.evidence:
            evidence.append(
                {
                    "file": hit.file,
                    "line": hit.line,
                    "rule": hit.rule,
                    "match": sanitize_snippet(hit.match),
                }
            )
        out.append(
            {
                "feature": d.feature,
                "severity": d.severity,
                "breaks_on_selfhost": d.breaks_on_selfhost,
                "evidence": evidence,
                "env_corroboration": d.env_corroboration,
                "porter_hint": d.porter_hint,
                "capacity_impact": d.capacity_impact,
            }
        )
    return out


def emit_result(
    *,
    intake: Intake,
    mode: str,
    verdict: Verdict,
    capacity: CapacityResult,
    scan: ScanResult | None,
    cost: CostResult | None,
    predictions: dict[str, Any],
    surveyor_meta: dict[str, Any],
    generated_at: str | None = None,
    include_current_cost: bool = True,
) -> dict[str, Any]:
    ts = generated_at or isoformat_z()
    source = intake.name or intake.repo_slug or "unknown"
    constraints: dict[str, Any] = {
        "region_allowlist": intake.region_allowlist or [],
        "region_source": intake.region_source,
        "spec_floor": capacity.spec_floor,
        "must_support": list(MUST_SUPPORT),
    }
    if intake.ceiling_inr_monthly is not None:
        constraints["ceiling_inr_monthly"] = intake.ceiling_inr_monthly

    doc: dict[str, Any] = {
        "schema": SCHEMA_SPEC,
        "generated_at": ts,
        "source_project": source,
        "capacity": capacity.capacity_block(),
        "constraints": constraints,
        "lockin_inventory": _thin_inventory(scan),
        "decision": {
            "verdict": verdict.verdict,
            "blockers": verdict.blockers,
            "reasons": verdict.reasons,
            "confidence": verdict.confidence,
        },
        "lockin_detail": _lockin_detail(scan),
        "surveyor": surveyor_meta,
        "predictions": predictions,
        "capacity_if_cdn": capacity.capacity_if_cdn,
    }
    if include_current_cost and cost is not None:
        doc["current_cost"] = cost.as_current_cost()

    return redact_obj(doc)


def render_card(doc: dict[str, Any]) -> str:
    decision = doc.get("decision") or {}
    cap = doc.get("capacity") or {}
    floor = (doc.get("constraints") or {}).get("spec_floor") or {}
    cost = doc.get("current_cost")
    lockin = doc.get("lockin_inventory") or []
    ceiling = (doc.get("constraints") or {}).get("ceiling_inr_monthly")
    lines = [
        f"# Surveyor result `{doc.get('source_project')}`",
        "",
        f"**Verdict:** {decision.get('verdict')} · mode `{ (doc.get('surveyor') or {}).get('mode') }`",
        f"**Generated:** `{doc.get('generated_at')}`",
        "",
        "## Capacity",
        "",
        "| Field | Demand | Spec floor |",
        "|---|---|---|",
        f"| vCPU | {cap.get('vcpu')} | {floor.get('vcpu')} |",
        f"| RAM GB | {cap.get('ram_gb')} | {floor.get('ram_gb')} |",
        f"| Disk GB | {cap.get('disk_gb')} | {floor.get('disk_gb')} |",
        f"| Egress TB | {cap.get('egress_tb')} | {floor.get('egress_tb')} |",
        "",
        f"Headroom factor: {cap.get('headroom_factor')} · {cap.get('derived_from')}",
        "",
        "## Constraints",
        "",
        f"- Ceiling ₹{ceiling if ceiling is not None else 'MISSING (never inferred)'}",
        f"- Regions: {', '.join((doc.get('constraints') or {}).get('region_allowlist') or [])}",
        f"- must_support: {', '.join((doc.get('constraints') or {}).get('must_support') or [])}",
        "",
    ]
    if cost:
        lines += [
            "## Current cost",
            "",
            f"- ₹{cost.get('monthly_inr')} / month ({cost.get('usd')} {cost.get('billing_currency')})",
            f"- FX {cost.get('fx_usd_inr')} pinned `{cost.get('fx_pinned_at')}`",
            f"- {cost.get('evidence')}",
            f"- includes_seats: {cost.get('includes_seats')}",
            "",
        ]
    lines += ["## Lock-in inventory", ""]
    if not lockin:
        lines.append("_None._")
    else:
        for item in lockin:
            broke = "breaks on self-host" if item.get("breaks_on_selfhost") else "portable"
            lines.append(f"- `{item.get('feature')}` — {broke}")
    lines += ["", "## Decision reasons", ""]
    for reason in decision.get("reasons") or []:
        lines.append(f"- {reason}")
    if decision.get("blockers"):
        lines.append("")
        lines.append("Blockers: " + ", ".join(decision["blockers"]))
    pred = doc.get("predictions") or {}
    if pred.get("prediction_hash"):
        lines += ["", f"Prediction hash: `{pred['prediction_hash']}`"]
    lines += [
        "",
        "---",
        "",
        "I cannot provision or purchase. Numbers come from APIs and rules, not from me.",
    ]
    if ceiling is None:
        lines += [
            "",
            "Send `ceiling_inr_monthly` to complete. A ceiling is never inferred.",
        ]
    return "\n".join(lines)
