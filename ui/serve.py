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


def run_pipeline(repo: str, ceiling: int, emit: Any | None = None) -> dict[str, Any]:
    def push(event: dict[str, Any]) -> None:
        if emit:
            event.setdefault("ts", round(time.time(), 3))
            emit(event)

    token = login()
    ids = load_agent_ids(token)
    query = f"Survey {repo} with ceiling ₹{ceiling}"

    push({"type": "log", "agent": "surveyor", "text": f"intake {repo} · ceiling ₹{ceiling}"})
    push({"type": "phase", "agent": "surveyor", "status": "running"})
    survey_session = create_session(token, ids["surveyor"])
    try:
        survey = a2a_send(
            token, ids["surveyor"], survey_session, query, agent="surveyor", on_event=push
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
    skip_rest = verdict in {"BLOCKED", "NEEDS_INPUT"}

    port = None
    port_session = None
    porter_diff = None
    if skip_rest or not ids.get("porter"):
        reason = f"verdict {verdict}" if skip_rest else "porter not deployed"
        push({"type": "log", "agent": "porter", "text": f"skipped · {reason}"})
        push({"type": "phase", "agent": "porter", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "porter", "status": "running"})
        push({"type": "log", "agent": "porter", "text": "dry-run rewrite from capacity spec"})
        port_session = create_session(token, ids["porter"])
        try:
            porter = a2a_send(
                token,
                ids["porter"],
                port_session,
                json.dumps(spec),
                agent="porter",
                on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "porter", "status": "error"})
            raise
        port = porter.get("port")
        porter_diff = porter_diff_from_bucket(porter)
        if porter.get("spec"):
            spec = porter["spec"]
        push({"type": "phase", "agent": "porter", "status": "done"})

    shop_session = None
    shop = None
    mandate = None
    if skip_rest:
        push({"type": "log", "agent": "broker", "text": f"skipped · verdict {verdict}"})
        push({"type": "phase", "agent": "broker", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "broker", "status": "running"})
        push({"type": "log", "agent": "broker", "text": "shopping Hetzner, DigitalOcean, Vultr"})
        shop_session = create_session(token, ids["broker"])
        try:
            broker = a2a_send(
                token,
                ids["broker"],
                shop_session,
                json.dumps(spec),
                agent="broker",
                on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "broker", "status": "error"})
            raise
        shop = broker.get("shop")
        mandate = broker.get("mandate")
        push({"type": "phase", "agent": "broker", "status": "done"})

    pilot = None
    pilot_session = None
    if not mandate or not ids.get("pilot"):
        reason = "no cart mandate" if not mandate else "pilot not deployed"
        push({"type": "log", "agent": "pilot", "text": f"skipped · {reason}"})
        push({"type": "phase", "agent": "pilot", "status": "skipped"})
    else:
        push({"type": "phase", "agent": "pilot", "status": "running"})
        push({"type": "log", "agent": "pilot", "text": "verify cart · park without purchase"})
        pilot_session = create_session(token, ids["pilot"])
        cart = dict(mandate)
        approval = dict(cart.get("approval") or {})
        if approval.get("status") != "approved":
            approval = {
                "status": "approved",
                "approver": "demo-ui",
                "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            cart["approval"] = approval
        try:
            pilot_resp = a2a_send(
                token,
                ids["pilot"],
                pilot_session,
                json.dumps(cart),
                agent="pilot",
                on_event=push,
            )
        except Exception:
            push({"type": "phase", "agent": "pilot", "status": "error"})
            raise
        pilot = unwrap_pilot(
            pilot_resp.get("pilot") or (pilot_resp.get("named") or {}).get("pilot_park")
        )
        push({"type": "phase", "agent": "pilot", "status": "done"})

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
        if path not in {"/api/run", "/api/run/stream"}:
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
        if path == "/api/run/stream":
            self._sse_begin()
            try:
                result = run_pipeline(repo, ceiling, emit=self._sse_emit)
                self._sse_emit({"type": "done", **result})
            except Exception as exc:
                self._sse_emit({"type": "error", "error": str(exc)})
            return
        try:
            result = run_pipeline(repo, ceiling)
        except Exception as exc:
            self._send(502, json.dumps({"error": str(exc)}).encode(), "application/json")
            return
        self._send(200, json.dumps(result).encode(), "application/json")


class Server(ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as exc:
        if getattr(exc, "errno", None) in {48, 98}:
            print(f"port {PORT} is already in use (http://{HOST}:{PORT})")
            print(f"stop the other process: lsof -iTCP:{PORT} -sTCP:LISTEN")
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
