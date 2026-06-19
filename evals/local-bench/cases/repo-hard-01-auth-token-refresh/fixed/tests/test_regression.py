from src.api import Api


def test_request_after_refresh_uses_new_token():
    api = Api("abc")
    api.refresh_token()
    assert api.request()["Authorization"] == "Bearer abc+refreshed"
