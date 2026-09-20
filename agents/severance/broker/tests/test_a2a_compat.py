from a2a_compat import rewrite_rpc_bytes
import json


def test_rewrites_a2a_10_method_names():
    raw = rewrite_rpc_bytes(b'{"jsonrpc":"2.0","method":"SendStreamingMessage","params":{}}')
    assert b'"message/stream"' in raw
    raw = rewrite_rpc_bytes(b'{"jsonrpc":"2.0","method":"SendMessage","params":{}}')
    assert b'"message/send"' in raw


def test_normalizes_nasiko_role_and_parts():
    raw = rewrite_rpc_bytes(
        b'{"jsonrpc":"2.0","method":"SendMessage","params":{"message":{"role":"ROLE_USER","parts":[{"text":"hi"}]}}}'
    )
    payload = json.loads(raw)
    assert payload["params"]["message"]["role"] == "user"
    assert payload["params"]["message"]["parts"][0]["kind"] == "text"


def test_leaves_03_methods_alone():
    body = b'{"jsonrpc":"2.0","method":"message/send","params":{}}'
    payload = json.loads(rewrite_rpc_bytes(body))
    assert payload["method"] == "message/send"
