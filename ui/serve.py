#!/usr/bin/env python3
"""Local demo UI. GitHub URL → Nasiko A2A Surveyor → Broker. Stdlib only."""

from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
UI_DIR = Path(__file__).resolve().parent
IDS_PATH = ROOT / ".nasiko-deploy" / "ids.json"


def _load_dotenv(path: Path) -> None:
    """Read ui/.env before config is snapped. Real environment always wins."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'").strip('"'))


_load_dotenv(UI_DIR / ".env")

NASIKO_URL = os.environ.get("NASIKO_URL", "http://localhost:8080").rstrip("/")
NASIKO_USER = os.environ.get("NASIKO_USER", "admin")
NASIKO_PASSWORD = os.environ.get("NASIKO_PASSWORD", "changeme")
CEILING = int(os.environ.get("CEILING_INR_MONTHLY", "4200"))
HOST = os.environ.get("UI_HOST", "127.0.0.1")
PORT = int(os.environ.get("UI_PORT", "8788"))

GITHUB_RE = re.compile(r"https?://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", re.I)

_token_lock = threading.Lock()
_token: str | None = None
_token_at = 0.0

SCHEMA_SPEC = "severance.capacity_spec/v1"
SCHEMA_SHOP = "severance.shop_result/v1"
SCHEMA_MANDATE = "severance.cart_mandate/v1"
SCHEMA_PORT = "severance.port_plan/v1"
SCHEMA_PILOT = "severance.pilot_run/v1"


def _http(method: str, path: str, *, token: str | None = None, body: Any = None, accept: str = "application/json", timeout: float = 120) -> tuple[int, str, str]:
    data = None if body is None else json.dumps(body).encode()
    headers = {"Accept": accept, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = Request(NASIKO_URL + path, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, resp.headers.get("content-type") or "", raw
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        return exc.code, exc.headers.get("content-type") or "", raw


def login() -> str:
    global _token, _token_at
    with _token_lock:
        if _token and (time.time() - _token_at) < 20 * 60:
            return _token
        status, _, raw = _http(
            "POST",
            "/api/auth/login",
            body={"username": NASIKO_USER, "password": NASIKO_PASSWORD},
            timeout=15,
        )
        payload = json.loads(raw) if raw else {}
        token = payload.get("token") if isinstance(payload, dict) else None
        if status >= 400 or not token:
            raise RuntimeError(f"Nasiko login failed ({status})")
        _token = token
        _token_at = time.time()
        return token


def _items(payload: Any) -> list:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, dict) and "data" in data:
        data = data["data"]
    return data if isinstance(data, list) else []


def load_agent_ids(token: str) -> dict[str, str]:
    ids: dict[str, str] = {}
    if IDS_PATH.is_file():
        blob = json.loads(IDS_PATH.read_text())
        for key in ("surveyor", "porter", "broker", "pilot"):
            row = blob.get(key) or {}
            aid = row.get("agent_id")
            if aid:
                ids[key] = aid
    if "surveyor" in ids and "broker" in ids:
        # Porter/Pilot are optional for backward compatibility.
        return ids
    status, _, raw = _http("GET", "/api/agents?limit=50", token=token, timeout=20)
    if status >= 400:
        raise RuntimeError(f"cannot list Nasiko agents ({status}): {raw[:300]}")
    for agent in _items(json.loads(raw) if raw else {}):
        if not isinstance(agent, dict):
            continue
        name = (agent.get("name") or agent.get("agent_name") or "").lower()
        aid = agent.get("id") or agent.get("agent_id")
        if not aid:
            continue
        if "surveyor" in name:
            ids.setdefault("surveyor", aid)
        if "porter" in name:
            ids.setdefault("porter", aid)
        if "broker" in name:
            ids.setdefault("broker", aid)
        if "pilot" in name:
            ids.setdefault("pilot", aid)
    if "surveyor" not in ids or "broker" not in ids:
        raise RuntimeError("severance-surveyor / severance-broker not found on Nasiko")
    return ids


def create_session(token: str, agent_id: str) -> str:
    status, _, raw = _http(
        "POST",
        "/api/chat/sessions",
        token=token,
        body={"agent_id": agent_id},
        timeout=20,
    )
    payload = json.loads(raw) if raw else {}
    data = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(data, dict):
        data = {}
    sid = data.get("session_id") or data.get("id")
    if status >= 400 or not sid:
        return str(uuid.uuid4())
    return str(sid)


def harvest(obj: Any, bucket: dict[str, Any]) -> None:
    if isinstance(obj, dict):
        schema = obj.get("schema") or obj.get("schema_name")
        if schema == SCHEMA_SPEC:
            bucket["spec"] = obj
        elif schema == SCHEMA_SHOP:
            bucket["shop"] = obj
        elif schema == SCHEMA_MANDATE:
            bucket["mandate"] = obj
        elif schema == SCHEMA_PORT:
            bucket["port"] = obj
        elif schema == SCHEMA_PILOT:
            bucket["pilot"] = obj
        name = obj.get("name")
        if name in {
            "shop_result",
            "cart_mandate",
            "surveyor_result.json",
            "surveyor_result",
            "shop_card",
            "port_plan",
            "porter_diff",
            "pilot_run",
            "pilot_park",
        }:
            bucket.setdefault("named", {})[name] = obj
        for value in obj.values():
            harvest(value, bucket)
    elif isinstance(obj, list):
        for item in obj:
            harvest(item, bucket)
    elif isinstance(obj, str):
        text = obj.strip()
        if text.startswith("{") and ("severance." in text or '"schema"' in text):
            try:
                harvest(json.loads(text), bucket)
            except json.JSONDecodeError:
                match = re.search(r"\{.*\}", text, re.DOTALL)
                if match:
                    try:
                        harvest(json.loads(match.group(0)), bucket)
                    except json.JSONDecodeError:
                        pass


def finalize_named(bucket: dict[str, Any]) -> None:
    named = bucket.get("named") or {}
    for art in named.values():
        if not isinstance(art, dict):
            continue
        for part in art.get("parts") or []:
            if not isinstance(part, dict):
                continue
            if part.get("data"):
                harvest(part["data"], bucket)
            text = part.get("text")
            if text:
                harvest(text, bucket)


def extract_status_texts(obj: Any) -> list[str]:
    """Pull short working-message text from A2A status-update SSE payloads."""
    texts: list[str] = []

    def consider(text: str) -> None:
        t = text.strip()
        if not t:
            return
        if t[0] in "{[" and ("severance." in t or '"schema"' in t):
            return
        t = t.split("\n", 1)[0]
        if t.startswith("#"):
            return
        if len(t) > 180:
            t = t[:177] + "..."
        if t in texts:
            return
        texts.append(t)

    def walk(node: Any, in_status: bool) -> None:
        if isinstance(node, dict):
            kind = str(node.get("kind") or node.get("type") or "")
            if (
                "statusUpdate" in node
                or "status-update" in kind
                or "status_update" in kind
                or isinstance(node.get("status"), dict)
            ):
                in_status = True
            if in_status:
                text = node.get("text")
                if isinstance(text, str):
                    consider(text)
            for value in node.values():
                walk(value, in_status)
        elif isinstance(node, list):
            for item in node:
                walk(item, in_status)

    walk(obj, False)
    return texts


def parse_sse(raw: str) -> dict[str, Any]:
    bucket: dict[str, Any] = {}
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            harvest(json.loads(payload), bucket)
        except json.JSONDecodeError:
            continue
    harvest(raw, bucket)
    finalize_named(bucket)
    return bucket


def porter_diff_from_bucket(bucket: dict[str, Any]) -> str | None:
    named = bucket.get("named") or {}
    diff_art = named.get("porter_diff")
    if not isinstance(diff_art, dict):
        return None
    for part in diff_art.get("parts") or []:
        if isinstance(part, dict) and part.get("text"):
            return str(part["text"])
    return None


def unwrap_pilot(pilot: Any) -> Any:
    if isinstance(pilot, dict) and "parts" in pilot:
        for part in pilot.get("parts") or []:
            if isinstance(part, dict) and part.get("data"):
                return part["data"]
    return pilot


def _new_artifacts(bucket: dict[str, Any], seen: set[str]) -> list[tuple[str, Any]]:
    """Return newly harvested artifacts as (kind, data) pairs."""
    out: list[tuple[str, Any]] = []
    mapping = (
        ("spec", "spec"),
        ("port", "port"),
        ("shop", "shop"),
        ("mandate", "mandate"),
        ("pilot", "pilot"),
    )
    for key, kind in mapping:
        if key in bucket and kind not in seen:
            seen.add(kind)
            data = bucket[key]
            if kind == "pilot":
                data = unwrap_pilot(data)
            out.append((kind, data))
    if "diff" not in seen:
        diff = porter_diff_from_bucket(bucket)
        if diff:
            seen.add("diff")
            out.append(("diff", diff))
    named = bucket.get("named") or {}
    if "pilot" not in seen:
        parked = named.get("pilot_park")
        if parked:
            seen.add("pilot")
            out.append(("pilot", unwrap_pilot(parked)))
    return out


def plans_from_shop(shop: dict[str, Any] | None, mandate: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    plans: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(item: Any) -> None:
        if not isinstance(item, dict):
            return
        key = (str(item.get("provider") or ""), str(item.get("plan_sku") or ""))
        if not key[0] or key in seen:
            return
        seen.add(key)
        plans.append(item)

    if shop:
        add(shop.get("winner"))
        add(shop.get("runner_up"))
        for item in shop.get("survivors") or []:
            add(item)
    if not plans and mandate:
        decision = mandate.get("decision") or {}
        add(decision)
        add(mandate.get("runner_up"))
    return plans


def a2a_send(
    token: str,
    agent_id: str,
    session_id: str,
    text: str,
    *,
    agent: str = "unknown",
    on_event: Any | None = None,
) -> dict[str, Any]:
    body = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "message/stream",
        "params": {
            "message": {
                "messageId": str(uuid.uuid4()),
                "contextId": session_id,
                "role": "ROLE_USER",
                "parts": [{"text": text}],
            },
            "metadata": {"agent_id": agent_id, "session_id": session_id},
        },
    }
    data = json.dumps(body).encode()
    headers = {
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }
    req = Request(NASIKO_URL + "/api/orchestrator/a2a", data=data, method="POST", headers=headers)

    def push(event: dict[str, Any]) -> None:
        if on_event:
            event.setdefault("ts", round(time.time(), 3))
            event.setdefault("agent", agent)
            on_event(event)

    bucket: dict[str, Any] = {}
    seen: set[str] = set()
    logged: set[str] = set()
    chunks: list[str] = []

    def flush_artifacts() -> None:
        finalize_named(bucket)
        for kind, payload in _new_artifacts(bucket, seen):
            push({"type": "artifact", "kind": kind, "data": payload})

    def ingest_obj(obj: Any) -> None:
        harvest(obj, bucket)
        for line in extract_status_texts(obj):
            key = line[:240]
            if key in logged:
                continue
            logged.add(key)
            push({"type": "log", "text": line})
        flush_artifacts()

    try:
        resp_cm = urlopen(req, timeout=180)
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Nasiko A2A {exc.code}: {raw[:500]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Nasiko A2A unreachable: {exc}") from exc

    with resp_cm as resp:
        ctype = (resp.headers.get("content-type") or "").lower()
        status = getattr(resp, "status", 200)
        if status >= 400:
            raw = resp.read().decode("utf-8", "replace")
            raise RuntimeError(f"Nasiko A2A {status}: {raw[:500]}")
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace")
            chunks.append(line)
            stripped = line.strip()
            if not stripped.startswith("data:"):
                continue
            payload = stripped[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                ingest_obj(json.loads(payload))
            except json.JSONDecodeError:
                continue
        raw = "".join(chunks)

    if "application/json" in ctype and not bucket.get("spec") and not bucket.get("shop"):
        try:
            ingest_obj(json.loads(raw))
        except json.JSONDecodeError:
            pass
    harvest(raw, bucket)
    flush_artifacts()
    bucket["raw"] = raw
    return bucket




# ---------------------------------------------------------------------------
# Run store. A run spans two HTTP requests -- survey, then authorise -- because a
# human chooses in between. The Broker parks its mandate against the A2A context
# id, so the second request must reuse the same session to reach the same gate.
# ---------------------------------------------------------------------------

_runs_lock = threading.Lock()
RUNS: dict[str, dict[str, Any]] = {}
RUN_TTL_SECONDS = 3600


def _put_run(run_id: str, data: dict[str, Any]) -> None:
    with _runs_lock:
        RUNS[run_id] = data
        cutoff = time.time() - RUN_TTL_SECONDS
        for stale in [k for k, v in RUNS.items() if v.get("created_at", 0) < cutoff]:
            RUNS.pop(stale, None)


def _get_run(run_id: str) -> dict[str, Any] | None:
    with _runs_lock:
        return RUNS.get(run_id)


def dashboard_links(ids: dict[str, str], sessions: dict[str, str]) -> dict[str, Any]:
    """Deep links into the Nasiko dashboard, so every claim here is checkable there."""
    out: dict[str, Any] = {
        "base": NASIKO_URL,
        "agents": f"{NASIKO_URL}/index.html?view=agents",
        "sessions": f"{NASIKO_URL}/sessions.html",
        "workflows": f"{NASIKO_URL}/index.html?view=workflows",
        "agent_ids": dict(ids),
    }
    for name, session_id in sessions.items():
        agent_id = ids.get(name)
        if agent_id and session_id:
            out[name] = f"{NASIKO_URL}/chat.html?agent_id={agent_id}&session_id={session_id}"
    return out


# ---------------------------------------------------------------------------
# Shopping results -> the choice the human is offered.
# ---------------------------------------------------------------------------

PROVIDER_LABELS = {
    "hetzner": "Hetzner",
    "digitalocean": "DigitalOcean",
    "vultr": "Vultr",
}

REJECTION_TEXT = {
    "OVER_CEILING": "costs more than your ceiling",
    "UNDER_SPEC_FLOOR": "too small for the surveyed workload",
    "REGION_NOT_ALLOWED": "no region in your allowlist",
    "MISSING_CAPABILITY": "missing a required capability",
    "UNSUPPORTED_CURRENCY": "priced in a currency we cannot pin",
}


def _provider_label(pid: str) -> str:
    return PROVIDER_LABELS.get(str(pid).lower(), str(pid or "").title())


def choices_from_shop(shop: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Every plan that cleared the hard filters, in the Broker's own ranking order.

    Only `provider` + `plan_sku` are ever sent back to authorise a plan. The prices
    shown here are for the human to read; the Broker re-derives them from its own
    scored set when it mints.
    """
    if not shop:
        return []
    survivors = [s for s in (shop.get("survivors") or []) if isinstance(s, dict)]
    if not survivors:
        survivors = [s for s in (shop.get("winner"), shop.get("runner_up")) if isinstance(s, dict)]

    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for index, row in enumerate(survivors):
        provider = str(row.get("provider") or "")
        sku = str(row.get("plan_sku") or "")
        if not provider or (provider, sku) in seen:
            continue
        seen.add((provider, sku))
        listed = row.get("listed_price") or {}
        out.append(
            {
                "provider": provider,
                "provider_label": _provider_label(provider),
                "plan_sku": sku,
                "monthly_inr": row.get("monthly_inr"),
                "listed_amount": listed.get("amount"),
                "listed_currency": str(listed.get("currency") or "").upper(),
                "fx_rate": row.get("fx_rate"),
                "fx_pinned_at": row.get("fx_pinned_at"),
                "region": row.get("region"),
                "vcpu": row.get("vcpu"),
                "ram_gb": row.get("ram_gb"),
                "disk_gb": row.get("disk_gb"),
                "egress_tb": row.get("egress_tb"),
                "source_url": row.get("source_url"),
                "discovered_via": row.get("url_discovered_via"),
                "scraped_at": row.get("scraped_at"),
                "suspect": bool(row.get("suspect")),
                "suspect_quote": row.get("suspect_quote") or "",
                "recommended": index == 0,
            }
        )
    return out


def rejections_from_shop(shop: dict[str, Any] | None) -> list[dict[str, Any]]:
    """What the Broker refused and why. Refusals are the point, so they stay visible."""
    if not shop:
        return []
    out = []
    for row in shop.get("rejected") or []:
        if not isinstance(row, dict):
            continue
        reason = str(row.get("reason") or "")
        out.append(
            {
                "provider": str(row.get("provider") or ""),
                "provider_label": _provider_label(row.get("provider") or ""),
                "plan_sku": row.get("plan_sku"),
                "reason": reason,
                "reason_text": REJECTION_TEXT.get(reason, reason.replace("_", " ").lower()),
                "detail": row.get("detail"),
            }
        )
    return out


def anakin_summary(choices: list[dict[str, Any]], shop: dict[str, Any] | None) -> dict[str, Any]:
    """Where the prices came from. `fixture-fallback` is never dressed up as live."""
    providers: dict[str, str] = {}
    for row in choices:
        providers.setdefault(row["provider"], row.get("discovered_via") or "unknown")
    for key in ("winner", "runner_up"):
        row = (shop or {}).get(key)
        if isinstance(row, dict) and row.get("provider"):
            providers.setdefault(row["provider"], row.get("url_discovered_via") or "unknown")
    live = sum(1 for via in providers.values() if via == "anakin-search")
    return {
        "providers": providers,
        "live": live,
        "fallback": sum(1 for via in providers.values() if via == "fixture-fallback"),
        "mode": "live" if live else ("fallback" if providers else "unknown"),
    }


# ---------------------------------------------------------------------------
# Phase 1: survey. Repo -> capacity spec -> port plan -> shortlist of VPS plans.
# Stops at the choice. Nothing is authorised here.
# ---------------------------------------------------------------------------


def run_survey(repo: str, ceiling: int, emit: Any | None = None) -> dict[str, Any]:
    def push(event: dict[str, Any]) -> None:
        if emit:
            event.setdefault("ts", round(time.time(), 3))
            emit(event)

    token = login()
    ids = load_agent_ids(token)
    sessions: dict[str, str] = {}
    push({"type": "control", "agent_ids": ids, "nasiko": NASIKO_URL})

    query = f"Survey {repo} with ceiling ₹{ceiling}"
    push({"type": "log", "agent": "surveyor", "text": f"intake {repo} · ceiling ₹{ceiling}"})
    push({"type": "phase", "agent": "surveyor", "status": "running"})
    sessions["surveyor"] = create_session(token, ids["surveyor"])
    push({"type": "session", "agent": "surveyor", "session_id": sessions["surveyor"]})
    try:
        survey = a2a_send(
            token, ids["surveyor"], sessions["surveyor"], query, agent="surveyor", on_event=push
        )
    except Exception:
        push({"type": "phase", "agent": "surveyor", "status": "error"})
        raise
    spec = survey.get("spec")
    if not spec:
        push({"type": "phase", "agent": "surveyor", "status": "error"})
        raise RuntimeError("Surveyor did not return a capacity spec")
    push({"type": "phase", "agent": "surveyor", "status": "done"})

    verdict = ((spec.get("decision") or {}).get("verdict") or "").upper()
    blocked = verdict in {"BLOCKED", "NEEDS_INPUT"}

    port = None
    porter_diff = None
    if blocked or not ids.get("porter"):
        reason = f"verdict {verdict}" if blocked else "porter not deployed"
        push({"type": "log", "agent": "porter", "text": f"skipped · {reason}"})
        push({"type": "phase", "agent": "porter", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "porter", "status": "running"})
        push({"type": "log", "agent": "porter", "text": "dry-run rewrite from capacity spec"})
        sessions["porter"] = create_session(token, ids["porter"])
        push({"type": "session", "agent": "porter", "session_id": sessions["porter"]})
        try:
            porter = a2a_send(
                token, ids["porter"], sessions["porter"], json.dumps(spec),
                agent="porter", on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "porter", "status": "error"})
            raise
        port = porter.get("port")
        porter_diff = porter_diff_from_bucket(porter)
        if porter.get("spec"):
            spec = porter["spec"]
        push({"type": "phase", "agent": "porter", "status": "done"})

    shop = None
    mandate = None
    if blocked:
        push({"type": "log", "agent": "broker", "text": f"skipped · verdict {verdict}"})
        push({"type": "phase", "agent": "broker", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "broker", "status": "running"})
        push({"type": "log", "agent": "broker", "text": "shopping Hetzner, DigitalOcean, Vultr"})
        sessions["broker"] = create_session(token, ids["broker"])
        push({"type": "session", "agent": "broker", "session_id": sessions["broker"]})
        try:
            broker = a2a_send(
                token, ids["broker"], sessions["broker"], json.dumps(spec),
                agent="broker", on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "broker", "status": "error"})
            raise
        shop = broker.get("shop")
        mandate = broker.get("mandate")
        push({"type": "phase", "agent": "broker", "status": "done"})

    choices = choices_from_shop(shop)
    rejected = rejections_from_shop(shop)
    run_id = str(uuid.uuid4())
    _put_run(
        run_id,
        {
            "created_at": time.time(),
            "repo": repo,
            "ceiling": ceiling,
            "token": token,
            "ids": ids,
            "sessions": sessions,
            "spec": spec,
            "shop": shop,
            "mandate": mandate,
            "choices": choices,
        },
    )

    return {
        "run_id": run_id,
        "repo": repo,
        "ceiling": ceiling,
        "spec": spec,
        "port": port,
        "porter_diff": porter_diff,
        "shop": shop,
        "choices": choices,
        "rejected": rejected,
        "anakin": anakin_summary(choices, shop),
        "mandate_preview": {
            "mandate_id": (mandate or {}).get("mandate_id"),
            "expires_at": (mandate or {}).get("expires_at"),
        },
        "nasiko": dashboard_links(ids, sessions),
        "blocked": blocked,
        "verdict": verdict,
    }


def extract_status_texts_from_raw(raw: str) -> list[str]:
    out: list[str] = []
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            out.extend(extract_status_texts(json.loads(payload)))
        except json.JSONDecodeError:
            continue
    return out


def _first_text(bucket: dict[str, Any]) -> str:
    for line in extract_status_texts_from_raw(str(bucket.get("raw") or "")):
        return line
    return ""


# ---------------------------------------------------------------------------
# Phase 2: authorise. The human picked a plan and pressed the button.
#
# This server writes no approval of its own. It relays two commands to the same
# Broker session -- CHOOSE, then APPROVE <mandate_id> -- and the Broker gate decides.
# What reaches the Pilot is the mandate the Broker signed and stamped, forwarded
# unchanged. If the gate refuses, the run stops here.
# ---------------------------------------------------------------------------


def run_authorize(
    run_id: str,
    provider: str,
    plan_sku: str,
    emit: Any | None = None,
) -> dict[str, Any]:
    def push(event: dict[str, Any]) -> None:
        if emit:
            event.setdefault("ts", round(time.time(), 3))
            emit(event)

    run = _get_run(run_id)
    if not run:
        raise RuntimeError("That run expired. Survey the repo again.")
    ids = run["ids"]
    sessions = run["sessions"]
    broker_session = sessions.get("broker")
    if not broker_session:
        raise RuntimeError("No Broker session on this run; nothing to authorise.")

    chosen = next(
        (c for c in run["choices"] if c["provider"] == provider and c["plan_sku"] == plan_sku),
        None,
    )
    if chosen is None:
        raise RuntimeError(f"{provider} {plan_sku} was not offered by this run.")

    # Re-mint for the picked plan even when it is the one the Broker ranked first.
    # One code path, and the mandate the human authorises is always minted after the
    # choice rather than before it.
    token = login()
    run["token"] = token
    push({"type": "phase", "agent": "broker", "status": "running"})
    push({
        "type": "log",
        "agent": "broker",
        "text": f"CHOOSE {provider} {plan_sku} · re-minting against the same ceiling",
    })
    choose = a2a_send(
        token, ids["broker"], broker_session, f"CHOOSE {provider} {plan_sku}",
        agent="broker", on_event=push,
    )
    mandate = choose.get("mandate")
    if not mandate:
        push({"type": "phase", "agent": "broker", "status": "error"})
        detail = _first_text(choose) or "No mandate was returned."
        raise RuntimeError(f"The Broker refused to mint for that plan. {detail}")
    mandate_id = mandate.get("mandate_id")
    push({"type": "artifact", "agent": "broker", "kind": "mandate", "data": mandate})
    push({
        "type": "log",
        "agent": "broker",
        "text": f"minted {mandate_id} · awaiting human approval",
    })

    push({"type": "log", "agent": "broker", "text": f"APPROVE {mandate_id}"})
    approved = a2a_send(
        token, ids["broker"], broker_session, f"APPROVE {mandate_id}",
        agent="broker", on_event=push,
    )
    stamped = approved.get("mandate") or mandate
    approval = stamped.get("approval") or {}
    if approval.get("status") != "approved":
        push({"type": "phase", "agent": "broker", "status": "error"})
        detail = _first_text(approved) or "no reason given"
        raise RuntimeError(f"The Broker approval gate did not record an approval: {detail}")
    push({"type": "phase", "agent": "broker", "status": "done"})
    push({
        "type": "log",
        "agent": "broker",
        "text": f"approval recorded by {approval.get('approver')} at {approval.get('approved_at')}",
    })

    pilot = None
    if not ids.get("pilot"):
        push({"type": "log", "agent": "pilot", "text": "skipped · pilot not deployed"})
        push({"type": "phase", "agent": "pilot", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "pilot", "status": "running"})
        push({"type": "log", "agent": "pilot", "text": "verify signature · route lane · park"})
        sessions["pilot"] = create_session(token, ids["pilot"])
        push({"type": "session", "agent": "pilot", "session_id": sessions["pilot"]})
        try:
            pilot_resp = a2a_send(
                token, ids["pilot"], sessions["pilot"], json.dumps(stamped),
                agent="pilot", on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "pilot", "status": "error"})
            raise
        pilot = unwrap_pilot(
            pilot_resp.get("pilot") or (pilot_resp.get("named") or {}).get("pilot_park")
        )
        push({"type": "phase", "agent": "pilot", "status": "done"})

    run["mandate"] = stamped
    run["sessions"] = sessions
    _put_run(run_id, run)

    return {
        "run_id": run_id,
        "chosen": chosen,
        "mandate": stamped,
        "pilot": pilot,
        "nasiko": dashboard_links(ids, sessions),
    }


# ---------------------------------------------------------------------------
# Control-plane status, so the UI can show Nasiko is real without being asked to
# trust this process. Everything here is read straight off the Nasiko API.
# ---------------------------------------------------------------------------


def nasiko_status() -> dict[str, Any]:
    token = login()
    status, _, raw = _http("GET", "/api/agents?limit=50", token=token, timeout=20)
    agents = []
    if status < 400:
        for agent in _items(json.loads(raw) if raw else {}):
            if not isinstance(agent, dict):
                continue
            name = str(agent.get("name") or agent.get("agent_name") or "")
            if "severance" not in name.lower():
                continue
            agents.append(
                {
                    "name": name,
                    "id": agent.get("id") or agent.get("agent_id"),
                    "status": agent.get("status") or agent.get("state"),
                    "version": agent.get("version_tag") or agent.get("version"),
                    "runtime": agent.get("runtime"),
                }
            )
    workflows = []
    wf_status, _, wf_raw = _http("GET", "/api/maf/workflows?limit=50", token=token, timeout=20)
    if wf_status < 400:
        for item in _items(json.loads(wf_raw) if wf_raw else {}):
            if isinstance(item, dict) and item.get("name"):
                workflows.append({"id": item.get("id"), "name": item.get("name")})
    return {
        "url": NASIKO_URL,
        "reachable": status < 400,
        "agents": agents,
        "workflows": workflows,
        "links": {
            "dashboard": NASIKO_URL,
            "agents": f"{NASIKO_URL}/index.html?view=agents",
            "sessions": f"{NASIKO_URL}/sessions.html",
            "workflows": f"{NASIKO_URL}/index.html?view=workflows",
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        self._send(status, json.dumps(payload, default=str).encode(), "application/json")

    def _sse_begin(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _sse_emit(self, obj: dict[str, Any]) -> None:
        payload = json.dumps(obj, default=str)
        self.wfile.write(f"data: {payload}\n\n".encode())
        self.wfile.flush()

    def _stream(self, work: Any) -> None:
        self._sse_begin()
        try:
            result = work(self._sse_emit)
            self._sse_emit({"type": "done", **result})
        except Exception as exc:
            self._sse_emit({"type": "error", "error": str(exc)})

    STATIC = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/app.css": ("app.css", "text/css; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    }

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/nasiko":
            try:
                self._json(200, nasiko_status())
            except Exception as exc:
                self._json(200, {"url": NASIKO_URL, "reachable": False, "error": str(exc)})
            return
        entry = self.STATIC.get(path)
        if not entry:
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        name, ctype = entry
        target = UI_DIR / name
        if not target.is_file():
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid JSON"})
            return

        if path in {"/api/survey/stream", "/api/run/stream", "/api/run"}:
            repo = str(payload.get("repo") or "").strip()
            if not GITHUB_RE.search(repo):
                self._json(400, {"error": "Need a GitHub repo URL, e.g. https://github.com/org/repo"})
                return
            try:
                ceiling = int(payload.get("ceiling") or CEILING)
            except (TypeError, ValueError):
                ceiling = CEILING
            ceiling = max(100, min(ceiling, 100000))
            if path == "/api/run":
                try:
                    self._json(200, run_survey(repo, ceiling))
                except Exception as exc:
                    self._json(502, {"error": str(exc)})
                return
            self._stream(lambda emit: run_survey(repo, ceiling, emit=emit))
            return

        if path == "/api/authorize/stream":
            run_id = str(payload.get("run_id") or "")
            provider = str(payload.get("provider") or "")
            plan_sku = str(payload.get("plan_sku") or "")
            if not run_id or not provider or not plan_sku:
                self._json(400, {"error": "run_id, provider and plan_sku are required"})
                return
            self._stream(lambda emit: run_authorize(run_id, provider, plan_sku, emit=emit))
            return

        self._json(404, {"error": "not found"})


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as exc:
        if getattr(exc, "errno", None) in {48, 98, 10048}:
            print(f"port {PORT} is already in use (http://{HOST}:{PORT})")
            raise SystemExit(1) from exc
        raise
    print(f"Severance UI  http://{HOST}:{PORT}")
    print(f"Nasiko        {NASIKO_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
        server.shutdown()


if __name__ == "__main__":
    main()
