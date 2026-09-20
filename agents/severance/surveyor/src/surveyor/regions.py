"""Vercel region ids → Broker canonical allowlist tokens."""

from __future__ import annotations

# Broker canonical tokens live in broker/providers.py REGION_ALIASES.
VERCEL_TO_BROKER: dict[str, str] = {
    "sin1": "sg-sin",
    "sgp1": "sg-sin",
    "bom1": "ap-south",
    "hyd1": "ap-south",
    "blr1": "in-blr",
    "syd1": "ap-south",
    "hnd1": "sg-sin",
    "icn1": "sg-sin",
    "kix1": "sg-sin",
    "fra1": "fra",
    "cdg1": "fra",
    "lhr1": "fra",
    "arn1": "fra",
    "iad1": "iad",
    "sfo1": "sfo",
    "pdx1": "sfo",
    "cle1": "iad",
    "gru1": "gru",
}

DEFAULT_REGION_ALLOWLIST = ("in-blr", "sg-sin", "ap-south")


def vercel_region_to_broker(region: str | None) -> str | None:
    if not region:
        return None
    token = region.strip().lower()
    if token in VERCEL_TO_BROKER:
        return VERCEL_TO_BROKER[token]
    if token in DEFAULT_REGION_ALLOWLIST or token in {"fra", "iad", "sfo", "gru"}:
        return token
    return VERCEL_TO_BROKER.get(token.replace("_", "-"))


def derive_allowlist(function_region: str | None) -> tuple[list[str], str]:
    mapped = vercel_region_to_broker(function_region)
    if mapped:
        return [mapped], "derived"
    return list(DEFAULT_REGION_ALLOWLIST), "default"
