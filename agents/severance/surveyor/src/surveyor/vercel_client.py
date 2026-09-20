"""Read-only Vercel REST client. Never sends decrypt. Redacts tokens from errors."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from surveyor.fixture_store import fixture_dir, load_json, load_text, write_json
from surveyor.redact import redact_text

API = "https://api.vercel.com"
ENV_MAP_DEFAULT = {
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


class VercelError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = redact_text(message)
        self.status = status


@dataclass
class ResolvedProject:
    team: str | None
    project_id: str
    name: str
    framework: str
    region: str | None
    fluid: bool
    root_dir: str
    production_branch: str | None = None
    candidates: list[dict[str, str]] = field(default_factory=list)
    ambiguous: bool = False
    missing: bool = False


def _offline() -> bool:
    return os.environ.get("SURVEYOR_OFFLINE", "").strip() not in {"", "0", "false", "False"}


def _token() -> str:
    return os.environ.get("VERCEL_TOKEN", "")


class VercelClient:
    def __init__(
        self,
        token: str | None = None,
        *,
        offline: bool | None = None,
        client: httpx.Client | None = None,
        fixture_name: str = "vercel",
    ):
        self.token = token if token is not None else _token()
        self.offline = _offline() if offline is None else offline
        self._client = client
        self.fixture_name = fixture_name

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}

    def _get(self, path: str, params: dict[str, Any] | None = None) -> httpx.Response:
        url = path if path.startswith("http") else f"{API}{path}"
        http = self._client or httpx.Client(timeout=60.0)
        own = self._client is None
        try:
            resp = http.get(url, headers=self._headers(), params=params or {})
            if resp.status_code == 429:
                resp = http.get(url, headers=self._headers(), params=params or {})
            return resp
        finally:
            if own:
                http.close()

    def resolve_project(
        self,
        repo_url: str,
        team: str | None = None,
        project: str | None = None,
    ) -> ResolvedProject:
        if self.offline:
            return self._resolve_offline(repo_url, project)
        if not self.token:
            return ResolvedProject(
                team=None,
                project_id="",
                name="",
                framework="",
                region=None,
                fluid=False,
                root_dir=".",
                missing=True,
            )
        parsed = urlparse(repo_url)
        repo_path = parsed.path.strip("/")
        if repo_path.endswith(".git"):
            repo_path = repo_path[:-4]
        owner, _, name = repo_path.partition("/")
        params: dict[str, Any] = {"repoUrl": repo_url, "limit": "50"}
        if team:
            params["teamId"] = team
        resp = self._get("/v10/projects", params)
        if resp.status_code >= 400:
            raise VercelError("VERCEL_PROJECTS_FAILED", f"HTTP {resp.status_code}", resp.status_code)
        payload = resp.json()
        write_json("vercel/projects.json", payload)
        projects = payload.get("projects") or payload if isinstance(payload, dict) else payload
        if isinstance(projects, dict):
            projects = projects.get("projects") or []
        matches = []
        for item in projects or []:
            link = item.get("link") or {}
            org = str(link.get("org") or "")
            repo = str(link.get("repo") or "")
            if project and (item.get("id") == project or item.get("name") == project):
                matches.append(item)
                continue
            if org.lower() == owner.lower() and repo.lower() == name.lower():
                matches.append(item)
        if project:
            matches = [
                m
                for m in matches
                if m.get("id") == project or m.get("name") == project
            ] or matches
        if not matches:
            return ResolvedProject(
                team=team,
                project_id="",
                name="",
                framework="",
                region=None,
                fluid=False,
                root_dir=".",
                missing=True,
            )
        if len(matches) > 1 and not project:
            return ResolvedProject(
                team=team,
                project_id="",
                name="",
                framework="",
                region=None,
                fluid=False,
                root_dir=".",
                ambiguous=True,
                candidates=[
                    {
                        "id": str(m.get("id")),
                        "name": str(m.get("name")),
                        "framework": str(m.get("framework") or ""),
                    }
                    for m in matches
                ],
            )
        item = matches[0]
        return _project_from_json(item, team)

    def pull_env_inventory(self, project_id: str, team: str | None = None) -> list[dict[str, Any]]:
        if self.offline:
            data = load_json("vercel/env.json")
            return [_env_row(x) for x in (data.get("envs") or data if isinstance(data, dict) else data)]
        params: dict[str, Any] = {}
        if team:
            params["teamId"] = team
        # Never pass decrypt.
        resp = self._get(f"/v10/projects/{project_id}/env", params)
        if resp.status_code >= 400:
            raise VercelError("VERCEL_ENV_FAILED", f"HTTP {resp.status_code}", resp.status_code)
        payload = resp.json()
        write_json("vercel/env.json", payload)
        rows = payload.get("envs") or payload
        if isinstance(rows, dict):
            rows = rows.get("envs") or []
        return [_env_row(x) for x in rows]

    def pull_deployments(self, project_id: str, team: str | None = None) -> dict[str, Any]:
        if self.offline:
            return load_json("vercel/deployments.json")
        params: dict[str, Any] = {"projectId": project_id, "limit": "20", "target": "production"}
        if team:
            params["teamId"] = team
        resp = self._get("/v6/deployments", params)
        if resp.status_code >= 400:
            raise VercelError("VERCEL_DEPLOYMENTS_FAILED", f"HTTP {resp.status_code}", resp.status_code)
        payload = resp.json()
        write_json("vercel/deployments.json", payload)
        deployments = payload.get("deployments") or []
        functions = []
        for dep in deployments[:1]:
            functions = dep.get("functions") or functions
        return {
            "count_30d": len(deployments),
            "last_prod": deployments[0] if deployments else None,
            "functions": functions,
        }

    def pull_billing_rows(self, project_id: str, start_ms: int, end_ms: int, team: str | None = None) -> list[dict[str, Any]]:
        if self.offline:
            text = load_text("vercel/charges.jsonl")
            return [json.loads(line) for line in text.splitlines() if line.strip()]
        params: dict[str, Any] = {"from": str(start_ms), "to": str(end_ms)}
        if team:
            params["teamId"] = team
        resp = self._get("/v1/billing/charges", params)
        if resp.status_code >= 400:
            raise VercelError("VERCEL_BILLING_FAILED", f"HTTP {resp.status_code}", resp.status_code)
        text = resp.text
        if os.environ.get("SURVEYOR_WRITE_FIXTURES") == "1":
            path = fixture_dir() / "vercel" / "charges.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        rows = []
        for line in text.splitlines():
            line = line.strip()
            if line:
                rows.append(json.loads(line))
        return rows

    def _resolve_offline(self, repo_url: str, project: str | None) -> ResolvedProject:
        if "ambiguous" in repo_url:
            if project:
                data = load_json("vercel/project.json")
                return _project_from_json(data, data.get("accountId"))
            return ResolvedProject(
                team=None,
                project_id="",
                name="",
                framework="nextjs",
                region="sin1",
                fluid=True,
                root_dir=".",
                ambiguous=True,
                candidates=[
                    {"id": "prj_a", "name": "victim-a", "framework": "nextjs"},
                    {"id": "prj_b", "name": "victim-b", "framework": "nextjs"},
                ],
            )
        if "unlinked" in repo_url:
            return ResolvedProject(
                team=None,
                project_id="",
                name="",
                framework="",
                region=None,
                fluid=False,
                root_dir=".",
                missing=True,
            )
        data = load_json("vercel/project.json")
        return _project_from_json(data, data.get("accountId"))


def _project_from_json(item: dict[str, Any], team: str | None) -> ResolvedProject:
    region = item.get("serverlessFunctionRegion") or item.get("resourceConfig", {}).get("functionDefaultRegions", [None])[0]
    root = item.get("rootDirectory") or "."
    fluid = bool(item.get("elasticConcurrencyEnabled") or item.get("fluid"))
    return ResolvedProject(
        team=team or item.get("accountId") or item.get("teamId"),
        project_id=str(item.get("id") or item.get("project_id")),
        name=str(item.get("name") or ""),
        framework=str(item.get("framework") or ""),
        region=str(region) if region else None,
        fluid=fluid,
        root_dir=str(root),
        production_branch=(item.get("link") or {}).get("productionBranch"),
    )


def _env_row(item: dict[str, Any]) -> dict[str, Any]:
    key = str(item.get("key") or item.get("id") or "")
    targets = item.get("target") or []
    if isinstance(targets, str):
        targets = [targets]
    typ = str(item.get("type") or "encrypted")
    return {
        "key": key,
        "targets": list(targets),
        "type": typ,
        "maps_to": ENV_MAP_DEFAULT.get(key),
        "source": "api:vercel/v10/projects/env",
    }


def map_env_key(key: str) -> str | None:
    return ENV_MAP_DEFAULT.get(key)
