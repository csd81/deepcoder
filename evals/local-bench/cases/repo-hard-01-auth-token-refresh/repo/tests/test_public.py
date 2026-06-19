from src.api import Api


def test_initial_request_uses_token():
    api = Api("abc")
    assert api.request()["Authorization"] == "Bearer abc"
