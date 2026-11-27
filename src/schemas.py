"""API 요청·응답 모델 (상세 설계 4절). 화면과 주고받는 JSON 모양은 여기서만 정한다.

pydantic은 이 모듈에서만 쓴다. 엔진 결과(dataclass)를 이 모델로 바꾸는 일은 main.py가 한다.
"""

import math
import re
from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, field_validator

SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9.\-=^]{1,20}$")
MAX_SYMBOLS = 8

# pydantic 기본 오류(형식·종류가 틀림)를 항목별 한국어로 바꿀 때 쓴다
FIELD_MESSAGES = {
    "symbols": "종목은 1~8개 넣어 주세요",
    "start": "날짜는 YYYY-MM-DD 형식으로 넣어 주세요",
    "end": "날짜는 YYYY-MM-DD 형식으로 넣어 주세요",
    "freq": "주기는 daily, weekly, monthly 중 하나입니다",
    "anchor": "매수 기준일은 숫자로 넣어 주세요",
    "amount": "금액은 0보다 큰 숫자여야 합니다",
    "currency": "통화는 KRW 또는 USD입니다",
    "fractional": "소수점 매수 여부는 true 또는 false입니다",
    "fee_pct": "수수료는 0~10% 사이 숫자입니다",
    "q": "검색어는 50자까지 넣어 주세요",
    "symbol": "종목 코드 하나를 문자열로 넣어 주세요",
    "ma_days": "이평선 기간은 20, 60, 120, 200일 중 하나입니다",
    "switch_ref": "기준 종목 코드는 문자열로 넣어 주세요",
    "tax": "양도세 어림 여부는 true 또는 false입니다",
    "rule": "매수 규칙은 none, ma_dip, ma_hot, switch 중 하나입니다",
    "include_daily": "날마다 평가금 포함 여부는 true 또는 false입니다",
}


def _clean_symbol(raw: str) -> str:
    """종목 코드 하나를 다듬는다 (앞뒤 공백 제거, 대문자). 형식이 틀리면 ValueError."""
    code = raw.strip().upper()
    if not SYMBOL_PATTERN.fullmatch(code):
        raise ValueError(f"종목 코드 형식이 올바르지 않습니다: '{raw}'")
    return code


MaDays = Literal[20, 60, 120, 200]  # 이평선 기간 (거래일, F-15)
SymbolCode = Annotated[str, AfterValidator(_clean_symbol)]  # 공백 제거·대문자·형식 검사
BacktestRule = Literal[
    "none", "ma_dip", "ma_hot", "switch"
]  # F-17. engine.RULES에서 lump_sum을 뺀 것


class Conditions(BaseModel):
    """두 요청(/api/backtest, /api/strategy)이 같이 쓰는 조건 (조건 패널, F-09).

    한 항목만 보고 알 수 있는 검사는 여기서, 항목끼리 맞추는 검사는 main에서 한다.
    """

    start: date
    end: date
    freq: Literal["daily", "weekly", "monthly"]
    anchor: int | None = None
    amount: float  # 투자 통화
    currency: Literal["KRW", "USD"]
    fractional: bool = True
    fee_pct: float = 0.0  # %

    @field_validator("amount")
    @classmethod
    def _check_amount(cls, amount: float) -> float:
        if not (math.isfinite(amount) and amount > 0):
            raise ValueError("금액은 0보다 커야 합니다")
        return amount

    @field_validator("fee_pct")
    @classmethod
    def _check_fee(cls, fee: float) -> float:
        if not (math.isfinite(fee) and 0 <= fee <= 10):
            raise ValueError("수수료는 0~10%입니다")
        return fee


class BacktestRequest(Conditions):
    """POST /api/backtest 요청."""

    symbols: list[str]
    tax: bool = False  # 양도세 어림 (F-20). 켜면 summary.tax·profit_after_tax를 채운다
    rule: BacktestRule = "none"  # 매수 규칙 (F-17). none이 아니면 9-6 소수점 매수로 계산
    ma_days: MaDays = 200  # ma_dip·ma_hot은 종목의, switch는 기준 종목의 이평선
    switch_ref: SymbolCode = "QQQ"  # rule이 switch일 때만 받는다. 형식은 늘 본다
    include_daily: bool = False  # 켜면 results[].daily에 줄이지 않은 날마다 값 (결정 d60)

    @field_validator("symbols")
    @classmethod
    def _check_symbols(cls, symbols: list[str]) -> list[str]:
        if not 1 <= len(symbols) <= MAX_SYMBOLS:
            raise ValueError(FIELD_MESSAGES["symbols"])
        cleaned: list[str] = []
        for raw in symbols:
            code = _clean_symbol(raw)
            if code in cleaned:
                raise ValueError(f"같은 종목이 두 번 들어 있습니다: {code}")
            cleaned.append(code)
        return cleaned


class StrategyRequest(Conditions):
    """POST /api/strategy 요청 (F-15). 종목 하나를 전략 5개로 계산한다."""

    symbol: SymbolCode
    ma_days: MaDays = 200
    switch_ref: SymbolCode = "QQQ"  # 레버리지 전환의 기준 종목


class FieldError(BaseModel):
    """입력 오류 한 줄 (422)."""

    field: str
    message: str


class Extreme(BaseModel):
    date: date
    return_pct: float


class Peak(BaseModel):
    date: date
    value: float


class DrawdownOut(BaseModel):
    date: date
    pct: float  # %, 0 아래


class UnderwaterOut(BaseModel):
    days: int  # 거래일 수
    start: date
    recovered: date | None  # 끝까지 원금 위로 못 올라왔으면 null


class SummaryOut(BaseModel):
    """종목 하나의 결과 지표 (계산 규칙 5절, v2 지표는 9-1·9-4·9-5절).

    금액은 투자 통화, 평단가(종목)와 가격은 종목 통화, 비율은 %.
    """

    buys: int
    first_buy: date
    last_buy: date
    invested: float
    shares: float
    leftover_cash: float
    avg_cost_asset: float | None
    avg_cost_invest: float | None
    eval_date: date
    eval_price: float
    eval_fx: float
    value: float
    profit: float
    return_pct: float
    xirr_pct: float | None
    best: Extreme
    worst: Extreme
    peak_value: Peak
    from_peak_pct: float
    max_drawdown: DrawdownOut | None  # 낙폭이 없으면 null
    underwater_days: int
    trading_days: int  # 첫 매수일 ~ data_through 거래일 수
    underwater_pct: float
    longest_underwater: UnderwaterOut | None
    last_underwater: date | None
    price_effect: float
    fx_effect: float  # 통화가 같으면 0
    avg_buy_fx: float | None  # 통화가 같으면 null
    tax: float | None  # 요청의 tax가 꺼져 있으면 null. 한국 종목은 0
    profit_after_tax: float | None  # 요청의 tax가 꺼져 있으면 null


class YearOut(BaseModel):
    return_pct: float  # 그해 마지막 거래일의 수익률 추이 값
    price_change_pct: float | None  # 종목 통화. 전해 데이터가 없으면 null


class AnalysisOut(BaseModel):
    """v2 분석 (계산 규칙 9-1·9-2·9-3). 매수 가격 목록은 같은 응답의 buys[].price다."""

    years: dict[str, YearOut]  # "YYYY" 오름차순
    months: dict[str, float]  # "YYYY-MM" 오름차순 → 월 수익률(%)
    buys_below_eval_price: int
    buys_below_avg_cost: int


class BuyOut(BaseModel):
    """매수 1회. return_pct는 그날 수익률(그 매수일의 수익률 추이 값), lot_return_pct는 이 회차 지금(그날 산
    몫만 끝날짜에 팔았을 때의 투자 통화 수익률)이고 qty가 0이면 null이다 (계산 규칙 9-1, 결정 d59). 둘 다 %."""

    date: date
    price: float
    fx: float
    qty: float
    cum_qty: float
    avg_cost_asset: float | None
    avg_cost_invest: float | None
    invested: float
    return_pct: float
    lot_return_pct: float | None


class DailyOut(BaseModel):
    """날마다 평가 (결정 d60). 그 종목 첫 매수일 ~ data_through 거래일마다 한 값이고 줄이지 않는다.

    value·invested는 투자 통화, return_pct는 %. 자리수는 ChartOut과 같다.
    """

    dates: list[date]
    value: list[float]
    invested: list[float]
    return_pct: list[float]


class SwitchRefOut(BaseModel):
    """레버리지 전환의 기준 종목. basis는 기준 종목의 어느 날 종가·이평선을 봤는지다 (결정 d29).

    same_day: 같은 거래소라 매수일 것을 봤다. previous_day: 다른 거래소이거나 시간대를 몰라
    매수일보다 앞선 마지막 거래일 것을 봤다. data_through는 기준 종목의 끝날짜 당일 또는 그 이전
    마지막 거래일이고, 없으면 null이다 (결정 d45, 저장본 알림에 기준일을 적는다).
    """

    symbol: str
    basis: Literal["same_day", "previous_day"]
    stale: bool
    data_through: date | None


# 저장본 출처의 종류: 종목 주가, 매수·평가 환율, 양도세 환율 (F-10). stale_sources도 이 순서다.
StaleKind = Literal["price", "fx", "tax_fx"]


class StaleSourceOut(BaseModel):
    """그 종목 계산에 저장본으로 쓴 코드 하나 (F-10).

    data_through는 그 코드의 끝날짜 당일 또는 그 이전 마지막 거래일이다 (계산 규칙 3절 평가 환율과
    같은 규칙). price면 결과의 data_through와 같다.
    """

    symbol: str
    kind: StaleKind
    data_through: date


class ResultOut(BaseModel):
    """종목 하나의 결과. listed_from이 있으면 상장일이 시작일보다 늦다.

    stale_sources는 그 종목 계산에 저장본으로 쓴 코드들이다 (price, fx, tax_fx 순, 기준 종목은
    switch_ref에 따로 있다). stale은 stale_sources가 비어 있지 않은 것과 같다.
    """

    symbol: str
    name: str
    currency: str
    notes: list[str]
    data_through: date
    stale: bool
    stale_sources: list[StaleSourceOut]
    listed_from: date | None
    switch_ref: SwitchRefOut | None  # 매수 규칙이 switch일 때만, 아니면 null
    summary: SummaryOut
    analysis: AnalysisOut
    buys: list[BuyOut]
    daily: DailyOut | None  # 요청의 include_daily가 꺼져 있으면 null


class ChartSeriesOut(BaseModel):
    value: list[float | None]
    invested: list[float | None]
    return_pct: list[float | None]
    price: list[float | None]
    avg_cost: list[float | None]
    drawdown: list[float | None]  # 평가금 낙폭(%), 첫 매수 전 null


class ChartOut(BaseModel):
    """그래프 데이터. 날짜가 많으면 줄여서 보내고, total_days는 줄이기 전 날짜 수다."""

    dates: list[date]
    series: dict[str, ChartSeriesOut]
    total_days: int


class SymbolError(BaseModel):
    symbol: str
    message: str


class BacktestResponse(BaseModel):
    params: BacktestRequest
    results: list[ResultOut]
    chart: ChartOut
    errors: list[SymbolError]


class StrategyOut(BaseModel):
    """같은 예산 전략 하나의 결과 (계산 규칙 9-6). 금액은 투자 통화, 평단가는 종목 통화."""

    value: float
    invested: float  # 5개 전략이 모두 같다
    return_pct: float
    xirr_pct: float | None
    avg_cost_asset: float | None
    worst_return_pct: float
    leftover_cash_invest: float
    rule_days: int  # 규칙이 걸린 매수일 수 (이평선 아래·과열·쉰 날)


class StrategiesOut(BaseModel):
    """전략 5개. 키와 순서는 engine.RULES와 같다. switch는 기준 종목을 못 받으면 null (결정 d31)."""

    none: StrategyOut
    ma_dip: StrategyOut
    ma_hot: StrategyOut
    switch: StrategyOut | None
    lump_sum: StrategyOut


class StrategyChartSeriesOut(BaseModel):
    value: list[float]  # 투자 통화
    invested: list[float]  # 투자 통화
    return_pct: list[float]


class StrategyChartOut(BaseModel):
    """전략 그래프. series 키는 계산한 전략만(engine.RULES 순서), total_days는 줄이기 전 날짜 수다."""

    dates: list[date]
    series: dict[str, StrategyChartSeriesOut]
    total_days: int


class StrategyResultOut(BaseModel):
    """종목 하나의 전략 비교. 종목 정보 필드는 ResultOut과 같은 뜻이다."""

    symbol: str
    name: str
    currency: str
    notes: list[str]
    data_through: date
    stale: bool  # 종목이나 환율을 저장본으로 계산했다
    listed_from: date | None
    switch_ref: SwitchRefOut | None  # 기준 종목을 못 받으면 null
    strategies: StrategiesOut
    chart: StrategyChartOut
    # "1"~"28", "31" → 평단가(종목 통화). 그 기준일로 매수일이 없거나, 정수 주로 한 주도 사지 못했거나,
    # 그 기준일로 사는 날 환율이 없으면 null (결정 d56)
    anchor_sweep: dict[str, float | None]
    # "YYYY-MM" 오름차순 → 수익률(%)
    start_sweep: dict[str, float]


class StrategyResponse(BaseModel):
    params: StrategyRequest
    result: StrategyResultOut | None
    errors: list[SymbolError]


class SearchHitOut(BaseModel):
    symbol: str
    name: str
    exchange: str
    type: str
