"""The only outbound write. Callable only after executor-recorded approval."""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any

import httpx

from broker.contracts import CartMandate, parse_iso, utc_now
from broker.verify import verify_mandate, VerifyError

logger = logging.getLogger(__name__)


def emit_to_pilot(
    mandate: CartMandate | dict[str, Any],
    *,
    approved: bool,
    headers: dict[str, str] | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    if not approved or mandate.approval.status != "approved":
        return {"error": "REFUSED", "reason": "NOT_APPROVED"}
    if parse_iso(mandate.expires_at) <= utc_now():
        return {"error": "REFUSED", "reason": "EXPIRED"}
    try:
        verify_mandate(mandate, check_expiry=True)
    except VerifyError as exc:
        return {"error": "REFUSED", "reason": exc.code, "detail": exc.message}

    url = os.environ.get("PILOT_A2A_URL", "").rstrip("/")
    agent_id = os.environ.get("PILOT_AGENT_ID", "")
    if not url:
        logger.info("PILOT_A2A_URL unset; stubbing emit_to_pilot for %s", mandate.mandate_id)
        return {
            "status": "stubbed",
            "reason": "PILOT_A2A_URL unset",
            "mandate_id": mandate.mandate_id,
            "pilot_agent_id": agent_id or None,
        }

    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": "message/send",
        "params": {
            "message": {
                "messageId": str(uuid.uuid4()),
                "role": "user",
                "parts": [
                    {
                        "text": CartMandate.model_validate(mandate).model_dump_json(
                            by_alias=True
                        )
                    }
                ],
            },
            "metadata": {"agent_id": agent_id} if agent_id else {},
        },
    }
    outbound_headers = {"Content-Type": "application/json"}
    if headers:
        token = headers.get("x-nasiko-agent-token") or headers.get("X-Nasiko-Agent-Token")
        if token:
            outbound_headers["x-nasiko-agent-token"] = token
        trace = headers.get("traceparent")
        if trace:
            outbound_headers["traceparent"] = trace

    own = client is None
    http = client or httpx.Client()
    try:
        response = http.post(url, headers=outbound_headers, json=payload, timeout=30.0)
        try:
            body = response.json()
        except ValueError:
            body = {"text": response.text}
        return {"status": "sent", "http_status": response.status_code, "body": body}
    except httpx.HTTPError as exc:
        return {"error": "UNREACHABLE", "reason": str(exc)}
    finally:
        if own:
            http.close()
