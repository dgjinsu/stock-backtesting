"""HTTP 진입점: 라우트, 입력 검사, market → engine 이어 붙이기, web/ 정적 파일 제공.

python -m src.main          # 서버 켜기 (HOST, PORT 환경변수)
python -m src.main --open   # 켜고 준비되면 브라우저 열기
"""

import asyncio
import bisect
import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from src import engine
from src.market import Market, MarketError, PriceHistory
from src.schemas import (
    FIELD_MESSAGES,
    AnalysisOut,
    BacktestRequest,
    BacktestResponse,
    BuyOut,
    ChartOut,
    ChartSeriesOut,
    Conditions,
    DailyOut,
    DrawdownOut,
    Extreme,
    FieldError,
    Peak,
    ResultOut,
    SearchHitOut,
    StaleKind,
    StaleSourceOut,
    StrategiesOut,
    StrategyChartOut,
    StrategyChartSeriesOut,
    StrategyOut,
    StrategyRequest,
    StrategyResponse,
    StrategyResultOut,
    SummaryOut,
    SwitchRefOut,
    SymbolError,
    UnderwaterOut,
    YearOut,
)

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
KST = timezone(timedelta(hours=9))  # "오늘"은 한국 날짜로 본다

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Settings:
    """서버 설정. 기본값은 로컬 실행 기준이다 (아키텍처 5절)."""

    host: str = "127.0.0.1"
    port: int = 8010
    data_dir: Path = Path("data")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        """환경변수에서 설정을 읽는다. PORT가 1~65535 숫자가 아니면 ValueError."""
        port_text = env.get("PORT", "8010")
        if not port_text.isdecimal() or not 0 < int(port_text) < 65536:
            raise ValueError(f"PORT는 1~65535 사이 숫자여야 합니다: {port_text!r}")
        return cls(
            host=env.get("HOST", "127.0.0.1"),
            port=int(port_text),
            data_dir=Path(env.get("DATA_DIR", "data")),
        )

    def resolved_data_dir(self) -> Path:
        """상대 경로면 저장소 폴더 기준으로 바꾼다. 어디서 켜도 같은 캐시를 쓴다."""
        return self.data_dir if self.data_dir.is_absolute() else ROOT / self.data_dir


class InputError(Exception):
    """항목끼리 맞지 않는 입력. 422로 돌려준다."""

    def __init__(self, errors: list[FieldError]) -> None:
        super().__init__(errors)
        self.errors = errors


def today_kst() -> date:
    """한국 날짜로 오늘."""
    return datetime.now(UTC).astimezone(KST).date()


# ---------- 입력 검사 ----------


def _anchor_for(request: Conditions) -> int | None:
    """주기에 맞는 매수 기준일. 비어 있으면 매주 월요일, 매월 1일 (범위는 _check_request가 본다)."""
    if request.freq == "daily":
        return None
    if request.anchor is not None:
        return request.anchor
    return 0 if request.freq == "weekly" else 1


def _check_request(request: Conditions, today: date) -> list[FieldError]:
    """항목끼리 맞춰 보는 검사. 틀린 것을 모두 모아 돌려준다."""
    errors: list[FieldError] = []
    anchor = _anchor_for(request)
    if request.freq == "weekly" and anchor is not None and not 0 <= anchor <= 4:
        errors.append(
            FieldError(field="anchor", message="매주 매수 요일은 0(월)~4(금) 중 하나입니다")
        )
    if request.freq == "monthly" and anchor is not None and not 1 <= anchor <= 31:
        errors.append(FieldError(field="anchor", message="매월 매수 날짜는 1~31 중 하나입니다"))
    if request.start >= request.end:
        errors.append(FieldError(field="start", message="시작일은 끝날짜보다 앞이어야 합니다"))
    if request.end > today:
        errors.append(
            FieldError(
                field="end", message=f"끝날짜는 오늘({today.isoformat()})보다 늦을 수 없습니다"
            )
        )
    return errors


def _to_params(request: Conditions, today: date) -> engine.Params:
    """항목끼리 맞춰 보고(틀리면 InputError) 엔진 조건을 만든다. 두 요청이 같이 쓴다."""
    problems = _check_request(request, today)
    if problems:
        raise InputError(problems)
    return engine.Params(
        start=request.start,
        end=request.end,
        freq=request.freq,
        anchor=_anchor_for(request),
        amount=request.amount,
        currency=request.currency,
        fractional=request.fractional,
        fee=request.fee_pct / 100,
    )


def _validation_errors(exc: RequestValidationError) -> list[FieldError]:
    details: list[FieldError] = []
    for error in exc.errors():
        location = [part for part in error.get("loc", ()) if part not in ("body", "query", "path")]
        field = str(location[0]) if location else "body"
        if error.get("type") == "value_error":
            message = str(error.get("ctx", {}).get("error", "입력값이 올바르지 않습니다"))
        elif field == "symbols" and len(location) > 1:
            message = "종목 코드는 문자열로 넣어 주세요"
        else:
            message = FIELD_MESSAGES.get(field, "요청 형식이 올바르지 않습니다")
        details.append(FieldError(field=field, message=message))
    return details


# ---------- 반올림 (응답을 만들 때 한 번) ----------


def _money(value: float, currency: str) -> float:
    return round(value, 0 if currency == "KRW" else 2)


def _maybe(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def _maybe_money(value: float | None, currency: str) -> float | None:
    return None if value is None else _money(value, currency)


def _pct(value: float) -> float:
    """% 값을 소수 2자리로. 첫 매수일처럼 −1e-14 같은 값이 −0.0으로 나가지 않게 0.0으로 맞춘다."""
    return round(value, 2) + 0.0


def _fx(value: float) -> float:
    """환율은 유효숫자 6자리. KRWUSD=X(약 0.000744)처럼 작은 환율도 0이 되지 않는다."""
    return float(f"{value:.6g}")


def _summary_out(
    s: engine.Summary, a: engine.Analysis, invest: str, asset: str, *, tax: bool
) -> SummaryOut:
    deepest, longest = a.max_drawdown, a.longest_underwater
    return SummaryOut(
        buys=s.buys,
        first_buy=s.first_buy,
        last_buy=s.last_buy,
        invested=_money(s.invested, invest),
        shares=round(s.shares, 4),
        leftover_cash=_money(s.leftover_cash, asset),
        avg_cost_asset=_maybe(s.avg_cost_asset, 4),
        avg_cost_invest=_maybe_money(s.avg_cost_invest, invest),
        eval_date=s.eval_date,
        eval_price=round(s.eval_price, 4),
        eval_fx=_fx(s.eval_fx),
        value=_money(s.value, invest),
        profit=_money(s.profit, invest),
        return_pct=round(s.return_pct, 2),
        xirr_pct=_maybe(s.xirr_pct, 2),
        best=Extreme(date=s.best.date, return_pct=round(s.best.value, 2)),
        worst=Extreme(date=s.worst.date, return_pct=round(s.worst.value, 2)),
        peak_value=Peak(date=s.peak_value.date, value=_money(s.peak_value.value, invest)),
        from_peak_pct=round(s.from_peak_pct, 2),
        max_drawdown=None
        if deepest is None
        else DrawdownOut(date=deepest.date, pct=round(deepest.value, 2)),
        underwater_days=a.underwater_days,
        trading_days=a.trading_days,
        underwater_pct=round(a.underwater_pct, 2),
        longest_underwater=None
        if longest is None
        else UnderwaterOut(days=longest.days, start=longest.start, recovered=longest.recovered),
        last_underwater=a.last_underwater,
        price_effect=_money(a.price_effect, invest),
        fx_effect=_money(a.fx_effect, invest),
        avg_buy_fx=None if a.avg_buy_fx is None else _fx(a.avg_buy_fx),
        tax=_money(a.tax, invest) if tax else None,
        profit_after_tax=_money(a.profit_after_tax, invest) if tax else None,
    )


def _analysis_out(a: engine.Analysis) -> AnalysisOut:
    """9-1·9-2·9-3 분석을 응답 자리수로 반올림한다. 엔진이 오름차순으로 주므로 그 순서대로 넣는다."""
    return AnalysisOut(
        years={
            str(y.year): YearOut(
                return_pct=round(y.return_pct, 2), price_change_pct=_maybe(y.price_change_pct, 2)
            )
            for y in a.years
        },
        months={m.month: round(m.return_pct, 2) for m in a.months},
        buys_below_eval_price=a.buys_below_eval_price,
        buys_below_avg_cost=a.buys_below_avg_cost,
    )


def _split_notes(history: PriceHistory, start: date) -> list[str]:
    """시작일 뒤의 분할 안내. 끝날짜 뒤의 분할도 가격·수량에 반영돼 있어 같이 적는다."""
    return [f"{day.isoformat()} {ratio} 분할 반영" for day, ratio in history.splits if day >= start]


def _date_on_or_before(dates: Sequence[date], day: date) -> date | None:
    """day 당일 또는 그 이전 마지막 날짜. 없으면 None. dates는 오름차순이다."""
    i = bisect.bisect_right(dates, day)
    return dates[i - 1] if i else None


def _stale_sources(
    history: PriceHistory,
    fx_history: PriceHistory | None,
    won_history: PriceHistory | None,
    end: date,
) -> list[StaleSourceOut]:
    """그 종목 계산에 저장본으로 쓴 코드들 (F-10). price, fx, tax_fx 순이고 안 쓰거나 새로 받은 것은 뺀다.

    기준일은 끝날짜 당일 또는 그 이전 마지막 거래일이다. 계산이 끝났다면 엔진이 그 날을 이미 찾았으니
    없으면 코드 버그다.
    """
    sources: list[StaleSourceOut] = []
    used: tuple[tuple[PriceHistory | None, StaleKind], ...] = (
        (history, "price"),
        (fx_history, "fx"),
        (won_history, "tax_fx"),
    )
    for h, kind in used:
        if h is None or not h.stale:
            continue
        through = _date_on_or_before(h.dates, end)
        if through is None:
            raise RuntimeError(f"{h.symbol}: 끝날짜 {end} 이전 날짜가 없는데 계산이 끝났다")
        sources.append(StaleSourceOut(symbol=h.symbol, kind=kind, data_through=through))
    return sources


def _result_out(
    history: PriceHistory,
    sim: engine.SimResult,
    analysis: engine.Analysis,
    params: engine.Params,
    stale_sources: list[StaleSourceOut],
    switch_ref: SwitchRefOut | None,
    *,
    tax: bool,
    include_daily: bool,
) -> ResultOut:
    invest, asset = params.currency, history.currency
    return ResultOut(
        symbol=history.symbol,
        name=history.name,
        currency=asset,
        notes=_split_notes(history, params.start),
        data_through=sim.summary.eval_date,
        stale=bool(stale_sources),
        stale_sources=stale_sources,
        listed_from=history.dates[0] if sim.summary.listed_after_start else None,
        switch_ref=switch_ref,
        summary=_summary_out(sim.summary, analysis, invest, asset, tax=tax),
        analysis=_analysis_out(analysis),
        buys=[
            BuyOut(
                date=b.date,
                price=round(b.price, 4),
                fx=_fx(b.fx),
                qty=round(b.qty, 4),
                cum_qty=round(b.cum_qty, 4),
                avg_cost_asset=_maybe(b.avg_cost_asset, 4),
                avg_cost_invest=_maybe_money(b.avg_cost_invest, invest),
                invested=_money(b.invested, invest),
                return_pct=_pct(b.return_pct),
                lot_return_pct=None if b.lot_return_pct is None else _pct(b.lot_return_pct),
            )
            for b in sim.buys
        ],
        daily=_daily_out(sim.daily, invest) if include_daily else None,
    )


def _daily_out(rows: Sequence[engine.DailyRow], invest: str) -> DailyOut:
    """줄이지 않은 날마다 평가를 그래프와 같은 자리수로 반올림한다 (결정 d60, 계산 규칙 5절 끝)."""
    return DailyOut(
        dates=[row.date for row in rows],
        value=[_money(row.value, invest) for row in rows],
        invested=[_money(row.invested, invest) for row in rows],
        return_pct=[_pct(row.return_pct) for row in rows],
    )


def _chart_out(chart: engine.Chart, invest: str) -> ChartOut:
    def money(values: list[float | None]) -> list[float | None]:
        return [_maybe_money(v, invest) for v in values]

    def digits(values: list[float | None], n: int) -> list[float | None]:
        return [_maybe(v, n) for v in values]

    return ChartOut(
        dates=chart.dates,
        series={
            symbol: ChartSeriesOut(
                value=money(s.value),
                invested=money(s.invested),
                return_pct=digits(s.return_pct, 2),
                price=digits(s.price, 4),
                avg_cost=digits(s.avg_cost, 4),
                drawdown=digits(s.drawdown, 2),
            )
            for symbol, s in chart.series.items()
        },
        total_days=chart.total_days,
    )


def _strategy_out(result: engine.StrategyResult, invest: str) -> StrategyOut:
    """전략 하나를 응답 자리수로 반올림한다 (계산 규칙 5절 끝)."""
    return StrategyOut(
        value=_money(result.value, invest),
        invested=_money(result.invested, invest),
        return_pct=round(result.return_pct, 2),
        xirr_pct=_maybe(result.xirr_pct, 2),
        avg_cost_asset=_maybe(result.avg_cost_asset, 4),
        worst_return_pct=round(result.worst_return_pct, 2),
        leftover_cash_invest=_money(result.leftover_cash_invest, invest),
        rule_days=result.rule_days,
    )


def _strategy_chart_out(chart: engine.StrategyChart, invest: str) -> StrategyChartOut:
    """전략 그래프를 응답 자리수로 반올림한다 (계산 규칙 5절 끝)."""
    return StrategyChartOut(
        dates=chart.dates,
        series={
            rule: StrategyChartSeriesOut(
                value=[_money(v, invest) for v in s.value],
                invested=[_money(v, invest) for v in s.invested],
                return_pct=[round(v, 2) for v in s.return_pct],
            )
            for rule, s in chart.series.items()
        },
        total_days=chart.total_days,
    )


# ---------- 계산하기 ----------


def _to_series(history: PriceHistory) -> engine.Series:
    return engine.Series(
        history.symbol,
        history.currency,
        history.dates,
        history.close,
        exchange_tz=history.exchange_tz,
    )


class FxError(MarketError):
    """종목은 받았지만 그 종목의 환율을 받지 못했다."""


def _series_task(
    market: Market, code: str, tasks: dict[str, "asyncio.Task[PriceHistory]"]
) -> "asyncio.Task[PriceHistory]":
    """코드 하나를 받는 작업. 요청 하나에서 같은 코드(종목·환율·기준 종목)는 작업 하나를 나눠 기다린다.

    실패해도 한 번만 부른다.
    """
    if code not in tasks:
        tasks[code] = asyncio.create_task(market.get_series(code))
    return tasks[code]


async def _fetch(
    market: Market,
    symbol: str,
    currency: str,
    tasks: dict[str, "asyncio.Task[PriceHistory]"],
) -> tuple[PriceHistory, PriceHistory | None]:
    """종목 하나와 (필요하면) 그 종목의 환율을 이어서 받는다. 종목끼리는 겹쳐서 받는다."""
    history = await asyncio.shield(_series_task(market, symbol, tasks))
    if history.currency == currency:
        return history, None
    return history, await _fetch_fx(market, f"{history.currency}{currency}=X", tasks)


async def _fetch_fx(
    market: Market, pair: str, tasks: dict[str, "asyncio.Task[PriceHistory]"]
) -> PriceHistory:
    """환율 하나. 받지 못하면 FxError ("{pair} 환율을 받지 못해 계산하지 못했습니다.")."""
    try:
        return await asyncio.shield(_series_task(market, pair, tasks))
    except MarketError as error:
        raise FxError(f"{pair} 환율을 받지 못해 계산하지 못했습니다.") from error


async def _fetch_with_tax_fx(
    market: Market,
    symbol: str,
    request: BacktestRequest,
    tasks: dict[str, "asyncio.Task[PriceHistory]"],
) -> tuple[PriceHistory, PriceHistory | None, PriceHistory | None]:
    """_fetch에 더해, 9-5 양도세에 원화 환율이 필요한 종목이면 {투자통화}KRW=X도 받는다.

    필요한 때: tax가 켜졌고, 투자 통화가 원화가 아니고, 종목 통화도 원화가 아니다 (한국 종목은 세금 0).
    tasks를 _fetch와 같이 써서 요청 하나에 한 번만 받는다. 받지 못하면 FxError (결정 d40).
    """
    history, fx_history = await _fetch(market, symbol, request.currency, tasks)
    if not request.tax or request.currency == "KRW" or history.currency == "KRW":
        return history, fx_history, None
    won = await _fetch_fx(market, f"{request.currency}KRW=X", tasks)
    return history, fx_history, won


def _switch_ref_out(
    code: str, asset: engine.Series, ref: engine.Series, stale: bool, *, end: date
) -> SwitchRefOut:
    """레버리지 전환의 기준 종목. basis는 engine.same_exchange로만 정한다 (결정 d29). 두 API가 같이 쓴다.

    data_through는 기준 종목의 끝날짜 당일 또는 그 이전 마지막 거래일이다 (결정 d45).
    """
    return SwitchRefOut(
        symbol=code,
        basis="same_day" if engine.same_exchange(asset, ref) else "previous_day",
        stale=stale,
        data_through=_date_on_or_before(ref.dates, end),
    )


async def run_backtest(market: Market, request: BacktestRequest, today: date) -> BacktestResponse:
    """종목과 환율을 받고(동시에), 종목마다 계산하고, 그래프 날짜축을 맞춘다 (아키텍처 1절).

    엔진에는 끝날짜로 자르지 않은 전체 데이터를 넘긴다 (결정 d32). tax가 켜진 달러 투자면
    양도세용 USDKRW=X를 요청 하나에 한 번 받는다 (9-5). 매수 규칙(F-17)이 none이 아니면 9-6 같은
    예산 규칙으로 계산하고, switch면 기준 종목을 환율 없이 한 번 받는다. 기준 종목을 받지 못하면 모든
    종목이 그 규칙으로 계산할 수 없으니 종목마다 오류다.
    """
    params = _to_params(request, today)
    tasks: dict[str, asyncio.Task[PriceHistory]] = {}
    # 기준 종목이 요청 종목이면 그 종목의 _fetch가 같은 작업을 기다린다 (따로 부르지 않는다)
    ref_task = _series_task(market, request.switch_ref, tasks) if request.rule == "switch" else None
    fetched = await asyncio.gather(
        *(_fetch_with_tax_fx(market, s, request, tasks) for s in request.symbols),
        return_exceptions=True,
    )
    ref: engine.Series | None = None
    ref_stale = False
    ref_error: str | None = None
    if ref_task is not None:
        try:
            ref_history = await asyncio.shield(ref_task)
        except MarketError:
            ref_error = f"기준 종목 {request.switch_ref}를 받지 못해 계산하지 못했습니다."
        else:
            ref, ref_stale = _to_series(ref_history), ref_history.stale

    results: list[ResultOut] = []
    errors: list[SymbolError] = []
    simulated: dict[str, engine.SimResult] = {}
    for symbol, outcome in zip(request.symbols, fetched, strict=True):
        if isinstance(outcome, MarketError):  # FxError 포함: 그 종목만 실패
            errors.append(SymbolError(symbol=symbol, message=str(outcome)))
            continue
        if isinstance(outcome, BaseException):
            raise outcome
        if ref_error is not None:
            errors.append(SymbolError(symbol=symbol, message=ref_error))
            continue
        history, fx_history, won_history = outcome
        asset = _to_series(history)
        fx = None if fx_history is None else _to_series(fx_history)
        won = None if won_history is None else _to_series(won_history)
        try:
            if request.rule == "none":
                sim = engine.simulate(asset, fx, params)
            else:  # 9-6 소수점 매수로 계산하고 fractional은 보지 않는다
                sim = engine.simulate_with_rule(
                    asset, fx, ref, params, request.rule, request.ma_days
                )
            # 양도세 환율이 필요 없으면(원화 투자, tax 꺼짐, 한국 종목) 세금이 0이거나 응답에서 버리는 값이라 1
            tax_fx = engine.rate_on(won, params.end)
            analysis = engine.analyze(sim, asset, fx, params.end, tax_fx=tax_fx)
        except engine.EngineError as error:  # 데이터 때문에 계산할 수 없음: 기간 안 매수일 없음 등
            errors.append(SymbolError(symbol=symbol, message=str(error)))
            continue
        simulated[symbol] = sim
        stale_sources = _stale_sources(history, fx_history, won_history, params.end)
        switch_ref = (
            None
            if ref is None
            else _switch_ref_out(request.switch_ref, asset, ref, ref_stale, end=params.end)
        )
        results.append(
            _result_out(
                history,
                sim,
                analysis,
                params,
                stale_sources,
                switch_ref,
                tax=request.tax,
                include_daily=request.include_daily,
            )
        )

    return BacktestResponse(
        params=request,
        results=results,
        chart=_chart_out(engine.build_chart(simulated), request.currency),
        errors=errors,
    )


async def _fetch_ref(market: Market, request: StrategyRequest) -> PriceHistory | None:
    """레버리지 전환의 기준 종목. 기준 종목 자신의 종가와 이평선만 보니 환율 없이 받는다.

    종목과 같으면 부르지 않고 None을 돌려준다 (종목의 것을 쓴다).
    """
    if request.switch_ref == request.symbol:
        return None
    return await market.get_series(request.switch_ref)


async def run_strategy(market: Market, request: StrategyRequest, today: date) -> StrategyResponse:
    """종목(+환율)과 기준 종목을 겹쳐 받고 같은 예산 전략 5개를 계산한다 (계산 규칙 9-6).

    전략별 평가금 그래프와 매수일·시작 시점 바꿔 보기(9-7)도 같이 만든다. 엔진에는 시작일·끝날짜로
    자르지 않은 전체 데이터를 넘긴다. 이평선은 시작일 이전 주가를 쓰고(9-6), 진행 중인 달은 데이터 마지막
    날을 보고 판정한다(2절). 기준 종목만 실패하면 레버리지 전환만 빼고 돌려준다 (결정 d31). 전략이나
    시작 시점 바꿔 보기에서 EngineError가 나면 result는 null이고 종목 오류다. 매수일 바꿔 보기는 계산할 수
    없는 기준일만 null이다 (결정 d56).
    """
    params = _to_params(request, today)
    fetched, ref_fetched = await asyncio.gather(
        _fetch(market, request.symbol, request.currency, {}),
        _fetch_ref(market, request),
        return_exceptions=True,
    )
    for outcome in (fetched, ref_fetched):
        if isinstance(outcome, BaseException) and not isinstance(outcome, MarketError):
            raise outcome  # 코드 버그는 숨기지 않는다

    errors: list[SymbolError] = []
    ref_errors: list[SymbolError] = []
    if isinstance(ref_fetched, BaseException):  # MarketError: 기준 종목만 실패
        ref_errors.append(SymbolError(symbol=request.switch_ref, message=str(ref_fetched)))
    if isinstance(fetched, BaseException):  # MarketError (FxError 포함): 종목 실패
        errors.append(SymbolError(symbol=request.symbol, message=str(fetched)))
        return StrategyResponse(params=request, result=None, errors=errors + ref_errors)

    history, fx_history = fetched
    asset = _to_series(history)
    fx = None if fx_history is None else _to_series(fx_history)
    ref: engine.Series | None
    if isinstance(ref_fetched, BaseException):
        ref, ref_stale = None, False
    elif ref_fetched is None:  # 기준 종목이 종목과 같다
        ref, ref_stale = asset, history.stale
    else:
        ref, ref_stale = _to_series(ref_fetched), ref_fetched.stale

    try:
        sims = {
            rule: engine.simulate_rule(asset, fx, ref, params, rule, request.ma_days)
            for rule in engine.RULES
            if rule != "switch" or ref is not None
        }
        # 바꿔 보기(9-7)는 요청의 조건(주기·수수료·소수점 매수) 그대로, 기준 종목 없이 계산한다
        starts = engine.start_sweep(asset, fx, params)
    except engine.EngineError as error:  # 기간 안 매수일 없음 등
        errors.append(SymbolError(symbol=request.symbol, message=str(error)))
        return StrategyResponse(params=request, result=None, errors=errors + ref_errors)
    # 그 기준일로 계산할 수 없으면(그날 환율 없음 등) 그 기준일만 None이다 (결정 d56)
    anchors = engine.anchor_sweep(asset, fx, params)
    chart = engine.build_strategy_chart(list(sims.values()))

    invest = request.currency
    switch = sims.get("switch")
    result = StrategyResultOut(
        symbol=history.symbol,
        name=history.name,
        currency=history.currency,
        notes=_split_notes(history, params.start),
        data_through=sims["none"].daily[-1].date,
        stale=history.stale or (fx_history is not None and fx_history.stale),
        listed_from=history.dates[0] if history.dates[0] > params.start else None,
        switch_ref=None
        if ref is None
        else _switch_ref_out(request.switch_ref, asset, ref, ref_stale, end=params.end),
        strategies=StrategiesOut(
            none=_strategy_out(sims["none"], invest),
            ma_dip=_strategy_out(sims["ma_dip"], invest),
            ma_hot=_strategy_out(sims["ma_hot"], invest),
            switch=None if switch is None else _strategy_out(switch, invest),
            lump_sum=_strategy_out(sims["lump_sum"], invest),
        ),
        chart=_strategy_chart_out(chart, invest),
        anchor_sweep={str(day): _maybe(avg, 4) for day, avg in anchors.items()},
        start_sweep={month: round(pct, 2) for month, pct in starts.items()},
    )
    return StrategyResponse(params=request, result=result, errors=ref_errors)


# ---------- 앱 ----------


def create_app(
    settings: Settings | None = None,
    market: Market | None = None,
    today: Callable[[], date] = today_kst,
) -> FastAPI:
    """API 라우트를 먼저 두고, 남은 경로는 web/ 정적 파일로 넘긴다. 테스트는 market과 today를 넣는다."""
    settings = settings or Settings.from_env(os.environ)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if market is not None:
            app.state.market = market
            yield
            return
        async with httpx.AsyncClient() as client:
            app.state.market = Market(settings.resolved_data_dir(), client)
            yield

    app = FastAPI(title="적립식 백테스트", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def on_invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [d.model_dump() for d in _validation_errors(exc)]
        return JSONResponse(status_code=422, content={"detail": details})

    @app.exception_handler(InputError)
    async def on_input_error(request: Request, exc: InputError) -> JSONResponse:
        return JSONResponse(
            status_code=422, content={"detail": [e.model_dump() for e in exc.errors]}
        )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/backtest")
    async def backtest(request: BacktestRequest) -> BacktestResponse:
        started = time.monotonic()
        response = await run_backtest(app.state.market, request, today())
        logger.info(
            "backtest %s %s: %d개 결과, %d개 실패, %.2fs",
            ",".join(request.symbols),
            request.freq,
            len(response.results),
            len(response.errors),
            time.monotonic() - started,
        )
        return response

    @app.post("/api/strategy")
    async def strategy(request: StrategyRequest) -> StrategyResponse:
        started = time.monotonic()
        response = await run_strategy(app.state.market, request, today())
        result = response.result
        done = 0 if result is None else sum(s is not None for _, s in result.strategies)
        logger.info(
            "strategy %s %s: %d개 전략, %d개 실패, %.2fs",
            request.symbol,
            request.freq,
            done,
            len(response.errors),
            time.monotonic() - started,
        )
        return response

    @app.get("/api/search")
    async def search(q: str = Query("", max_length=50)) -> list[SearchHitOut]:
        try:
            hits = await app.state.market.search(q)
        except MarketError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return [
            SearchHitOut(symbol=h.symbol, name=h.name, exchange=h.exchange, type=h.type)
            for h in hits
        ]

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()


def _open_browser_when_ready(url: str, timeout_s: float = 30.0) -> None:
    """서버가 /healthz에 답하면 브라우저를 연다. 시간 안에 안 뜨면 그냥 끝낸다."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}healthz", timeout=1):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.3)
    logger.warning("서버가 %s초 안에 뜨지 않아 브라우저를 열지 않았습니다", timeout_s)


def main(argv: list[str]) -> None:
    """서버를 켠다. `--open`이 있으면 준비된 뒤 브라우저를 연다."""
    import uvicorn

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    settings = Settings.from_env(os.environ)
    if "--open" in argv:
        host = "127.0.0.1" if settings.host == "0.0.0.0" else settings.host
        url = f"http://{host}:{settings.port}/"
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main(sys.argv[1:])
