"""Deterministic cards. Rendered from mandate / shop JSON, never written by the model."""

from __future__ import annotations

from typing import Any

from broker.contracts import CartMandate


def render_approval_card(mandate: CartMandate | dict) -> str:
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    d = mandate.decision
    c = mandate.constraints_applied
    lines: list[str] = [
        f"# Cart mandate `{mandate.mandate_id}`",
        "",
        f"**Status:** {mandate.approval.status} · expires `{mandate.expires_at}`",
        f"**Spec hash:** `{mandate.spec_hash}`",
        "",
        "## Decision",
        "",
        f"| Field | Value |",
        f"|---|---|",
        f"| Provider | {d.provider} |",
        f"| SKU | `{d.plan_sku}` |",
        f"| Region | `{d.region}` |",
        f"| Monthly | ₹{d.monthly_inr} |",
        f"| Ceiling | ₹{c.ceiling_inr_monthly} |",
        f"| Headroom | ₹{c.headroom_inr} |",
        f"| Savings vs current | ₹{mandate.savings_vs_current_inr} |",
        f"| Setup | ₹{d.setup_inr} |",
        f"| Listed | {d.listed_price.amount} {d.listed_price.currency} |",
        f"| FX | {d.fx_rate} {d.listed_price.currency}/INR pinned `{d.fx_pinned_at}` |",
        f"| Source | {d.source_url} |",
        f"| Discovered via | {d.url_discovered_via} |",
        f"| Scraped at | `{d.scraped_at}` |",
        "",
        "## Constraints applied (from the Surveyor spec — not negotiable)",
        "",
        f"- Ceiling ₹{c.ceiling_inr_monthly}",
        f"- Regions: {', '.join(c.region_allowlist)}",
        (
            f"- Spec floor: {c.spec_floor.vcpu} vCPU / {c.spec_floor.ram_gb} GB RAM / "
            f"{c.spec_floor.disk_gb} GB disk / {c.spec_floor.egress_tb} TB egress"
        ),
        "",
    ]
    if mandate.runner_up:
        ru = mandate.runner_up
        lines += [
            "## Runner-up",
            "",
            f"- {ru.provider} `{ru.plan_sku}` · ₹{ru.monthly_inr}",
            "",
        ]
    lines += ["## Rejections", ""]
    if not mandate.rejected:
        lines.append("_None._")
    else:
        for r in mandate.rejected:
            lines.append(f"- {r.provider} `{r.plan_sku}` — **{r.reason}** — {r.detail}")
    lines.append("")
    if mandate.suspect:
        lines += ["## SUSPECT (injection scanner)", ""]
        for flag in mandate.suspect:
            lines.append(f"- {flag.provider}: `{flag.quote}`")
        lines.append("")
    if mandate.lockin_inventory:
        lines += ["## Lock-in inventory (passed through for the Porter)", ""]
        for item in mandate.lockin_inventory:
            broke = "breaks on self-host" if item.breaks_on_selfhost else "portable"
            lines.append(f"- `{item.feature}` — {broke}")
        lines.append("")
    lines += [
        "---",
        "",
        f"Approve by replying exactly: `APPROVE {mandate.mandate_id}`",
        "A bare yes does not resolve this mandate. I cannot provision or purchase.",
    ]
    return "\n".join(lines)


def _plan_line(item: dict[str, Any]) -> str:
    provider = item.get("provider") or "?"
    sku = item.get("plan_sku") or "?"
    monthly = item.get("monthly_inr")
    region = item.get("region") or ""
    url = item.get("source_url") or ""
    price = f"₹{monthly}" if monthly is not None else "—"
    loc = f" · {region}" if region else ""
    link = f" · [pricing]({url})" if url else ""
    return f"- **{provider}** `{sku}` · {price}/mo{loc}{link}"


def render_shop_card(shop: dict[str, Any], mandate: CartMandate | dict | None = None) -> str:
    """Human card of suggested VPS links. Does not ask for purchase approval."""
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    plans: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in [shop.get("winner"), shop.get("runner_up"), *(shop.get("survivors") or [])]:
        if not isinstance(item, dict):
            continue
        key = (str(item.get("provider") or ""), str(item.get("plan_sku") or ""))
        if not key[0] or key in seen:
            continue
        seen.add(key)
        plans.append(item)
    mid = ""
    if mandate is not None:
        mid = mandate.mandate_id
    elif isinstance(shop.get("mandate_id"), str):
        mid = shop["mandate_id"]
    lines = [
        "# Suggested VPS",
        "",
        "I cannot buy or provision. These are scored matches with live (or fixture) pricing links.",
        "",
    ]
    if plans:
        lines += ["## Plans", ""]
        lines += [_plan_line(p) for p in plans]
        lines.append("")
    else:
        lines += ["_No plan passed the spec floor and ceiling._", ""]
    if mid:
        lines += [
            f"A signed cart mandate `{mid}` is attached for later purchase (Agent 04).",
            "",
        ]
    return "\n".join(lines)
