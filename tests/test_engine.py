"""계산 엔진(src/engine.py)을 기준값과 계산 규칙으로 확인한다. 네트워크 없이 fixture만 쓴다."""

from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import pytest

from src.engine import (
    Analysis,
    EngineError,
    Params,
    Series,
    StrategyResult,
    analyze,
    anchor_sweep,
    build_chart,
    buy_days,
    simulate,
    simulate_rule,
    start_sweep,
    xirr,
)
from tests.helpers import CASE_IDS, load_expected, load_series

EXPECTED = load_expected()
START = date.fromisoformat(EXPECTED["period"][0])
END = date.fromisoformat(EXPECTED["period"][1])

# 계산 규칙 7절 허용 오차: 평단가 ±0.01, 수량 ±0.0001, 금액 ±1원, 수익률 ±0.01%p
TOLERANCE = {
    "invested": 1.0,
    "shares": 1e-4,
    "leftover_cash_asset": 0.01,
    "avg_cost_asset": 0.01,
    "avg_cost_invest": 0.01,
    "eval_price": 1e-4,
    "eval_fx": 1e-4,
    "value": 1.0,
    "return_pct": 0.01,
    "xirr_pct": 0.01,
}

CASES = [(case, symbol) for case in EXPECTED["cases"] for symbol in case["results"]]


def _params(case: dict[str, Any], **changes: Any) -> Params:
    values: dict[str, Any] = {
        "start": START,
        "end": END,
        "freq": case["freq"],
        "anchor": case["anchor"],
        "amount": float(case["amount"]),
        "currency": case["invest_currency"],
        "fractional": case["fractional"],
        "fee": case["fee"],
    }
    values.update(changes)
    return Params(**values)


def _run(symbol: str, params: Params) -> Any:
    asset = load_series(symbol)
    fx = (
        None
        if asset.currency == params.currency
        else load_series(f"{asset.currency}{params.currency}=X")
    )
    return simulate(asset, fx, params)


def _weekdays(first: date, last: date, holidays: frozenset[date] = frozenset()) -> list[date]:
    days = []
    day = first
    while day <= last:
        if day.weekday() < 5 and day not in holidays:
            days.append(day)
        day += timedelta(days=1)
    return days


# ---------- 기준값 ----------


@pytest.mark.parametrize(
    ("case", "symbol"), CASES, ids=[f"{CASE_IDS[c['name']]}-{s}" for c, s in CASES]
)
def test_simulate_matches_expected_json(case: dict[str, Any], symbol: str) -> None:
    expected = case["results"][symbol]
    summary = _run(symbol, _params(case)).summary
    assert summary.buys == expected["buys"]
    assert summary.first_buy.isoformat() == expected["first_buy"]
    assert summary.last_buy.isoformat() == expected["last_buy"]
    actual = {
        "invested": summary.invested,
        "shares": summary.shares,
        "leftover_cash_asset": summary.leftover_cash,
        "avg_cost_asset": summary.avg_cost_asset,
        "avg_cost_invest": summary.avg_cost_invest,
        "eval_price": summary.eval_price,
        "eval_fx": summary.eval_fx,
        "value": summary.value,
        "return_pct": summary.return_pct,
        "xirr_pct": summary.xirr_pct,
    }
    for field, tolerance in TOLERANCE.items():
        assert actual[field] == pytest.approx(expected[field], abs=tolerance), field


def test_simulate_qld_monthly_daily_rows_cover_first_buy_to_last_trading_day() -> None:
    result = _run("QLD", _params(EXPECTED["cases"][0]))
    assert result.daily[0].date == result.summary.first_buy
    assert result.daily[-1].date == date(2026, 11, 23)
    assert result.daily[-1].invested == pytest.approx(120_000_000)
    assert len(result.buys) == 60
    assert result.buys[-1].cum_qty == pytest.approx(result.summary.shares)


def test_simulate_qld_monthly_extremes_match_design_example() -> None:
    """상세 설계 4절 응답 예시의 최고·최저 수익률과 평가금 최고점."""
    summary = _run("QLD", _params(EXPECTED["cases"][0])).summary
    assert summary.best.date == date(2026, 6, 2)
    assert summary.best.value == pytest.approx(211.6, abs=0.05)
    assert summary.worst.date == date(2022, 6, 16)
    assert summary.worst.value == pytest.approx(-39.4, abs=0.05)
    assert summary.peak_value.date == date(2026, 6, 2)
    assert summary.peak_value.value == pytest.approx(342_707_723, abs=1)


def test_simulate_last_daily_row_matches_summary_value() -> None:
    result = _run("QLD", _params(EXPECTED["cases"][0]))
    assert result.daily[-1].value == pytest.approx(result.summary.value)
    assert result.daily[-1].fx == pytest.approx(result.summary.eval_fx)


def test_simulate_few_days_period_has_no_xirr() -> None:
    """며칠짜리 기간은 연환산 해가 +10,000%를 넘어 계산 불가다 (계산 규칙 5절)."""
    params = _params(EXPECTED["cases"][4], start=date(2025, 11, 21), end=date(2025, 11, 24))
    assert _run("QLD", params).summary.xirr_pct is None


def test_simulate_same_currency_uses_fx_one() -> None:
    case = next(c for c in EXPECTED["cases"] if c["invest_currency"] == "USD")
    result = _run("QQQ", _params(case))
    assert result.summary.eval_fx == 1.0
    assert all(row.fx == 1.0 for row in result.buys)


def test_simulate_without_buy_days_in_period_raises_engine_error() -> None:
    case = EXPECTED["cases"][0]
    params = _params(case, start=date(2030, 1, 1), end=date(2030, 2, 1))
    with pytest.raises(EngineError, match="매수일"):
        _run("QLD", params)


def test_simulate_listed_after_start_is_flagged() -> None:
    days = _weekdays(date(2024, 1, 2), date(2024, 6, 28))
    asset = Series("NEW", "KRW", days, [100.0] * len(days))
    params = Params(date(2023, 1, 1), date(2024, 6, 28), "monthly", 1, 1_000_000.0, "KRW")
    summary = simulate(asset, None, params).summary
    assert summary.listed_after_start is True
    assert summary.first_buy == date(2024, 1, 2)


def test_simulate_listed_before_start_is_not_flagged() -> None:
    assert _run("QLD", _params(EXPECTED["cases"][0])).summary.listed_after_start is False


def test_simulate_fx_starting_after_first_buy_raises_engine_error() -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 3, 29), frozenset({date(2024, 1, 1)}))
    asset = Series("US", "USD", days, [10.0] * len(days))
    fx_days = [d for d in days if d >= date(2024, 2, 1)]
    fx = Series("USDKRW=X", "KRW", fx_days, [1300.0] * len(fx_days))
    params = Params(date(2024, 1, 1), date(2024, 3, 29), "monthly", 1, 100_000.0, "KRW")
    with pytest.raises(EngineError, match="환율"):
        simulate(asset, fx, params)


@pytest.mark.parametrize(
    "with_fx", [True, False], ids=["fx-for-same-currency", "no-fx-for-other-currency"]
)
def test_simulate_rejects_fx_mismatching_currencies(with_fx: bool) -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 3, 29))
    currency = "KRW" if with_fx else "USD"
    asset = Series("X", currency, days, [10.0] * len(days))
    fx = Series("USDKRW=X", "KRW", days, [1300.0] * len(days)) if with_fx else None
    params = Params(date(2024, 1, 1), date(2024, 3, 29), "monthly", 1, 100_000.0, "KRW")
    with pytest.raises(ValueError, match="환율"):
        simulate(asset, fx, params)


def test_simulate_rejects_non_positive_amount() -> None:
    days = _weekdays(date(2024, 1, 2), date(2024, 3, 29))
    asset = Series("X", "KRW", days, [100.0] * len(days))
    with pytest.raises(ValueError, match="금액"):
        simulate(
            asset, None, Params(date(2024, 1, 1), date(2024, 3, 29), "daily", None, 0.0, "KRW")
        )


def test_simulate_whole_shares_keeps_cash_until_one_share_is_affordable() -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 3, 29), frozenset({date(2024, 1, 1)}))
    asset = Series("BIG", "KRW", days, [250.0] * len(days))
    params = Params(
        date(2024, 1, 1), date(2024, 3, 29), "monthly", 1, 100.0, "KRW", fractional=False
    )
    result = simulate(asset, None, params)
    assert [row.qty for row in result.buys] == [0, 0, 1]
    assert result.buys[0].avg_cost_asset is None
    assert result.summary.leftover_cash == pytest.approx(50.0)
    assert result.summary.value == pytest.approx(300.0)


# ---------- 매수일 (계산 규칙 2절) ----------


def test_buy_days_monthly_start_mid_month_skips_that_month() -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 3, 31), frozenset({date(2024, 1, 1)}))
    assert buy_days(days, date(2024, 1, 15), date(2024, 3, 31), "monthly", 1) == [
        date(2024, 2, 1),
        date(2024, 3, 1),
    ]


def test_buy_days_monthly_31_in_30_day_month_uses_last_trading_day() -> None:
    days = _weekdays(date(2024, 4, 1), date(2024, 5, 31))
    assert buy_days(days, date(2024, 4, 1), date(2024, 5, 31), "monthly", 31) == [
        date(2024, 4, 30),
        date(2024, 5, 31),
    ]


def test_buy_days_monthly_anchor_after_last_trading_day_stays_in_month() -> None:
    # 2024-08-31은 토요일. 다음 거래일(9/3)은 다음 달이라 8월 마지막 거래일(8/30)에 산다
    days = _weekdays(date(2024, 8, 1), date(2024, 9, 30), frozenset({date(2024, 9, 2)}))
    assert buy_days(days, date(2024, 8, 1), date(2024, 9, 30), "monthly", 31) == [
        date(2024, 8, 30),
        date(2024, 9, 30),
    ]


def test_buy_days_weekly_friday_holiday_uses_last_trading_day_of_week() -> None:
    days = _weekdays(date(2024, 3, 25), date(2024, 4, 5), frozenset({date(2024, 3, 29)}))
    assert buy_days(days, date(2024, 3, 25), date(2024, 4, 5), "weekly", 4) == [
        date(2024, 3, 28),
        date(2024, 4, 5),
    ]


def test_buy_days_weekly_monday_holiday_uses_next_trading_day() -> None:
    days = _weekdays(date(2024, 5, 27), date(2024, 5, 31), frozenset({date(2024, 5, 27)}))
    assert buy_days(days, date(2024, 5, 27), date(2024, 5, 31), "weekly", 0) == [date(2024, 5, 28)]


def test_buy_days_monthly_unfinished_month_does_not_buy_early() -> None:
    # 데이터가 2/23(금)에 끝났다. 2월 25일 이후 거래일은 아직 안 왔으니 2월에는 사지 않는다
    days = _weekdays(date(2024, 1, 1), date(2024, 2, 23), frozenset({date(2024, 1, 1)}))
    assert buy_days(days, date(2024, 1, 1), date(2024, 2, 24), "monthly", 25) == [date(2024, 1, 25)]


def test_buy_days_weekly_unfinished_week_does_not_buy_early() -> None:
    days = _weekdays(date(2024, 3, 18), date(2024, 3, 25))  # 3/25(월)에서 끝
    assert buy_days(days, date(2024, 3, 18), date(2024, 3, 26), "weekly", 4) == [date(2024, 3, 22)]


def test_buy_days_daily_returns_every_trading_day_in_period() -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 1, 31))
    assert buy_days(days, date(2024, 1, 10), date(2024, 1, 12), "daily", None) == [
        date(2024, 1, 10),
        date(2024, 1, 11),
        date(2024, 1, 12),
    ]


@pytest.mark.parametrize(
    ("freq", "anchor"),
    [("monthly", 0), ("monthly", 32), ("monthly", None), ("weekly", 5), ("weekly", -1)],
    ids=["monthly-0", "monthly-32", "monthly-none", "weekly-5", "weekly-negative"],
)
def test_buy_days_rejects_anchor_out_of_range(freq: str, anchor: int | None) -> None:
    days = _weekdays(date(2024, 1, 1), date(2024, 1, 31))
    with pytest.raises(ValueError, match="기준"):
        buy_days(days, date(2024, 1, 1), date(2024, 1, 31), freq, anchor)  # type: ignore[arg-type]


# ---------- XIRR ----------


def test_xirr_ten_percent_after_one_year() -> None:
    flows = [(date(2023, 1, 1), -100.0), (date(2024, 1, 1), 110.0)]
    rate = xirr(flows)
    assert rate is not None
    assert rate == pytest.approx(0.10, abs=1e-9)


def test_xirr_above_ten_thousand_percent_returns_none() -> None:
    assert xirr([(date(2024, 1, 1), -100.0), (date(2024, 1, 2), 105.0)]) is None


def test_xirr_without_sign_change_returns_none() -> None:
    assert xirr([(date(2023, 1, 1), -100.0), (date(2024, 1, 1), -10.0)]) is None


def test_xirr_total_loss_returns_none() -> None:
    assert xirr([(date(2023, 1, 1), -100.0), (date(2024, 1, 1), 0.0)]) is None


def test_xirr_falls_back_to_bisection_when_newton_jumps_out() -> None:
    # 뉴턴법 첫 걸음이 −99.99% 아래로 튀어 이분법으로 푼다. 값은 이분법 결과를 적어 둔 것
    rate = xirr([(date(2014, 1, 1), -100.0), (date(2024, 1, 1), 1.0)])
    assert rate is not None
    assert rate == pytest.approx(-0.368883508, abs=1e-6)


# ---------- 그래프 날짜축 ----------


def test_build_chart_merges_dates_and_fills_missing_days() -> None:
    a_days = [date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4)]
    b_days = [date(2024, 1, 3), date(2024, 1, 5)]
    params = Params(date(2024, 1, 1), date(2024, 1, 5), "daily", None, 100.0, "KRW")
    a = simulate(Series("A", "KRW", a_days, [10.0, 11.0, 12.0]), None, params)
    b = simulate(Series("B", "KRW", b_days, [20.0, 25.0]), None, params)
    chart = build_chart({"A": a, "B": b})
    assert chart.dates == [date(2024, 1, d) for d in (2, 3, 4, 5)]
    assert chart.series["B"].price == [None, 20.0, 20.0, 25.0]
    assert chart.series["A"].price == [10.0, 11.0, 12.0, 12.0]
    assert chart.series["A"].invested[-1] == pytest.approx(300.0)
    assert chart.total_days == 4


def test_build_chart_downsampling_keeps_first_last_and_extremes() -> None:
    result = _run("QLD", _params(EXPECTED["cases"][4]))  # 매일 매수, 거래일 1,254개
    chart = build_chart({"QLD": result}, max_points=100)
    assert len(chart.dates) <= 100
    assert chart.total_days == len(result.daily)
    for must in (
        result.daily[0].date,
        result.daily[-1].date,
        result.summary.best.date,
        result.summary.worst.date,
    ):
        assert must in chart.dates


# ---------- v2 분석: 계산 규칙 9-1 ~ 9-5 ----------

V2 = EXPECTED["v2"]
CASE_IDS_LIST = [CASE_IDS[case["name"]] for case in EXPECTED["cases"]]


def _v2_params(**changes: Any) -> Params:
    start, end = (date.fromisoformat(d) for d in V2["period"])
    params = Params(start, end, "monthly", V2["anchor"], float(V2["amount"]), V2["invest_currency"])
    return replace(params, **changes)


def _analyze(symbol: str, params: Params) -> Analysis:
    asset = load_series(symbol)
    fx = (
        None
        if asset.currency == params.currency
        else load_series(f"{asset.currency}{params.currency}=X")
    )
    return analyze(simulate(asset, fx, params), asset, fx, params.end, tax_fx=1.0)


def test_analyze_drawdown_and_underwater_match_v2_reference() -> None:
    a, m = _analyze("QLD", _v2_params()), V2["metrics"]
    assert a.max_drawdown is not None
    assert a.max_drawdown.date == date.fromisoformat(m["max_drawdown"]["date"])
    assert a.max_drawdown.value == pytest.approx(m["max_drawdown"]["pct"], abs=0.01)
    assert (a.underwater_days, a.trading_days) == (m["underwater_days"], m["trading_days"])
    assert a.underwater_pct == pytest.approx(m["underwater_pct"], abs=0.01)
    assert a.longest_underwater is not None
    longest = m["longest_underwater"]
    assert a.longest_underwater.days == longest["days"]
    assert a.longest_underwater.start.isoformat() == longest["start"]
    assert a.longest_underwater.recovered is not None
    assert a.longest_underwater.recovered.isoformat() == longest["recovered"]
    assert a.last_underwater == date.fromisoformat(m["last_underwater"])
    assert a.buys_below_eval_price == m["buys_below_eval_price"]
    assert a.buys_below_avg_cost == m["buys_below_avg_cost"]


def test_analyze_years_and_months_match_v2_reference() -> None:
    a, m = _analyze("QLD", _v2_params()), V2["metrics"]
    years = {str(y.year): y for y in a.years}
    assert list(years) == list(m["years"])
    for year, want in m["years"].items():
        assert years[year].return_pct == pytest.approx(want["return_pct"], abs=0.01)
        if want["price_change_pct"] is None:
            assert years[year].price_change_pct is None
        else:
            assert years[year].price_change_pct == pytest.approx(want["price_change_pct"], abs=0.01)
    assert len(a.months) == m["months"]["count"]
    assert sum(1 for x in a.months if x.return_pct > 0) == m["months"]["up"]
    best = max(a.months, key=lambda x: x.return_pct)
    worst = min(a.months, key=lambda x: x.return_pct)
    assert (best.month, worst.month) == (
        m["months"]["best"]["month"],
        m["months"]["worst"]["month"],
    )
    assert best.return_pct == pytest.approx(m["months"]["best"]["return_pct"], abs=0.01)
    assert worst.return_pct == pytest.approx(m["months"]["worst"]["return_pct"], abs=0.01)


def test_analyze_profit_split_and_tax_match_v2_reference() -> None:
    a, m = _analyze("QLD", _v2_params()), V2["metrics"]
    assert a.price_effect == pytest.approx(m["price_effect"], abs=1)
    assert a.fx_effect == pytest.approx(m["fx_effect"], abs=1)
    assert a.price_effect + a.fx_effect == pytest.approx(m["profit"], abs=1)
    assert a.avg_buy_fx == pytest.approx(m["avg_buy_fx"], abs=0.01)
    assert a.tax == pytest.approx(m["tax"], abs=1)
    assert a.profit_after_tax == pytest.approx(m["profit_after_tax"], abs=1)


def test_analyze_korean_stock_has_no_fx_effect_and_no_tax() -> None:
    a = _analyze("005930.KS", _v2_params())
    assert a.fx_effect == 0
    assert a.avg_buy_fx is None
    assert a.tax == 0
    assert a.price_effect == pytest.approx(a.profit_after_tax, abs=1e-6)


def test_analyze_dollar_investment_tax_uses_given_won_rate() -> None:
    """9-5: 달러 투자면 손익을 원화로 바꿔 세금을 계산하고 다시 달러로. 손익 $10,000, 1달러 1,000원이면
    (1,000만원 − 250만원) × 22% = 165만원 = $1,650."""
    dates = [date(2024, 1, 1), date(2024, 1, 2)]
    asset = Series(
        "USX", "USD", dates, [100.0, 1100.0]
    )  # 10주 + 1000/1100주 → 평가 12,000, 투자 2,000
    params = Params(dates[0], dates[1], "daily", None, 1000.0, "USD")
    result = simulate(asset, None, params)
    assert result.summary.profit == pytest.approx(10_000)
    a = analyze(result, asset, None, params.end, tax_fx=1000.0)
    assert a.tax == pytest.approx(1650.0)
    assert a.profit_after_tax == pytest.approx(8350.0)
    assert a.fx_effect == 0


@pytest.mark.parametrize("tax_fx", [0.0, -1.0, float("inf")], ids=["zero", "negative", "inf"])
def test_analyze_non_positive_tax_fx_raises_value_error(tax_fx: float) -> None:
    asset = _rising()
    params = Params(date(2024, 1, 1), date(2024, 1, 10), "daily", None, 1000.0, "KRW")
    with pytest.raises(ValueError, match="tax_fx"):
        analyze(simulate(asset, None, params), asset, None, params.end, tax_fx=tax_fx)


def test_analyze_whole_shares_fx_effect_is_same_across_symbols() -> None:
    """9-4 셋째 줄: 같은 날 같은 원화를 바꾸면 환율 효과는 종목이 달라도 같다 (정수 주의 남은 현금 포함).
    소수점 매수의 환율 효과(−746,367원)·평균 매수 환율(1,352.57원)과 같다."""
    m = V2["metrics"]
    for symbol in ("QQQ", "QLD", "SOXL"):
        a = _analyze(symbol, _v2_params(fractional=False))
        assert a.fx_effect == pytest.approx(m["fx_effect"], abs=1)
        assert a.avg_buy_fx == pytest.approx(m["avg_buy_fx"], abs=0.01)


def test_analyze_asset_history_longer_than_fx_history_skips_days_without_fx() -> None:
    """종목 이력이 환율 이력보다 길어도 월별 수익률을 계산한다 (첫 매수 달의 지난달부터만 본다)."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    short_fx = Series(fx.symbol, fx.currency, fx.dates[60:], fx.close[60:])
    params = _v2_params()
    a = analyze(simulate(asset, short_fx, params), asset, short_fx, params.end, tax_fx=1.0)
    assert len(a.months) == V2["metrics"]["months"]["count"]


def test_analyze_first_month_without_trades_in_previous_month_spans_two_months() -> None:
    """9-3: 첫 매수 달 바로 전 달에 거래가 없으면(거래정지) 그 앞 월말과 비교해 첫 달이 빠지지 않는다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    keep = [i for i, d in enumerate(asset.dates) if (d.year, d.month) != (2023, 3)]
    halted = Series(
        "QLD", asset.currency, [asset.dates[i] for i in keep], [asset.close[i] for i in keep]
    )
    params = _v2_params(start=date(2023, 4, 1))
    a = analyze(simulate(halted, fx, params), halted, fx, params.end, tax_fx=1.0)
    assert a.months[0].month == "2023-04"
    assert len(a.months) == 43  # 2023-04 ~ 2026-10


def test_analyze_year_without_previous_year_data_has_no_price_change() -> None:
    """9-2: 전해 데이터가 없으면(그해 상장) 주가 등락은 None."""
    asset = load_series("QLD")
    cut = next(i for i, d in enumerate(asset.dates) if d >= date(2022, 6, 15))
    late = Series("LATE", asset.currency, asset.dates[cut:], asset.close[cut:])
    params = Params(date(2022, 1, 1), date(2023, 12, 31), "monthly", 1, 1000.0, "USD")
    a = analyze(simulate(late, None, params), late, None, params.end, tax_fx=1300.0)
    years = {y.year: y for y in a.years}
    assert years[2022].price_change_pct is None
    assert years[2023].price_change_pct is not None


def _rising(days: int = 70) -> Series:
    dates = [date(2024, 1, 1) + timedelta(days=i) for i in range(days)]
    return Series("UP", "KRW", dates, [100.0 + i for i in range(days)])


def test_analyze_rising_prices_have_no_drawdown_or_underwater_days() -> None:
    """결정 d25: 낙폭이 없으면 None, 원금 아래였던 날이 없으면 0일·None."""
    asset = _rising()
    params = Params(date(2024, 1, 1), date(2024, 3, 10), "daily", None, 1000.0, "KRW")
    a = analyze(simulate(asset, None, params), asset, None, params.end, tax_fx=1.0)
    assert a.max_drawdown is None
    assert a.underwater_days == 0
    assert a.longest_underwater is None
    assert a.last_underwater is None


def test_analyze_period_without_ended_month_has_no_months() -> None:
    """결정 d25: 끝난 달이 없으면 월별은 빈 목록 (끝날짜 3-9는 3월 말일이 아니다)."""
    asset = _rising()
    params = Params(date(2024, 3, 1), date(2024, 3, 9), "daily", None, 1000.0, "KRW")
    a = analyze(simulate(asset, None, params), asset, None, params.end, tax_fx=1.0)
    assert a.months == []


def test_analyze_longest_underwater_tie_keeps_the_first() -> None:
    """결정 d25: 가장 긴 원금 아래 구간이 같은 길이로 둘이면 앞의 것."""
    prices = [100.0, 90.0, 90.0, 200.0, 90.0, 40.0, 300.0]
    dates = [date(2024, 1, 1) + timedelta(days=i) for i in range(len(prices))]
    asset = Series("ZIG", "KRW", dates, prices)
    params = Params(dates[0], dates[-1], "daily", None, 100.0, "KRW")
    a = analyze(simulate(asset, None, params), asset, None, params.end, tax_fx=1.0)
    assert a.longest_underwater is not None
    assert (a.longest_underwater.days, a.longest_underwater.start) == (2, dates[1])
    assert a.longest_underwater.recovered == dates[3]


# ---------- v2 전략과 바꿔 보기: 계산 규칙 9-6, 9-7 ----------

RULES = ["none", "ma_dip", "ma_hot", "switch", "lump_sum"]


def _strategy(rule: str) -> StrategyResult:
    asset, fx, ref = load_series("QLD"), load_series("USDKRW=X"), load_series(V2["switch_ref"])
    return simulate_rule(asset, fx, ref, _v2_params(), rule, ma_days=V2["ma_days"])


@pytest.mark.parametrize("rule", RULES)
def test_simulate_rule_matches_v2_reference(rule: str) -> None:
    got, want = _strategy(rule), V2["strategies"][rule]
    assert got.value == pytest.approx(want["value"], abs=1)
    assert got.return_pct == pytest.approx(want["return_pct"], abs=0.01)
    assert got.xirr_pct == pytest.approx(want["xirr_pct"], abs=0.01)
    assert got.avg_cost_asset == pytest.approx(want["avg_cost_asset"], abs=0.01)
    assert got.worst_return_pct == pytest.approx(want["worst_return_pct"], abs=0.01)
    assert got.leftover_cash_invest == pytest.approx(want["leftover_cash_invest"], abs=1)
    assert got.rule_days == want["rule_days"]


def test_simulate_rule_none_equals_simulate() -> None:
    """기본 적립 전략은 simulate와 같은 평가금과 날마다 값을 낸다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    basic = simulate(asset, fx, _v2_params())
    got = _strategy("none")
    assert got.value == pytest.approx(basic.summary.value, abs=1e-6)
    assert [r.date for r in got.daily] == [r.date for r in basic.daily]
    assert got.daily[-1].value == pytest.approx(basic.daily[-1].value, abs=1e-6)


def test_simulate_rule_moving_average_short_history_uses_multiplier_one() -> None:
    """9-6: 상장 후 n거래일이 안 되면 배수 1 (기본 적립과 같다)."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    young = Series("YOUNG", asset.currency, asset.dates[-150:], asset.close[-150:])
    params = _v2_params(start=young.dates[0])
    dip = simulate_rule(young, fx, None, params, "ma_dip", ma_days=200)
    basic = simulate(young, fx, params)
    assert dip.rule_days == 0
    assert dip.value == pytest.approx(basic.summary.value, abs=1e-6)


def test_simulate_rule_switch_without_reference_raises_value_error() -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    with pytest.raises(ValueError, match="기준 종목"):
        simulate_rule(asset, fx, None, _v2_params(), "switch", ma_days=200)


def test_anchor_sweep_matches_v2_reference() -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    got = anchor_sweep(asset, fx, _v2_params())
    assert list(got) == [int(a) for a in V2["anchor_sweep"]]
    for anchor, avg in V2["anchor_sweep"].items():
        assert got[int(anchor)] == pytest.approx(avg, abs=0.01)


def test_start_sweep_matches_v2_reference() -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    got = start_sweep(asset, fx, _v2_params())
    assert list(got) == list(V2["start_sweep"])
    for month, ret in V2["start_sweep"].items():
        assert got[month] == pytest.approx(ret, abs=0.01)


@pytest.mark.parametrize("case", EXPECTED["cases"][2:6], ids=CASE_IDS_LIST[2:6])
def test_simulate_rule_none_matches_v1_cases_with_fee_and_other_frequencies(
    case: dict[str, Any],
) -> None:
    """기본 적립 전략은 v1 기준값(수수료 0.25%, 매주, 매일, 달러 투자)과 같다 (9-6 공식의 f, 주기)."""
    params = _params(case)
    for symbol, want in case["results"].items():
        asset = load_series(symbol)
        fx = (
            None
            if asset.currency == params.currency
            else load_series(f"{asset.currency}{params.currency}=X")
        )
        got = simulate_rule(asset, fx, None, params, "none")
        assert got.value == pytest.approx(want["value"], abs=1)
        assert got.return_pct == pytest.approx(want["return_pct"], abs=0.01)
        assert got.avg_cost_asset == pytest.approx(want["avg_cost_asset"], abs=0.01)


def test_simulate_rule_unknown_rule_raises_value_error() -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    with pytest.raises(ValueError, match="알 수 없는 전략"):
        simulate_rule(asset, fx, None, _v2_params(), "dca_x", ma_days=200)  # type: ignore[arg-type]


@pytest.mark.parametrize("ma_days", [0, -5], ids=["zero", "negative"])
def test_simulate_rule_non_positive_ma_days_raises_value_error(ma_days: int) -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    with pytest.raises(ValueError, match="이평선 기간"):
        simulate_rule(asset, fx, None, _v2_params(), "ma_dip", ma_days=ma_days)


def test_simulate_rule_missing_fx_raises_value_error() -> None:
    asset = load_series("QLD")
    with pytest.raises(ValueError, match="환율"):
        simulate_rule(asset, None, None, _v2_params(), "none")


def test_start_sweep_skips_months_before_listing() -> None:
    """9-7: 상장 달보다 앞선 달은 빼고 상장 달은 남긴다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    cut = next(i for i, d in enumerate(asset.dates) if d >= date(2023, 3, 1))
    late = Series("LATE", asset.currency, asset.dates[cut:], asset.close[cut:])
    got = start_sweep(late, fx, _v2_params(start=date(2022, 1, 1)))
    assert min(got) == "2023-03"


def test_start_sweep_missing_fx_raises_engine_error() -> None:
    """환율이 모자라면 조용히 건너뛰지 않고 오류를 올린다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    cut = next(i for i, d in enumerate(fx.dates) if d >= date(2024, 1, 1))
    short_fx = Series(fx.symbol, fx.currency, fx.dates[cut:], fx.close[cut:])
    with pytest.raises(EngineError, match="환율"):
        start_sweep(asset, short_fx, _v2_params())


def test_anchor_sweep_anchor_without_buy_day_is_none() -> None:
    """기간이 짧아 그 기준일로는 매수일이 없으면 None (다른 기준일은 계산한다)."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    got = anchor_sweep(asset, fx, _v2_params(start=date(2026, 10, 5), end=date(2026, 10, 20)))
    assert got[10] is not None
    assert got[25] is None
