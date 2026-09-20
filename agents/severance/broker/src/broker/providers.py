"""Pinned provider shortlist. The Pilot must have an adapter for every id here."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    domains: tuple[str, ...]
    search_prompt: str
    fallback_url: str
    capabilities: tuple[str, ...]
    plan_family: str


PROVIDERS: dict[str, Provider] = {
    "hetzner": Provider(
        id="hetzner",
        name="Hetzner",
        domains=("hetzner.com",),
        search_prompt="Hetzner Cloud CPX shared vCPU plan pricing page",
        fallback_url="https://www.hetzner.com/cloud/",
        capabilities=("docker", "cloud-init", "ipv4"),
        plan_family="CPX",
    ),
    "digitalocean": Provider(
        id="digitalocean",
        name="DigitalOcean",
        domains=("digitalocean.com",),
        search_prompt="DigitalOcean Droplet 4 vCPU 8 GB pricing page",
        fallback_url="https://www.digitalocean.com/pricing/droplets",
        capabilities=("docker", "cloud-init", "ipv4"),
        plan_family="basic-droplet",
    ),
    "vultr": Provider(
        id="vultr",
        name="Vultr",
        domains=("vultr.com",),
        search_prompt="Vultr Cloud Compute 4 vCPU 8 GB pricing page",
        fallback_url="https://www.vultr.com/pricing/",
        capabilities=("docker", "cloud-init", "ipv4"),
        plan_family="vc2",
    ),
}

PROVIDER_ORDER: tuple[str, ...] = ("hetzner", "digitalocean", "vultr")

# Canonical allowlist token -> names that show up on vendor pages / APIs.
REGION_ALIASES: dict[str, frozenset[str]] = {
    "sg-sin": frozenset(
        {
            "sg-sin",
            "sin",
            "sgp",
            "sgp1",
            "singapore",
            "ap-southeast",
            "ap-southeast-1",
        }
    ),
    "in-blr": frozenset(
        {
            "in-blr",
            "blr",
            "blr1",
            "bangalore",
            "bengaluru",
            "bengalooru",
        }
    ),
    "ap-south": frozenset(
        {
            "ap-south",
            "ap-south-1",
            "mumbai",
            "bom",
            "bom1",
        }
    ),
    "fra": frozenset({"fra", "frankfurt", "eu-central"}),
}


def get_provider(provider_id: str) -> Provider:
    try:
        return PROVIDERS[provider_id]
    except KeyError as exc:
        raise KeyError(f"unknown provider {provider_id!r}; shortlist is {list(PROVIDERS)}") from exc


def provider_index(provider_id: str) -> int:
    try:
        return PROVIDER_ORDER.index(provider_id)
    except ValueError:
        return len(PROVIDER_ORDER)


def normalize_region_token(token: str) -> str:
    return token.strip().lower().replace("_", "-").replace(" ", "-")


def regions_overlap_allowlist(offered: list[str], allowlist: list[str]) -> tuple[bool, str | None]:
    """Return (ok, matched_canonical_or_none)."""
    offered_norm = {normalize_region_token(r) for r in offered}
    for canonical in allowlist:
        aliases = REGION_ALIASES.get(canonical, frozenset({normalize_region_token(canonical)}))
        if offered_norm & {normalize_region_token(a) for a in aliases} or offered_norm & {
            normalize_region_token(canonical)
        }:
            return True, canonical
    return False, None
