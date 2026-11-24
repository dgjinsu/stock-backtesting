"""HTTP 진입점(src/main.py)을 확인한다. Yahoo는 fixture를 물린 가짜로 바꿔 네트워크 없이 부른다."""

import asyncio
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from src.main import Settings, app, create_app
from src.market import Market
from tests.helpers import FakeYahoo, inverted_fx_payload, load_series

TODAY = date(2026, 11, 24)
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


class Clock:
    def __init__(self) -> None:
        self.now = 1_795_500_000.0

    def __call__(self) -> float:
        return self.now


class Api:
    """테스트용 서버 하나: TestClient, 가짜 Yahoo, 시계."""

    def __init__(self, client: TestClient, yahoo: FakeYahoo, clock: Clock) -> None:
        self.client, self.yahoo, self.clock = client, yahoo, clock


@pytest.fixture
def api(tmp_path: Path) -> Iterator[Api]:
    yahoo, clock = FakeYahoo(), Clock()
    client = httpx.AsyncClient(transport=httpx.MockTransport(yahoo))
    market = Market(tmp_path, client, clock=clock)
    server = create_app(Settings(data_dir=tmp_path), market=market, today=lambda: TODAY)
    with TestClient(server) as test_client:
        yield Api(test_client, yahoo, clock)
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


def test_backtest_example_matches_expected_values(api: Api) -> None:
    client = api.client
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


def test_backtest_chart_shares_one_date_axis(api: Api) -> None:
    client = api.client
    chart = _post(client, freq="daily", anchor=None, amount=100_000).json()["chart"]
    assert 0 < len(chart["dates"]) <= 1000
    assert chart["total_days"] > len(chart["dates"])  # 5년 매일(약 1,250일)은 줄여서 보낸다
    for symbol in ("QQQ", "QLD"):
        series = chart["series"][symbol]
        assert len(series["value"]) == len(chart["dates"])
        assert len(series["return_pct"]) == len(chart["dates"])


def test_backtest_usd_investment_needs_no_fx(api: Api) -> None:
    client, yahoo = api.client, api.yahoo
    body = _post(client, symbols=["QQQ"], amount=1500, currency="USD").json()
    summary = _result(body, "QQQ")["summary"]
    assert summary["value"] == pytest.approx(138_171, abs=1)
    assert summary["eval_fx"] == 1
    assert not any("USDKRW" in path for path in yahoo.calls)


def test_backtest_unknown_symbol_fails_alone(api: Api) -> None:
    client = api.client
    body = _post(client, symbols=["QLD", "XXXX"]).json()
    assert [r["symbol"] for r in body["results"]] == ["QLD"]
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]
    assert list(body["chart"]["series"]) == ["QLD"]


def test_backtest_all_symbols_failing_returns_only_errors(
    api: Api,
) -> None:
    client = api.client
    response = _post(client, symbols=["XXXX"])
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == []
    assert body["chart"]["dates"] == []
    assert body["chart"]["total_days"] == 0
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
    api: Api, changes: dict[str, Any], field: str, words: str
) -> None:
    client, yahoo = api.client, api.yahoo
    response = _post(client, **changes)
    assert response.status_code == 422
    details = response.json()["detail"]
    assert any(d["field"] == field and words in d["message"] for d in details), details
    assert yahoo.calls == []


def test_backtest_weekly_without_anchor_defaults_to_monday(
    api: Api,
) -> None:
    client = api.client
    body = _post(client, symbols=["QLD"], freq="weekly", anchor=None, amount=500_000).json()
    assert _result(body, "QLD")["summary"]["first_buy"] == "2021-11-29"


# ---------- GET /api/search ----------


def test_search_returns_hits(api: Api) -> None:
    client, yahoo = api.client, api.yahoo
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


def test_search_korean_name_returns_empty_list(api: Api) -> None:
    """F-01: 한글 이름은 결과 없음 (화면이 "코드나 영문 이름으로 찾아 주세요"라고 안내한다)."""
    api.yahoo.search_status = 400
    response = api.client.get("/api/search", params={"q": "삼성전자"})
    assert response.status_code == 200
    assert response.json() == []


def test_search_failure_returns_503_with_message(api: Api) -> None:
    client, yahoo = api.client, api.yahoo
    yahoo.fail = True
    response = client.get("/api/search", params={"q": "qld"})
    assert response.status_code == 503
    assert "검색" in response.json()["detail"]


# ---------- 실패 경로와 경계 (리뷰 반영) ----------


def test_backtest_krw_stock_bought_in_usd_keeps_small_fx(api: Api) -> None:
    api.yahoo.extra["KRWUSD=X"] = inverted_fx_payload("USDKRW=X", "USD")
    body = _post(api.client, symbols=["005930.KS"], amount=1500, currency="USD").json()
    assert body["errors"] == []
    result = _result(body, "005930.KS")
    assert result["summary"]["eval_fx"] == pytest.approx(1 / 1344.16, rel=1e-5)
    assert all(row["fx"] > 0 for row in result["buys"])


def test_backtest_with_stale_cache_marks_result(api: Api) -> None:
    assert _post(api.client).status_code == 200
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    qld = _result(_post(api.client).json(), "QLD")
    assert qld["stale"] is True
    assert qld["data_through"] == "2026-11-23"


def test_backtest_listed_after_start_reports_listing_date(api: Api) -> None:
    qld = _result(_post(api.client, start="2020-01-01").json(), "QLD")
    assert qld["listed_from"] == load_series("QLD").dates[0].isoformat()


def test_backtest_fx_failure_fails_only_that_symbol(api: Api) -> None:
    api.yahoo.missing.add("USDKRW=X")
    body = _post(api.client, symbols=["QLD", "005930.KS"]).json()
    assert [r["symbol"] for r in body["results"]] == ["005930.KS"]
    assert body["errors"] == [
        {"symbol": "QLD", "message": "USDKRW=X 환율을 받지 못해 계산하지 못했습니다."}
    ]


def test_backtest_without_buy_days_in_period_is_symbol_error(api: Api) -> None:
    body = _post(api.client, start="2026-11-03", end="2026-11-20").json()
    assert body["results"] == []
    assert all("매수일" in e["message"] for e in body["errors"])
    assert len(body["errors"]) == 2


def test_backtest_end_after_injected_today_is_rejected(api: Api) -> None:
    response = _post(api.client, end="2026-11-25")
    assert response.status_code == 422
    assert response.json()["detail"][0]["field"] == "end"


def test_backtest_reports_all_cross_field_errors_at_once(api: Api) -> None:
    response = _post(api.client, freq="weekly", anchor=6, start="2026-11-24")
    fields = {d["field"] for d in response.json()["detail"]}
    assert fields == {"anchor", "start"}


def test_backtest_non_text_symbol_has_own_message(api: Api) -> None:
    details = _post(api.client, symbols=[1]).json()["detail"]
    assert details[0]["field"] == "symbols"
    assert "문자열" in details[0]["message"]


def test_backtest_notes_split_after_end_too(api: Api) -> None:
    qld = _result(_post(api.client, end="2024-01-02").json(), "QLD")
    assert "2025-11-20 2:1 분할 반영" in qld["notes"]


def test_search_too_long_query_names_q_field(api: Api) -> None:
    response = api.client.get("/api/search", params={"q": "x" * 51})
    assert response.status_code == 422
    assert response.json()["detail"][0]["field"] == "q"


def test_backtest_shared_fx_pair_is_fetched_once_even_when_failing(api: Api) -> None:
    assert _post(api.client).status_code == 200
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    api.yahoo.calls.clear()
    _post(api.client)
    assert sum(1 for path in api.yahoo.calls if path.endswith("USDKRW=X")) == 1


def test_backtest_unexpected_error_is_not_hidden(api: Api, monkeypatch: pytest.MonkeyPatch) -> None:
    market = api.client.app.state.market  # type: ignore[attr-defined]
    original = market.get_series

    async def broken(symbol: str) -> Any:
        if symbol == "USDKRW=X":
            raise RuntimeError("코드 버그")
        return await original(symbol)

    monkeypatch.setattr(market, "get_series", broken)
    with pytest.raises(RuntimeError, match="코드 버그"):
        _post(api.client)
