"""HTTP 진입점(src/main.py)을 확인한다. Yahoo는 fixture를 물린 가짜로 바꿔 네트워크 없이 부른다."""

import asyncio
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
    FakeYahoo,
    inverted_fx_payload,
    load_expected,
    load_series,
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
