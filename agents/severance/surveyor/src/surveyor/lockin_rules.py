"""Lock-in rule catalogue. Data only. The scanner is dumb; this is the product."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SEVERITY_SILENT = "BREAKS_SILENTLY"
SEVERITY_LOUD = "BREAKS_LOUDLY"
SEVERITY_DEGRADES = "DEGRADES"
SEVERITY_OK = "OK"
SEVERITY_BLOCKED = "BLOCKED"


@dataclass(frozen=True)
class Matcher:
    """A text matcher. Never evaluates code."""

    kind: str  # content | path | filename
    pattern: str
    glob: str | None = None  # optional path substring filter for content


@dataclass(frozen=True)
class LockinRule:
    id: str
    feature: str
    severity: str
    breaks_on_selfhost: bool
    porter_hint: str
    matchers: tuple[Matcher, ...]
    env_keys: tuple[str, ...] = ()
    capacity_impact: dict[str, Any] | None = None
    packages: tuple[str, ...] = ()
    blocked: bool = False


def _r(
    id: str,
    feature: str,
    severity: str,
    hint: str,
    matchers: list[Matcher],
    *,
    env_keys: tuple[str, ...] = (),
    capacity_impact: dict[str, Any] | None = None,
    packages: tuple[str, ...] = (),
    blocked: bool = False,
    breaks: bool | None = None,
) -> LockinRule:
    if breaks is None:
        breaks = severity in {SEVERITY_SILENT, SEVERITY_LOUD} or (
            severity == SEVERITY_DEGRADES
        )
        if severity == SEVERITY_OK:
            breaks = False
        if severity == SEVERITY_BLOCKED:
            breaks = True
    return LockinRule(
        id=id,
        feature=feature,
        severity=severity,
        breaks_on_selfhost=breaks,
        porter_hint=hint,
        matchers=tuple(matchers),
        env_keys=env_keys,
        capacity_impact=capacity_impact,
        packages=packages,
        blocked=blocked or severity == SEVERITY_BLOCKED,
    )


RULES: tuple[LockinRule, ...] = (
    _r(
        "isr",
        "isr",
        SEVERITY_SILENT,
        "Custom cacheHandler on Redis/Valkey; persistent volume; pin revalidate",
        [
            Matcher("content", r"export\s+const\s+revalidate"),
            Matcher("content", r"revalidate\s*:"),
            Matcher("content", r"revalidatePath\s*\("),
            Matcher("content", r"revalidateTag\s*\("),
            Matcher("content", r"unstable_cache\s*\("),
            Matcher("content", r"generateStaticParams\s*\("),
        ],
    ),
    _r(
        "next/image",
        "next/image",
        SEVERITY_DEGRADES,
        "Keep built-in optimizer + volume, or imgproxy; remotePatterns must be carried over",
        [
            Matcher("content", r"from\s+['\"]next/image['\"]"),
            Matcher("content", r"images\s*:"),
        ],
        capacity_impact={"image_ram_gb": 1},
    ),
    _r(
        "edge-runtime",
        "edge-runtime",
        SEVERITY_LOUD,
        "Force nodejs runtime",
        [Matcher("content", r"export\s+const\s+runtime\s*=\s*['\"]edge['\"]")],
    ),
    _r(
        "middleware",
        "middleware",
        SEVERITY_DEGRADES,
        "Replace geo with CDN headers or GeoIP db",
        [
            Matcher("path", r"(^|/)middleware\.(ts|js)$"),
            Matcher("path", r"(^|/)proxy\.(ts|js)$"),
        ],
    ),
    _r(
        "vercel-blob",
        "@vercel/blob",
        SEVERITY_LOUD,
        "S3-compatible store (Garage/SeaweedFS) behind a thin put/list/del shim",
        [Matcher("content", r"@vercel/blob")],
        env_keys=("BLOB_READ_WRITE_TOKEN",),
        packages=("@vercel/blob",),
        capacity_impact={"disk_gb": 25},
    ),
    _r(
        "vercel-kv",
        "@vercel/kv",
        SEVERITY_LOUD,
        "Valkey/Redis + standard driver, or an Upstash-REST-compatible proxy",
        [Matcher("content", r"@vercel/kv")],
        env_keys=("KV_REST_API_URL", "KV_REST_API_TOKEN", "KV_URL"),
        packages=("@vercel/kv",),
    ),
    _r(
        "vercel-postgres",
        "@vercel/postgres",
        SEVERITY_DEGRADES,
        "Keep Neon, or pg + self-hosted Postgres; flag as data-migration item",
        [Matcher("content", r"@vercel/postgres")],
        env_keys=("POSTGRES_URL", "POSTGRES_URL_NON_POOLING"),
        packages=("@vercel/postgres",),
    ),
    _r(
        "vercel-edge-config",
        "@vercel/edge-config",
        SEVERITY_LOUD,
        "JSON/Redis-backed config",
        [Matcher("content", r"@vercel/edge-config")],
        env_keys=("EDGE_CONFIG",),
        packages=("@vercel/edge-config",),
    ),
    _r(
        "vercel-functions-sdk",
        "@vercel/functions",
        SEVERITY_SILENT,
        "Native background queue / after on long-lived Node",
        [
            Matcher("content", r"@vercel/functions"),
            Matcher("content", r"from\s+['\"]@vercel/functions['\"]"),
            Matcher("content", r"\bwaitUntil\s*\("),
        ],
        packages=("@vercel/functions",),
    ),
    _r(
        "vercel-analytics",
        "@vercel/analytics",
        SEVERITY_SILENT,
        "Plausible/Umami/PostHog or drop",
        [
            Matcher("content", r"@vercel/analytics"),
            Matcher("content", r"@vercel/speed-insights"),
            Matcher("content", r"/_vercel/insights"),
        ],
        packages=("@vercel/analytics", "@vercel/speed-insights"),
    ),
    _r(
        "vercel-flags/toolbar",
        "@vercel/flags",
        SEVERITY_LOUD,
        "OpenFeature provider / env flags",
        [
            Matcher("content", r"@vercel/flags"),
            Matcher("content", r"@vercel/toolbar"),
            Matcher("content", r"from\s+['\"]flags['\"]"),
        ],
        packages=("@vercel/flags", "@vercel/toolbar", "flags"),
    ),
    _r(
        "vercel-firewall/botid",
        "@vercel/firewall",
        SEVERITY_SILENT,
        "Caddy/Cloudflare WAF + rate limit — a security regression, surface it prominently",
        [
            Matcher("content", r"@vercel/firewall"),
            Matcher("content", r"\bbotid\b"),
        ],
        packages=("@vercel/firewall", "botid"),
    ),
    _r(
        "ai-gateway",
        "ai-gateway",
        SEVERITY_LOUD,
        "Provider keys direct, or gateway with a static key",
        [
            Matcher("content", r"AI_GATEWAY_API_KEY"),
            Matcher("content", r"VERCEL_OIDC_TOKEN"),
            Matcher("content", r"@ai-sdk/gateway"),
        ],
        env_keys=("AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"),
    ),
    _r(
        "vercel-env-vars",
        "vercel-env-vars",
        SEVERITY_SILENT,
        "Inject equivalents at container start",
        [
            Matcher("content", r"process\.env\.VERCEL"),
            Matcher("content", r"NEXT_PUBLIC_VERCEL_"),
        ],
    ),
    _r(
        "cron",
        "cron",
        SEVERITY_SILENT,
        "System cron / scheduler container hitting the same routes with the same bearer",
        [Matcher("content", r"['\"]crons['\"]\s*:", glob="vercel.json")],
        env_keys=("CRON_SECRET",),
    ),
    _r(
        "vercel-json-routing",
        "vercel-json-routing",
        SEVERITY_SILENT,
        "Port into next.config or the reverse proxy",
        [
            Matcher("content", r"['\"]rewrites['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]redirects['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]headers['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]cleanUrls['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]trailingSlash['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]routes['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"['\"]builds['\"]\s*:", glob="vercel.json"),
        ],
    ),
    _r(
        "function-config",
        "function-config",
        SEVERITY_DEGRADES,
        "Set timeouts in the proxy",
        [
            Matcher("content", r"['\"]functions['\"]\s*:", glob="vercel.json"),
            Matcher("content", r"export\s+const\s+maxDuration"),
        ],
    ),
    _r(
        "serverless-shaped-handlers",
        "serverless-shaped-handlers",
        SEVERITY_LOUD,
        "Wrap in a small server, or move into route handlers",
        [
            Matcher("content", r"export\s+default\s+function\s+handler\s*\("),
            Matcher("path", r"^api/.+\.(ts|js)$"),
        ],
    ),
    _r(
        "output-mode",
        "output-mode",
        SEVERITY_DEGRADES,
        "Set output: 'standalone'",
        [Matcher("filename", r"next\.config\.")],
    ),
    _r(
        "draft-mode/preview",
        "draft-mode/preview",
        SEVERITY_DEGRADES,
        "Own preview auth",
        [
            Matcher("content", r"draftMode\s*\("),
            Matcher("content", r"x-vercel-protection-bypass"),
        ],
    ),
    _r(
        "skew-protection",
        "skew-protection",
        SEVERITY_DEGRADES,
        "Keep previous build served for N minutes",
        [
            Matcher("content", r"skewProtection"),
            Matcher("content", r"skew-protection"),
        ],
    ),
    _r(
        "og-images",
        "og-images",
        SEVERITY_OK,
        "none",
        [
            Matcher("content", r"from\s+['\"]next/og['\"]"),
            Matcher("content", r"@vercel/og"),
            Matcher("content", r"ImageResponse"),
        ],
        packages=("@vercel/og",),
        breaks=False,
    ),
    _r(
        "sandbox/workflow/queue",
        "sandbox/workflow/queue",
        SEVERITY_BLOCKED,
        "Rewrite or exclude",
        [
            Matcher("content", r"@vercel/sandbox"),
            Matcher("content", r"@vercel/queue"),
            Matcher("content", r"from\s+['\"]workflow['\"]"),
        ],
        packages=("@vercel/sandbox", "@vercel/queue", "workflow"),
        blocked=True,
    ),
)

ENV_MAP: dict[str, str] = {
    "BLOB_READ_WRITE_TOKEN": "@vercel/blob",
    "KV_REST_API_URL": "@vercel/kv",
    "KV_REST_API_TOKEN": "@vercel/kv",
    "KV_URL": "@vercel/kv",
    "POSTGRES_URL": "@vercel/postgres",
    "POSTGRES_URL_NON_POOLING": "@vercel/postgres",
    "EDGE_CONFIG": "@vercel/edge-config",
    "CRON_SECRET": "cron",
    "VERCEL_OIDC_TOKEN": "ai-gateway",
    "AI_GATEWAY_API_KEY": "ai-gateway",
}

OTHER_FRAMEWORK_PACKAGES = (
    "nuxt",
    "nuxt3",
    "@sveltejs/kit",
    "astro",
    "@remix-run/node",
    "@remix-run/react",
    "vite",
)

SKIP_DIR_NAMES = {
    "node_modules",
    ".git",
    ".next",
    "dist",
    ".vercel",
    "__pycache__",
    ".turbo",
}

SCAN_SUFFIXES = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".mts",
    ".cts",
}

RULES_BY_ID: dict[str, LockinRule] = {r.id: r for r in RULES}

# Features that test 1 (lockin_heavy) must fire. BLOCKED + other-framework are separate tests.
HEAVY_RULE_IDS: tuple[str, ...] = tuple(
    r.id for r in RULES if r.severity != SEVERITY_BLOCKED
)
