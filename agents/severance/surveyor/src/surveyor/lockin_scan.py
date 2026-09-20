"""Pure lock-in scanner. Rules × file tree. Never executes the repo."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from surveyor.contracts import EvidenceHit, LockinDetail, LockinFeature
from surveyor.lockin_rules import (
    ENV_MAP,
    HEAVY_RULE_IDS,
    OTHER_FRAMEWORK_PACKAGES,
    RULES,
    RULES_BY_ID,
    SCAN_SUFFIXES,
    SKIP_DIR_NAMES,
    LockinRule,
    Matcher,
)
from surveyor.redact import sanitize_snippet

MAX_FILE_BYTES = 1 * 1024 * 1024


@dataclass
class ScanResult:
    framework: str
    details: list[LockinDetail] = field(default_factory=list)
    inventory: list[LockinFeature] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    blocked_products: list[str] = field(default_factory=list)


def _iter_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(root).parts
        if any(part in SKIP_DIR_NAMES for part in rel_parts):
            continue
        if path.suffix.lower() not in SCAN_SUFFIXES and path.name not in {
            "vercel.json",
            "next.config.js",
            "next.config.mjs",
            "next.config.ts",
            "package.json",
        }:
            if path.suffix:
                continue
        yield path


def _read_text(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > MAX_FILE_BYTES:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _line_of(text: str, match: re.Match[str]) -> int:
    return text.count("\n", 0, match.start()) + 1


def detect_framework(root: Path) -> str:
    pkg_path = root / "package.json"
    if not pkg_path.is_file():
        # maybe a single nested package.json
        found = list(root.glob("*/package.json"))
        pkg_path = found[0] if found else pkg_path
    if not pkg_path.is_file():
        return "unknown"
    try:
        data = json.loads(pkg_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unknown"
    deps = {}
    for key in ("dependencies", "devDependencies"):
        block = data.get(key) or {}
        if isinstance(block, dict):
            deps.update(block)
    if "next" in deps:
        return "next"
    for name in OTHER_FRAMEWORK_PACKAGES:
        if name in deps:
            if name == "vite" and "next" not in deps:
                return "other"
            if name != "vite":
                return "other"
    return "other" if deps else "unknown"


def _package_hit(root: Path, packages: tuple[str, ...]) -> EvidenceHit | None:
    pkg_path = root / "package.json"
    if not pkg_path.is_file():
        found = list(root.glob("*/package.json"))
        pkg_path = found[0] if len(found) == 1 else pkg_path
    if not pkg_path.is_file():
        return None
    text = _read_text(pkg_path)
    if text is None:
        return None
    for pkg in packages:
        if f'"{pkg}"' in text or f"'{pkg}'" in text:
            for i, line in enumerate(text.splitlines(), 1):
                if pkg in line:
                    return EvidenceHit(
                        file=_rel(root, pkg_path),
                        line=i,
                        rule="pkg.import",
                        match=sanitize_snippet(line),
                    )
    return None


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return path.name


def _match_rule(root: Path, rule: LockinRule) -> list[EvidenceHit]:
    hits: list[EvidenceHit] = []
    if rule.packages:
        pkg_hit = _package_hit(root, rule.packages)
        if pkg_hit:
            pkg_hit.rule = f"pkg.{rule.id}"
            hits.append(pkg_hit)

    compiled = [(m, re.compile(m.pattern)) for m in rule.matchers]
    for path in _iter_files(root):
        rel = _rel(root, path)
        text = None
        for matcher, cre in compiled:
            if matcher.glob and matcher.glob not in rel and path.name != matcher.glob:
                continue
            if matcher.kind == "path":
                if cre.search(rel):
                    hits.append(
                        EvidenceHit(
                            file=rel,
                            line=1,
                            rule=rule.id,
                            match=sanitize_snippet(rel),
                        )
                    )
                continue
            if matcher.kind == "filename":
                if cre.search(path.name) or cre.search(rel):
                    if rule.id == "output-mode":
                        text = text if text is not None else _read_text(path)
                        if text is not None and "standalone" in text:
                            continue
                    hits.append(
                        EvidenceHit(
                            file=rel,
                            line=1,
                            rule=rule.id,
                            match=sanitize_snippet(path.name),
                        )
                    )
                continue
            if matcher.kind == "content":
                if text is None:
                    text = _read_text(path)
                if not text:
                    continue
                found = cre.search(text)
                if found:
                    line = text.splitlines()[_line_of(text, found) - 1]
                    hits.append(
                        EvidenceHit(
                            file=rel,
                            line=_line_of(text, found),
                            rule=rule.id,
                            match=sanitize_snippet(line),
                        )
                    )
    return hits


def _env_keys_for(env_inventory: list[dict[str, Any]] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for row in env_inventory or []:
        key = str(row.get("key") or "")
        if not key:
            continue
        mapped = row.get("maps_to") or ENV_MAP.get(key)
        out[key] = str(mapped) if mapped else ""
    return out


def scan_lockin(
    tree_handle: str | Path,
    env_inventory: list[dict[str, Any]] | None = None,
    deployments: dict[str, Any] | None = None,
    *,
    metrics_flags: dict[str, Any] | None = None,
) -> ScanResult:
    root = Path(tree_handle)
    framework = detect_framework(root)
    env_keys = _env_keys_for(env_inventory)
    details: list[LockinDetail] = []
    blocked: list[str] = []
    warnings: list[str] = []

    if framework == "other":
        details.append(
            LockinDetail(
                feature="other-framework",
                severity="BLOCKED",
                breaks_on_selfhost=True,
                evidence=[
                    EvidenceHit(
                        file="package.json",
                        line=1,
                        rule="other-framework",
                        match="non-Next framework in package.json",
                    )
                ],
                porter_hint="v1 is Next.js only",
            )
        )
        blocked.append("UNSUPPORTED_FRAMEWORK")

    for rule in RULES:
        hits = _match_rule(root, rule)
        if deployments and rule.id == "edge-runtime":
            for fn in deployments.get("functions") or []:
                if str(fn.get("runtime") or "").lower() == "edge":
                    hits.append(
                        EvidenceHit(
                            file=str(fn.get("route") or "deployment"),
                            line=1,
                            rule="manifest.edge",
                            match="runtime=edge",
                        )
                    )
        if not hits:
            continue
        env_hit = [k for k in rule.env_keys if k in env_keys]
        details.append(
            LockinDetail(
                feature=rule.feature,
                severity=rule.severity,
                breaks_on_selfhost=rule.breaks_on_selfhost,
                evidence=hits,
                env_corroboration=env_hit,
                porter_hint=rule.porter_hint,
                capacity_impact=rule.capacity_impact,
            )
        )
        if rule.blocked:
            blocked.append("VERCEL_ONLY_PRODUCT")

    features_found = {d.feature for d in details}
    for key, mapped in env_keys.items():
        if not mapped:
            continue
        if mapped not in features_found and mapped not in {d.feature for d in details}:
            # DECLARED_UNUSED: env present, no matching lock-in row
            related = any(mapped == d.feature or mapped in d.feature for d in details)
            if not related:
                warnings.append(f"DECLARED_UNUSED:{key}")

    for detail in details:
        rule = next((r for r in RULES if r.feature == detail.feature), None)
        if rule and rule.env_keys:
            if not any(k in env_keys for k in rule.env_keys):
                warnings.append(f"USED_MISSING:{detail.feature}")

    flags = metrics_flags or {}
    if flags.get("isr_operations", 0) and "isr" not in features_found:
        warnings.append("INVENTORY_GAP:isr")

    inventory = [
        LockinFeature(feature=d.feature, breaks_on_selfhost=d.breaks_on_selfhost)
        for d in details
    ]
    return ScanResult(
        framework="next" if framework == "next" else framework,
        details=details,
        inventory=inventory,
        warnings=warnings,
        blocked_products=blocked,
    )


def rule_ids_fired(result: ScanResult) -> set[str]:
    ids: set[str] = set()
    for detail in result.details:
        for ev in detail.evidence:
            if ev.rule in RULES_BY_ID:
                ids.add(ev.rule)
            else:
                # map feature back to id
                for rule in RULES:
                    if rule.feature == detail.feature:
                        ids.add(rule.id)
    for detail in result.details:
        for rule in RULES:
            if rule.feature == detail.feature:
                ids.add(rule.id)
    return ids


__all__ = ["scan_lockin", "ScanResult", "HEAVY_RULE_IDS", "rule_ids_fired"]
