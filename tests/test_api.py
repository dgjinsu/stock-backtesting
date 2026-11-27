"""HTTP 진입점(src/main.py)을 확인한다. Yahoo는 fixture를 물린 가짜로 바꿔 네트워크 없이 부른다."""

import asyncio
import logging
import math
import re
import time
from collections import Counter
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any, get_args

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
        # 이슈 #36: 매수 규칙 (F-17). 일시금은 전략 비교 전용이라 받지 않는다
        ({"rule": "lump_sum"}, "rule", "매수 규칙"),
        ({"rule": "abc"}, "rule", "매수 규칙"),
        ({"ma_days": 50}, "ma_days", "이평선"),
        ({"switch_ref": "QQ Q"}, "switch_ref", "종목 코드"),
        ({"switch_ref": 1}, "switch_ref", "문자열"),
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
        "rule-lump-sum",
        "rule-unknown",
        "ma-days-50",
        "switch-ref-format",
        "switch-ref-not-text",
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
    """Yahoo가 모두 실패하면 저장본으로 계산한다. stale_sources는 종목 주가(price)와 매수·평가 환율(fx) 두 줄이다
    (F-10, 이슈 #59). 기준일은 계산 규칙 7절: 평가 가격 2026-11-23 종가, 평가 환율 11-24 값.

    같은 USDKRW=X를 쓰는 QQQ에도 자기 줄이 있다 (하나로 합치는 일은 화면이 한다). price 줄의 기준일은 결과의
    data_through와 같다 (엔진의 기준일과 main의 기준일이 어긋나지 않는지)."""
    assert _post(api.client).status_code == 200
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    body = _post(api.client).json()
    qld = _result(body, "QLD")
    assert qld["stale"] is True
    assert qld["data_through"] == "2026-11-23"
    assert qld["stale_sources"] == [
        {"symbol": "QLD", "kind": "price", "data_through": "2026-11-23"},
        {"symbol": "USDKRW=X", "kind": "fx", "data_through": "2026-11-24"},
    ]
    qqq = _result(body, "QQQ")
    assert qqq["stale_sources"] == [
        {"symbol": "QQQ", "kind": "price", "data_through": "2026-11-23"},
        {"symbol": "USDKRW=X", "kind": "fx", "data_through": "2026-11-24"},
    ]
    for result in body["results"]:
        price = result["stale_sources"][0]
        assert price["data_through"] == result["data_through"], result["symbol"]


def test_backtest_stale_sources_sunday_end_date_back_to_friday(api: Api) -> None:
    """data_through는 그 코드의 끝날짜 당일 또는 그 이전 마지막 거래일이다 (계산 규칙 3절 평가 환율과 같은
    규칙). 끝날짜가 2026-11-22(일)이면 종목 주가와 USDKRW=X 모두 그 전 금요일 11-20이다. 저장본의 마지막 날
    (11-23, 11-24)을 그대로 적으면 이 테스트가 깨진다."""
    assert _post(api.client, symbols=["QLD"]).status_code == 200
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    body = _post(api.client, symbols=["QLD"], end="2026-11-22").json()
    assert body["errors"] == []
    qld = _result(body, "QLD")
    assert qld["data_through"] == "2026-11-20"
    assert qld["stale_sources"] == [
        {"symbol": "QLD", "kind": "price", "data_through": "2026-11-20"},
        {"symbol": "USDKRW=X", "kind": "fx", "data_through": "2026-11-20"},
    ]


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
    """9-8: QLD와 QQQ는 둘 다 America/New_York이라 매수일 종가를 본다. 기준 종목의 기준일(data_through)은
    끝날짜 2026-11-24 당일 또는 그 이전 마지막 거래일 2026-11-23이다 (계산 규칙 7절, 이슈 #59)."""
    switch_ref = _strategy(api.client)["result"]["switch_ref"]
    assert switch_ref == {
        "symbol": "QQQ",
        "basis": "same_day",
        "stale": False,
        "data_through": "2026-11-23",
    }


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
    assert body["result"]["switch_ref"] == {
        "symbol": "QQQ",
        "basis": "same_day",
        "stale": False,
        "data_through": "2026-11-23",
    }
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
    """기준 종목만 저장본이면 switch_ref.stale만 True다. 종목·환율은 새로 받았으니 result.stale은 False.
    저장본이어도 기준일은 끝날짜 이전 마지막 거래일 2026-11-23이다 (이슈 #59)."""
    _strategy(api.client)
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("QQQ")
    body = _strategy(api.client)
    assert body["errors"] == []
    result = body["result"]
    assert result["stale"] is False
    assert result["switch_ref"] == {
        "symbol": "QQQ",
        "basis": "same_day",
        "stale": True,
        "data_through": "2026-11-23",
    }
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
    환율이 저장본이면 stale이다. tax가 꺼져 있으면 USDKRW=X를 쓰지 않으니 stale이 아니다.

    이슈 #59: stale_sources는 양도세 환율(tax_fx) 한 줄이고 기준일은 끝날짜 2026-11-24의 값이다 (계산 규칙
    9-8 달러 양도세의 원/달러 환율). tax를 끄면 []다."""
    usd: dict[str, Any] = {"symbols": ["QQQ"], **USD_REQUEST}
    assert _backtest(api.client, **usd)["errors"] == []  # 종목과 USDKRW=X 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("USDKRW=X")
    taxed = _backtest(api.client, **usd)
    assert taxed["errors"] == []
    qqq = _result(taxed, "QQQ")
    assert qqq["stale"] is True
    assert qqq["stale_sources"] == [
        {"symbol": "USDKRW=X", "kind": "tax_fx", "data_through": "2026-11-24"}
    ]
    untaxed = _result(_backtest(api.client, **usd, tax=False), "QQQ")
    assert untaxed["stale"] is False
    assert untaxed["stale_sources"] == []


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


@pytest.mark.parametrize("rule", ["none", "switch"], ids=["none", "switch"])
def test_backtest_four_symbols_five_years_daily_with_tax_from_saved_data_within_one_second(
    api: Api, rule: str
) -> None:
    """비기능 "속도" (이슈 #35·#36): 저장본으로 4종목 5년 매일 10만원, 원화, 양도세 켬 요청 하나가 1초 안.
    매수 규칙은 기본(none)과 레버리지 전환(switch, 기준 종목 QQQ) 둘 다 잰다.

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
        "rule": rule,
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
        assert result["daily"] is None, result[
            "symbol"
        ]  # include_daily를 보내지 않으면 꺼진 응답을 잰다
        if rule == "switch":  # 잰 응답이 레버리지 전환으로 계산한 것인지
            assert result["switch_ref"] is not None, result["symbol"]
    for symbol, series in body["chart"]["series"].items():
        assert "drawdown" in series, symbol
    assert len(api.yahoo.calls) == calls  # 저장본만 썼다
    assert elapsed < BACKTEST_SPEED_LIMIT_S, f"{elapsed:.2f}s"


# ---------- POST /api/backtest 매수 규칙 (F-17, 계산 규칙 9-6, 이슈 #36) ----------

# F-17 매수 규칙 4개: 9-8 전략 표에서 일시금(전략 비교 전용)을 뺀 것
BACKTEST_RULES = [rule for rule in V2["strategies"] if rule != "lump_sum"]
CHOSEN_RULES = [rule for rule in BACKTEST_RULES if rule != "none"]  # 9-6 규칙 매수로 계산한다
NON_SWITCH_RULES = [rule for rule in BACKTEST_RULES if rule != "switch"]  # 기준 종목을 받지 않는다
# 9-8 끝날짜는 7절과 같아 평가 환율도 같다 (1,344.16원). 남은 현금(원) 기준값을 종목 통화로 바꿀 때 쓴다
V2_EVAL_FX = _v1_result("monthly1-krw2m", "QLD")["eval_fx"]
# 기준 종목의 기준일(data_through, 이슈 #59): 9-8 끝날짜 2026-11-24 당일 또는 그 이전 마지막 거래일. 평가 가격이
# 2026-11-23 종가인 것과 같다 (계산 규칙 7절)
REF_THROUGH = "2026-11-23"
SAME_DAY_QQQ = {
    "symbol": V2["switch_ref"],
    "basis": "same_day",
    "stale": False,
    "data_through": REF_THROUGH,
}
PREVIOUS_DAY_QQQ = {
    "symbol": V2["switch_ref"],
    "basis": "previous_day",
    "stale": False,
    "data_through": REF_THROUGH,
}
REF_QQQ_FAILED = "기준 종목 QQQ를 받지 못해 계산하지 못했습니다."


def _rest_rows(result: dict[str, Any]) -> int:
    """레버리지 전환에서 쉰 매수일(qty 0) 줄 수."""
    return sum(1 for row in result["buys"] if row["qty"] == 0)


def _count_get_series(api: Api, monkeypatch: pytest.MonkeyPatch) -> Counter[str]:
    """market.get_series 호출을 종목별로 센다. 성공한 두 번째 호출은 저장본에서 나와 Yahoo 호출 수로는
    가려내지 못해서 래퍼로 센다 (설계 메모)."""
    market = api.client.app.state.market  # type: ignore[attr-defined]
    original = market.get_series
    counts: Counter[str] = Counter()

    async def counting(symbol: str) -> PriceHistory:
        counts[symbol] += 1
        history: PriceHistory = await original(symbol)
        return history

    monkeypatch.setattr(market, "get_series", counting)
    return counts


# 요청 모양 (schemas)


def test_backtest_rule_type_is_engine_rules_without_lump_sum() -> None:
    """F-17: 매수 규칙은 none·ma_dip·ma_hot·switch다. engine.RULES에서 lump_sum만 뺀 것과 같은 순서다."""
    assert get_args(schemas.BacktestRule) == tuple(r for r in engine.RULES if r != "lump_sum")
    assert list(get_args(schemas.BacktestRule)) == BACKTEST_RULES


def test_backtest_request_without_rule_fields_fills_none_200_qqq() -> None:
    """rule·ma_days·switch_ref를 빼면 기본값 none, 200, QQQ다 (F-15·F-17). 기존 요청이 그대로 돈다."""
    request = schemas.BacktestRequest.model_validate(V2_BACKTEST)
    assert (request.rule, request.ma_days, request.switch_ref) == ("none", 200, "QQQ")


def test_backtest_request_lowercase_switch_ref_is_uppercased() -> None:
    request = schemas.BacktestRequest.model_validate({**V2_BACKTEST, "switch_ref": " qqq "})
    assert request.switch_ref == "QQQ"


@pytest.mark.parametrize("ma_days", [20, 60, 120, 200], ids=["ma20", "ma60", "ma120", "ma200"])
def test_backtest_request_allowed_ma_days_is_kept(ma_days: int) -> None:
    """F-15: 이평선은 20·60·120·200일 중 하나. 화면은 200만 보내지만 API는 다 받는다 (결정 d43)."""
    request = schemas.BacktestRequest.model_validate({**V2_BACKTEST, "ma_days": ma_days})
    assert request.ma_days == ma_days


# 9-8 기준값


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_backtest_rule_reference_case_summary_matches_v2_strategies(api: Api, rule: str) -> None:
    """9-8 조건에 rule을 주면 summary가 전략 표 그 줄과 같다 (금액 ±1원, % ±0.01%p, 평단가 ±0.01).

    남은 현금은 종목 통화(달러 2자리)로 온다. 원화 기준값을 평가 환율로 나눠 ±0.01달러로 본다. 달러 2자리에
    평가 환율을 곱해 원화로 비교하면 ma_dip이 약 4원 어긋난다 (설계 메모).
    """
    body = _backtest(api.client, rule=rule)
    assert body["errors"] == []
    assert body["params"]["rule"] == rule
    qld = _result(body, "QLD")
    summary, want = qld["summary"], V2["strategies"][rule]
    assert summary["value"] == pytest.approx(want["value"], abs=1)
    assert summary["return_pct"] == pytest.approx(want["return_pct"], abs=0.01)
    assert summary["xirr_pct"] == pytest.approx(want["xirr_pct"], abs=0.01)
    assert summary["avg_cost_asset"] == pytest.approx(want["avg_cost_asset"], abs=0.01)
    assert summary["worst"]["return_pct"] == pytest.approx(want["worst_return_pct"], abs=0.01)
    leftover_asset = want["leftover_cash_invest"] / V2_EVAL_FX
    assert summary["leftover_cash"] == pytest.approx(leftover_asset, abs=0.01)
    assert summary["invested"] == pytest.approx(V2_INVESTED, abs=1)
    assert summary["buys"] == len(qld["buys"]) == METRICS["buys"]


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_backtest_rule_fx_effect_and_avg_buy_fx_match_v2_metrics(api: Api, rule: str) -> None:
    """9-4: 환율 효과 −746,367원, 평균 매수 환율 1,352.57원은 매수 방식과 상관없다. 주가 효과 + 환율 효과는
    그 규칙의 손익이다."""
    summary = _result(_backtest(api.client, rule=rule), "QLD")["summary"]
    # 이 테스트가 가려내는지: 그 규칙으로 계산한 결과다 (환율 효과만으로는 규칙을 무시해도 같다)
    assert summary["value"] == pytest.approx(V2["strategies"][rule]["value"], abs=1)
    assert summary["fx_effect"] == pytest.approx(METRICS["fx_effect"], abs=1)
    assert summary["avg_buy_fx"] == pytest.approx(METRICS["avg_buy_fx"], abs=0.01)
    assert summary["price_effect"] + summary["fx_effect"] == pytest.approx(summary["profit"], abs=1)


@pytest.mark.parametrize("rule", CHOSEN_RULES, ids=CHOSEN_RULES)
def test_backtest_rule_avg_cost_invest_is_null_in_summary_and_buys(api: Api, rule: str) -> None:
    """결정 d39: 규칙 매수 결과에는 평단가(투자 통화)가 없다. summary와 buys 모두 null."""
    qld = _result(_backtest(api.client, rule=rule), "QLD")
    assert qld["summary"]["avg_cost_invest"] is None
    assert [row["avg_cost_invest"] for row in qld["buys"]] == [None] * len(qld["buys"])


def test_backtest_switch_buys_keep_rest_days_with_zero_qty_and_same_day_reference(
    api: Api,
) -> None:
    """레버리지 전환: buys는 매수일마다 60줄이고 쉰 날 15줄은 qty 0 (v2.strategies.switch.rule_days).
    QLD와 QQQ는 둘 다 America/New_York이라 매수일 종가를 본다. 기준 종목은 환율 없이 한 번 받는다."""
    body = _backtest(api.client, rule="switch")
    assert body["errors"] == []
    qld = _result(body, "QLD")
    assert len(qld["buys"]) == METRICS["buys"]
    assert _rest_rows(qld) == V2["strategies"]["switch"]["rule_days"]
    assert qld["switch_ref"] == SAME_DAY_QQQ
    assert _called(api.yahoo) == Counter({"QLD": 1, "USDKRW=X": 1, "QQQ": 1})


def test_backtest_switch_cross_exchange_matches_v2_and_uses_previous_day(api: Api) -> None:
    """9-8 다른 거래소 레버리지 전환 (결정 d29): 005930.KS, 원화. 평가금 298,106,846원, +148.42%,
    XIRR 37.64%, 평단가 76,241.12원, 쉰 매수일 14줄, 기준 종목은 전날 종가로 본다."""
    body = _backtest(api.client, symbols=["005930.KS"], rule="switch")
    assert body["errors"] == []
    samsung = _result(body, "005930.KS")
    summary, want = samsung["summary"], V2["switch_cross_exchange"]
    assert summary["value"] == pytest.approx(want["value"], abs=1)
    assert summary["return_pct"] == pytest.approx(want["return_pct"], abs=0.01)
    assert summary["xirr_pct"] == pytest.approx(want["xirr_pct"], abs=0.01)
    assert summary["avg_cost_asset"] == pytest.approx(want["avg_cost_asset"], abs=0.01)
    assert summary["worst"]["return_pct"] == pytest.approx(want["worst_return_pct"], abs=0.01)
    assert summary["leftover_cash"] == pytest.approx(want["leftover_cash_invest"], abs=1)
    assert _rest_rows(samsung) == want["rule_days"]
    assert samsung["switch_ref"] == PREVIOUS_DAY_QQQ
    assert _called(api.yahoo) == Counter({"005930.KS": 1, "QQQ": 1})


# 요청 값이 엔진까지 가는지


def test_backtest_rule_none_response_equals_response_without_rule(api: Api) -> None:
    """rule을 빼면 none이다: 응답 전체가 같고, params에 기본값(none, 200, QQQ)을 채운다. none은 지금처럼
    simulate로 계산하므로 원화 평단가가 있고 switch_ref는 null이다."""
    without = _backtest(api.client, symbols=["QQQ", "QLD"])
    with_none = _backtest(api.client, symbols=["QQQ", "QLD"], rule="none")
    assert with_none == without
    params = with_none["params"]
    assert (params["rule"], params["ma_days"], params["switch_ref"]) == ("none", 200, "QQQ")
    for result in with_none["results"]:
        assert result["switch_ref"] is None, result["symbol"]
        assert result["summary"]["avg_cost_invest"] is not None, result["symbol"]


def test_backtest_ma_dip_whole_shares_flag_keeps_values(api: Api) -> None:
    """9-6, 결정 d28: 규칙 매수는 소수점 매수로 계산하므로 fractional=false여도 결과가 true일 때와 같다."""
    fractional = _backtest(api.client, rule="ma_dip")
    whole = _backtest(api.client, rule="ma_dip", fractional=False)
    assert whole["params"]["fractional"] is False
    summary = _result(whole, "QLD")["summary"]
    assert summary["value"] == pytest.approx(V2["strategies"]["ma_dip"]["value"], abs=1)
    assert whole["results"] == fractional["results"]
    assert whole["chart"] == fractional["chart"]


def test_backtest_ma_days_reaches_engine(api: Api) -> None:
    """F-15: 고른 이평선 기간으로 계산한다. 200일은 9-8 기준값, 20일은 엔진을 ma_days=20으로 부른 값과 같고
    (공식은 다시 만들지 않는다) 둘이 다르다."""
    short = _result(_backtest(api.client, rule="ma_dip", ma_days=20), "QLD")["summary"]
    long = _result(_backtest(api.client, rule="ma_dip", ma_days=200), "QLD")["summary"]
    assert long["value"] == pytest.approx(V2["strategies"]["ma_dip"]["value"], abs=1)
    params = engine.Params(
        start=date.fromisoformat(V2_BACKTEST["start"]),
        end=date.fromisoformat(V2_BACKTEST["end"]),
        freq=V2_BACKTEST["freq"],
        anchor=V2_BACKTEST["anchor"],
        amount=V2_BACKTEST["amount"],
        currency=V2_BACKTEST["currency"],
    )
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    want = engine.simulate_rule(asset, fx, None, params, "ma_dip", ma_days=20)
    assert short["value"] == pytest.approx(want.value, abs=1)
    assert short["value"] != pytest.approx(long["value"], abs=1)


@pytest.mark.parametrize("rule", NON_SWITCH_RULES, ids=NON_SWITCH_RULES)
def test_backtest_non_switch_rule_ignores_unknown_switch_ref(api: Api, rule: str) -> None:
    """기준 종목은 switch일 때만 받는다. 다른 규칙에 없는 switch_ref(ZZZZ)를 줘도 부르지 않고 오류도 없으며
    switch_ref는 null이다."""
    body = _backtest(api.client, rule=rule, switch_ref="ZZZZ")
    assert body["errors"] == []
    qld = _result(body, "QLD")
    assert qld["switch_ref"] is None
    assert qld["summary"]["value"] == pytest.approx(V2["strategies"][rule]["value"], abs=1)
    assert _called(api.yahoo) == Counter({"QLD": 1, "USDKRW=X": 1})


# 호출 횟수


@pytest.mark.parametrize(
    ("symbols", "want"),
    [
        (["QQQ", "QLD", "TQQQ"], Counter({"QQQ": 1, "QLD": 1, "TQQQ": 1, "USDKRW=X": 1})),
        (["QLD", "TQQQ"], Counter({"QLD": 1, "TQQQ": 1, "USDKRW=X": 1, "QQQ": 1})),
    ],
    ids=["reference-among-symbols", "reference-not-among-symbols"],
)
def test_backtest_switch_gets_reference_series_once(
    api: Api, monkeypatch: pytest.MonkeyPatch, symbols: list[str], want: Counter[str]
) -> None:
    """기준 종목은 요청 하나에 한 번만 받는다. 요청 종목과 같으면 그 데이터를 쓰고, 종목이 여럿이어도 한 번."""
    counts = _count_get_series(api, monkeypatch)
    body = _backtest(api.client, symbols=symbols, rule="switch", switch_ref="QQQ")
    assert body["errors"] == []
    assert counts == want
    assert [r["switch_ref"] for r in body["results"]] == [SAME_DAY_QQQ] * len(symbols)


# 실패 경로


@pytest.mark.parametrize(
    ("missing", "switch_ref", "message"),
    [
        ("QQQ", "QQQ", REF_QQQ_FAILED),
        (None, "ZZZZ", "기준 종목 ZZZZ를 받지 못해 계산하지 못했습니다."),
    ],
    ids=["qqq-not-found", "unknown-code"],
)
def test_backtest_switch_reference_failure_fails_each_symbol(
    api: Api, missing: str | None, switch_ref: str, message: str
) -> None:
    """기준 종목을 받지 못하면 200이고, 결과 전체가 그 규칙이라 종목마다 errors에 담는다 (환율 실패와 같은
    처리). results와 그래프는 비고, 기준 종목은 한 번만 부른다."""
    if missing is not None:
        api.yahoo.missing.add(missing)
    body = _backtest(api.client, symbols=["QLD", "TQQQ"], rule="switch", switch_ref=switch_ref)
    assert body["results"] == []
    assert body["errors"] == [
        {"symbol": "QLD", "message": message},
        {"symbol": "TQQQ", "message": message},
    ]
    assert body["chart"]["series"] == {}
    assert _called(api.yahoo)[switch_ref] == 1


def test_backtest_switch_failing_symbol_keeps_own_error_over_reference_error(api: Api) -> None:
    """종목과 기준 종목이 모두 실패하면 그 종목은 자기 오류 한 줄이다 (설계 메모 표)."""
    body = _backtest(api.client, symbols=["QLD", "XXXX"], rule="switch", switch_ref="ZZZZ")
    assert body["results"] == []
    assert body["errors"] == [
        {"symbol": "QLD", "message": "기준 종목 ZZZZ를 받지 못해 계산하지 못했습니다."},
        {"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."},
    ]


def test_backtest_switch_missing_reference_symbol_reports_own_and_reference_errors(
    api: Api,
) -> None:
    """기준 종목이 요청 종목이면서 없으면 그 종목은 자기 문구, 다른 종목은 기준 종목 문구다. 한 번만 부른다."""
    api.yahoo.missing.add("QQQ")
    body = _backtest(api.client, symbols=["QQQ", "QLD"], rule="switch")
    assert body["results"] == []
    assert body["errors"] == [
        {"symbol": "QQQ", "message": "'QQQ' 종목을 찾을 수 없습니다."},
        {"symbol": "QLD", "message": REF_QQQ_FAILED},
    ]
    assert _called(api.yahoo)["QQQ"] == 1


def test_backtest_switch_reference_symbol_fx_failure_keeps_other_symbol(api: Api) -> None:
    """기준 종목이 요청 종목이고 그 종목의 환율만 실패하면, 그 종목은 환율 문구이고 다른 종목은 받은 기준 종목
    데이터로 계산한다. 005930.KS는 9-8 다른 거래소 레버리지 전환 값이다."""
    api.yahoo.missing.add("USDKRW=X")
    body = _backtest(api.client, symbols=["QQQ", "005930.KS"], rule="switch")
    assert body["errors"] == [{"symbol": "QQQ", "message": FX_FAILED}]
    samsung = _result(body, "005930.KS")
    want = V2["switch_cross_exchange"]
    assert samsung["summary"]["value"] == pytest.approx(want["value"], abs=1)
    assert samsung["switch_ref"] == PREVIOUS_DAY_QQQ
    assert _called(api.yahoo)["QQQ"] == 1


def test_backtest_switch_stale_reference_only_marks_switch_ref(api: Api) -> None:
    """기준 종목만 저장본이면 switch_ref.stale만 true다. 종목·환율은 새로 받았으니 results[].stale은 false
    (/api/strategy와 같다). 값은 9-8 레버리지 전환 그대로다.

    이슈 #59: 기준 종목은 stale_sources에 넣지 않아 []이고, switch_ref에 기준일 2026-11-23이 있다."""
    assert _backtest(api.client, rule="switch")["errors"] == []  # 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("QQQ")
    body = _backtest(api.client, rule="switch")
    assert body["errors"] == []
    qld = _result(body, "QLD")
    assert qld["stale"] is False
    assert qld["stale_sources"] == []
    assert qld["switch_ref"] == {
        "symbol": "QQQ",
        "basis": "same_day",
        "stale": True,
        "data_through": "2026-11-23",
    }
    assert qld["summary"]["value"] == pytest.approx(V2["strategies"]["switch"]["value"], abs=1)


# ---------- 저장본 출처 stale_sources와 기준 종목 기준일 (F-10, F-17, 이슈 #59) ----------

# 새로 받으면 stale_sources가 비는 조건. 9-8 조건(양도세 켬)에 종목·통화·매수 규칙만 바꾼다
FRESH_CASES: dict[str, dict[str, Any]] = {
    "krw-qld-tax": {},  # 9-8 조건 그대로: 매수·평가 환율(fx)을 쓴다
    "krw-three-symbols": {"symbols": ["QQQ", "QLD", "005930.KS"]},  # 환율이 필요 없는 종목도 섞는다
    "usd-qqq-tax": {"symbols": ["QQQ"], **USD_REQUEST},  # 양도세 환율(tax_fx)을 쓴다
    "krw-qld-switch": {"rule": "switch"},  # 기준 종목을 쓴다
}


def _switch_ref_of(api: Api, endpoint: str, **changes: Any) -> dict[str, Any]:
    """9-8 조건을 레버리지 전환으로 /api/backtest 또는 /api/strategy에 보내 QLD의 switch_ref를 돌려준다."""
    if endpoint == "backtest":
        body = _backtest(api.client, rule="switch", **changes)
        assert body["errors"] == []
        backtest_ref: dict[str, Any] = _result(body, "QLD")["switch_ref"]
        return backtest_ref
    body = _strategy(api.client, **changes)
    assert body["errors"] == []
    strategy_ref: dict[str, Any] = body["result"]["switch_ref"]
    return strategy_ref


def test_stale_kind_is_price_fx_tax_fx_in_order() -> None:
    """stale_sources의 kind는 종목 주가, 매수·평가 환율, 양도세 환율이고 줄 순서도 이 순서다 (설계 메모)."""
    assert get_args(schemas.StaleKind) == ("price", "fx", "tax_fx")


@pytest.mark.parametrize("changes", list(FRESH_CASES.values()), ids=list(FRESH_CASES))
def test_backtest_fresh_data_has_empty_stale_sources(api: Api, changes: dict[str, Any]) -> None:
    """모두 새로 받으면 모든 결과의 stale_sources는 []이고 stale은 false다 (stale은 stale_sources가 비어 있지
    않은 것과 같다)."""
    body = _backtest(api.client, **changes)
    assert body["errors"] == []
    assert body["results"]
    for result in body["results"]:
        assert result["stale_sources"] == [], result["symbol"]
        assert result["stale"] is False, result["symbol"]


def test_backtest_krw_qld_with_saved_usdkrw_lists_only_fx_source(api: Api) -> None:
    """원화 투자 9-8 QLD에서 USDKRW=X만 저장본이면 stale_sources는 매수·평가 환율(fx) 한 줄이다. 종목은 새로
    받아 price 줄이 없고, 원화 투자라 양도세 환율(tax_fx)은 따로 없다. 기준일은 평가 환율 날 11-24 (7절)."""
    assert _backtest(api.client)["errors"] == []  # 종목과 USDKRW=X 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("USDKRW=X")
    body = _backtest(api.client)
    assert body["errors"] == []
    qld = _result(body, "QLD")
    assert qld["stale"] is True
    assert qld["stale_sources"] == [
        {"symbol": "USDKRW=X", "kind": "fx", "data_through": "2026-11-24"}
    ]


def test_backtest_usd_qqq_tax_all_saved_lists_price_before_tax_fx(api: Api) -> None:
    """줄 순서는 price, fx, tax_fx다. 달러로 QQQ를 사고 양도세를 켠 채 Yahoo가 모두 실패하면 종목 주가 다음에
    양도세 환율이 온다. 달러 종목을 달러로 사서 fx 줄은 없다."""
    usd: dict[str, Any] = {"symbols": ["QQQ"], **USD_REQUEST}
    assert _backtest(api.client, **usd)["errors"] == []
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    body = _backtest(api.client, **usd)
    assert body["errors"] == []
    qqq = _result(body, "QQQ")
    assert qqq["stale"] is True
    assert qqq["stale_sources"] == [
        {"symbol": "QQQ", "kind": "price", "data_through": "2026-11-23"},
        {"symbol": "USDKRW=X", "kind": "tax_fx", "data_through": "2026-11-24"},
    ]


def test_backtest_switch_stale_reference_among_symbols_lists_only_own_price(api: Api) -> None:
    """기준 종목은 stale_sources에 넣지 않는다 (switch_ref에 따로 있다). QQQ가 요청 종목이면서 기준 종목이고
    저장본이면 QQQ 결과에는 자기 주가(price) 한 줄만 있고 QLD 결과는 []다. switch_ref는 둘 다 저장본이다."""
    request: dict[str, Any] = {"symbols": ["QQQ", "QLD"], "rule": "switch"}
    assert _backtest(api.client, **request)["errors"] == []  # 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.missing.add("QQQ")
    body = _backtest(api.client, **request)
    assert body["errors"] == []
    qqq, qld = _result(body, "QQQ"), _result(body, "QLD")
    assert qqq["stale_sources"] == [
        {"symbol": "QQQ", "kind": "price", "data_through": "2026-11-23"}
    ]
    assert qld["stale_sources"] == []
    assert (qqq["stale"], qld["stale"]) == (True, False)
    assert qqq["switch_ref"] == qld["switch_ref"] == {**SAME_DAY_QQQ, "stale": True}


@pytest.mark.parametrize(
    ("endpoint", "end", "want"),
    [
        ("backtest", V2["period"][1], REF_THROUGH),
        ("strategy", V2["period"][1], REF_THROUGH),
        ("backtest", "2024-12-31", "2024-12-31"),
        ("strategy", "2024-12-31", "2024-12-31"),
    ],
    ids=[
        "backtest-v2-end",
        "strategy-v2-end",
        "backtest-end-2024-12-31",
        "strategy-end-2024-12-31",
    ],
)
def test_switch_ref_data_through_is_last_trading_day_on_or_before_end(
    api: Api, endpoint: str, end: str, want: str
) -> None:
    """switch_ref.data_through는 기준 종목의 끝날짜 당일 또는 그 이전 마지막 거래일이다. 저장본 마지막 날
    (2026-11-23)을 그대로 적지 않는다. 같은 모델(SwitchRefOut)이라 두 API 모두에 붙는다 (이슈 #59 (라))."""
    ref = _switch_ref_of(api, endpoint, end=end)
    assert ref == {"symbol": "QQQ", "basis": "same_day", "stale": False, "data_through": want}


# ---------- 매수 내역 두 열, 산 매수만 세는 싸게 산 횟수, 날마다 평가금 (F-14·F-16, 이슈 #62) ----------

# 9-8 매수 내역 1·14·60회(buys[0]·[13]·[59])의 그날 수익률·이 회차 지금 (결정 d59). 날짜 키 순서가 회차 순서다
BUY_ROWS: dict[str, dict[str, float]] = V2["buy_rows"]
BUY_ROW_INDEXES = (0, 13, 59)
# 9-8 매수 규칙 결과의 산 횟수(qty > 0인 줄 수)와 싸게 산 횟수 (결정 d58)
RULE_BOUGHT: dict[str, dict[str, int]] = V2["rule_bought"]
# 상세 설계 4절 buys 예의 키
BUY_KEYS = {
    "date",
    "price",
    "fx",
    "qty",
    "cum_qty",
    "avg_cost_asset",
    "avg_cost_invest",
    "invested",
    "return_pct",
    "lot_return_pct",
}
# 상세 설계 4절 daily 모양 (결정 d60)
DAILY_KEYS = {"dates", "value", "invested", "return_pct"}
V2_DATA_THROUGH = "2026-11-23"  # 7절: 9-8 끝날짜 2026-11-24의 평가 가격은 2026-11-23 종가
# 7절 매일 10만원 사례의 주기·금액. 9-8 기간에 넣으면 마지막 거래일 2026-11-23이 매수일이다
DAILY_REQUEST: dict[str, Any] = {
    "freq": DAILY_CASE["freq"],
    "anchor": DAILY_CASE["anchor"],
    "amount": DAILY_CASE["amount"],
}


def _without_daily(body: dict[str, Any]) -> dict[str, Any]:
    """응답에서 params와 results[].daily를 뺀 나머지. include_daily가 다른 두 응답을 비교할 때 쓴다."""
    rest = {key: value for key, value in body.items() if key != "params"}
    rest["results"] = [
        {key: value for key, value in result.items() if key != "daily"}
        for result in body["results"]
    ]
    return rest


# 매수 내역 두 열 (9-1, 결정 d59)


def test_backtest_v2_reference_case_buys_return_and_lot_return_match_v2_buy_rows(api: Api) -> None:
    """9-8: buys[0] 2021-12-01 0.00 / 93.09, buys[13] 2023-01-03 −33.54 / 340.54, buys[59] 2026-11-02
    107.23 / −9.19 (±0.01%p). 줄 키는 상세 설계 4절 buys 예와 같고, 두 열은 소수 2자리 %다 (5절 끝)."""
    buys = _result(_backtest(api.client), "QLD")["buys"]
    assert len(buys) == METRICS["buys"]
    assert set(buys[0]) == BUY_KEYS
    assert [buys[k]["date"] for k in BUY_ROW_INDEXES] == list(BUY_ROWS)
    for k in BUY_ROW_INDEXES:
        row, want = buys[k], BUY_ROWS[buys[k]["date"]]
        assert row["return_pct"] == pytest.approx(want["return_pct"], abs=0.01), row["date"]
        assert row["lot_return_pct"] == pytest.approx(want["lot_return_pct"], abs=0.01), row["date"]
    for row in buys:
        assert row["return_pct"] == round(row["return_pct"], 2), row["date"]
        assert row["lot_return_pct"] == round(row["lot_return_pct"], 2), row["date"]


@pytest.mark.parametrize(
    ("changes", "last_day_buy"),
    [({}, False), ({"rule": "switch"}, False), (DAILY_REQUEST, True)],
    ids=["monthly", "monthly-switch", "daily-last-day-buy"],
)
def test_backtest_buys_return_pct_equals_chart_return_pct_on_buy_days(
    api: Api, changes: dict[str, Any], last_day_buy: bool
) -> None:
    """그날 수익률은 그 매수일의 수익률 추이 값이라 chart.dates에 있는 매수일은 chart.series.QLD.return_pct와
    같다 (상세 설계 4절). 레버리지 전환은 남은 현금이 들고, 매일 매수는 마지막 거래일이 매수일이라 평가 환율로
    다시 평가한 값(그래프 끝)과 같다."""
    body = _backtest(api.client, **changes)
    chart = body["chart"]
    on_chart = dict(zip(chart["dates"], chart["series"]["QLD"]["return_pct"], strict=True))
    buys = _result(body, "QLD")["buys"]
    shown = [row for row in buys if row["date"] in on_chart]
    assert shown
    for row in shown:
        assert row["return_pct"] == on_chart[row["date"]], row["date"]
    if last_day_buy:
        assert buys[-1]["date"] == chart["dates"][-1] == V2_DATA_THROUGH
        assert buys[-1]["return_pct"] == _result(body, "QLD")["summary"]["return_pct"]


def test_backtest_switch_rest_rows_have_null_lot_return_and_numeric_return_pct(api: Api) -> None:
    """레버리지 전환에서 산 수량 0인 15줄은 lot_return_pct가 null이고 return_pct(그날 수익률)는 숫자다.
    산 45줄은 lot_return_pct가 있다 (결정 d59, v2.rule_bought.switch)."""
    buys = _result(_backtest(api.client, rule="switch"), "QLD")["buys"]
    rests = [row for row in buys if row["qty"] == 0]
    assert len(rests) == V2["strategies"]["switch"]["rule_days"]
    for row in rests:
        assert row["lot_return_pct"] is None, row["date"]
        assert isinstance(row["return_pct"], float), row["date"]
    bought = [row for row in buys if row["qty"] > 0]
    assert len(bought) == RULE_BOUGHT["switch"]["bought"]
    assert all(row["lot_return_pct"] is not None for row in bought)


# 싸게 산 횟수 (9-1, 결정 d58)


@pytest.mark.parametrize("rule", list(RULE_BOUGHT), ids=list(RULE_BOUGHT))
def test_backtest_rule_buy_counts_skip_zero_qty_days_match_v2_rule_bought(
    api: Api, rule: str
) -> None:
    """9-8: 레버리지 전환은 쉰 15번을 빼고 산 45번 중 36번·12번, 이평선 아래 2배·위 절반은 쉰 날이 없어
    60번 중 51번·22번 그대로다 (과열 때 절반 51번·23번). 산 횟수는 qty가 0보다 큰 buys 줄 수다."""
    qld = _result(_backtest(api.client, rule=rule), "QLD")
    want = RULE_BOUGHT[rule]
    assert sum(1 for row in qld["buys"] if row["qty"] > 0) == want["bought"]
    assert qld["analysis"]["buys_below_eval_price"] == want["buys_below_eval_price"]
    assert qld["analysis"]["buys_below_avg_cost"] == want["buys_below_avg_cost"]


# 날마다 평가금 include_daily (결정 d60)


def test_backtest_request_without_include_daily_defaults_to_false() -> None:
    """include_daily를 빼면 false다. 기존 요청이 그대로 돈다."""
    request = schemas.BacktestRequest.model_validate(V2_BACKTEST)
    assert request.include_daily is False


@pytest.mark.parametrize("value", ["maybe", None], ids=["text", "null"])
def test_backtest_non_boolean_include_daily_returns_422_without_yahoo(api: Api, value: Any) -> None:
    """include_daily는 true 또는 false다. 아니면 422이고 항목은 include_daily, Yahoo는 부르지 않는다."""
    response = _post(api.client, include_daily=value)
    assert response.status_code == 422, response.text[:200]
    details = response.json()["detail"]
    assert any(d["field"] == "include_daily" for d in details), details
    assert api.yahoo.calls == []


def test_backtest_include_daily_true_returns_every_trading_day_from_first_buy_to_data_through(
    api: Api,
) -> None:
    """9-8, include_daily true: QLD daily.dates는 1,250개로 summary.trading_days·chart.total_days와 같고,
    첫날 2021-12-01(첫 매수일), 끝날 2026-11-23(data_through)이다. 마지막 value는 summary.value와 ±1원이다."""
    body = _backtest(api.client, include_daily=True)
    assert body["params"]["include_daily"] is True
    qld = _result(body, "QLD")
    daily, summary = qld["daily"], qld["summary"]
    assert set(daily) == DAILY_KEYS
    dates = daily["dates"]
    assert len(dates) == METRICS["trading_days"] == summary["trading_days"]
    assert len(dates) == body["chart"]["total_days"]
    assert (dates[0], dates[-1]) == (V2_FIRST_BUY, V2_DATA_THROUGH)
    assert dates[-1] == qld["data_through"]
    assert dates == sorted(set(dates))
    for column in ("value", "invested", "return_pct"):
        assert len(daily[column]) == len(dates), column
    assert daily["value"][-1] == pytest.approx(summary["value"], abs=1)
    assert daily["invested"][-1] == pytest.approx(summary["invested"], abs=1)
    assert daily["return_pct"][-1] == pytest.approx(summary["return_pct"], abs=0.01)


@pytest.mark.parametrize("rule", ["none", "switch"], ids=["none", "switch"])
def test_backtest_include_daily_matches_chart_and_buys_with_chart_digits(
    api: Api, rule: str
) -> None:
    """daily는 줄이지 않은 날마다 값이다. 그래프에 남은 날은 chart.series.QLD와 같은 값이고, 매수일의
    return_pct는 buys[].return_pct와 같다. 자리수는 chart와 같다: 원화 금액은 정수, return_pct는 소수 2자리."""
    body = _backtest(api.client, include_daily=True, rule=rule)
    qld, chart = _result(body, "QLD"), body["chart"]
    daily, series = qld["daily"], chart["series"]["QLD"]
    index = {day: i for i, day in enumerate(daily["dates"])}
    assert set(chart["dates"]) <= set(index)
    for column in CHART_COLUMNS:
        assert [daily[column][index[day]] for day in chart["dates"]] == series[column], column
    for row in qld["buys"]:
        assert row["return_pct"] == daily["return_pct"][index[row["date"]]], row["date"]
    assert all(v == round(v) for v in daily["value"] + daily["invested"])
    assert all(v == round(v, 2) for v in daily["return_pct"])


@pytest.mark.parametrize("case", ["missing", "false"], ids=["missing", "false"])
def test_backtest_without_or_false_include_daily_has_null_daily_and_same_rest(
    api: Api, case: str
) -> None:
    """include_daily를 빼거나 false면 results[].daily는 null이고, daily와 params를 뺀 나머지 응답은 true일 때와
    같다. params에는 false를 채운다."""
    request: dict[str, Any] = {"symbols": ["QQQ", "QLD"]}
    on = _backtest(api.client, **request, include_daily=True)
    off_changes: dict[str, Any] = {} if case == "missing" else {"include_daily": False}
    off = _backtest(api.client, **request, **off_changes)
    assert off["params"]["include_daily"] is False
    assert on["params"] == {**off["params"], "include_daily": True}
    for result in off["results"]:
        assert result["daily"] is None, result["symbol"]
    for result in on["results"]:
        assert result["daily"] is not None, result["symbol"]
    assert _without_daily(on) == _without_daily(off)


def test_backtest_include_daily_late_symbol_starts_at_its_own_first_buy(api: Api) -> None:
    """daily 범위는 그 종목의 첫 매수일부터 data_through까지다. QQQ 데이터가 2023-03부터면 QQQ daily는 그 첫
    매수일부터라 함께 그린 그래프 날짜(chart.total_days)보다 짧고, QLD daily는 2021-12-01부터다. null은 없다."""
    api.yahoo.extra["QQQ"] = payload_from("QQQ", LATE_FIRST_DAY)
    body = _backtest(api.client, symbols=["QQQ", "QLD"], include_daily=True)
    assert body["errors"] == []
    for symbol in ("QQQ", "QLD"):
        result = _result(body, symbol)
        daily, summary = result["daily"], result["summary"]
        assert daily["dates"][0] == summary["first_buy"], symbol
        assert daily["dates"][-1] == result["data_through"], symbol
        assert len(daily["dates"]) == summary["trading_days"], symbol
        for column in ("value", "invested", "return_pct"):
            assert None not in daily[column], (symbol, column)
    qqq_daily = _result(body, "QQQ")["daily"]
    assert qqq_daily["dates"][0] >= LATE_FIRST_DAY.isoformat()
    assert len(qqq_daily["dates"]) < body["chart"]["total_days"]
    assert _result(body, "QLD")["daily"]["dates"][0] == V2_FIRST_BUY


def test_backtest_include_daily_unknown_symbol_fails_alone_and_others_keep_daily(api: Api) -> None:
    """없는 종목은 errors에만 있고, 받은 종목은 daily를 그대로 받는다."""
    body = _backtest(api.client, symbols=["QLD", "XXXX"], include_daily=True)
    assert [r["symbol"] for r in body["results"]] == ["QLD"]
    assert body["errors"] == [{"symbol": "XXXX", "message": "'XXXX' 종목을 찾을 수 없습니다."}]
    assert len(_result(body, "QLD")["daily"]["dates"]) == METRICS["trading_days"]


def test_backtest_include_daily_fx_failure_keeps_daily_of_symbol_without_fx(api: Api) -> None:
    """USDKRW=X를 받지 못하면 달러 종목(QLD)은 환율 오류이고, 원화로 사는 한국 종목(005930.KS)은 환율이 필요
    없어 daily까지 받는다. 기간은 9-8과 같아 첫 매수일은 2021-12-01이다."""
    api.yahoo.missing.add("USDKRW=X")
    body = _backtest(api.client, symbols=["QLD", "005930.KS"], include_daily=True)
    assert body["errors"] == [{"symbol": "QLD", "message": FX_FAILED}]
    samsung = _result(body, "005930.KS")
    daily, summary = samsung["daily"], samsung["summary"]
    assert daily["dates"][0] == summary["first_buy"]
    assert len(daily["dates"]) == summary["trading_days"]
    assert daily["value"][-1] == pytest.approx(summary["value"], abs=1)


def test_backtest_include_daily_from_saved_data_equals_fresh_daily(api: Api) -> None:
    """저장본만 있을 때(Yahoo 실패)도 daily를 싣고, 값은 새로 받았을 때와 같다. 결과는 stale이다."""
    fresh = _result(_backtest(api.client, include_daily=True), "QLD")  # 저장본을 채운다
    api.clock.now += 7 * 3600
    api.yahoo.fail = True
    saved = _result(_backtest(api.client, include_daily=True), "QLD")
    assert saved["stale"] is True
    assert saved["daily"] is not None
    assert saved["daily"] == fresh["daily"]


def test_backtest_first_buy_zero_return_is_not_negative_zero(api: Api) -> None:
    """첫 매수일의 그날 수익률은 계산 오차로 −1.1e-14가 될 수 있다. 응답은 −0.0이 아니라 0.0이다 (PR #72 리뷰).

    QLD를 2023-01-03 하루만 사서 그날 평가하면 buys와 daily의 첫 return_pct가 그 경우다."""
    body = _backtest(
        api.client, start="2023-01-02", end="2023-01-03", tax=False, include_daily=True
    )
    qld = _result(body, "QLD")
    first_buy, first_day = qld["buys"][0]["return_pct"], qld["daily"]["return_pct"][0]
    assert first_buy == first_day == 0.0
    assert math.copysign(1.0, first_buy) == math.copysign(1.0, first_day) == 1.0
