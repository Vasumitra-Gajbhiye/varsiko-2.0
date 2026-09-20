from surveyor.intake import looks_like_survey, merge_intake, parse_intake
from surveyor.redact import looks_like_secret


def test_parses_github_url_and_tree_ref():
    intake = parse_intake(
        "Please survey https://github.com/acme/victim-app/tree/main/apps/web ceiling_inr_monthly: 1500"
    )
    assert intake.owner == "acme"
    assert intake.name == "victim-app"
    assert intake.ref == "main"
    assert intake.subdir == "apps/web"
    assert intake.ceiling_inr_monthly == 1500
    assert intake.repo_url == "https://github.com/acme/victim-app"


def test_parses_json_overrides():
    intake = parse_intake(
        '{"repo":"https://github.com/acme/victim-app","ceiling_inr_monthly":1500,'
        '"region_allowlist":["sg-sin"],"window_days":7}'
    )
    assert intake.ceiling_inr_monthly == 1500
    assert intake.region_allowlist == ["sg-sin"]
    assert intake.window_days == 7


def test_never_infers_ceiling():
    intake = parse_intake("https://github.com/acme/victim-app is expensive, maybe 2000")
    assert intake.repo_url
    assert intake.ceiling_inr_monthly is None


def test_rupee_ceiling_word():
    intake = parse_intake("https://github.com/acme/x ceiling ₹1500")
    assert intake.ceiling_inr_monthly == 1500


def test_pasted_token_is_refused():
    text = "use VERCEL_TOKEN=vercel_abcdefghijklmnopqrstuvwxyz123456"
    intake = parse_intake(text)
    assert intake.pasted_secret is True
    assert intake.repo_url is None
    assert looks_like_secret(text)


def test_merge_keeps_repo_adds_ceiling():
    base = parse_intake("https://github.com/acme/victim-app")
    update = parse_intake("ceiling_inr_monthly: 1500")
    merged = merge_intake(base, update)
    assert merged.repo_url.endswith("victim-app")
    assert merged.ceiling_inr_monthly == 1500


def test_bare_ceiling_only_when_allowed():
    assert parse_intake("1500").ceiling_inr_monthly is None
    assert parse_intake("1500", allow_bare_ceiling=True).ceiling_inr_monthly == 1500


def test_looks_like_survey():
    assert looks_like_survey("https://github.com/acme/victim-app")
    assert not looks_like_survey("hello there")
