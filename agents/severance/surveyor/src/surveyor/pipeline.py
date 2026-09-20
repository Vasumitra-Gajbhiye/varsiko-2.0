"""Code pipeline. The LLM never sizes a server, classifies lock-in, or picks a verdict."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from surveyor.capacity import MetricsBundle, derive_capacity, static_default_capacity
from surveyor.contracts import isoformat_z
from surveyor.cost import pull_cost
from surveyor.emit import emit_result, render_card
from surveyor.fixture_store import repo_fixture
from surveyor.intake import Intake
from surveyor.lockin_scan import scan_lockin
from surveyor.metrics import pull_metrics
from surveyor.predict import build_predictions
from surveyor.regions import derive_allowlist
from surveyor.repo_fetch import RepoFetchError, fetch_repo
from surveyor.vercel_client import ResolvedProject, VercelClient, VercelError
from surveyor.verdict import decide

StageCb = Callable[[str], None]


@dataclass
class PipelineResult:
    mode: str = "static-only"
    intake: Intake | None = None
    document: dict[str, Any] | None = None
    card: str = ""
    park: str | None = None
    park_message: str = ""
    candidates: list[dict[str, str]] = field(default_factory=list)
    error: dict[str, Any] | None = None
    stages: list[str] = field(default_factory=list)

    def as_narration(self) -> str:
        if self.card:
            return self.card
        if self.error:
            return f"{self.error.get('error')}: {self.error.get('message')}"
        return "No result."


def _offline(flag: bool | None) -> bool:
    if flag is not None:
        return flag
    return os.environ.get("SURVEYOR_OFFLINE", "").strip() not in {"", "0", "false", "False"}


def _pick_repo_fixture(intake: Intake) -> Path | None:
    url = f"{intake.repo_url or ''} {intake.name or ''} {intake.raw_text or ''}".lower()
    mapping = (
        ("lockin-heavy", "lockin_heavy"),
        ("poisoned", "poisoned"),
        ("nuxt", "other_framework"),
        ("sandbox", "sandbox"),
        ("unlinked", "clean"),
        ("clean", "clean"),
        ("ambiguous", "lockin_heavy"),
        ("victim-app", "lockin_heavy"),
    )
    for needle, name in mapping:
        if needle in url:
            path = repo_fixture(name)
            if path.is_dir():
                return path
    default = repo_fixture("lockin_heavy")
    return default if default.is_dir() else None


def run_pipeline(
    intake: Intake,
    *,
    offline: bool | None = None,
    on_stage: StageCb | None = None,
    force_metrics_403: bool = False,
    force_egress_conflict: bool = False,
) -> PipelineResult:
    result = PipelineResult(intake=intake)
    if intake.pasted_secret:
        result.error = {
            "error": "SECRET_IN_CHAT",
            "message": "Secrets never travel in the message. Set VERCEL_TOKEN / GITHUB_TOKEN via nasiko secrets.",
        }
        result.card = result.error["message"]
        return result
    if not intake.repo_url:
        result.error = {"error": "MISSING_REPO", "message": "Need a GitHub URL."}
        result.card = result.error["message"]
        return result

    def stage(name: str) -> None:
        result.stages.append(name)
        if on_stage:
            on_stage(name)

    use_offline = _offline(offline)
    client = VercelClient(offline=use_offline)
    tmp: tempfile.TemporaryDirectory[str] | None = None
    try:
        stage("resolving project")
        try:
            project = client.resolve_project(
                intake.repo_url,
                team=intake.vercel_team,
                project=intake.vercel_project,
            )
        except VercelError as exc:
            project = ResolvedProject(
                team=None,
                project_id="",
                name="",
                framework="",
                region=None,
                fluid=False,
                root_dir=".",
                missing=True,
            )
            vercel_error = exc
        else:
            vercel_error = None

        if project.ambiguous:
            result.mode = "needs-input"
            result.park = "project"
            result.candidates = project.candidates
            names = ", ".join(f"{c['name']} ({c['id']})" for c in project.candidates)
            result.park_message = (
                f"Several Vercel projects match this repo. Send vercel_project=<id>. Candidates: {names}"
            )

        if intake.region_allowlist is None:
            allow, source = derive_allowlist(project.region)
            intake.region_allowlist = allow
            intake.region_source = source

        env_inventory: list[dict[str, Any]] = []
        deployments: dict[str, Any] = {}
        cost = None
        metrics: MetricsBundle | None = None
        mode = "static-only"
        observability = False

        if project.ambiguous:
            mode = "needs-input"
        elif project.missing or not project.project_id:
            mode = "static-only"
        else:
            stage("pulling billing")
            now = datetime.now(timezone.utc)
            start = now - timedelta(days=intake.window_days)
            try:
                rows = client.pull_billing_rows(
                    project.project_id,
                    int(start.timestamp() * 1000),
                    int(now.timestamp() * 1000),
                    team=project.team,
                )
                window = f"{start.date()}..{now.date()}"
                cost = pull_cost(rows, project.project_id, window=window)
            except VercelError:
                cost = None
            try:
                env_inventory = client.pull_env_inventory(project.project_id, team=project.team)
            except VercelError:
                env_inventory = []
            try:
                deployments = client.pull_deployments(project.project_id, team=project.team)
            except VercelError:
                deployments = {}

            stage("querying metrics")
            try:
                metrics = pull_metrics(
                    project.project_id,
                    project.team,
                    start=start.isoformat(),
                    end=now.isoformat(),
                    window_days=intake.window_days,
                    offline=use_offline,
                    force_403=force_metrics_403,
                )
            except VercelError:
                metrics = MetricsBundle(unavailable=["observability_plus_required"], window_days=intake.window_days)

            if metrics.unavailable and not metrics.available:
                mode = "live-no-observability"
                observability = False
            else:
                mode = "live"
                observability = True

        if intake.ceiling_inr_monthly is None and result.park != "project":
            result.park = "ceiling"
            result.park_message = (
                "constraints.ceiling_inr_monthly is required and is never inferred. "
                "Reply with ceiling_inr_monthly: 1500 (or a JSON object with that field)."
            )
            mode = "needs-input"

        stage("walking repo")
        tree_root: Path | None = None
        repo_too_large = False
        fetch_failed = False
        fixture_path = _pick_repo_fixture(intake) if use_offline else None
        if fixture_path:
            tmp = tempfile.TemporaryDirectory(prefix="surveyor-")
            dest = Path(tmp.name) / "tree"
            shutil.copytree(fixture_path, dest)
            tree_root = dest
        else:
            tmp = tempfile.TemporaryDirectory(prefix="surveyor-")
            try:
                handle = fetch_repo(
                    intake.repo_url,
                    intake.ref,
                    dest=Path(tmp.name) / "tree",
                )
                tree_root = handle.root
            except RepoFetchError as exc:
                fetch_failed = True
                if exc.code == "REPO_TOO_LARGE":
                    repo_too_large = True
                tree_root = None

        scan = None
        if tree_root is not None:
            scan_root = tree_root
            if intake.subdir:
                candidate = tree_root / intake.subdir
                if candidate.is_dir():
                    scan_root = candidate
            elif project.root_dir not in {"", ".", None}:
                candidate = tree_root / str(project.root_dir)
                if candidate.is_dir():
                    scan_root = candidate
            scan = scan_lockin(
                scan_root,
                env_inventory=env_inventory,
                deployments=deployments,
                metrics_flags={"isr_operations": (metrics.isr_operations if metrics else 0)},
            )

        stage("deriving spec")
        billing_tb = None
        if cost and cost.bandwidth_gb:
            billing_tb = (cost.bandwidth_gb / 1000.0) * (30.0 / max(intake.window_days, 1))
        if force_egress_conflict:
            billing_tb = 0.4
        function_mem = None
        for fn in (deployments or {}).get("functions") or []:
            mem = fn.get("memory")
            if mem:
                function_mem = float(mem) / 1024.0 if float(mem) > 32 else float(mem)
                break

        if mode in {"live", "live-no-observability"} and metrics is not None:
            capacity = derive_capacity(
                metrics,
                scan.details if scan else [],
                billing_bandwidth_tb=billing_tb,
                function_memory_gb=function_mem,
                observability=observability,
            )
        else:
            capacity = static_default_capacity()
            if scan:
                capacity = derive_capacity(
                    MetricsBundle(window_days=intake.window_days),
                    scan.details,
                    observability=False,
                    function_memory_gb=function_mem,
                )

        if capacity.evidence_conflicts:
            if capacity.confidence == "high":
                capacity.confidence = "medium"
            elif capacity.confidence == "medium":
                capacity.confidence = "low"

        result.mode = mode
        verdict = decide(
            intake=intake,
            scan=scan,
            capacity=capacity,
            mode=mode,
            repo_too_large=repo_too_large,
            no_static_fallback=fetch_failed and tree_root is None and mode == "static-only" and scan is None,
        )
        predictions = build_predictions(capacity, metrics, scan)
        warnings = list((scan.warnings if scan else []) + capacity.warnings)
        if vercel_error:
            warnings.append(f"VERCEL:{vercel_error.code}")
        meta = {
            "version": "0.1.0",
            "mode": mode,
            "window": {
                "days": intake.window_days,
                "granularity": "1h",
                "environment": "production",
            },
            "vercel": {
                "team": project.team,
                "project_id": project.project_id,
                "framework": project.framework,
                "fluid_compute": project.fluid,
                "function_region": project.region,
            },
            "repo": {
                "url": intake.repo_url,
                "ref": intake.ref or "HEAD",
                "framework_detected": scan.framework if scan else "unknown",
            },
            "method": {
                "constants": capacity.constants,
                **capacity.method,
            },
            "region_source": intake.region_source,
            "evidence_conflicts": capacity.evidence_conflicts,
            "warnings": warnings,
            "env_inventory": [
                {k: v for k, v in row.items() if k != "value"} for row in env_inventory
            ],
        }
        include_cost = cost is not None and mode != "static-only"
        doc = emit_result(
            intake=intake,
            mode=mode,
            verdict=verdict,
            capacity=capacity,
            scan=scan,
            cost=cost,
            predictions=predictions,
            surveyor_meta=meta,
            include_current_cost=include_cost,
        )
        result.document = doc
        result.card = render_card(doc)
        if result.park == "ceiling":
            result.park_message = result.park_message or (
                "constraints.ceiling_inr_monthly is required and is never inferred."
            )
        return result
    finally:
        if tmp is not None:
            tmp.cleanup()
