"""Pinned FX table. Never fetch a live rate — an unpinned rate makes the spec unauditable."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class FxTable:
    usd_inr: float
    pinned_at: str

    def rate_for(self, currency: str) -> float:
        code = currency.strip().upper()
        if code == "INR":
            return 1.0
        if code == "USD":
            return self.usd_inr
        raise ValueError(f"no pinned FX rate for currency {currency!r}")


def load_fx_table() -> FxTable:
    return FxTable(
        usd_inr=float(os.environ.get("FX_USD_INR", "83.0")),
        pinned_at=os.environ.get("FX_PINNED_AT", "2026-09-20T12:00:00Z"),
    )


def usd_to_inr(amount_usd: float, fx: FxTable | None = None) -> int:
    table = fx or load_fx_table()
    return int(round(amount_usd * table.usd_inr))
