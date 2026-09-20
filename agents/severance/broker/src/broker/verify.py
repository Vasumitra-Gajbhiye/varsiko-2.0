"""Pilot-side verification. Signature check plus an independent ceiling comparison.

If the Broker were fully compromised, the Pilot still refuses an over-cap mandate.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from broker.contracts import (
    SIGNATURE_KID,
    CartMandate,
    canonical_dumps,
    parse_iso,
)
from broker.mandate import signing_key

import hmac


class VerifyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def to_dict(self) -> dict[str, Any]:
        return {"ok": False, "error": self.code, "message": self.message}


def verify_signature(mandate: CartMandate | dict[str, Any], secret: str | None = None) -> None:
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    if mandate.signature.kid != SIGNATURE_KID:
        raise VerifyError("UNKNOWN_KID", f"unknown signature kid {mandate.signature.kid}")
    if mandate.signature.alg != "HMAC-SHA256":
        raise VerifyError("UNSUPPORTED_ALG", f"unsupported alg {mandate.signature.alg}")
    payload = mandate.unsigned_payload()
    body = canonical_dumps(payload)
    expected = hmac.new(signing_key(secret), body.encode("utf-8"), digestmod="sha256").hexdigest()
    if not hmac.compare_digest(expected, mandate.signature.value):
        raise VerifyError("BAD_SIGNATURE", "HMAC-SHA256 does not match canonical payload")


def recheck_ceiling(mandate: CartMandate | dict[str, Any]) -> None:
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    monthly = mandate.decision.monthly_inr
    ceiling = mandate.constraints_applied.ceiling_inr_monthly
    if monthly > ceiling:
        raise VerifyError("OVER_CEILING", f"{monthly} > {ceiling}")


def verify_not_expired(mandate: CartMandate | dict[str, Any], now: datetime | None = None) -> None:
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    moment = now or datetime.now(timezone.utc)
    if parse_iso(mandate.expires_at) <= moment:
        raise VerifyError("EXPIRED", f"mandate {mandate.mandate_id} expired at {mandate.expires_at}")


def verify_mandate(
    mandate: CartMandate | dict[str, Any],
    secret: str | None = None,
    *,
    now: datetime | None = None,
    check_expiry: bool = True,
) -> dict[str, Any]:
    """Independent Pilot checks: HMAC, then monthly_inr <= ceiling, then expiry."""
    if isinstance(mandate, dict):
        mandate = CartMandate.model_validate(mandate)
    verify_signature(mandate, secret)
    recheck_ceiling(mandate)
    if check_expiry:
        verify_not_expired(mandate, now)
    return {"ok": True, "mandate_id": mandate.mandate_id}
