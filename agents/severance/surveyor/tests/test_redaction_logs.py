from surveyor.redact import redact_text

FAKE = "github_pat_abcdefghijklmnopqrstuv"


def test_exception_text_redacted():
    try:
        raise RuntimeError(f"failed with {FAKE}")
    except RuntimeError as exc:
        assert FAKE not in redact_text(str(exc))
