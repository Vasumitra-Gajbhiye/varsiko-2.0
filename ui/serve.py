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

NASIKO_URL = os.environ.get("NASIKO_URL", "http://localhost:8080").rstrip("/")
NASIKO_USER = os.environ.get("NASIKO_USER", "admin")
NASIKO_PASSWORD = os.environ.get("NASIKO_PASSWORD", "changeme")
CEILING = int(os.environ.get("CEILING_INR_MONTHLY", "1500"))
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
    named = bucket.get("named") or {}
    for name, art in named.items():
        for part in art.get("parts") or []:
            if not isinstance(part, dict):
                continue
            if part.get("data"):
                harvest(part["data"], bucket)
            text = part.get("text")
            if text:
                harvest(text, bucket)
    return bucket


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


def a2a_send(token: str, agent_id: str, session_id: str, text: str) -> dict[str, Any]:
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
    status, ctype, raw = _http(
        "POST",
        "/api/orchestrator/a2a",
        token=token,
        body=body,
        accept="text/event-stream",
        timeout=180,
    )
    if status >= 400:
        raise RuntimeError(f"Nasiko A2A {status}: {raw[:500]}")
    bucket = parse_sse(raw)
    if "application/json" in ctype and not bucket.get("spec") and not bucket.get("shop"):
        try:
            harvest(json.loads(raw), bucket)
        except json.JSONDecodeError:
            pass
    bucket["raw"] = raw
    return bucket


def run_pipeline(repo: str, ceiling: int) -> dict[str, Any]:
    token = login()
    ids = load_agent_ids(token)
    query = f"Survey {repo} with ceiling ₹{ceiling}"
    survey_session = create_session(token, ids["surveyor"])
    survey = a2a_send(token, ids["surveyor"], survey_session, query)
    spec = survey.get("spec")
    if not spec:
        raise RuntimeError("Surveyor did not return a capacity spec")
    verdict = ((spec.get("decision") or {}).get("verdict") or "").upper()

    port = None
    port_session = None
    porter_diff = None
    if verdict not in {"BLOCKED", "NEEDS_INPUT"} and ids.get("porter"):
        port_session = create_session(token, ids["porter"])
        porter = a2a_send(token, ids["porter"], port_session, json.dumps(spec))
        port = porter.get("port")
        named = porter.get("named") or {}
        diff_art = named.get("porter_diff")
        if isinstance(diff_art, dict):
            for part in diff_art.get("parts") or []:
                if isinstance(part, dict) and part.get("text"):
                    porter_diff = part["text"]
                    break
        # Prefer forwarded spec if Porter returned one.
        if porter.get("spec"):
            spec = porter["spec"]

    shop_session = None
    shop = None
    mandate = None
    if verdict not in {"BLOCKED", "NEEDS_INPUT"}:
        shop_session = create_session(token, ids["broker"])
        broker = a2a_send(
            token,
            ids["broker"],
            shop_session,
            json.dumps(spec),
        )
        shop = broker.get("shop")
        mandate = broker.get("mandate")

    pilot = None
    pilot_session = None
    if mandate and ids.get("pilot"):
        pilot_session = create_session(token, ids["pilot"])
        # Mark approval so Pilot's lane routing has a complete cart; Pilot still parks.
        cart = dict(mandate)
        approval = dict(cart.get("approval") or {})
        if approval.get("status") != "approved":
            approval = {
                "status": "approved",
                "approver": "demo-ui",
                "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            cart["approval"] = approval
        pilot_resp = a2a_send(token, ids["pilot"], pilot_session, json.dumps(cart))
        pilot = pilot_resp.get("pilot") or (pilot_resp.get("named") or {}).get("pilot_park")
        if isinstance(pilot, dict) and "parts" in pilot:
            for part in pilot.get("parts") or []:
                if isinstance(part, dict) and part.get("data"):
                    pilot = part["data"]
                    break

    plans = plans_from_shop(shop, mandate)
    return {
        "spec": spec,
        "plans": plans,
        "shop": shop,
        "mandate": mandate,
        "port": port,
        "porter_diff": porter_diff,
        "pilot": pilot,
        "nasiko_session_url": (
            f"{NASIKO_URL}/chat.html?agent_id={ids['surveyor']}&session_id={survey_session}"
        ),
        "nasiko_sessions": {
            "surveyor": f"{NASIKO_URL}/chat.html?agent_id={ids['surveyor']}&session_id={survey_session}",
            "porter": (
                f"{NASIKO_URL}/chat.html?agent_id={ids['porter']}&session_id={port_session}"
                if port_session and ids.get("porter")
                else None
            ),
            "broker": (
                f"{NASIKO_URL}/chat.html?agent_id={ids['broker']}&session_id={shop_session}"
                if shop_session
                else None
            ),
            "pilot": (
                f"{NASIKO_URL}/chat.html?agent_id={ids['pilot']}&session_id={pilot_session}"
                if pilot_session and ids.get("pilot")
                else None
            ),
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

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in {"/", "/index.html"}:
            target = UI_DIR / "index.html"
        elif path == "/app.css":
            target = UI_DIR / "app.css"
        elif path == "/app.js":
            target = UI_DIR / "app.js"
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        if not target.is_file():
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            self._send(400, json.dumps({"error": "invalid JSON"}).encode(), "application/json")
            return
        if path != "/api/run":
            self._send(404, json.dumps({"error": "not found"}).encode(), "application/json")
            return
        repo = str(payload.get("repo") or "").strip()
        if not GITHUB_RE.search(repo):
            self._send(
                400,
                json.dumps({"error": "Need a GitHub repo URL, e.g. https://github.com/org/repo"}).encode(),
                "application/json",
            )
            return
        ceiling = int(payload.get("ceiling") or CEILING)
        try:
            result = run_pipeline(repo, ceiling)
        except Exception as exc:
            self._send(502, json.dumps({"error": str(exc)}).encode(), "application/json")
            return
        self._send(200, json.dumps(result).encode(), "application/json")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Severance UI  http://{HOST}:{PORT}")
    print(f"Nasiko        {NASIKO_URL}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
        server.shutdown()


if __name__ == "__main__":
    main()
