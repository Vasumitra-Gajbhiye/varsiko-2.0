"""Nasiko's control plane speaks A2A 1.0 method names; a2a-sdk 0.3.26 speaks 0.3."""

from __future__ import annotations

import asyncio
import json

METHOD_MAP = {
    "SendMessage": "message/send",
    "SendStreamingMessage": "message/stream",
    "GetTask": "tasks/get",
    "CancelTask": "tasks/cancel",
    "TaskResubscription": "tasks/resubscribe",
}

ROLE_MAP = {
    "ROLE_USER": "user",
    "ROLE_AGENT": "agent",
}


def _normalize_message(msg: dict) -> None:
    role = msg.get("role")
    if isinstance(role, str) and role in ROLE_MAP:
        msg["role"] = ROLE_MAP[role]
    parts = msg.get("parts")
    if not isinstance(parts, list):
        return
    for part in parts:
        if not isinstance(part, dict):
            continue
        if "kind" in part:
            continue
        if "text" in part:
            part["kind"] = "text"
        elif "data" in part:
            part["kind"] = "data"
        elif "file" in part:
            part["kind"] = "file"


def rewrite_rpc_bytes(body: bytes) -> bytes:
    try:
        payload = json.loads(body.decode() or "null")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body
    if not isinstance(payload, dict):
        return body
    method = payload.get("method")
    mapped = METHOD_MAP.get(method) if isinstance(method, str) else None
    if mapped:
        payload["method"] = mapped
    params = payload.get("params")
    if isinstance(params, dict) and isinstance(params.get("message"), dict):
        _normalize_message(params["message"])
    return json.dumps(payload).encode()


class A2a10MethodCompat:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        chunks = bytearray()
        more = True
        while more:
            event = await receive()
            etype = event.get("type")
            if etype == "http.request":
                chunks.extend(event.get("body") or b"")
                more = bool(event.get("more_body"))
            elif etype == "http.disconnect":
                return
            else:
                more = False
        rewritten = rewrite_rpc_bytes(bytes(chunks))
        headers = []
        for key, value in scope.get("headers") or []:
            if key == b"content-length":
                headers.append((key, str(len(rewritten)).encode()))
            else:
                headers.append((key, value))
        new_scope = dict(scope)
        new_scope["headers"] = headers
        sent = False
        hold = asyncio.Event()

        async def new_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": rewritten, "more_body": False}
            # Do not fake a client disconnect — that aborts SSE streams.
            await hold.wait()
            return {"type": "http.disconnect"}

        await self.app(new_scope, new_receive, send)
