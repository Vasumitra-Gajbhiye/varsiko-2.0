"""One real Anakin round trip per provider. Not collected by pytest. Costs a few credits.

    cd agents/severance/broker
    ANAKIN_API_KEY=ak_live_... .venv312/bin/python scripts/live_smoke.py            # look only
    ANAKIN_API_KEY=ak_live_... .venv312/bin/python scripts/live_smoke.py --save     # overwrite fixtures

--save writes the REAL search + scrape payloads into src/broker/fixtures/ (the demo's insurance policy),
then copy them to tests/fixtures/.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
os.environ["BROKER_OFFLINE"] = "0"
if "--save" in sys.argv:
    os.environ["BROKER_WRITE_FIXTURES"] = "1"

from broker.discovery import discover_pricing_pages  # noqa: E402
from broker.pricing import fetch_pricing  # noqa: E402
from broker.providers import PROVIDER_ORDER  # noqa: E402

if not os.environ.get("ANAKIN_API_KEY"):
    sys.exit("set ANAKIN_API_KEY")

for pid in PROVIDER_ORDER:
    print(f"\n=== {pid}")
    d = discover_pricing_pages(pid)
    print(f"search  via={d.discovered_via} unreachable={d.unreachable} suspect={d.suspect}")
    for c in d.candidates[:3]:
        print("   ", c.url)
    if d.discarded:
        print("    discarded (not allowlisted):", d.discarded)
    if not d.candidates:
        continue
    f = fetch_pricing(pid, d.candidates[0].url, discovered_via=d.discovered_via)
    print(f"scrape  via={f.discovered_via} unreachable={f.unreachable} suspect={f.suspect} rows={len(f.rows)} {f.detail}")
    for r in f.rows[:6]:
        print(f"    {r.plan_sku:<14} {r.vcpu}vCPU {r.ram_gb}GB {r.disk_gb}GB  {r.price} {r.currency}/{r.period}  regions={r.regions}")
    if f.discovered_via == "fixture-fallback":
        print("    !! this is FIXTURE data, not a live result:", f.detail)
