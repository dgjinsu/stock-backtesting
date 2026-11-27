"""계산 엔진(src/engine.py)을 기준값과 계산 규칙으로 확인한다. 네트워크 없이 fixture만 쓴다."""

from bisect import bisect_right
from collections.abc import Callable
from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import pytest

from src import engine
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
from tests.helpers import CASE_IDS, MONTH_END_CASES, load_expected, load_series

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


def _strategy(rule: str, **changes: Any) -> StrategyResult:
    """9-8 조건(QLD, 기준 종목 QQQ, 200일선)의 전략 하나. changes로 Params 항목을 바꾼다."""
    asset, fx, ref = load_series("QLD"), load_series("USDKRW=X"), load_series(V2["switch_ref"])
    return simulate_rule(asset, fx, ref, _v2_params(**changes), rule, ma_days=V2["ma_days"])


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


# 전략 그래프 (상세 설계 3절, 기능 명세 F-07·F-15)

MAX_CHART_POINTS = 1000  # 기능 명세 F-07: 최대 약 1,000점
# 7절 매일 사례(10만원)의 주기·금액으로 9-8 기간을 매일 산다: 거래일이 1,000일을 넘는다
DAILY_CASE = next(c for c in EXPECTED["cases"] if CASE_IDS[c["name"]] == "daily-krw100k")
DAILY_CHANGES: dict[str, Any] = {
    "freq": DAILY_CASE["freq"],
    "anchor": DAILY_CASE["anchor"],
    "amount": float(DAILY_CASE["amount"]),
}


def _must_keep_dates(results: list[StrategyResult]) -> set[date]:
    """줄여도 남아야 하는 날: 첫날, 마지막 날, 전략마다 최고·최저 수익률 날 (같은 값이면 앞의 날)."""
    days = {results[0].daily[0].date, results[0].daily[-1].date}
    for result in results:
        returns = [row.return_pct for row in result.daily]
        days.add(result.daily[returns.index(max(returns))].date)
        days.add(result.daily[returns.index(min(returns))].date)
    return days


def test_build_strategy_chart_daily_five_years_keeps_first_last_and_rule_extremes() -> None:
    """F-07·F-15: 5년 매일은 1,000점 이하로 줄이되 꼭 남길 날은 남기고, 남긴 날의 값은 그날 daily 값이다."""
    results = [_strategy(rule, **DAILY_CHANGES) for rule in RULES]
    chart = engine.build_strategy_chart(results)
    assert chart.total_days == len(results[0].daily)
    assert chart.total_days > MAX_CHART_POINTS
    assert len(chart.dates) <= MAX_CHART_POINTS
    assert _must_keep_dates(results) <= set(chart.dates)
    assert list(chart.series) == RULES
    for result in results:
        series = chart.series[result.rule]
        assert len(series.value) == len(series.invested) == len(chart.dates), result.rule
        assert len(series.return_pct) == len(chart.dates), result.rule
        # 같은 float라 정확히 같다: 마지막 행은 평가 환율로 다시 평가한 값, 최저 수익률 날은 남긴다
        assert series.value[-1] == result.value, result.rule
        assert min(series.return_pct) == result.worst_return_pct, result.rule
        row_on = {row.date: row for row in result.daily}
        assert series.value == [row_on[d].value for d in chart.dates], result.rule
        assert series.invested == [row_on[d].invested for d in chart.dates], result.rule
        assert series.return_pct == [row_on[d].return_pct for d in chart.dates], result.rule


def test_build_strategy_chart_up_to_max_points_keeps_every_day() -> None:
    """9-8 조건을 1년(2025-11-25 ~ 2026-11-24) 매월로 줄이면 거래일이 1,000일 이하라 줄이지 않는다."""
    results = [_strategy(rule, start=date(2025, 11, 25)) for rule in RULES]
    chart = engine.build_strategy_chart(results)
    days = [row.date for row in results[0].daily]
    assert len(days) <= MAX_CHART_POINTS
    assert chart.dates == days
    assert chart.total_days == len(days)
    assert list(chart.series) == RULES
    for result in results:
        series = chart.series[result.rule]
        assert series.value == [row.value for row in result.daily], result.rule
        assert series.invested == [row.invested for row in result.daily], result.rule
        assert series.return_pct == [row.return_pct for row in result.daily], result.rule


def test_build_strategy_chart_different_date_axes_raise_value_error() -> None:
    """다섯 전략은 같은 asset·fx·Params로 불러 날짜축이 같다. 다르면 호출 계약 위반이다."""
    none, dip = _strategy("none"), _strategy("ma_dip")
    with pytest.raises(ValueError, match="날짜"):
        engine.build_strategy_chart([none, replace(dip, daily=dip.daily[1:])])


def test_build_strategy_chart_same_rule_twice_raises_value_error() -> None:
    """같은 rule이 두 번이면 series 키가 겹친다. 호출 계약 위반이다."""
    none = _strategy("none")
    with pytest.raises(ValueError, match="두 번"):
        engine.build_strategy_chart([none, none])


# ---------- 결정 d24·d25·d29: 끝난 달, 달러 양도세, 다른 거래소 기준 종목 ----------


def _cut(series: Series, last_day: date) -> Series:
    """last_day까지만 남긴다. replace로 잘라 시간대 같은 다른 필드는 그대로 둔다."""
    k = bisect_right(series.dates, last_day)
    return replace(series, dates=series.dates[:k], close=series.close[:k])


@pytest.mark.parametrize(
    ("cut", "end", "last_month", "count"),
    list(MONTH_END_CASES.values()),
    ids=list(MONTH_END_CASES),
)
def test_analyze_months_month_is_ended_only_when_end_and_data_reach_month_end(
    cut: date | None, end: date, last_month: str, count: int
) -> None:
    """9-3, 결정 d24: 그 달 말일 ≤ 끝날짜이고 데이터 마지막 날 ≥ 그 달 말일이어야 끝난 달이다.

    데이터 9-29·끝날짜 9-30이면 9월 월말 값이 9-29 종가라 9월은 빠진다. 2절 진행 중인 달과 같은 판정이라
    말일이 토요일(10-31)이고 데이터가 금요일(10-30)까지여도 10월은 빠진다.
    """
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    if cut is not None:
        asset = _cut(asset, cut)
        assert asset.dates[-1] == cut
    params = _v2_params(end=end)
    a = analyze(simulate(asset, fx, params), asset, fx, end, tax_fx=1.0)
    assert (a.months[0].month, a.months[-1].month, len(a.months)) == ("2021-12", last_month, count)


def test_analyze_dollar_investment_tax_matches_v2_reference() -> None:
    """9-5, 결정 d25: QQQ 매월 1일 $1,500 달러 투자, 9-8 기간. tax_fx는 끝날짜 당일 또는 그 이전 마지막
    USDKRW=X 종가다. 평가금·투자금은 7절 "매월 1일 1,500달러" 줄, tax_fx는 7절 평가 환율과 같다."""
    want = V2["dollar_tax"]
    usd_case = next(c for c in EXPECTED["cases"] if c["invest_currency"] == "USD")
    usd_qqq = usd_case["results"]["QQQ"]
    krw_eval_fx = EXPECTED["cases"][0]["results"]["QLD"]["eval_fx"]
    asset, won = load_series("QQQ"), load_series("USDKRW=X")
    params = _v2_params(amount=1500.0, currency="USD")
    tax_fx = won.close[bisect_right(won.dates, params.end) - 1]
    result = simulate(asset, None, params)
    a = analyze(result, asset, None, params.end, tax_fx=tax_fx)
    assert result.summary.value == pytest.approx(usd_qqq["value"], abs=1)
    assert result.summary.invested == pytest.approx(usd_qqq["invested"], abs=1)
    assert tax_fx == pytest.approx(krw_eval_fx, abs=1e-4)
    assert tax_fx == pytest.approx(want["tax_fx"], abs=0.01)
    assert result.summary.profit == pytest.approx(want["profit"], abs=1)
    assert a.tax == pytest.approx(want["tax"], abs=1)
    assert a.profit_after_tax == pytest.approx(want["profit_after_tax"], abs=1)


def _switch_cross_exchange() -> StrategyResult:
    """005930.KS(서울)를 QQQ(뉴욕) 200일선으로 레버리지 전환. 9-8 기간, 매월 1일 200만원, 원화."""
    asset, ref = load_series("005930.KS"), load_series(V2["switch_ref"])
    return simulate_rule(asset, None, ref, _v2_params(), "switch", ma_days=V2["ma_days"])


def test_simulate_rule_switch_cross_exchange_matches_v2_reference() -> None:
    """9-6, 결정 d29: 거래소 시간대가 다르면 기준 종목 종가·이평선을 매수일보다 앞선 마지막 거래일로 본다.
    그날 종가를 쓰는 규칙이면 299,148,879원 / 쉰 매수일 15번이 나와 기준값과 다르다."""
    want = V2["switch_cross_exchange"]
    got = _switch_cross_exchange()
    assert got.value == pytest.approx(want["value"], abs=1)
    assert got.return_pct == pytest.approx(want["return_pct"], abs=0.01)
    assert got.xirr_pct == pytest.approx(want["xirr_pct"], abs=0.01)
    assert got.avg_cost_asset == pytest.approx(want["avg_cost_asset"], abs=0.01)
    assert got.worst_return_pct == pytest.approx(want["worst_return_pct"], abs=0.01)
    assert got.leftover_cash_invest == pytest.approx(want["leftover_cash_invest"], abs=1)
    assert got.rule_days == want["rule_days"]


def test_simulate_rule_switch_cross_exchange_buys_2022_02_03_on_previous_reference_close() -> None:
    """결정 d29에서 갈리는 날: 005930.KS 2022-02-03 매수일에 QQQ 2-03 종가(353.55 < 200일선 366.27)는
    한국 장이 끝난 뒤에 나온다. 2-02 종가(368.49 > 366.19)로 보고 그날 산다 (평단가가 바뀐다)."""
    rows = _switch_cross_exchange().daily
    i = next(i for i, row in enumerate(rows) if row.date == date(2022, 2, 3))
    assert rows[i - 1].date == date(2022, 1, 28)  # 설 연휴 앞 마지막 거래일
    assert rows[i - 1].avg_cost_asset is not None
    assert rows[i].avg_cost_asset != pytest.approx(rows[i - 1].avg_cost_asset, abs=1e-9)


SYNTH_DAYS = [date(2024, 1, 1) + timedelta(days=i) for i in range(5)]
# 기준 종목 종가가 매수일(마지막 날)에만 3일 이평선 위: 전날 9 < 11, 매수일 13 > 11.33
SPIKE_ON_BUY_DAY = [12.0, 12.0, 12.0, 9.0, 13.0]


def _switch_last_day(
    asset_tz: str, ref_tz: str, ref_days: list[date], ref_close: list[float]
) -> StrategyResult:
    """SYNTH_DAYS 마지막 날 한 번만 $1,000을 넣는 레버리지 전환 (3일 이평선). 사는 종목 가격은 늘 $100."""
    asset = Series("BUY", "USD", SYNTH_DAYS, [100.0] * len(SYNTH_DAYS), exchange_tz=asset_tz)
    ref = Series("REF", "USD", ref_days, ref_close, exchange_tz=ref_tz)
    last = SYNTH_DAYS[-1]
    params = Params(last, last + timedelta(days=1), "daily", None, 1000.0, "USD")
    return simulate_rule(asset, None, ref, params, "switch", ma_days=3)


def test_simulate_rule_switch_same_exchange_tz_uses_buy_day_reference_close() -> None:
    """9-6, 결정 d29: 두 종목 시간대가 같으면 매수일 기준 종목 종가(13 > 이평선 11.33)를 보고 그날 산다."""
    got = _switch_last_day("America/New_York", "America/New_York", SYNTH_DAYS, SPIKE_ON_BUY_DAY)
    assert got.rule_days == 0
    assert got.avg_cost_asset == pytest.approx(100.0, abs=0.01)
    assert got.leftover_cash_invest == pytest.approx(0.0, abs=1)


@pytest.mark.parametrize(
    ("asset_tz", "ref_tz"),
    [
        ("Asia/Seoul", "America/New_York"),
        ("America/New_York", "Asia/Seoul"),
        ("", "America/New_York"),
        ("Asia/Seoul", ""),
        ("", ""),
    ],
    ids=["kr-asset-us-ref", "us-asset-kr-ref", "asset-tz-empty", "ref-tz-empty", "both-tz-empty"],
)
def test_simulate_rule_switch_other_or_unknown_exchange_tz_uses_previous_reference_close(
    asset_tz: str, ref_tz: str
) -> None:
    """결정 d29: 시간대가 다르거나(방향 상관없이) 하나라도·둘 다 비면 매수일보다 앞선 마지막 거래일로 본다.
    전날 종가 9 < 이평선 11이라 그날은 쉬고 (쉰 매수일 1번), 산 돈은 0이다."""
    got = _switch_last_day(asset_tz, ref_tz, SYNTH_DAYS, SPIKE_ON_BUY_DAY)
    assert got.rule_days == 1
    assert got.avg_cost_asset is None  # 산 수량 0
    assert got.leftover_cash_invest == pytest.approx(1000.0, abs=1)


def test_simulate_rule_switch_other_exchange_short_reference_before_buy_day_uses_multiplier_one() -> (
    None
):
    """9-6: 매수일보다 앞선 마지막 거래일까지 기준 종목이 n거래일이 안 되면 배수 1로 산다.
    기준 종목은 1-03부터 3거래일 (12, 13, 9). 매수일 그날로 보면 9 < 11.33이라 쉬게 된다."""
    got = _switch_last_day("Asia/Seoul", "America/New_York", SYNTH_DAYS[2:], [12.0, 13.0, 9.0])
    assert got.rule_days == 0
    assert got.avg_cost_asset == pytest.approx(100.0, abs=0.01)
    assert got.leftover_cash_invest == pytest.approx(0.0, abs=1)


def test_series_without_exchange_tz_defaults_to_empty() -> None:
    """시간대 없이 만든 Series는 ""(모름)다. 기존 Series(symbol, currency, dates, close) 호출이 그대로 돈다."""
    series = Series("X", "KRW", [date(2024, 1, 2)], [100.0])
    assert series.exchange_tz == ""


@pytest.mark.parametrize(
    ("a_tz", "b_tz", "same"),
    [
        ("America/New_York", "America/New_York", True),
        ("Asia/Seoul", "America/New_York", False),
        ("", "America/New_York", False),
        ("", "", False),
    ],
    ids=["same-tz", "other-tz", "one-empty", "both-empty"],
)
def test_same_exchange_true_only_when_both_tz_known_and_equal(
    a_tz: str, b_tz: str, same: bool
) -> None:
    """9-6, 결정 d29: 시간대가 둘 다 비어 있지 않고 같을 때만 같은 거래소다. 하나라도 모르면 다른 거래소.
    simulate_rule과 /api/strategy의 basis가 같이 쓰는 판정이라 순서를 바꿔도 같은 값이어야 한다."""
    a = Series("A", "USD", [date(2024, 1, 2)], [100.0], exchange_tz=a_tz)
    b = Series("B", "USD", [date(2024, 1, 2)], [100.0], exchange_tz=b_tz)
    assert engine.same_exchange(a, b) is same
    assert engine.same_exchange(b, a) is same


@pytest.mark.parametrize(
    ("symbol", "tz"),
    [("QLD", "America/New_York"), ("QQQ", "America/New_York"), ("005930.KS", "Asia/Seoul")],
    ids=["QLD", "QQQ", "005930.KS"],
)
def test_load_series_reads_exchange_tz_from_fixture_meta(symbol: str, tz: str) -> None:
    """helpers.load_series가 meta.exchangeTimezoneName을 읽는다. 빠지면 QLD·QQQ가 다른 거래소로 판정된다.
    v2.strategies.switch는 QLD 매수일 중 그날·전날 판정이 갈리는 날이 없어 값으로는 못 잡으니 여기서 본다."""
    assert load_series(symbol).exchange_tz == tz


# ---------- 이슈 #35: 공개 환율 함수, 낙폭 그래프, 결정 d35 ----------

# 목·금·월. 토요일(1-06)과 일요일에는 환율이 없다
RATE_DAYS = [date(2024, 1, 4), date(2024, 1, 5), date(2024, 1, 8)]
RATE_FX = Series("USDKRW=X", "KRW", RATE_DAYS, [1300.0, 1310.0, 1320.0])


@pytest.mark.parametrize(
    ("fx", "day", "want"),
    [
        (RATE_FX, date(2024, 1, 5), 1310.0),
        (RATE_FX, date(2024, 1, 6), 1310.0),
        (load_series("USDKRW=X"), date.fromisoformat(V2["period"][1]), V2["dollar_tax"]["tax_fx"]),
        (None, date(2024, 1, 6), 1.0),
    ],
    ids=["same-day", "saturday-uses-friday", "dollar-tax-end", "same-currency-is-one"],
)
def test_rate_on_day_returns_close_on_or_before_day(
    fx: Series | None, day: date, want: float
) -> None:
    """계산 규칙 3절: day 당일 또는 그 이전 마지막 종가. 통화가 같으면(fx None) 1이다.
    9-5 양도세 환율도 같은 규칙이라 main이 이 함수로 찾는다: 9-8 끝날짜 2026-11-24의 USDKRW=X는 1,344.16원."""
    assert engine.rate_on(fx, day) == pytest.approx(want, abs=0.01)


def test_rate_on_before_first_rate_raises_engine_error() -> None:
    """3절: day 이전 환율이 없으면 계산할 수 없다. simulate의 "환율 없는 날"과 같은 EngineError다."""
    with pytest.raises(EngineError, match="USDKRW=X 환율이 2024-01-03 이전에는 없습니다"):
        engine.rate_on(RATE_FX, date(2024, 1, 3))


def test_build_chart_drawdown_is_none_before_first_buy_and_ends_at_from_peak() -> None:
    """9-1 평가금 낙폭 열. B는 1-03에 처음 사고 1-05에 값이 크게 떨어진 뒤, 1-08에는 거래가 없다.

    첫 매수 전(1-02)은 None, 거래가 없는 날은 직전 값, 마지막 값은 요약의 최고점 대비(from_peak_pct)와 같은
    float다. 가장 낮은 점은 analyze의 평가금 최대 낙폭과 같은 날·같은 값이다 (같은 공식을 나눠 쓴다).
    """
    a_days = [date(2024, 1, d) for d in (2, 3, 4, 5, 8)]
    b_days = [date(2024, 1, d) for d in (3, 4, 5)]
    params = Params(date(2024, 1, 1), date(2024, 1, 8), "daily", None, 100.0, "KRW")
    b_asset = Series("B", "KRW", b_days, [10.0, 20.0, 1.0])
    a = simulate(Series("A", "KRW", a_days, [10.0, 11.0, 12.0, 13.0, 14.0]), None, params)
    b = simulate(b_asset, None, params)
    chart = build_chart({"A": a, "B": b})
    assert chart.dates == a_days
    drawdown = chart.series["B"].drawdown
    assert len(drawdown) == len(chart.dates)
    assert drawdown[0] is None
    assert None not in drawdown[1:]
    assert drawdown[-1] == drawdown[-2]  # 1-08: B는 거래가 없어 1-05 값
    assert drawdown[-1] == b.summary.from_peak_pct
    worst = analyze(b, b_asset, None, params.end, tax_fx=1.0).max_drawdown
    assert worst is not None
    assert min(v for v in drawdown if v is not None) == worst.value
    assert chart.dates[drawdown.index(worst.value)] == worst.date
    assert chart.series["A"].drawdown[-1] == a.summary.from_peak_pct


@pytest.mark.parametrize("max_points", [100, MAX_CHART_POINTS], ids=["100-points", "1000-points"])
def test_build_chart_downsampling_keeps_max_drawdown_date(max_points: int) -> None:
    """줄여도 종목마다 평가금 최대 낙폭 날짜를 남긴다. 9-8 QLD(1,250 거래일)의 2026-11-20 −42.2%.

    그날은 첫날·마지막 날·최고·최저 수익률 날이 아니라 따로 남겨야 한다. 1,000점은 지금 일정 간격으로도
    우연히 남고, 100점이면 빠진다. 그래프의 가장 낮은 점은 analyze 값과 정확히 같다.
    """
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    params = _v2_params()
    result = simulate(asset, fx, params)
    worst = analyze(result, asset, fx, params.end, tax_fx=1.0).max_drawdown
    assert worst is not None
    assert worst.date.isoformat() == V2["metrics"]["max_drawdown"]["date"]
    assert len(result.daily) == V2["metrics"]["trading_days"]
    s = result.summary
    # 이 테스트가 가려내는지: 다른 규칙으로 이미 남기는 날이 아니다
    assert worst.date not in {
        result.daily[0].date,
        result.daily[-1].date,
        s.best.date,
        s.worst.date,
    }
    chart = build_chart({"QLD": result}, max_points=max_points)
    assert len(chart.dates) <= max_points
    assert worst.date in chart.dates
    drawdown = chart.series["QLD"].drawdown
    assert len(drawdown) == len(chart.dates)
    assert drawdown[chart.dates.index(worst.date)] == worst.value
    assert min(v for v in drawdown if v is not None) == worst.value


def test_anchor_sweep_whole_shares_without_one_share_is_none() -> None:
    """9-7, 결정 d35: 정수 주만 살 때 한 주도 사지 못하면 보유 수량이 0이라 평단가가 없어 None이다.

    _rising()은 100원부터 하루 1원씩 오른다. 매월 1일 50원씩 세 번(1-01, 2-01, 3-01) 넣어도 150원이라
    3-01 종가 160원짜리 한 주를 사지 못한다. 같은 조건을 소수점 매수로 하면 값이 있다.
    """
    asset = _rising()
    params = Params(
        date(2024, 1, 1), date(2024, 3, 10), "monthly", 1, 50.0, "KRW", fractional=False
    )
    assert anchor_sweep(asset, None, params)[1] is None
    assert anchor_sweep(asset, None, replace(params, fractional=True))[1] is not None


# ---------- 이슈 #36: 매수 규칙을 SimResult로 (F-17, 계산 규칙 9-6) ----------

# F-17 매수 규칙 4개: 9-8 전략 표에서 일시금(전략 비교 전용)을 뺀 것
BACKTEST_RULES = [rule for rule in V2["strategies"] if rule != "lump_sum"]
# 9-8: 매수일은 7절 "매월 1일 200만원" QLD와 같다 (60번, 2021-12-01 ~ 2026-11-02, 투자금 1억 2천만원)
V1_MONTHLY = next(c for c in EXPECTED["cases"] if CASE_IDS[c["name"]] == "monthly1-krw2m")
V1_QLD = V1_MONTHLY["results"]["QLD"]
# 7절 허용 오차에서 평단가(투자 통화)를 뺀 것. 규칙 매수에는 원화 평단가가 없다 (결정 d39)
RULE_SUMMARY_TOLERANCE = {k: v for k, v in TOLERANCE.items() if k != "avg_cost_invest"}


def _with_rule(rule: str, **changes: Any) -> engine.SimResult:
    """9-8 조건(QLD, 기준 종목 QQQ, 200일선)을 매수 규칙 하나로. changes로 Params 항목을 바꾼다."""
    asset, fx, ref = load_series("QLD"), load_series("USDKRW=X"), load_series(V2["switch_ref"])
    params = _v2_params(**changes)
    return engine.simulate_with_rule(asset, fx, ref, params, rule, ma_days=V2["ma_days"])


def _summary_numbers(s: engine.Summary) -> dict[str, float | None]:
    """RULE_SUMMARY_TOLERANCE 키로 요약 숫자를 모은다."""
    return {
        "invested": s.invested,
        "shares": s.shares,
        "leftover_cash_asset": s.leftover_cash,
        "avg_cost_asset": s.avg_cost_asset,
        "eval_price": s.eval_price,
        "eval_fx": s.eval_fx,
        "value": s.value,
        "return_pct": s.return_pct,
        "xirr_pct": s.xirr_pct,
    }


def _assert_rule_summary(s: engine.Summary, want: dict[str, Any]) -> None:
    """9-8 전략 표 한 줄과 7절 허용 오차로 비교한다. 남은 현금은 leftover_cash × eval_fx(투자 통화)로 본다."""
    assert s.value == pytest.approx(want["value"], abs=1)
    assert s.return_pct == pytest.approx(want["return_pct"], abs=0.01)
    assert s.xirr_pct == pytest.approx(want["xirr_pct"], abs=0.01)
    assert s.avg_cost_asset == pytest.approx(want["avg_cost_asset"], abs=0.01)
    assert s.worst.value == pytest.approx(want["worst_return_pct"], abs=0.01)
    assert s.leftover_cash * s.eval_fx == pytest.approx(want["leftover_cash_invest"], abs=1)


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_simulate_with_rule_reference_case_matches_v2_strategies(rule: str) -> None:
    """9-8 전략 표: 규칙마다 summary가 v2.strategies와 같고, 매수 60번·투자금은 기본 적립과 같다 (9-6)."""
    s = _with_rule(rule).summary
    _assert_rule_summary(s, V2["strategies"][rule])
    assert s.buys == V2["metrics"]["buys"]
    assert (s.first_buy.isoformat(), s.last_buy.isoformat()) == (
        V1_QLD["first_buy"],
        V1_QLD["last_buy"],
    )
    assert s.invested == pytest.approx(V1_QLD["invested"], abs=1)


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_simulate_with_rule_summary_and_daily_equal_simulate_rule(rule: str) -> None:
    """두 함수는 같은 계산 루프를 쓴다 (설계 메모 _run_rule). simulate_rule의 7개 값과 daily가 그대로 같다."""
    sim, strategy = _with_rule(rule), _strategy(rule)
    s = sim.summary
    assert s.value == strategy.value
    assert s.invested == strategy.invested
    assert s.return_pct == strategy.return_pct
    assert s.xirr_pct == strategy.xirr_pct
    assert s.avg_cost_asset == strategy.avg_cost_asset
    assert s.worst.value == strategy.worst_return_pct
    assert s.leftover_cash * s.eval_fx == strategy.leftover_cash_invest
    assert sim.daily == strategy.daily


def test_simulate_with_rule_none_matches_simulate() -> None:
    """rule none은 기본 적립이라 simulate(소수점 매수)와 같다: 매수 60줄, 평단가 $37.9743, 평가금 225,824,590원.
    다른 것은 원화 평단가뿐이다 (결정 d39)."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    basic, got = simulate(asset, fx, _v2_params()), _with_rule("none")
    s, b = got.summary, basic.summary
    assert len(got.buys) == len(basic.buys) == V2["metrics"]["buys"]
    assert (s.buys, s.first_buy, s.last_buy, s.eval_date) == (
        b.buys,
        b.first_buy,
        b.last_buy,
        b.eval_date,
    )
    assert s.listed_after_start is b.listed_after_start is False
    want = _summary_numbers(b)
    for field, value in _summary_numbers(s).items():
        assert value == pytest.approx(want[field], abs=RULE_SUMMARY_TOLERANCE[field]), field
    for got_x, want_x, tolerance in (
        (s.best, b.best, 0.01),
        (s.worst, b.worst, 0.01),
        (s.peak_value, b.peak_value, 1.0),
    ):
        assert got_x.date == want_x.date
        assert got_x.value == pytest.approx(want_x.value, abs=tolerance)
    for row, want_row in zip(got.buys, basic.buys, strict=True):
        assert (row.date, row.price, row.fx) == (want_row.date, want_row.price, want_row.fx)
        assert row.qty == pytest.approx(want_row.qty, abs=1e-4), row.date
        assert row.cum_qty == pytest.approx(want_row.cum_qty, abs=1e-4), row.date
        assert row.avg_cost_asset == pytest.approx(want_row.avg_cost_asset, abs=0.01), row.date
        assert row.invested == pytest.approx(want_row.invested, abs=1), row.date
        assert row.cash == pytest.approx(want_row.cash, abs=0.01), row.date


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_simulate_with_rule_buys_one_row_per_buy_day_ending_at_summary(rule: str) -> None:
    """buys는 매수일(돈을 넣은 날)마다 한 줄이다. 날짜·가격·환율·누적 투자금은 기본 적립(simulate)과 같고,
    마지막 줄의 누적 수량·평단가·남은 현금이 summary와 맞는다. analyze가 9-4 달러 원가를 이 줄로 센다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    basic = simulate(asset, fx, _v2_params())
    got = _with_rule(rule)
    s = got.summary
    assert len(got.buys) == s.buys == V2["metrics"]["buys"]
    assert [(r.date, r.price, r.fx) for r in got.buys] == [
        (r.date, r.price, r.fx) for r in basic.buys
    ]
    assert [r.invested for r in got.buys] == pytest.approx([r.invested for r in basic.buys], abs=1)
    assert sum(r.qty for r in got.buys) == pytest.approx(s.shares, abs=1e-4)
    last = got.buys[-1]
    assert last.cum_qty == pytest.approx(s.shares, abs=1e-4)
    assert last.avg_cost_asset == pytest.approx(s.avg_cost_asset, abs=0.01)
    assert last.invested == pytest.approx(s.invested, abs=1)
    assert last.cash == pytest.approx(s.leftover_cash, abs=0.01)


def test_simulate_with_rule_switch_rest_days_are_zero_qty_rows() -> None:
    """레버리지 전환에서 쉰 매수일도 줄이 있고 qty는 0이다 (정수 주 모드와 같다). 9-8: 15줄
    (v2.strategies.switch.rule_days). 쉰 날은 보유 수량이 그대로이고 넣은 돈이 현금으로 쌓인다."""
    buys = _with_rule("switch").buys
    rests = [i for i, row in enumerate(buys) if row.qty == 0]
    assert len(rests) == V2["strategies"]["switch"]["rule_days"]
    for i in rests:
        if i == 0:
            continue
        assert buys[i].cum_qty == buys[i - 1].cum_qty, buys[i].date
        assert buys[i].cash > buys[i - 1].cash, buys[i].date


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_simulate_with_rule_avg_cost_invest_is_none(rule: str) -> None:
    """결정 d39: 규칙 매수에는 평단가(투자 통화)가 없다. summary와 buys 모두 None."""
    got = _with_rule(rule)
    assert got.summary.avg_cost_invest is None
    assert [row.avg_cost_invest for row in got.buys] == [None] * len(got.buys)


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_simulate_with_rule_whole_shares_flag_is_ignored(rule: str) -> None:
    """9-6, 결정 d28: 규칙 매수는 소수점 매수로 계산하고 p.fractional은 보지 않는다."""
    assert _with_rule(rule, fractional=False) == _with_rule(rule)


def test_simulate_with_rule_switch_cross_exchange_matches_v2_reference() -> None:
    """9-8 다른 거래소 레버리지 전환 (결정 d29): 005930.KS를 QQQ 200일선으로, 원화. 평가금 298,106,846원,
    +148.42%, XIRR 37.64%, 평단가 76,241.12원. 쉰 매수일 14줄은 qty 0이다."""
    want = V2["switch_cross_exchange"]
    asset, ref = load_series("005930.KS"), load_series(V2["switch_ref"])
    got = engine.simulate_with_rule(asset, None, ref, _v2_params(), "switch", ma_days=V2["ma_days"])
    _assert_rule_summary(got.summary, want)
    assert len(got.buys) == got.summary.buys
    assert sum(1 for row in got.buys if row.qty == 0) == want["rule_days"]


@pytest.mark.parametrize("rule", BACKTEST_RULES, ids=BACKTEST_RULES)
def test_analyze_rule_result_fx_effect_matches_v2_metrics(rule: str) -> None:
    """9-4: 환율 효과(−746,367원)와 평균 매수 환율(1,352.57원)은 매수 방식과 상관없다. 쉰 날도 넣은 돈은
    그날 환율로 바꿨으니 buys 줄로 센다. 주가 효과 + 환율 효과 = 그 규칙의 손익."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    params = _v2_params()
    sim = _with_rule(rule)
    a = analyze(sim, asset, fx, params.end, tax_fx=1.0)
    assert a.fx_effect == pytest.approx(V2["metrics"]["fx_effect"], abs=1)
    assert a.avg_buy_fx == pytest.approx(V2["metrics"]["avg_buy_fx"], abs=0.01)
    assert a.price_effect + a.fx_effect == pytest.approx(sim.summary.profit, abs=1)


def test_simulate_with_rule_lump_sum_raises_value_error() -> None:
    """F-17에 일시금은 없다 (전략 비교 전용). 호출 계약 위반이라 데이터 오류(EngineError)가 아니다."""
    with pytest.raises(ValueError) as excinfo:  # noqa: PT011 - 메시지는 설계에 없다
        _with_rule("lump_sum")
    assert not isinstance(excinfo.value, EngineError)


def test_simulate_with_rule_unknown_rule_raises_value_error() -> None:
    """검사 순서와 메시지는 simulate_rule 그대로다 (설계 메모 _run_rule)."""
    with pytest.raises(ValueError, match="알 수 없는 전략"):
        _with_rule("dca_x")


def test_simulate_with_rule_switch_without_reference_raises_value_error() -> None:
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    with pytest.raises(ValueError, match="기준 종목"):
        engine.simulate_with_rule(asset, fx, None, _v2_params(), "switch", ma_days=V2["ma_days"])


def test_simulate_with_rule_without_buy_days_in_period_raises_engine_error() -> None:
    with pytest.raises(EngineError, match="매수일"):
        _with_rule("ma_dip", start=date(2030, 1, 1), end=date(2030, 2, 1))


def test_simulate_with_rule_fx_starting_after_first_buy_raises_engine_error() -> None:
    """환율이 2024년부터만 있으면 첫 매수일(2021-12-01)에 환율이 없다 (3절)."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    cut = next(i for i, d in enumerate(fx.dates) if d >= date(2024, 1, 1))
    short_fx = Series(fx.symbol, fx.currency, fx.dates[cut:], fx.close[cut:])
    with pytest.raises(EngineError, match="환율"):
        engine.simulate_with_rule(asset, short_fx, None, _v2_params(), "ma_dip", ma_days=200)


def test_simulate_with_rule_listed_after_start_is_flagged() -> None:
    """종목 데이터가 시작일보다 늦게 시작하면 listed_after_start다 (simulate와 같은 뜻, main의 listed_from)."""
    got = _with_rule("ma_dip", start=date(2020, 1, 1))
    assert got.summary.listed_after_start is True
    assert got.summary.first_buy >= load_series("QLD").dates[0]


# ---------- 이슈 #62: 매수 내역 두 열, 산 매수만 세는 싸게 산 횟수 (F-14·F-16, 9-1, 결정 d58·d59) ----------

# 9-8 매수 내역 1·14·60회(buys[0]·[13]·[59])의 그날 수익률·이 회차 지금. 날짜 키 순서가 회차 순서다
BUY_ROWS: dict[str, dict[str, float]] = V2["buy_rows"]
BUY_ROW_INDEXES = (0, 13, 59)
# 9-8 매수 규칙 결과의 산 횟수(qty > 0인 매수일 수)와 싸게 산 횟수
RULE_BOUGHT: dict[str, dict[str, int]] = V2["rule_bought"]
# 7절 "월15일 수수료 0.25%" 사례의 수수료 (비율 0.0025)
FEE: float = next(c for c in EXPECTED["cases"] if CASE_IDS[c["name"]] == "monthly15-krw2m-fee0.25")[
    "fee"
]
# 7절 매일 10만원 사례의 주기·금액. 9-8 기간에 넣으면 마지막 거래일 2026-11-23이 매수일이다
DAILY_BUY: dict[str, Any] = {
    "freq": DAILY_CASE["freq"],
    "anchor": DAILY_CASE["anchor"],
    "amount": float(DAILY_CASE["amount"]),
}


def _basic(**changes: Any) -> engine.SimResult:
    """9-8 조건(QLD, 원화)을 기본 적립(simulate)으로. changes로 Params 항목을 바꾼다."""
    result: engine.SimResult = _run("QLD", _v2_params(**changes))
    return result


# 9-8 조건을 매수 방식마다 계산한다. 이 회차 지금이 매수 방식과 상관없이 같은 식인지 볼 때 쓴다
BUY_METHODS: dict[str, Callable[..., engine.SimResult]] = {
    "fractional": _basic,
    "whole-shares": lambda **changes: _basic(fractional=False, **changes),
    "ma-dip": lambda **changes: _with_rule("ma_dip", **changes),
    "ma-hot": lambda **changes: _with_rule("ma_hot", **changes),
    "switch": lambda **changes: _with_rule("switch", **changes),
}
# 그날 수익률이 같은 날 daily 값인지 볼 결과. 남은 현금(정수 주·매수 규칙)과 쉰 날, 마지막 거래일 매수를 넣는다
RETURN_PCT_CASES: dict[str, Callable[[], engine.SimResult]] = {
    "monthly-fractional": _basic,
    "monthly-fee0.25": lambda: _basic(fee=FEE),
    "monthly-switch": lambda: _with_rule("switch"),
    "daily-fractional": lambda: _basic(**DAILY_BUY),
    "daily-whole-shares": lambda: _basic(fractional=False, **DAILY_BUY),
    "daily-ma-dip": lambda: _with_rule("ma_dip", **DAILY_BUY),
}
LAST_DAY_BUY_CASES = [case for case in RETURN_PCT_CASES if case.startswith("daily-")]

# 정수 주만 매월 1일 100원, 1~2월 150원·3~6월 400원 (손으로 셀 수 있는 사례). 1월 2일(현금 100원)과
# 3~5월(150·250·350원)은 한 주 값이 모자라 사지 않는다. 2월 1일 150원·6월 3일 400원에 한 주씩 사서
# 평단가 275원, 평가 가격 400원이다. 1월 2일은 둘보다 싸지만 사지 않은 날이다
STEP_DAYS = _weekdays(date(2024, 1, 1), date(2024, 6, 28), frozenset({date(2024, 1, 1)}))
STEP = Series("STEP", "KRW", STEP_DAYS, [150.0 if d.month <= 2 else 400.0 for d in STEP_DAYS])
STEP_PARAMS = Params(
    date(2024, 1, 1), date(2024, 6, 28), "monthly", 1, 100.0, "KRW", fractional=False
)


# 9-8 기준값


@pytest.mark.parametrize(
    "method", ["simulate", "with-rule-none"], ids=["simulate", "with-rule-none"]
)
def test_buy_rows_reference_case_return_and_lot_return_match_v2_buy_rows(method: str) -> None:
    """9-8 매수 내역 두 열 (결정 d59): 1회 2021-12-01 0.00% / +93.09%, 14회 2023-01-03 −33.54% / +340.54%,
    60회 2026-11-02 +107.23% / −9.19% (±0.01%p). 기본 적립은 simulate와 simulate_with_rule(none)이 같다."""
    result = _basic() if method == "simulate" else _with_rule("none")
    assert [result.buys[k].date.isoformat() for k in BUY_ROW_INDEXES] == list(BUY_ROWS)
    for k in BUY_ROW_INDEXES:
        row = result.buys[k]
        want = BUY_ROWS[row.date.isoformat()]
        assert row.return_pct == pytest.approx(want["return_pct"], abs=0.01), row.date
        assert row.lot_return_pct == pytest.approx(want["lot_return_pct"], abs=0.01), row.date


# 그날 수익률 (9-1, 5절)


@pytest.mark.parametrize("case", list(RETURN_PCT_CASES), ids=list(RETURN_PCT_CASES))
def test_buy_rows_return_pct_equals_daily_return_pct_on_buy_day(case: str) -> None:
    """9-1 그날 수익률 = 그 매수일의 수익률 추이 값 (5절, 결정 d59). 새 공식이 아니라 같은 날 daily 값이라
    정수 주·매수 규칙의 남은 현금도 들어가고, 쉰 날(qty 0)에도 값이 있다."""
    result = RETURN_PCT_CASES[case]()
    daily = {row.date: row.return_pct for row in result.daily}
    for row in result.buys:
        assert row.return_pct == pytest.approx(daily[row.date], abs=1e-6), row.date


@pytest.mark.parametrize("case", LAST_DAY_BUY_CASES, ids=LAST_DAY_BUY_CASES)
def test_buy_rows_last_trading_day_buy_return_pct_is_revalued_at_eval_fx(case: str) -> None:
    """매일 매수면 마지막 거래일 2026-11-23이 매수일이다. 그날 수익률은 평가 환율(끝날짜 11-24 기준)로 다시
    평가한 값이라 daily 마지막 값·summary.return_pct와 같다 (5절 끝). 그날 환율로 평가하면 약 0.02%p 다르다."""
    result = RETURN_PCT_CASES[case]()
    last = result.buys[-1]
    assert last.date == result.daily[-1].date == result.summary.eval_date
    # 이 테스트가 가려내는지: 마지막 매수일의 환율과 평가 환율이 다르다
    assert engine.rate_on(load_series("USDKRW=X"), last.date) != result.summary.eval_fx
    assert last.return_pct == pytest.approx(result.daily[-1].return_pct, abs=1e-6)
    assert last.return_pct == pytest.approx(result.summary.return_pct, abs=1e-6)


# 이 회차 지금 (9-1)


@pytest.mark.parametrize("method", list(BUY_METHODS), ids=list(BUY_METHODS))
def test_buy_rows_lot_return_with_fee_is_one_minus_fee_times_without_fee(method: str) -> None:
    """9-1 이 회차 지금 (결정 d59): 그날 산 몫의 원가가 매수 가격 × 매수 환율 ÷ (1 − f)라서, 수수료 0.25%면
    같은 회차의 (1 + 이 회차 지금)이 수수료 0일 때의 (1 − 0.0025)배다. 정수 주·매수 규칙도 같은 식이다.
    두 결과에서 모두 산 회차만 비교한다."""
    run = BUY_METHODS[method]
    base, with_fee = run(), run(fee=FEE)
    assert [row.date for row in base.buys] == [row.date for row in with_fee.buys]
    pairs = [
        (b, f) for b, f in zip(base.buys, with_fee.buys, strict=True) if b.qty > 0 and f.qty > 0
    ]
    assert pairs
    for b, f in pairs:
        assert b.lot_return_pct is not None, b.date
        assert f.lot_return_pct is not None, b.date
        want = (1 + b.lot_return_pct / 100) * (1 - FEE)
        assert 1 + f.lot_return_pct / 100 == pytest.approx(want, abs=1e-4), b.date


@pytest.mark.parametrize(
    "method",
    [m for m in BUY_METHODS if m != "fractional"],
    ids=[m for m in BUY_METHODS if m != "fractional"],
)
def test_buy_rows_lot_return_on_bought_day_is_same_across_buy_methods(method: str) -> None:
    """이 회차 지금은 그날 가격·환율, 평가 가격·환율, 수수료로만 정해진다 (9-1). 정수 주·매수 규칙에서 산
    회차는 같은 날 기본 적립(소수점) 회차와 값이 같다. 앞서 모은 현금으로 산 몫도 그 매수일의 환율로 본다."""
    basic = {row.date: row.lot_return_pct for row in _basic().buys}
    bought = [row for row in BUY_METHODS[method]().buys if row.qty > 0]
    assert bought
    for row in bought:
        assert row.lot_return_pct == pytest.approx(basic[row.date], abs=1e-6), row.date


def test_buy_rows_switch_rest_days_have_no_lot_return() -> None:
    """레버리지 전환에서 쉰 15줄(qty 0)은 이 회차 지금이 None이고 산 45줄은 값이 있다 (9-1, 결정 d59).
    쉰 줄의 그날 수익률은 값이 있다 (위 daily 테스트의 monthly-switch)."""
    buys = _with_rule("switch").buys
    assert [row.lot_return_pct is None for row in buys] == [row.qty == 0 for row in buys]
    assert sum(1 for row in buys if row.qty == 0) == V2["strategies"]["switch"]["rule_days"]
    bought = sum(1 for row in buys if row.lot_return_pct is not None)
    assert bought == RULE_BOUGHT["switch"]["bought"]


def test_buy_rows_whole_shares_unaffordable_days_have_no_lot_return() -> None:
    """정수 주만 매일 10만원이면 QLD 한 주 값이 모자라 사지 않은 날(qty 0)이 있다. 그날은 이 회차 지금이
    None이고, 산 날은 값이 있다."""
    buys = _basic(fractional=False, **DAILY_BUY).buys
    assert any(row.qty == 0 for row in buys)  # 이 테스트가 가려내는지: 못 산 날이 있다
    assert [row.lot_return_pct is None for row in buys] == [row.qty == 0 for row in buys]


def test_buy_rows_whole_shares_step_prices_lot_return_only_on_bought_days() -> None:
    """손으로 센 사례 (STEP): 못 산 1월·3~5월은 None, 2월 1일(150원에 사서 지금 400원)은 +166.67%, 6월 3일
    (400원에 사서 지금 400원)은 0%다. 수수료 0이라 (1 − f)는 1이다."""
    buys = simulate(STEP, None, STEP_PARAMS).buys
    assert [row.qty for row in buys] == [0, 1, 0, 0, 0, 1]
    assert [row.lot_return_pct for row in buys] == [
        None,
        pytest.approx(166.67, abs=0.01),
        None,
        None,
        None,
        pytest.approx(0.0, abs=0.01),
    ]


# 싸게 산 횟수 (9-1, 결정 d58)


def test_analyze_whole_shares_zero_qty_days_are_not_counted_as_cheap_buys() -> None:
    """9-1: 산 수량이 0인 매수일은 싸게 산 횟수에 세지 않는다. STEP의 1월 2일(150원)은 평가 가격 400원과
    평단가 275원보다 싸지만 사지 않았으니 빠지고, 2월 1일 한 번만 센다 (산 2번 중 1번·1번)."""
    result = simulate(STEP, None, STEP_PARAMS)
    assert (result.summary.avg_cost_asset, result.summary.eval_price) == (275.0, 400.0)
    a = analyze(result, STEP, None, STEP_PARAMS.end, tax_fx=1.0)
    assert (a.buys_below_eval_price, a.buys_below_avg_cost) == (1, 1)


@pytest.mark.parametrize("rule", list(RULE_BOUGHT), ids=list(RULE_BOUGHT))
def test_analyze_rule_result_buy_counts_skip_zero_qty_days_match_v2_rule_bought(rule: str) -> None:
    """9-8 (결정 d58): 이평선 아래 2배·위 절반은 60번 중 51번·22번, 과열 때 절반은 51번·23번, 레버리지 전환은
    쉰 15번을 빼고 산 45번 중 36번·12번이다. 산 횟수는 qty가 0보다 큰 buys 줄 수다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    sim = _with_rule(rule)
    a = analyze(sim, asset, fx, _v2_params().end, tax_fx=1.0)
    want = RULE_BOUGHT[rule]
    assert sum(1 for row in sim.buys if row.qty > 0) == want["bought"]
    assert (a.buys_below_eval_price, a.buys_below_avg_cost) == (
        want["buys_below_eval_price"],
        want["buys_below_avg_cost"],
    )


def test_analyze_rule_none_buy_counts_stay_v2_metrics() -> None:
    """기본 적립은 쉰 날이 없어 simulate_with_rule(none)도 v2.metrics 그대로 60번 중 51번·24번이다."""
    asset, fx = load_series("QLD"), load_series("USDKRW=X")
    a = analyze(_with_rule("none"), asset, fx, _v2_params().end, tax_fx=1.0)
    m = V2["metrics"]
    assert (a.buys_below_eval_price, a.buys_below_avg_cost) == (
        m["buys_below_eval_price"],
        m["buys_below_avg_cost"],
    )
