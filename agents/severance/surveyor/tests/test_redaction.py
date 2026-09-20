from surveyor.emit import emit_result, render_card
from surveyor.capacity import static_default_capacity
from surveyor.intake import parse_intake
from surveyor.predict import build_predictions
from surveyor.redact import redact_text
from surveyor.verdict import decide


FAKE = "vercel_abcdefghijklmnopqrstuvwxyz123456"


def test_redact_text_strips_token():
    assert FAKE not in redact_text(f"token={FAKE}")


def test_output_json_and_card_have_no_planted_token():
    intake = parse_intake("https://github.com/acme/clean-app ceiling_inr_monthly: 1500")
    cap = static_default_capacity()
    v = decide(intake=intake, scan=None, capacity=cap, mode="static-only")
    pred = build_predictions(cap, None, None, committed_at="2026-09-20T12:34:56Z")
    meta = {
        "version": "0.1.0",
        "mode": "static-only",
        "warnings": [f"note {FAKE}"],
        "env_inventory": [],
        "method": {"constants": cap.constants},
    }
    doc = emit_result(
        intake=intake,
        mode="static-only",
        verdict=v,
        capacity=cap,
        scan=None,
        cost=None,
        predictions=pred,
        surveyor_meta=meta,
        include_current_cost=False,
    )
    blob = render_card(doc) + str(doc)
    assert FAKE not in blob
    assert "[REDACTED]" in str(doc["surveyor"]["warnings"])
