from src.api import Api


def test_initial_request_uses_token():
    api = Api("abc")
    assert api.request()["Authorization"] == "Bearer abc"


def test_request_after_refresh_uses_new_token():
    api = Api("abc")
    api.refresh_token()
    hdr = api.request()["Authorization"]
    assert hdr == "Bearer abc+refreshed", hdr
