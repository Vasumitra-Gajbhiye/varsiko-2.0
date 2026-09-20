import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from serve import harvest, parse_sse, plans_from_shop


def test_parse_sse_picks_spec_and_shop():
    spec = {"schema": "severance.capacity_spec/v1", "constraints": {"spec_floor": {"vcpu": 3}}}
    shop = {
        "schema": "severance.shop_result/v1",
        "winner": {"provider": "hetzner", "plan_sku": "cpx31", "source_url": "https://www.hetzner.com/cloud/", "monthly_inr": 1035},
        "survivors": [
            {"provider": "hetzner", "plan_sku": "cpx31", "source_url": "https://www.hetzner.com/cloud/", "monthly_inr": 1035},
            {"provider": "vultr", "plan_sku": "vc2", "source_url": "https://www.vultr.com/pricing/", "monthly_inr": 1400},
        ],
    }
    raw = (
        "data: " + json.dumps({"artifactUpdate": {"artifact": {"name": "surveyor_result.json", "parts": [{"text": json.dumps(spec)}]}}})
        + "\n"
        + "data: " + json.dumps({"artifactUpdate": {"artifact": {"name": "shop_result", "parts": [{"data": shop}]}}})
        + "\n"
    )
    bucket = parse_sse(raw)
    assert bucket["spec"]["constraints"]["spec_floor"]["vcpu"] == 3
    plans = plans_from_shop(bucket["shop"])
    assert [p["provider"] for p in plans] == ["hetzner", "vultr"]
    assert plans[0]["source_url"].startswith("https://www.hetzner.com")


def test_harvest_nested_text_json():
    bucket = {}
    harvest({"parts": [{"text": json.dumps({"schema": "severance.cart_mandate/v1", "decision": {"provider": "hetzner"}})}]}, bucket)
    assert bucket["mandate"]["decision"]["provider"] == "hetzner"
