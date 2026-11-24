"""HTTP 진입점: 라우트, 입력 검사, market → engine 이어 붙이기, web/ 정적 파일 제공.

python -m src.main          # 서버 켜기 (HOST, PORT 환경변수)
python -m src.main --open   # 켜고 준비되면 브라우저 열기
"""

import asyncio
import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from collections.abc import AsyncIterator, Callable, Mapping
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
    BacktestRequest,
    BacktestResponse,
    BuyOut,
    ChartOut,
    ChartSeriesOut,
    Extreme,
    FieldError,
    Peak,
    ResultOut,
    SearchHitOut,
    SummaryOut,
    SymbolError,
)

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
KST = timezone(timedelta(hours=9))  # "오늘"은 한국 날짜로 본다

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Settings:
    """서버 설정. 기본값은 로컬 실행 기준이다 (아키텍처 5절)."""

    host: str = "127.0.0.1"
    port: int = 8000
    data_dir: Path = Path("data")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        """환경변수에서 설정을 읽는다. PORT가 1~65535 숫자가 아니면 ValueError."""
        port_text = env.get("PORT", "8000")
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


def _anchor_for(request: BacktestRequest) -> int | None:
    """주기에 맞는 매수 기준일. 비어 있으면 매주 월요일, 매월 1일 (범위는 _check_request가 본다)."""
    if request.freq == "daily":
        return None
    if request.anchor is not None:
        return request.anchor
    return 0 if request.freq == "weekly" else 1


def _check_request(request: BacktestRequest, today: date) -> list[FieldError]:
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


def _fx(value: float) -> float:
    """환율은 유효숫자 6자리. KRWUSD=X(약 0.000744)처럼 작은 환율도 0이 되지 않는다."""
    return float(f"{value:.6g}")


def _summary_out(s: engine.Summary, invest: str, asset: str) -> SummaryOut:
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
    )


def _result_out(
    history: PriceHistory, sim: engine.SimResult, params: engine.Params, fx_stale: bool
) -> ResultOut:
    invest, asset = params.currency, history.currency
    notes = [
        f"{day.isoformat()} {ratio} 분할 반영"
        for day, ratio in history.splits
        if day >= params.start  # 끝날짜 뒤의 분할도 가격·수량에 반영돼 있다
    ]
    return ResultOut(
        symbol=history.symbol,
        name=history.name,
        currency=asset,
        notes=notes,
        data_through=sim.summary.eval_date,
        stale=history.stale or fx_stale,
        listed_from=history.dates[0] if sim.summary.listed_after_start else None,
        summary=_summary_out(sim.summary, invest, asset),
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
            )
            for b in sim.buys
        ],
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
            )
            for symbol, s in chart.series.items()
        },
    )


# ---------- 계산하기 ----------


def _to_series(history: PriceHistory) -> engine.Series:
    return engine.Series(history.symbol, history.currency, history.dates, history.close)


class FxError(MarketError):
    """종목은 받았지만 그 종목의 환율을 받지 못했다."""


async def _fetch(
    market: Market,
    symbol: str,
    currency: str,
    fx_tasks: dict[str, "asyncio.Task[PriceHistory]"],
) -> tuple[PriceHistory, PriceHistory | None]:
    """종목 하나와 (필요하면) 그 종목의 환율을 이어서 받는다. 종목끼리는 겹쳐서 받는다.

    같은 환율 쌍은 fx_tasks에 작업 하나만 만들어 나눠 기다린다 (실패해도 한 번만 부른다).
    """
    history = await market.get_series(symbol)
    if history.currency == currency:
        return history, None
    pair = f"{history.currency}{currency}=X"
    if pair not in fx_tasks:
        fx_tasks[pair] = asyncio.create_task(market.get_series(pair))
    try:
        return history, await asyncio.shield(fx_tasks[pair])
    except MarketError as error:
        raise FxError(f"{pair} 환율을 받지 못해 계산하지 못했습니다.") from error


async def run_backtest(market: Market, request: BacktestRequest, today: date) -> BacktestResponse:
    """종목과 환율을 받고(동시에), 종목마다 계산하고, 그래프 날짜축을 맞춘다 (아키텍처 1절)."""
    problems = _check_request(request, today)
    if problems:
        raise InputError(problems)
    params = engine.Params(
        start=request.start,
        end=request.end,
        freq=request.freq,
        anchor=_anchor_for(request),
        amount=request.amount,
        currency=request.currency,
        fractional=request.fractional,
        fee=request.fee_pct / 100,
    )
    fx_tasks: dict[str, asyncio.Task[PriceHistory]] = {}
    fetched = await asyncio.gather(
        *(_fetch(market, s, request.currency, fx_tasks) for s in request.symbols),
        return_exceptions=True,
    )

    results: list[ResultOut] = []
    errors: list[SymbolError] = []
    simulated: dict[str, engine.SimResult] = {}
    for symbol, outcome in zip(request.symbols, fetched, strict=True):
        if isinstance(outcome, MarketError):  # FxError 포함: 그 종목만 실패
            errors.append(SymbolError(symbol=symbol, message=str(outcome)))
            continue
        if isinstance(outcome, BaseException):
            raise outcome
        history, fx_history = outcome
        fx = None if fx_history is None else _to_series(fx_history)
        try:
            sim = engine.simulate(_to_series(history), fx, params)
        except engine.EngineError as error:  # 데이터 때문에 계산할 수 없음: 기간 안 매수일 없음 등
            errors.append(SymbolError(symbol=symbol, message=str(error)))
            continue
        simulated[symbol] = sim
        fx_stale = fx_history is not None and fx_history.stale
        results.append(_result_out(history, sim, params, fx_stale))

    return BacktestResponse(
        params=request,
        results=results,
        chart=_chart_out(engine.build_chart(simulated), request.currency),
        errors=errors,
    )


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
