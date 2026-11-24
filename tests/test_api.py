"""HTTP 진입점(src/main.py)을 확인한다. 네트워크 없이 TestClient로 부른다."""

from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_healthz_returns_ok() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root_serves_web_index_html() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "적립식 백테스트" in response.text


def test_unknown_api_path_returns_404() -> None:
    assert client.get("/api/does-not-exist").status_code == 404
