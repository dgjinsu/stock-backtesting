"""HTTP 진입점(src/main.py)을 확인한다. Yahoo는 fixture를 물린 가짜로 바꿔 네트워크 없이 부른다."""

import asyncio
import logging
import re
import time
from collections import Counter
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from src import engine, schemas
from src.main import Settings, _to_series, app, create_app
from src.market import Market, PriceHistory
from tests.helpers import (
    CASE_IDS,
    MONTH_END_CASES,
    FakeYahoo,
    inverted_fx_payload,
    load_expected,
    load_series,
    payload_from,
    yahoo_payload,
)

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


# ---------- 엔진 입력으로 바꾸기 (결정 d29) ----------


def _history(tmp_path: Path, symbol: str, *, stale: bool = False) -> PriceHistory:
    """가짜 Yahoo에서 받은 PriceHistory. stale이면 한 번 받아 저장한 뒤 7시간 지나 Yahoo가 실패한다."""
    yahoo, clock = FakeYahoo(), Clock()

    async def fetch() -> PriceHistory:
        async with httpx.AsyncClient(transport=httpx.MockTransport(yahoo)) as client:
            market = Market(tmp_path, client, clock=clock)
            history = await market.get_series(symbol)
            if stale:
                clock.now += 7 * 3600
                yahoo.fail = True
                history = await market.get_series(symbol)
            return history

    return asyncio.run(fetch())


@pytest.mark.parametrize(
    ("symbol", "tz"),
    [("QLD", "America/New_York"), ("005930.KS", "Asia/Seoul")],
    ids=["QLD", "005930.KS"],
)
def test_to_series_fake_yahoo_history_keeps_exchange_tz(
    tmp_path: Path, symbol: str, tz: str
) -> None:
    """레버리지 전환이 거래소를 비교하도록 main이 PriceHistory.exchange_tz를 엔진 Series로 넘긴다."""
    series = _to_series(_history(tmp_path, symbol))
    assert series.symbol == symbol
    assert series.exchange_tz == tz


def test_to_series_stale_cache_only_keeps_exchange_tz(tmp_path: Path) -> None:
    """Yahoo가 실패해 저장본만 쓸 때도 시간대가 남는다 (캐시 파일의 exchange_tz)."""
    history = _history(tmp_path, "QLD", stale=True)
    assert history.stale is True
    assert _to_series(history).exchange_tz == "America/New_York"


# ---------- POST /api/strategy (계산 규칙 9-6, 9-8) ----------

V2 = load_expected()["v2"]
# 9-8 기준값 조건: QLD, 매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화, 수수료 0, 200일선, 기준 종목 QQQ.
# EXAMPLE(11-24부터)과 기간이 달라 따로 둔다
STRATEGY_EXAMPLE: dict[str, Any] = {
    "symbol": V2["symbol"],
    "start": V2["period"][0],
    "end": V2["period"][1],
    "freq": V2["freq"],
    "anchor": V2["anchor"],
    "amount": V2["amount"],
    "currency": V2["invest_currency"],
    "fractional": True,
    "fee_pct": 0,
    "ma_days": V2["ma_days"],
    "switch_ref": V2["switch_ref"],
}
# 계산 규칙 7절 허용 오차: 평단가 ±0.01, 금액 ±1원, 수익률 ±0.01%p. rule_days는 정확히 같다
STRATEGY_TOLERANCE = {
    "value": 1.0,
    "return_pct": 0.01,
    "xirr_pct": 0.01,
    "avg_cost_asset": 0.01,
    "worst_return_pct": 0.01,
    "leftover_cash_invest": 1.0,
}
OTHER_RULES = [rule for rule in V2["strategies"] if rule != "switch"]
# 이슈 #25 완료 기준: 매월 말일, 끝날짜 2026-10-31(토) → 2021-11-30 ~ 2026-10-30 60회.
# 끝날짜로 잘라 넘기면 10월이 진행 중인 달로 빠져 118,000,000원(59회)이다
MONTH_END_INVESTED = 120_000_000


def _v1_result(case_id: str, symbol: str) -> dict[str, Any]:
    """7절 기준값 사례 하나의 종목 결과. 사례는 CASE_IDS의 ASCII id로 찾는다."""
    case = next(c for c in load_expected()["cases"] if CASE_IDS[c["name"]] == case_id)
    result: dict[str, Any] = case["results"][symbol]
    return result


# 9-8: 매수일은 7절과 같고, 9-6: 일시금을 포함한 5개 전략 모두 같은 총액이다 (7절 QLD 매월 1일 200만원)
V2_INVESTED = _v1_result("monthly1-krw2m", "QLD")["invested"]
# 9-8 달러 양도세: QQQ 매월 $1,500의 평가금·투자금은 7절 "매월 1일 1,500달러" 줄과 같다
USD_QQQ = _v1_result("monthly1-usd1500", "QQQ")


def _strategy(client: TestClient, **changes: Any) -> dict[str, Any]:
    """POST /api/strategy를 부르고 200인지 본 뒤 본문을 돌려준다."""
    response = client.post("/api/strategy", json={**STRATEGY_EXAMPLE, **changes})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _assert_strategy(got: dict[str, Any] | None, want: dict[str, Any]) -> None:
    """전략 하나의 7개 값이 기준값과 허용 오차 안인지."""
    assert got is not None
    for field, tolerance in STRATEGY_TOLERANCE.items():
        assert got[field] == pytest.approx(want[field], abs=tolerance), field
    assert got["rule_days"] == want["rule_days"]


def _called(yahoo: FakeYahoo) -> Counter[str]:
    """가짜 Yahoo가 받은 차트 요청을 종목별로 센다."""
    return Counter(path.rsplit("/", 1)[-1] for path in yahoo.calls)


# 기준값과 응답 모양


@pytest.mark.parametrize("rule", list(V2["strategies"]), ids=list(V2["strategies"]))
def test_strategy_reference_case_matches_v2_strategies(api: Api, rule: str) -> None:
    """9-8 전략 표. 시작일로 자르지 않은 데이터를 넘겨야 맞는다: ma_dip·ma_hot 이평선은 2021-11-25 이전
    200거래일 종가를 쓴다 (9-6)."""
    body = _strategy(api.client)
    assert body["errors"] == []
    got = body["result"]["strategies"][rule]
    _assert_strategy(got, V2["strategies"][rule])
    assert got["invested"] == pytest.approx(V2_INVESTED, abs=1)


def test_strategy_reference_case_keys_follow_v2_strategies_and_engine_rules(api: Api) -> None:
    """strategies 키와 순서는 expected.json v2.strategies와 engine.RULES와 같다. 안쪽 7개 이름 + invested."""
    strategies = _strategy(api.client)["result"]["strategies"]
    assert list(strategies) == list(V2["strategies"])
    assert list(strategies) == list(engine.RULES)
    for rule, values in strategies.items():
        assert {*V2["strategies"][rule], "invested"} <= set(values), rule


def test_strategy_reference_case_result_describes_symbol(api: Api) -> None:
    """종목 정보는 /api/backtest와 같다: 분할 안내(1절), 평가일 2026-11-23(7절), 저장본 아님, 상장일 앞섬."""
    result = _strategy(api.client)["result"]
    assert result["symbol"] == "QLD"
    assert result["name"] == "ProShares Ultra QQQ"
    assert result["currency"] == "USD"
    assert "2025-11-20 2:1 분할 반영" in result["notes"]
    assert result["data_through"] == "2026-11-23"
    assert result["stale"] is False
    assert result["listed_from"] is None


def test_strategy_params_echo_uppercase_codes_and_filled_defaults(api: Api) -> None:
    """params는 요청 그대로다. 종목 코드는 대문자, ma_days·switch_ref는 기본값(F-15: 200일, QQQ)을 채운다."""
    body = {k: v for k, v in STRATEGY_EXAMPLE.items() if k not in ("ma_days", "switch_ref")}
    response = api.client.post("/api/strategy", json={**body, "symbol": " qld "})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["params"]["symbol"] == "QLD"
    assert data["params"]["ma_days"] == 200
    assert data["params"]["switch_ref"] == "QQQ"
    assert data["result"]["switch_ref"]["symbol"] == "QQQ"


def test_strategy_request_lowercase_switch_ref_is_uppercased() -> None:
    request = schemas.StrategyRequest.model_validate({**STRATEGY_EXAMPLE, "switch_ref": " qqq "})
    assert request.switch_ref == "QQQ"


@pytest.mark.parametrize("ma_days", [20, 60, 120, 200], ids=["ma20", "ma60", "ma120", "ma200"])
def test_strategy_request_allowed_ma_days_is_kept(ma_days: int) -> None:
    """F-15: 이평선은 20·60·120·200일 중 하나."""
    request = schemas.StrategyRequest.model_validate({**STRATEGY_EXAMPLE, "ma_days": ma_days})
    assert request.ma_days == ma_days


# 거래소 판정 (결정 d29)


def test_strategy_same_timezone_reference_uses_same_day_basis(api: Api) -> None:
    """9-8: QLD와 QQQ는 둘 다 America/New_York이라 매수일 종가를 본다."""
    switch_ref = _strategy(api.client)["result"]["switch_ref"]
    assert switch_ref == {"symbol": "QQQ", "basis": "same_day", "stale": False}


def test_strategy_cross_exchange_reference_matches_v2_and_uses_previous_day(api: Api) -> None:
    """9-8 다른 거래소 레버리지 전환: 005930.KS를 QQQ 200일선으로. 기준 종목은 환율 없이 받는다."""
    body = _strategy(api.client, symbol="005930.KS")
    assert body["errors"] == []
    result = body["result"]
    _assert_strategy(result["strategies"]["switch"], V2["switch_cross_exchange"])
    assert result["switch_ref"]["basis"] == "previous_day"
    assert _called(api.yahoo) == Counter({"005930.KS": 1, "QQQ": 1})


def test_strategy_reference_without_timezone_uses_previous_day_with_same_switch(
    api: Api,
) -> None:
    """9-6: 시간대를 모르면 다른 거래소로 본다. 9-8: 이 사례는 전날 종가로 봐도 판정이 갈리는 날이 없다."""
    payload = yahoo_payload("QQQ")
    del payload["chart"]["result"][0]["meta"]["exchangeTimezoneName"]
    api.yahoo.extra["QQQ"] = payload
    result = _strategy(api.client)["result"]
    assert result["switch_ref"]["basis"] == "previous_day"
    _assert_strategy(result["strategies"]["switch"], V2["strategies"]["switch"])


# 엔진에 넘기는 데이터와 조건


def test_strategy_month_end_until_saturday_keeps_october_buy_from_uncut_data(api: Api) -> None:
    """2절 진행 중인 달: 끝날짜 10-31(토)이어도 데이터가 그 뒤까지 있으면 10월은 끝난 달이라 10-30에 산다."""
    body = _strategy(api.client, anchor=31, end="2026-10-31")
    strategies = body["result"]["strategies"]
    assert list(strategies) == list(V2["strategies"])
    for rule, values in strategies.items():
        assert values["invested"] == pytest.approx(MONTH_END_INVESTED, abs=1), rule


def test_strategy_usd_qqq_none_matches_dollar_reference(api: Api) -> None:
    """9-8 달러 양도세 사례의 평가금 $138,171, 투자금 $90,000, 손익 $48,171."""
    body = _strategy(api.client, symbol="QQQ", amount=1500, currency="USD")
    assert body["errors"] == []
    none = body["result"]["strategies"]["none"]
    assert none["value"] == pytest.approx(USD_QQQ["value"], abs=1)
    assert none["invested"] == pytest.approx(USD_QQQ["invested"], abs=1)
    assert none["value"] - none["invested"] == pytest.approx(V2["dollar_tax"]["profit"], abs=1)


def test_strategy_usd_qqq_with_qqq_reference_fetches_qqq_once_without_fx(api: Api) -> None:
    """달러 종목을 달러로 사면 환율을 받지 않고, 기준 종목이 종목과 같으면 한 번만 받는다."""
    body = _strategy(api.client, symbol="QQQ", amount=1500, currency="USD")
    assert body["result"]["switch_ref"] == {"symbol": "QQQ", "basis": "same_day", "stale": False}
    assert _called(api.yahoo) == Counter({"QQQ": 1})


def test_strategy_whole_shares_flag_keeps_strategy_values(api: Api) -> None:
    """9-6, 결정 d28: 전략은 소수점 매수로 계산하므로 fractional=false여도 값이 같다."""
    fractional = _strategy(api.client)
    whole = _strategy(api.client, fractional=False)
    assert whole["params"]["fractional"] is False
    assert whole["result"]["strategies"] == fractional["result"]["strategies"]


def test_strategy_ma_days_reaches_engine(api: Api) -> None:
    """F-15: 고른 이평선 기간으로 계산한다. 공식은 다시 만들지 않고, 20일선 요청이 엔진을 ma_days=20으로
    부른 값과 같은지만 본다 (API와 엔진의 연결)."""
    body = _strategy(api.client, ma_days=20)
    params = engine.Params(
        start=date.fromisoformat(STRATEGY_EXAMPLE["start"]),
        end=date.fromisoformat(STRATEGY_EXAMPLE["end"]),
        freq=STRATEGY_EXAMPLE["freq"],
        anchor=STRATEGY_EXAMPLE["anchor"],
        amount=STRATEGY_EXAMPLE["amount"],
        currency=STRATEGY_EXAMPLE["currency"],
    )
    asset, fx, ref = load_series("QLD"), load_series("USDKRW=X"), load_series("QQQ")
    strategies = body["result"]["strategies"]
    for rule in engine.RULES:
        want = engine.simulate_rule(asset, fx, ref, params, rule, ma_days=20)
        assert strategies[rule]["rule_days"] == want.rule_days, rule
        assert strategies[rule]["value"] == pytest.approx(want.value, abs=1), rule
    # 200일선 기준값과 실제로 갈린다: 기본값 200으로 계산하면 이 테스트가 실패한다
    assert strategies["ma_dip"]["rule_days"] != V2["strategies"]["ma_dip"]["rule_days"]


def test_strategy_listed_after_start_reports_listing_date(api: Api) -> None:
    """listed_from은 main이 정한다: 첫 거래일이 시작일보다 늦으면 그 날짜다 (/api/backtest와 같은 뜻)."""
    result = _strategy(api.client, start="2020-01-01")["result"]
    assert result["listed_from"] == load_series("QLD").dates[0].isoformat()


# 입력 오류 (422, Yahoo를 부르지 않는다)


@pytest.mark.parametrize(
    ("changes", "field", "words"),
    [
        ({"ma_days": 50}, "ma_days", "이평선"),
        ({"switch_ref": "QQ Q"}, "switch_ref", "종목 코드"),
        ({"symbol": "QQ Q"}, "symbol", "종목 코드"),
        ({"anchor": 0}, "anchor", "1~31"),
        ({"start": "2026-11-24"}, "start", "시작일"),
        ({"end": "2026-11-25"}, "end", "오늘"),
        ({"amount": 0}, "amount", "금액"),
        ({"fee_pct": 11}, "fee_pct", "수수료"),
        ({"currency": "JPY"}, "currency", "통화"),
    ],
    ids=[
        "ma-days-50",
        "switch-ref-format",
        "symbol-format",
        "monthly-anchor-0",
        "start-not-before-end",
        "end-after-today",
        "amount-zero",
        "fee-11",
        "currency-jpy",
    ],
)
def test_strategy_bad_input_returns_422_with_korean_message_without_yahoo(
    api: Api, changes: dict[str, Any], field: str, words: str
) -> None:
    response = api.client.post("/api/strategy", json={**STRATEGY_EXAMPLE, **changes})
    assert response.status_code == 422, response.text
    details = response.json()["detail"]
    assert any(d["field"] == field and words in d["message"] for d in details), details
    assert api.yahoo.calls == []


@pytest.mark.parametrize("field", ["symbol", "switch_ref"], ids=["symbol", "switch-ref"])
def test_strategy_non_text_code_returns_422_with_own_message(api: Api, field: str) -> None:
    """FIELD_MESSAGES의 symbol·switch_ref 문구: 종목 코드는 문자열로 넣는다."""
    response = api.client.post("/api/strategy", json={**STRATEGY_EXAMPLE, field: 1})
    assert response.status_code == 422, response.text
    details = response.json()["detail"]
    assert any(d["field"] == field and "문자열" in d["message"] for d in details), details
    assert api.yahoo.calls == []


# 실패 경로


def test_strategy_unknown_symbol_returns_null_result_with_error(api: Api) -> None:
    body = _strategy(api.client, symbol="XXXX")
    assert body["result"] is None
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]


def test_strategy_missing_fx_returns_null_result_with_fx_message(api: Api) -> None:
    api.yahoo.missing.add("USDKRW=X")
    body = _strategy(api.client)
    assert body["result"] is None
    assert body["errors"] == [
        {"symbol": "QLD", "message": "USDKRW=X 환율을 받지 못해 계산하지 못했습니다."}
    ]


def test_strategy_without_buy_days_in_period_returns_null_result(api: Api) -> None:
    """11-03 ~ 11-20에는 매월 1일 매수일(11-02)이 없다. 엔진의 EngineError를 종목 오류로 돌려준다."""
    body = _strategy(api.client, start="2026-11-03", end="2026-11-20")
    assert body["result"] is None
    assert [e["symbol"] for e in body["errors"]] == ["QLD"]
    assert "매수일" in body["errors"][0]["message"]


def test_strategy_unknown_reference_nulls_only_switch(api: Api) -> None:
    """결정 d31: 기준 종목을 못 받으면 레버리지 전환만 빠지고 나머지 4개는 그대로 돌려준다."""
    body = _strategy(api.client, switch_ref="XXXX")
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]
    result = body["result"]
    assert result["switch_ref"] is None
    assert result["strategies"]["switch"] is None
    for rule in OTHER_RULES:
        _assert_strategy(result["strategies"][rule], V2["strategies"][rule])
        assert result["strategies"][rule]["invested"] == pytest.approx(V2_INVESTED, abs=1)


def test_strategy_symbol_and_reference_failing_lists_symbol_first(api: Api) -> None:
    """종목과 기준 종목이 모두 실패하면 result는 null이고 errors는 종목 줄이 먼저다 (설계 메모)."""
    body = _strategy(api.client, symbol="XXXX", switch_ref="YYYY")
    assert body["result"] is None
    assert body["errors"] == [
        {"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."},
        {"symbol": "YYYY", "message": "'YYYY' 종목을 찾을 수 없습니다."},
    ]


def test_strategy_stale_reference_only_marks_switch_ref(api: Api) -> None:
    """기준 종목만 저장본이면 switch_ref.stale만 True다. 종목·환율은 새로 받았으니 result.stale은 False."""
    _strategy(api.client)
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("QQQ")
    body = _strategy(api.client)
    assert body["errors"] == []
    result = body["result"]
    assert result["stale"] is False
    assert result["switch_ref"] == {"symbol": "QQQ", "basis": "same_day", "stale": True}
    _assert_strategy(result["strategies"]["switch"], V2["strategies"]["switch"])


def test_strategy_all_stale_cache_marks_result_and_reference(api: Api) -> None:
    """Yahoo가 모두 실패하면 저장본으로 계산하고 둘 다 stale로 알린다."""
    _strategy(api.client)
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    body = _strategy(api.client)
    assert body["errors"] == []
    result = body["result"]
    assert result["stale"] is True
    assert result["switch_ref"]["stale"] is True
    assert result["data_through"] == "2026-11-23"


def test_strategy_unexpected_reference_error_is_not_hidden(
    api: Api, monkeypatch: pytest.MonkeyPatch
) -> None:
    """기준 종목을 받다가 MarketError가 아닌 예외가 나면 숨기지 않는다 (코드 컨벤션 2절)."""
    market = api.client.app.state.market  # type: ignore[attr-defined]
    original = market.get_series

    async def broken(symbol: str) -> Any:
        if symbol == "QQQ":
            raise RuntimeError("코드 버그")
        return await original(symbol)

    monkeypatch.setattr(market, "get_series", broken)
    with pytest.raises(RuntimeError, match="코드 버그"):
        api.client.post("/api/strategy", json=STRATEGY_EXAMPLE)


# 호출 횟수와 동시 요청


def test_strategy_krw_qld_fetches_each_symbol_once_two_at_most(api: Api) -> None:
    """종목·환율·기준 종목을 한 번씩만 받고, Yahoo 동시 요청은 2개를 넘지 않는다."""
    body = _strategy(api.client)
    assert body["errors"] == []
    assert _called(api.yahoo) == Counter({"QLD": 1, "USDKRW=X": 1, "QQQ": 1})
    assert api.yahoo.max_in_flight <= 2


# ---------- POST /api/strategy 그래프와 바꿔 보기 (계산 규칙 9-7, 결정 d30) ----------

MAX_CHART_POINTS = 1000  # 기능 명세 F-07: 최대 약 1,000점
CHART_COLUMNS = ("value", "invested", "return_pct")
# 9-8: 매수일은 7절과 같다. 첫 매수일 2021-12-01이 전략 그래프의 첫 날이다
V2_FIRST_BUY = _v1_result("monthly1-krw2m", "QLD")["first_buy"]
# 7절 "월15일 수수료 0.25%" 사례. 9-8 기간(11-25부터)으로 불러도 첫 매수일이 2021-12-15라 매수일 60번이 같다
FEE_CASE = next(
    c for c in load_expected()["cases"] if CASE_IDS[c["name"]] == "monthly15-krw2m-fee0.25"
)
FEE_QLD = FEE_CASE["results"]["QLD"]
# 결정 d30: 7절 매일 사례 = 6단계 조건(4종목 5년 매일 10만원, 원화). 요청 하나가 2초 안
DAILY_CASE = next(c for c in load_expected()["cases"] if CASE_IDS[c["name"]] == "daily-krw100k")
SPEED_SYMBOLS = list(DAILY_CASE["results"])  # QQQ, QLD, TQQQ, SOXL
SPEED_LIMIT_S = 2.0  # 기능 명세 비기능 요구 "속도", 결정 d30


def _assert_anchor_sweep_matches_v2(got: dict[str, Any]) -> None:
    """9-8 매수일 바꿔 보기: 키 "1"~"28", "31" 순서가 같고 평단가는 ±0.01 안."""
    assert list(got) == list(V2["anchor_sweep"])
    for anchor, avg in V2["anchor_sweep"].items():
        assert got[anchor] == pytest.approx(avg, abs=0.01), anchor


def _assert_start_sweep_matches_v2(got: dict[str, Any]) -> None:
    """9-8 시작 시점 바꿔 보기: 키 "YYYY-MM" 순서가 같고 수익률은 ±0.01%p 안."""
    assert list(got) == list(V2["start_sweep"])
    for month, ret in V2["start_sweep"].items():
        assert got[month] == pytest.approx(ret, abs=0.01), month


# 기준값과 응답 모양


def test_strategy_reference_case_anchor_sweep_matches_v2(api: Api) -> None:
    """9-8 조건(매월 1일 요청)의 anchor_sweep. 예: 24일 37.5742, 15일 38.2687."""
    _assert_anchor_sweep_matches_v2(_strategy(api.client)["result"]["anchor_sweep"])


def test_strategy_reference_case_start_sweep_matches_v2(api: Api) -> None:
    """9-8 조건의 start_sweep: 2021-12 ~ 2026-05. 예: 2025-03 +0.82, 2025-04 −0.71."""
    _assert_start_sweep_matches_v2(_strategy(api.client)["result"]["start_sweep"])


def test_strategy_reference_case_chart_covers_trading_days(api: Api) -> None:
    """날짜축은 첫 매수일부터 data_through까지의 거래일(9-8 1,250일)이고, 1,000점 이하로 줄여 보낸다."""
    result = _strategy(api.client)["result"]
    chart = result["chart"]
    assert chart["total_days"] == V2["metrics"]["trading_days"]
    assert len(chart["dates"]) <= MAX_CHART_POINTS
    assert chart["dates"][0] == V2_FIRST_BUY
    assert chart["dates"][-1] == result["data_through"]
    assert list(chart["series"]) == list(engine.RULES)
    for rule, series in chart["series"].items():
        for column in CHART_COLUMNS:
            assert len(series[column]) == len(chart["dates"]), (rule, column)


@pytest.mark.parametrize("rule", list(V2["strategies"]), ids=list(V2["strategies"]))
def test_strategy_reference_case_chart_end_and_worst_match_strategies(api: Api, rule: str) -> None:
    """그래프 끝값은 요약 평가금(±1원), 최저 수익률은 요약 worst_return_pct(±0.01%p)와 같다.
    줄여도 최저 수익률 날짜가 남는다는 확인이다."""
    result = _strategy(api.client)["result"]
    series, summary = result["chart"]["series"][rule], result["strategies"][rule]
    assert series["value"][-1] == pytest.approx(summary["value"], abs=1)
    assert min(series["return_pct"]) == pytest.approx(summary["worst_return_pct"], abs=0.01)


# 바꿔 보기에 넘기는 데이터와 조건


def test_strategy_month_end_until_saturday_anchor_sweep_uses_uncut_data(api: Api) -> None:
    """끝날짜 10-31(토)이어도 자르지 않은 데이터를 넘기면 10월은 끝난 달이라 말일 매수가 2021-11-30 ~
    2026-10-30 60번으로 9-8 기준값의 31일과 같다. 끝날짜로 잘라 넘기면 10-30 매수가 빠져 값이 달라진다."""
    body = _strategy(api.client, anchor=31, end="2026-10-31")
    assert body["errors"] == []
    sweep = body["result"]["anchor_sweep"]
    assert sweep["31"] == pytest.approx(V2["anchor_sweep"]["31"], abs=0.01)


def test_strategy_fee_reaches_both_sweeps(api: Api) -> None:
    """두 바꿔 보기는 요청의 수수료를 담은 같은 Params로 계산한다 (9-7 "2·4절 그대로").
    15일 평단가와 2021-12 시작 수익률이 7절 "월15일 수수료 0.25%" 사례와 같다."""
    # 이 테스트가 가려내는지: 수수료 없는 15일 값(9-8)과는 허용 오차보다 크게 다르다
    assert FEE_QLD["avg_cost_asset"] != pytest.approx(V2["anchor_sweep"]["15"], abs=0.01)
    body = _strategy(api.client, anchor=FEE_CASE["anchor"], fee_pct=FEE_CASE["fee"] * 100)
    assert body["errors"] == []
    result = body["result"]
    assert result["anchor_sweep"]["15"] == pytest.approx(FEE_QLD["avg_cost_asset"], abs=0.01)
    assert result["start_sweep"]["2021-12"] == pytest.approx(FEE_QLD["return_pct"], abs=0.01)


def test_strategy_whole_shares_reach_both_sweeps(api: Api) -> None:
    """두 바꿔 보기는 요청의 fractional도 따른다 (9-7 "2·4절 그대로"). QQQ 정수 주의 1일 평단가와 2021-12
    시작 수익률이 7절 "월1일 200만원 정수주" 사례와 같다. QLD는 두 방식 차이가 허용 오차 안이라 QQQ로 본다."""
    whole = _v1_result("monthly1-krw2m-whole-shares", "QQQ")
    fractional = _v1_result("monthly1-krw2m", "QQQ")
    # 이 테스트가 가려내는지: 소수점 매수 값과는 허용 오차보다 크게 다르다
    assert whole["avg_cost_asset"] != pytest.approx(fractional["avg_cost_asset"], abs=0.01)
    assert whole["return_pct"] != pytest.approx(fractional["return_pct"], abs=0.01)
    body = _strategy(api.client, symbol="QQQ", fractional=False)
    assert body["errors"] == []
    result = body["result"]
    assert result["anchor_sweep"]["1"] == pytest.approx(whole["avg_cost_asset"], abs=0.01)
    assert result["start_sweep"]["2021-12"] == pytest.approx(whole["return_pct"], abs=0.01)


def test_strategy_short_period_has_null_anchor_and_empty_start_sweep(api: Api) -> None:
    """9-7: 그 기준일로 매수일이 없으면 null(25일), 있으면 값(10일). 끝날짜 달의 6개월 전 달이 시작일보다
    앞이면 시작할 달이 없어 {}다. 키 29개는 null이어도 그대로 있다."""
    body = _strategy(api.client, start="2026-10-05", end="2026-10-20", anchor=10)
    assert body["errors"] == []
    result = body["result"]
    assert list(result["anchor_sweep"]) == list(V2["anchor_sweep"])
    assert result["anchor_sweep"]["25"] is None
    assert result["anchor_sweep"]["10"] is not None
    assert result["start_sweep"] == {}


# 실패 경로


def test_strategy_unknown_reference_chart_drops_switch_and_keeps_sweeps(api: Api) -> None:
    """결정 d31: 기준 종목을 못 받으면 chart.series에도 switch 키가 없다. 바꿔 보기는 기준 종목을 쓰지 않아
    v2 기준값 그대로다."""
    body = _strategy(api.client, switch_ref="XXXX")
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]
    result = body["result"]
    assert list(result["chart"]["series"]) == OTHER_RULES
    assert result["chart"]["total_days"] == V2["metrics"]["trading_days"]
    _assert_anchor_sweep_matches_v2(result["anchor_sweep"])
    _assert_start_sweep_matches_v2(result["start_sweep"])


def test_strategy_sweep_engine_error_returns_null_result(api: Api) -> None:
    """바꿔 보기 한 점이라도 계산할 수 없으면 result는 null이고 종목 오류다 (상세 설계 4절).

    환율이 2021-11-29부터 있으면 요청(매월 1일, 첫 매수 12-01)과 시작 시점은 계산되지만, 매수일 바꿔 보기의
    25일은 2021-11-26에 사서 그날 환율이 없다."""
    api.yahoo.extra["USDKRW=X"] = payload_from("USDKRW=X", date(2021, 11, 29))
    body = _strategy(api.client)
    assert body["result"] is None
    assert [e["symbol"] for e in body["errors"]] == ["QLD"]
    assert "USDKRW=X 환율이 2021-11-26 이전에는 없습니다" in body["errors"][0]["message"]


# 로그와 속도


def test_strategy_logs_symbol_freq_and_elapsed(api: Api, caplog: pytest.LogCaptureFixture) -> None:
    """코드 컨벤션 2절: 로그에 종목, 주기, 걸린 시간을 남긴다."""
    with caplog.at_level(logging.INFO, logger="src.main"):
        _strategy(api.client)
    lines = [r.getMessage() for r in caplog.records if r.name == "src.main"]
    assert any(
        "QLD" in line and "monthly" in line and re.search(r"\d+\.\d+s", line) for line in lines
    ), lines


@pytest.mark.parametrize("symbol", SPEED_SYMBOLS, ids=SPEED_SYMBOLS)
def test_strategy_five_years_daily_from_saved_data_within_two_seconds(
    api: Api, symbol: str
) -> None:
    """결정 d30: 저장본으로 4종목 각각 POST /api/strategy 한 번(전략 5개, 그래프, 두 바꿔 보기)이 2초 안.

    첫 요청은 저장본을 채우고 첫 호출 준비를 떠맡으므로 재지 않는다. client.post 앞뒤만 잰다.
    """
    changes = {"symbol": symbol, "freq": "daily", "anchor": None, "amount": DAILY_CASE["amount"]}
    assert _strategy(api.client, **changes)["errors"] == []  # 저장본을 채운다. 재지 않는다
    calls = len(api.yahoo.calls)
    started = time.perf_counter()
    response = api.client.post("/api/strategy", json={**STRATEGY_EXAMPLE, **changes})
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result is not None
    # 잰 응답이 F-15가 쓰는 값을 다 담았는지: 전략 5개만 재면 기준보다 가볍다
    assert {"strategies", "chart", "anchor_sweep", "start_sweep"} <= set(result), list(result)
    assert len(api.yahoo.calls) == calls  # 저장본만 썼다
    assert elapsed < SPEED_LIMIT_S, f"{symbol}: {elapsed:.2f}s"


# ---------- POST /api/backtest v2 지표 (계산 규칙 9-1 ~ 9-5, 9-8, 이슈 #35) ----------

# 9-8 기준값 조건에 양도세 어림(F-20)을 켠다: QLD, 매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화
V2_BACKTEST: dict[str, Any] = {
    "symbols": [V2["symbol"]],
    "start": V2["period"][0],
    "end": V2["period"][1],
    "freq": V2["freq"],
    "anchor": V2["anchor"],
    "amount": V2["amount"],
    "currency": V2["invest_currency"],
    "fractional": True,
    "fee_pct": 0,
    "tax": True,
}
METRICS = V2["metrics"]
DOLLAR_TAX = V2["dollar_tax"]
# 9-8 달러 양도세: 같은 기간·기준일로 7절 "매월 1일 1,500달러" 사례의 금액·통화를 쓴다
USD_CASE = next(c for c in load_expected()["cases"] if CASE_IDS[c["name"]] == "monthly1-usd1500")
USD_REQUEST: dict[str, Any] = {
    "amount": USD_CASE["amount"],
    "currency": USD_CASE["invest_currency"],
}
# summary에 더하는 v2 필드 11개 (9-1·9-4·9-5). 이름은 expected.json v2.metrics와 같다
V2_SUMMARY_FIELDS = (
    "max_drawdown",
    "underwater_days",
    "trading_days",
    "underwater_pct",
    "longest_underwater",
    "last_underwater",
    "price_effect",
    "fx_effect",
    "avg_buy_fx",
    "tax",
    "profit_after_tax",
)
# analysis 묶음 (9-1·9-2·9-3). "매수 가격 목록"은 따로 두지 않고 buys[].price를 쓴다
V2_ANALYSIS_FIELDS = ("years", "months", "buys_below_eval_price", "buys_below_avg_cost")
TAX_FIELDS = ("tax", "profit_after_tax")
FX_FAILED = "USDKRW=X 환율을 받지 못해 계산하지 못했습니다."
V2_FROM_PEAK_PCT = -34.11  # 상세 설계 4절 응답 예: 9-8 조건의 평가금 최고점 대비
# 결정 d32: 9-8에서 끝날짜만 2026-10-31(토). 데이터를 10-30(금)에서 자르면 9월까지 58개다
_, D32_END, D32_CUT_LAST_MONTH, D32_CUT_COUNT = MONTH_END_CASES[
    "data-1030fri-end-1031sat-skips-oct"
]
LATE_FIRST_DAY = date(2023, 3, 1)  # 늦게 시작한 종목: payload_from으로 이날부터만 남긴다
BACKTEST_SPEED_LIMIT_S = 1.0  # 기능 명세 비기능 요구 "속도", 이슈 #35


def _backtest(client: TestClient, **changes: Any) -> dict[str, Any]:
    """9-8 조건(양도세 켬)으로 POST /api/backtest를 부르고 200인지 본 뒤 본문을 돌려준다."""
    response = client.post("/api/backtest", json={**V2_BACKTEST, **changes})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# 응답 모양과 9-8 기준값


def test_backtest_v2_reference_case_adds_v2_fields_named_like_v2_metrics(api: Api) -> None:
    """summary에 v2 필드 11개, 결과에 analysis 4개, 그래프에 drawdown을 더한다. 이름은 v2.metrics와 같다."""
    assert set(V2_SUMMARY_FIELDS) <= set(METRICS)
    assert set(V2_ANALYSIS_FIELDS) <= set(METRICS)
    body = _backtest(api.client)
    assert body["errors"] == []
    assert body["params"]["tax"] is True
    qld = _result(body, "QLD")
    assert set(V2_SUMMARY_FIELDS) <= set(qld["summary"])
    assert set(qld["analysis"]) == set(V2_ANALYSIS_FIELDS)
    assert "drawdown" in body["chart"]["series"]["QLD"]


def test_backtest_v2_reference_case_summary_drawdown_and_underwater_match_v2_metrics(
    api: Api,
) -> None:
    """9-1, 9-8: 최대 낙폭 −42.2% (2026-11-20), 원금 아래 331일 / 1,250 거래일 (26.48%),
    가장 길게 253 거래일 (2022-03-30 ~ 2023-04-03 회복), 마지막으로 원금 아래 2023-05-04."""
    summary = _result(_backtest(api.client), "QLD")["summary"]
    want = METRICS["max_drawdown"]
    assert summary["max_drawdown"] == {
        "date": want["date"],
        "pct": pytest.approx(want["pct"], abs=0.01),
    }
    assert summary["underwater_days"] == METRICS["underwater_days"]
    assert summary["trading_days"] == METRICS["trading_days"]
    assert summary["underwater_pct"] == pytest.approx(METRICS["underwater_pct"], abs=0.01)
    assert summary["longest_underwater"] == METRICS["longest_underwater"]
    assert summary["last_underwater"] == METRICS["last_underwater"]


def test_backtest_v2_reference_case_summary_profit_split_and_tax_match_v2_metrics(
    api: Api,
) -> None:
    """9-4·9-5, 9-8: 주가 효과 +106,570,957원, 환율 효과 −746,367원, 평균 매수 환율 1,352.57원,
    양도세 22,731,410원, 세후 손익 83,093,180원 (금액 ±1원)."""
    summary = _result(_backtest(api.client), "QLD")["summary"]
    for field in ("price_effect", "fx_effect", "tax", "profit_after_tax"):
        assert summary[field] == pytest.approx(METRICS[field], abs=1), field
    assert summary["avg_buy_fx"] == pytest.approx(METRICS["avg_buy_fx"], abs=0.01)
    assert summary["profit"] == pytest.approx(METRICS["profit"], abs=1)


def test_backtest_v2_reference_case_analysis_years_match_v2_metrics(api: Api) -> None:
    """9-2, 9-8: 연도별 6개가 "YYYY" 오름차순이고 값이 v2.metrics.years와 같다 (2022: −35.72 / −60.64)."""
    years = _result(_backtest(api.client), "QLD")["analysis"]["years"]
    assert list(years) == list(METRICS["years"])
    for year, want in METRICS["years"].items():
        assert years[year]["return_pct"] == pytest.approx(want["return_pct"], abs=0.01), year
        if want["price_change_pct"] is None:
            assert years[year]["price_change_pct"] is None, year
        else:
            change = pytest.approx(want["price_change_pct"], abs=0.01)
            assert years[year]["price_change_pct"] == change, year


def test_backtest_v2_reference_case_analysis_months_match_v2_metrics(api: Api) -> None:
    """9-3, 9-8: 월 수익률(%)이 "YYYY-MM" 오름차순으로 59개, 오른 달 36개, 최고 2026-04 +30.35,
    최저 2022-12 −22.33. v2.metrics.months는 요약이라 응답에서 요약을 만들어 비교한다."""
    months = _result(_backtest(api.client), "QLD")["analysis"]["months"]
    want = METRICS["months"]
    assert list(months) == sorted(months)
    assert len(months) == want["count"]
    assert sum(1 for pct in months.values() if pct > 0) == want["up"]
    best, worst = max(months, key=months.__getitem__), min(months, key=months.__getitem__)
    assert (best, worst) == (want["best"]["month"], want["worst"]["month"])
    assert months[best] == pytest.approx(want["best"]["return_pct"], abs=0.01)
    assert months[worst] == pytest.approx(want["worst"]["return_pct"], abs=0.01)


def test_backtest_v2_reference_case_analysis_buy_counts_match_v2_metrics(api: Api) -> None:
    """9-1, 9-8: 매수 60번 중 지금 가격보다 싸게 산 51번, 평단가보다 싸게 산 24번.
    매수 가격 목록은 같은 응답의 buys[].price(줄이지 않은 60줄)다."""
    qld = _result(_backtest(api.client), "QLD")
    assert qld["analysis"]["buys_below_eval_price"] == METRICS["buys_below_eval_price"]
    assert qld["analysis"]["buys_below_avg_cost"] == METRICS["buys_below_avg_cost"]
    assert len(qld["buys"]) == METRICS["buys"]


# 엔진에 넘기는 데이터 (결정 d32)


def test_backtest_month_end_saturday_end_date_keeps_october_from_uncut_data(api: Api) -> None:
    """결정 d32, 9-3: 엔진에 끝날짜로 자르지 않은 전체 데이터를 넘긴다. 끝날짜 10-31(토)이어도 데이터가 그 뒤까지
    있어 10월은 끝난 달이다: 2021-12 ~ 2026-10 59개 (9-8 v2.metrics.months와 같은 수).

    끝날짜로 잘라 넘기면 데이터가 10-30(금)에서 끝나 10월이 빠진다 (MONTH_END_CASES
    "data-1030fri-end-1031sat-skips-oct": 2026-09·58개). 그러면 이 테스트가 깨진다.
    """
    body = _backtest(api.client, end=D32_END.isoformat())
    assert body["errors"] == []
    months = _result(body, "QLD")["analysis"]["months"]
    assert (list(months)[-1], len(months)) == ("2026-10", METRICS["months"]["count"])
    assert (list(months)[-1], len(months)) != (D32_CUT_LAST_MONTH, D32_CUT_COUNT)


# 양도세 어림 (F-20, 계산 규칙 9-5)


def test_backtest_dollar_investment_tax_matches_v2_dollar_tax_and_fetches_usdkrw_once(
    api: Api,
) -> None:
    """9-5, 9-8 달러 양도세 (결정 d25): QQQ 매월 1일 $1,500 달러 투자, 손익 $48,171, 양도세 $10,188,
    세후 손익 $37,982 (±1). 원화가 아닌 종목이 둘이어도 USDKRW=X는 한 번만 받는다."""
    body = _backtest(api.client, symbols=["QQQ", "QLD"], **USD_REQUEST)
    assert body["errors"] == []
    summary = _result(body, "QQQ")["summary"]
    assert summary["profit"] == pytest.approx(DOLLAR_TAX["profit"], abs=1)
    assert summary["tax"] == pytest.approx(DOLLAR_TAX["tax"], abs=1)
    assert summary["profit_after_tax"] == pytest.approx(DOLLAR_TAX["profit_after_tax"], abs=1)
    # 달러 종목을 달러로 샀다: 환율 효과 0, 평균 매수 환율 없음 (9-4, 결정 d25)
    assert summary["fx_effect"] == 0
    assert summary["avg_buy_fx"] is None
    assert _called(api.yahoo) == Counter({"QQQ": 1, "QLD": 1, "USDKRW=X": 1})


def test_backtest_dollar_investment_without_tax_has_null_tax_and_skips_usdkrw(api: Api) -> None:
    """F-20: tax가 꺼져 있으면 tax·profit_after_tax는 null이고, 달러 투자에 USDKRW=X를 부르지 않는다."""
    body = _backtest(api.client, symbols=["QQQ"], tax=False, **USD_REQUEST)
    assert body["errors"] == []
    summary = _result(body, "QQQ")["summary"]
    assert (summary["tax"], summary["profit_after_tax"]) == (None, None)
    assert "USDKRW=X" not in _called(api.yahoo)


def test_backtest_dollar_tax_without_usdkrw_fails_non_krw_symbols_only(api: Api) -> None:
    """결정 d40: 달러 투자 tax에서 USDKRW=X를 받지 못하면 원화가 아닌 종목은 그 종목 오류다 (환율 실패와 같은
    메시지). 한국 종목은 세금이 0이라 양도세 환율이 필요 없어 결과가 나온다. USDKRW=X는 한 번만 부른다."""
    api.yahoo.extra["KRWUSD=X"] = inverted_fx_payload("USDKRW=X", "USD")
    api.yahoo.missing.add("USDKRW=X")
    body = _backtest(api.client, symbols=["QQQ", "QLD", "005930.KS"], **USD_REQUEST)
    assert [r["symbol"] for r in body["results"]] == ["005930.KS"]
    assert body["errors"] == [
        {"symbol": "QQQ", "message": FX_FAILED},
        {"symbol": "QLD", "message": FX_FAILED},
    ]
    samsung = _result(body, "005930.KS")["summary"]
    assert samsung["tax"] == 0
    assert samsung["profit_after_tax"] == samsung["profit"]
    assert list(body["chart"]["series"]) == ["005930.KS"]
    assert _called(api.yahoo)["USDKRW=X"] == 1


def test_backtest_saved_usdkrw_for_tax_marks_stale_only_when_tax_is_on(api: Api) -> None:
    """stale의 "환율"에는 양도세용 USDKRW=X도 들어간다. 달러 종목을 달러로 사면 종목은 새로 받았어도 양도세
    환율이 저장본이면 stale이다. tax가 꺼져 있으면 USDKRW=X를 쓰지 않으니 stale이 아니다."""
    usd: dict[str, Any] = {"symbols": ["QQQ"], **USD_REQUEST}
    assert _backtest(api.client, **usd)["errors"] == []  # 종목과 USDKRW=X 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("USDKRW=X")
    taxed = _backtest(api.client, **usd)
    assert taxed["errors"] == []
    assert _result(taxed, "QQQ")["stale"] is True
    untaxed = _backtest(api.client, **usd, tax=False)
    assert _result(untaxed, "QQQ")["stale"] is False


def test_backtest_korean_stock_with_tax_has_zero_tax(api: Api) -> None:
    """9-5: 한국 종목(005930.KS)을 원화로 사면 양도세 0, 세후 손익 = 손익. 통화가 같아 환율 효과 0,
    평균 매수 환율 null (9-4, 결정 d25). 환율은 받지 않는다."""
    body = _backtest(api.client, symbols=["005930.KS"])
    assert body["errors"] == []
    summary = _result(body, "005930.KS")["summary"]
    assert summary["tax"] == 0
    assert summary["profit_after_tax"] == summary["profit"]
    assert summary["fx_effect"] == 0
    assert summary["avg_buy_fx"] is None
    assert _called(api.yahoo) == Counter({"005930.KS": 1})


def test_backtest_krw_with_tax_fetches_each_symbol_and_usdkrw_once(api: Api) -> None:
    """원화 투자는 양도세에 환율을 따로 받지 않는다 (tax_fx 1). 변환 환율 USDKRW=X는 종목끼리 나눠 한 번,
    Yahoo 동시 요청은 2개 이하."""
    body = _backtest(api.client, symbols=["QQQ", "QLD"])
    assert body["errors"] == []
    assert _called(api.yahoo) == Counter({"QQQ": 1, "QLD": 1, "USDKRW=X": 1})
    assert api.yahoo.max_in_flight <= 2


def test_backtest_tax_flag_changes_only_tax_fields(api: Api) -> None:
    """F-20: tax는 summary의 tax·profit_after_tax만 바꾼다 (켜면 값, 끄면 null). 나머지 지표·분석·그래프·
    매수 내역은 같다."""
    on, off = _backtest(api.client), _backtest(api.client, tax=False)
    assert (on["params"]["tax"], off["params"]["tax"]) == (True, False)
    result_on, result_off = _result(on, "QLD"), _result(off, "QLD")
    summary_on, summary_off = result_on.pop("summary"), result_off.pop("summary")
    assert summary_on["tax"] == pytest.approx(METRICS["tax"], abs=1)
    assert summary_on["profit_after_tax"] == pytest.approx(METRICS["profit_after_tax"], abs=1)
    assert (summary_off["tax"], summary_off["profit_after_tax"]) == (None, None)

    def without_tax(summary: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in summary.items() if k not in TAX_FIELDS}

    assert without_tax(summary_on) == without_tax(summary_off)
    assert result_on == result_off
    assert on["chart"] == off["chart"]


def test_backtest_without_tax_field_defaults_to_false(api: Api) -> None:
    """tax를 빼면 false다: params에 false를 채우고 세금 두 필드는 null이다. 기존 요청(EXAMPLE)이 그대로 돈다."""
    response = _post(api.client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["params"]["tax"] is False
    for result in body["results"]:
        summary = result["summary"]
        assert (summary["tax"], summary["profit_after_tax"]) == (None, None), result["symbol"]


def test_backtest_non_boolean_tax_returns_422_with_korean_message(api: Api) -> None:
    """tax는 true 또는 false다. 아니면 422, 항목 tax에 한국어 메시지, Yahoo는 부르지 않는다."""
    response = _post(api.client, tax="maybe")
    assert response.status_code == 422, response.text
    details = response.json()["detail"]
    assert any(d["field"] == "tax" and "양도세" in d["message"] for d in details), details
    assert api.yahoo.calls == []


# 낙폭 그래프 (F-13, 계산 규칙 9-1)


def test_backtest_v2_reference_case_drawdown_series_bottoms_at_max_drawdown_and_ends_at_from_peak(
    api: Api,
) -> None:
    """chart.series.QLD.drawdown은 그날 평가금 낙폭(%)이다. 1,250일을 1,000점 이하로 줄여도 가장 낮은 점이
    summary.max_drawdown과 같은 날(2026-11-20)·같은 값(−42.2)이고, 마지막 값은 from_peak_pct(−34.11)다."""
    body = _backtest(api.client)
    chart, summary = body["chart"], _result(body, "QLD")["summary"]
    assert chart["total_days"] == METRICS["trading_days"]
    assert len(chart["dates"]) <= MAX_CHART_POINTS
    drawdown = chart["series"]["QLD"]["drawdown"]
    assert len(drawdown) == len(chart["dates"])
    assert None not in drawdown  # 종목 하나라 날짜축이 첫 매수일부터다
    assert METRICS["max_drawdown"]["date"] in chart["dates"]
    lowest = min(drawdown)
    assert lowest == pytest.approx(METRICS["max_drawdown"]["pct"], abs=0.01)
    assert chart["dates"][drawdown.index(lowest)] == METRICS["max_drawdown"]["date"]
    assert lowest == summary["max_drawdown"]["pct"]
    assert drawdown[-1] == pytest.approx(V2_FROM_PEAK_PCT, abs=0.01)
    assert drawdown[-1] == summary["from_peak_pct"]


def test_backtest_late_symbol_drawdown_is_null_only_before_first_buy(api: Api) -> None:
    """chart.series 값은 그 종목 첫 매수 전 날짜에서 null이다 (상세 설계 4절). QQQ 데이터가 2023-03부터면
    QLD와 섞은 그래프에서 QQQ drawdown은 첫 매수일 전 날짜에서만 null이고 QLD에는 null이 없다."""
    api.yahoo.extra["QQQ"] = payload_from("QQQ", LATE_FIRST_DAY)
    body = _backtest(api.client, symbols=["QQQ", "QLD"])
    assert body["errors"] == []
    first_buy = _result(body, "QQQ")["summary"]["first_buy"]
    assert first_buy >= LATE_FIRST_DAY.isoformat()
    dates, series = body["chart"]["dates"], body["chart"]["series"]
    assert any(
        d < first_buy for d in dates
    )  # 이 테스트가 가려내는지: 첫 매수 전 날짜가 그래프에 있다
    assert len(series["QQQ"]["drawdown"]) == len(dates)
    assert [v is None for v in series["QQQ"]["drawdown"]] == [d < first_buy for d in dates]
    assert None not in series["QLD"]["drawdown"]


def test_backtest_late_symbol_first_year_has_null_price_change(api: Api) -> None:
    """9-2, 결정 d25: 전해 데이터가 없으면(2023-03부터 데이터) 그해 주가 등락은 null, 다음 해는 값이 있다."""
    api.yahoo.extra["QQQ"] = payload_from("QQQ", LATE_FIRST_DAY)
    years = _result(_backtest(api.client, symbols=["QQQ"]), "QQQ")["analysis"]["years"]
    first_year = str(LATE_FIRST_DAY.year)
    assert next(iter(years)) == first_year
    assert years[first_year]["price_change_pct"] is None
    assert years[str(LATE_FIRST_DAY.year + 1)]["price_change_pct"] is not None


# 속도


def test_backtest_four_symbols_five_years_daily_with_tax_from_saved_data_within_one_second(
    api: Api,
) -> None:
    """비기능 "속도" (이슈 #35): 저장본으로 4종목 5년 매일 10만원, 원화, 양도세 켬 요청 하나가 1초 안.

    v2 지표·분석·낙폭 열을 다 담은 응답을 잰다. 첫 요청은 저장본을 채우고 첫 호출 준비를 떠맡으므로 재지 않고,
    client.post 앞뒤만 잰다. 재는 동안 Yahoo를 부르지 않는다.
    """
    request = {
        **EXAMPLE,
        "symbols": SPEED_SYMBOLS,
        "freq": DAILY_CASE["freq"],
        "anchor": DAILY_CASE["anchor"],
        "amount": DAILY_CASE["amount"],
        "tax": True,
    }
    first = api.client.post("/api/backtest", json=request)  # 저장본을 채운다. 재지 않는다
    assert first.status_code == 200, first.text
    assert first.json()["errors"] == []
    calls = len(api.yahoo.calls)
    started = time.perf_counter()
    response = api.client.post("/api/backtest", json=request)
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    body = response.json()
    assert [r["symbol"] for r in body["results"]] == SPEED_SYMBOLS
    # 잰 응답이 이슈 #35에서 더한 값을 다 담았는지: v1 응답만 재면 기준보다 가볍다
    for result in body["results"]:
        assert "analysis" in result, result["symbol"]
        assert result["summary"].get("tax") is not None, result["symbol"]
    for symbol, series in body["chart"]["series"].items():
        assert "drawdown" in series, symbol
    assert len(api.yahoo.calls) == calls  # 저장본만 썼다
    assert elapsed < BACKTEST_SPEED_LIMIT_S, f"{elapsed:.2f}s"
