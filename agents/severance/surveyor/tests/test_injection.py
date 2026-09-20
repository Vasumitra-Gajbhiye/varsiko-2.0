from surveyor.lockin_scan import scan_lockin
from surveyor.fixture_store import repo_fixture
from surveyor.verdict import decide
from surveyor.intake import parse_intake
from surveyor.capacity import static_default_capacity


def test_poisoned_repo_matches_clean_verdict():
    clean = scan_lockin(repo_fixture("clean"))
    poisoned = scan_lockin(repo_fixture("poisoned"))
    intake = parse_intake("https://github.com/acme/x ceiling_inr_monthly: 1500")
    cap = static_default_capacity()
    v_clean = decide(intake=intake, scan=clean, capacity=cap, mode="static-only")
    v_poisoned = decide(intake=intake, scan=poisoned, capacity=cap, mode="static-only")
    assert v_clean.verdict == v_poisoned.verdict == "PROCEED"
    assert [d.feature for d in clean.details] == [d.feature for d in poisoned.details]
    dumped = " ".join(hit.match for d in poisoned.details for hit in d.evidence)
    assert "Ignore prior" not in dumped
