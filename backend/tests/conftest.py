import pytest

@pytest.fixture
def api_client():
    import requests
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s
