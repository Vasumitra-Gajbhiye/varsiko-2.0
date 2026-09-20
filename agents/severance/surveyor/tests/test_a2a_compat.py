from a2a_compat import rewrite_rpc_bytes


def test_rewrites_a2a_10_method_names():
    raw = rewrite_rpc_bytes(b'{"jsonrpc":"2.0","method":"SendStreamingMessage","params":{}}')
    assert b'"message/stream"' in raw
    raw = rewrite_rpc_bytes(b'{"jsonrpc":"2.0","method":"SendMessage","params":{}}')
    assert b'"message/send"' in raw
