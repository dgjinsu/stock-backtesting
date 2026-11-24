"""HTTP 진입점(src/main.py)을 확인한다. Yahoo는 fixture를 물린 가짜로 바꿔 네트워크 없이 부른다."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from src.main import Settings, app, create_app
from src.market import Market
from tests.helpers import FakeYahoo

EXAMPLE: dict[str, Any] = {
    "symbols": ["QQQ", "QLD"],
    "start": "2021-11-24",
    "end": "2026-11-24",
    "freq": "monthly",
    "anchor": 1,
    "amount": 2_000_000,
    "currency": "KRW",
    "fractional": True,
    "fee_pct": 0,
}


@pytest.fixture
def api(tmp_path: Path) -> Iterator[tuple[TestClient, FakeYahoo]]:
    yahoo = FakeYahoo()
    client = httpx.AsyncClient(transport=httpx.MockTransport(yahoo))
    market = Market(tmp_path, client)
    with TestClient(create_app(Settings(data_dir=tmp_path), market=market)) as test_client:
        yield test_client, yahoo
    asyncio.run(client.aclose())


def _post(client: TestClient, **changes: Any) -> httpx.Response:
    return client.post("/api/backtest", json={**EXAMPLE, **changes})


def _result(body: dict[str, Any], symbol: str) -> dict[str, Any]:
    return next(r for r in body["results"] if r["symbol"] == symbol)


# ---------- 정적 파일, 상태 ----------


def test_healthz_returns_ok() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_root_serves_web_index_html() -> None:
    with TestClient(app) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "적립식 백테스트" in response.text


def test_unknown_api_path_returns_404() -> None:
    with TestClient(app) as client:
        assert client.get("/api/does-not-exist").status_code == 404


def test_openapi_docs_page_is_served() -> None:
    with TestClient(app) as client:
        assert client.get("/docs").status_code == 200


# ---------- POST /api/backtest ----------


def test_backtest_example_matches_expected_values(api: tuple[TestClient, FakeYahoo]) -> None:
    client, _ = api
    response = _post(client)
    assert response.status_code == 200
    body = response.json()
    assert body["errors"] == []
    assert [r["symbol"] for r in body["results"]] == ["QQQ", "QLD"]
    qld = _result(body, "QLD")
    summary = qld["summary"]
    assert qld["name"] == "ProShares Ultra QQQ"
    assert qld["currency"] == "USD"
    assert qld["data_through"] == "2026-11-23"
    assert qld["stale"] is False
    assert summary["buys"] == 60
    assert summary["first_buy"] == "2021-12-01"
    assert summary["avg_cost_asset"] == pytest.approx(37.97, abs=0.01)
    assert summary["avg_cost_invest"] == pytest.approx(51363, abs=1)
    assert summary["value"] == pytest.approx(225_824_590, abs=1)
    assert summary["profit"] == pytest.approx(105_824_590, abs=1)
    assert summary["return_pct"] == 88.19
    assert summary["xirr_pct"] == 25.75
    assert summary["eval_fx"] == 1344.16
    assert summary["best"] == {"date": "2026-06-02", "return_pct": pytest.approx(211.6, abs=0.05)}
    assert summary["from_peak_pct"] == pytest.approx(-34.1, abs=0.05)
    assert "2025-11-20 2:1 분할 반영" in qld["notes"]
    assert len(qld["buys"]) == 60
    assert qld["buys"][0]["date"] == "2021-12-01"


def test_backtest_chart_shares_one_date_axis(api: tuple[TestClient, FakeYahoo]) -> None:
    client, _ = api
    chart = _post(client, freq="daily", anchor=None, amount=100_000).json()["chart"]
    assert 0 < len(chart["dates"]) <= 1000
    for symbol in ("QQQ", "QLD"):
        series = chart["series"][symbol]
        assert len(series["value"]) == len(chart["dates"])
        assert len(series["return_pct"]) == len(chart["dates"])


def test_backtest_usd_investment_needs_no_fx(api: tuple[TestClient, FakeYahoo]) -> None:
    client, yahoo = api
    body = _post(client, symbols=["QQQ"], amount=1500, currency="USD").json()
    summary = _result(body, "QQQ")["summary"]
    assert summary["value"] == pytest.approx(138_171, abs=1)
    assert summary["eval_fx"] == 1
    assert not any("USDKRW" in path for path in yahoo.calls)


def test_backtest_unknown_symbol_fails_alone(api: tuple[TestClient, FakeYahoo]) -> None:
    client, _ = api
    body = _post(client, symbols=["QLD", "XXXX"]).json()
    assert [r["symbol"] for r in body["results"]] == ["QLD"]
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]
    assert list(body["chart"]["series"]) == ["QLD"]


def test_backtest_all_symbols_failing_returns_only_errors(
    api: tuple[TestClient, FakeYahoo],
) -> None:
    client, _ = api
    response = _post(client, symbols=["XXXX"])
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == []
    assert body["chart"]["dates"] == []
    assert len(body["errors"]) == 1


@pytest.mark.parametrize(
    ("changes", "field", "words"),
    [
        ({"amount": 0}, "amount", "금액"),
        ({"symbols": [f"S{i}" for i in range(9)]}, "symbols", "1~8"),
        ({"symbols": []}, "symbols", "1~8"),
        ({"symbols": ["QQ Q"]}, "symbols", "종목 코드"),
        ({"symbols": ["QLD", "qld"]}, "symbols", "두 번"),
        ({"start": "2026-11-24"}, "start", "시작일"),
        ({"end": "2099-01-01"}, "end", "오늘"),
        ({"start": "2021/11/24"}, "start", "날짜"),
        ({"freq": "weekly", "anchor": 6}, "anchor", "요일"),
        ({"anchor": 0}, "anchor", "날짜"),
        ({"currency": "JPY"}, "currency", "통화"),
        ({"fee_pct": 11}, "fee_pct", "수수료"),
    ],
    ids=[
        "amount-zero",
        "nine-symbols",
        "no-symbols",
        "bad-symbol",
        "duplicate-symbol",
        "start-not-before-end",
        "end-after-today",
        "bad-date",
        "weekly-anchor",
        "monthly-anchor",
        "currency",
        "fee",
    ],
)
def test_backtest_bad_input_returns_422_with_korean_message(
    api: tuple[TestClient, FakeYahoo], changes: dict[str, Any], field: str, words: str
) -> None:
    client, yahoo = api
    response = _post(client, **changes)
    assert response.status_code == 422
    details = response.json()["detail"]
    assert any(d["field"] == field and words in d["message"] for d in details), details
    assert yahoo.calls == []


def test_backtest_weekly_without_anchor_defaults_to_monday(
    api: tuple[TestClient, FakeYahoo],
) -> None:
    client, _ = api
    body = _post(client, symbols=["QLD"], freq="weekly", anchor=None, amount=500_000).json()
    assert _result(body, "QLD")["summary"]["first_buy"] == "2021-11-29"


# ---------- GET /api/search ----------


def test_search_returns_hits(api: tuple[TestClient, FakeYahoo]) -> None:
    client, yahoo = api
    yahoo.search_payload = {
        "quotes": [
            {
                "symbol": "QLD",
                "shortname": "ProShares Ultra QQQ",
                "exchDisp": "NYSEArca",
                "quoteType": "ETF",
            }
        ]
    }
    response = client.get("/api/search", params={"q": "qld"})
    assert response.status_code == 200
    assert response.json() == [
        {"symbol": "QLD", "name": "ProShares Ultra QQQ", "exchange": "NYSEArca", "type": "ETF"}
    ]


def test_search_failure_returns_503_with_message(api: tuple[TestClient, FakeYahoo]) -> None:
    client, yahoo = api
    yahoo.fail = True
    response = client.get("/api/search", params={"q": "qld"})
    assert response.status_code == 503
    assert "검색" in response.json()["detail"]
