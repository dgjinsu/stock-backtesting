"""API 요청·응답 모델 (상세 설계 4절). 화면과 주고받는 JSON 모양은 여기서만 정한다.

pydantic은 이 모듈에서만 쓴다. 엔진 결과(dataclass)를 이 모델로 바꾸는 일은 main.py가 한다.
"""

import math
import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, field_validator

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
}


def _clean_symbol(raw: str) -> str:
    """종목 코드 하나를 다듬는다 (앞뒤 공백 제거, 대문자). 형식이 틀리면 ValueError."""
    code = raw.strip().upper()
    if not SYMBOL_PATTERN.fullmatch(code):
        raise ValueError(f"종목 코드 형식이 올바르지 않습니다: '{raw}'")
    return code


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

    symbol: str
    ma_days: Literal[20, 60, 120, 200] = 200  # 이평선 기간 (거래일)
    switch_ref: str = "QQQ"  # 레버리지 전환의 기준 종목

    @field_validator("symbol", "switch_ref")
    @classmethod
    def _check_code(cls, raw: str) -> str:
        return _clean_symbol(raw)


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


class SummaryOut(BaseModel):
    """종목 하나의 결과 지표 (계산 규칙 5절). 금액은 투자 통화, 평단가(종목)와 가격은 종목 통화."""

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


class BuyOut(BaseModel):
    date: date
    price: float
    fx: float
    qty: float
    cum_qty: float
    avg_cost_asset: float | None
    avg_cost_invest: float | None
    invested: float


class ResultOut(BaseModel):
    """종목 하나의 결과. stale이면 저장본으로 계산했고, listed_from이 있으면 상장일이 시작일보다 늦다."""

    symbol: str
    name: str
    currency: str
    notes: list[str]
    data_through: date
    stale: bool
    listed_from: date | None
    summary: SummaryOut
    buys: list[BuyOut]


class ChartSeriesOut(BaseModel):
    value: list[float | None]
    invested: list[float | None]
    return_pct: list[float | None]
    price: list[float | None]
    avg_cost: list[float | None]


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


class SwitchRefOut(BaseModel):
    """레버리지 전환의 기준 종목. basis는 기준 종목의 어느 날 종가·이평선을 봤는지다 (결정 d29).

    same_day: 같은 거래소라 매수일 것을 봤다. previous_day: 다른 거래소이거나 시간대를 몰라
    매수일보다 앞선 마지막 거래일 것을 봤다.
    """

    symbol: str
    basis: Literal["same_day", "previous_day"]
    stale: bool


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


class StrategyResponse(BaseModel):
    params: StrategyRequest
    result: StrategyResultOut | None
    errors: list[SymbolError]


class SearchHitOut(BaseModel):
    symbol: str
    name: str
    exchange: str
    type: str
