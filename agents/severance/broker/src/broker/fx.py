"""Pinned FX table. Never fetch a live rate — an unpinned rate makes the mandate unauditable."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class FxTable:
    eur_inr: float
    usd_inr: float
    pinned_at: str

    def rate_for(self, currency: str) -> float:
        code = currency.strip().upper()
        if code == "INR":
            return 1.0
        if code == "EUR":
            return self.eur_inr
        if code == "USD":
            return self.usd_inr
        raise ValueError(f"no pinned FX rate for currency {currency!r}")


def load_fx_table() -> FxTable:
    return FxTable(
        eur_inr=float(os.environ.get("FX_EUR_INR", "94.2")),
        usd_inr=float(os.environ.get("FX_USD_INR", "83.0")),
        pinned_at=os.environ.get("FX_PINNED_AT", "2026-09-20T12:00:00Z"),
    )


def to_monthly_inr(amount: float, currency: str, period: str, fx: FxTable | None = None) -> int:
    table = fx or load_fx_table()
    monthly = amount if period == "monthly" else amount * 730.0
    return int(round(monthly * table.rate_for(currency)))
