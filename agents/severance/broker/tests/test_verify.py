from broker.mandate import constraints_hash, mint_mandate, signing_key
from broker.scoring import score_candidates
from broker.verify import VerifyError, recheck_ceiling, verify_mandate, verify_signature
from broker.discovery import discover_pricing_pages
from broker.pricing import fetch_pricing
from broker.providers import PROVIDER_ORDER


def _mint(spec, secret, ceiling=None):
    rows = []
    for pid in PROVIDER_ORDER:
        disc = discover_pricing_pages(pid, offline=True)
        fetched = fetch_pricing(pid, disc.candidates[0].url, offline=True)
        rows.extend(fetched.rows)
    constraints = spec.constraints
    if ceiling is not None:
        constraints = constraints.model_copy(update={"ceiling_inr_monthly": ceiling})
    ranked = score_candidates(rows, constraints)
    minted = mint_mandate(
        ranked.winner,
        constraints,
        constraints_hash(constraints),
        ranked=ranked,
        spec=spec.model_copy(update={"constraints": constraints}),
        secret=secret,
    )
    return minted, ranked


def test_happy_path(spec, secret):
    minted, _ = _mint(spec, secret)
    assert verify_mandate(minted, secret, check_expiry=False)["ok"] is True


def test_one_digit_tamper_fails(spec, secret):
    minted, _ = _mint(spec, secret)
    dumped = minted.model_dump(mode="json", by_alias=True)
    dumped["decision"]["monthly_inr"] = dumped["decision"]["monthly_inr"] + 1
    try:
        verify_signature(dumped, secret)
        raise AssertionError("tamper should fail")
    except VerifyError as exc:
        assert exc.code == "BAD_SIGNATURE"


def test_over_ceiling_fails_even_with_valid_signature(spec, secret):
    """Pilot re-checks the number independently. A forged-but-signed over-cap mandate still dies."""
    minted, _ = _mint(spec, secret)
    dumped = minted.unsigned_payload()
    dumped["decision"]["monthly_inr"] = 99999
    import hmac
    from broker.contracts import CartMandate, canonical_dumps, Signature

    value = hmac.new(signing_key(secret), canonical_dumps(dumped).encode(), "sha256").hexdigest()
    forged = {**dumped, "approval": minted.approval.model_dump(), "signature": {"alg": "HMAC-SHA256", "kid": "severance-2026", "value": value}}
    mandate = CartMandate.model_validate(forged)
    verify_signature(mandate, secret)
    try:
        recheck_ceiling(mandate)
        raise AssertionError("ceiling recheck should fail")
    except VerifyError as exc:
        assert exc.code == "OVER_CEILING"
    try:
        verify_mandate(mandate, secret, check_expiry=False)
        raise AssertionError("verify_mandate should fail")
    except VerifyError as exc:
        assert exc.code == "OVER_CEILING"
