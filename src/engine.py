"""계산 엔진: 매수일, 시뮬레이션, 날마다 평가, XIRR, 그래프용 날짜축.

표준 라이브러리만 쓰고 네트워크·파일·현재 시각을 읽지 않는다 (아키텍처 3절).
공식은 docs/2_계산규칙.md, 함수 모양은 docs/4_상세설계.md 3절을 따른다.
값은 반올림하지 않은 채로 돌려준다. 반올림은 응답을 만들 때 한 번 한다.
"""

import calendar
import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, timedelta
from itertools import pairwise
from typing import Literal

Freq = Literal["daily", "weekly", "monthly"]

# XIRR 이분법 구간: −99.99% ~ +10,000% (계산 규칙 5절)
_XIRR_LOW = -0.9999
_XIRR_HIGH = 100.0


class EngineError(ValueError):
    """데이터 때문에 계산할 수 없는 조건 (기간 안 매수일 없음, 환율 없음 등).

    메시지는 사용자에게 그대로 보여 줄 한국어다. 입력 계약 위반(금액 0 등)은 ValueError다.
    """


@dataclass(frozen=True, slots=True)
class Series:
    """한 종목의 날짜별 종가. 날짜는 거래소 현지 날짜, 오름차순, 중복 없음.

    exchange_tz는 거래소 시간대 이름(Yahoo exchangeTimezoneName, 예 "America/New_York")이고
    모르면 빈 문자열이다. 엔진은 두 종목의 값이 같은지만 본다 (계산 규칙 9-6, 결정 d29).
    """

    symbol: str
    currency: str
    dates: list[date]
    close: list[float]
    exchange_tz: str = ""

    def __post_init__(self) -> None:
        if len(self.dates) != len(self.close):
            raise ValueError(f"{self.symbol}: 날짜와 종가 개수가 다릅니다")


@dataclass(frozen=True, slots=True)
class Params:
    """백테스트 조건. amount는 투자 통화, fee는 비율(0.0025 = 0.25%)."""

    start: date
    end: date
    freq: Freq
    anchor: int | None
    amount: float
    currency: str
    fractional: bool = True
    fee: float = 0.0


@dataclass(frozen=True, slots=True)
class BuyRow:
    """매수 1회. 평단가는 이번 매수까지의 값이고, 아직 산 수량이 없으면 None.

    매수 규칙(simulate_with_rule)이면 쉰 날은 qty 0이고 avg_cost_invest는 None이다 (결정 d39).
    """

    date: date
    price: float
    fx: float
    qty: float
    cum_qty: float
    avg_cost_asset: float | None
    avg_cost_invest: float | None
    invested: float
    cash: float


@dataclass(frozen=True, slots=True)
class DailyRow:
    """첫 매수일부터 거래일마다 평가한 값. value·invested는 투자 통화."""

    date: date
    price: float
    fx: float
    value: float
    invested: float
    return_pct: float
    avg_cost_asset: float | None


@dataclass(frozen=True, slots=True)
class Extreme:
    """최고·최저 값과 그날. value 단위는 쓰는 곳마다 다르다: best·worst는 %, peak_value는 금액."""

    date: date
    value: float


@dataclass(frozen=True, slots=True)
class Summary:
    """결과 지표 (계산 규칙 5절).

    simulate_with_rule 결과면 avg_cost_invest는 None(결정 d39), leftover_cash는 9-6에서 쓰지 않고 쌓인
    현금(종목 통화), invested는 A × 매수 횟수다.
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
    peak_value: Extreme
    listed_after_start: bool

    @property
    def from_peak_pct(self) -> float:
        """지금 평가금이 평가금 최고점보다 몇 % 낮은지 (0 이하). 기능 명세 F-06."""
        return (self.value / self.peak_value.value - 1) * 100 if self.peak_value.value > 0 else 0.0


@dataclass(frozen=True, slots=True)
class SimResult:
    """종목 하나의 시뮬레이션 결과."""

    symbol: str
    currency: str
    summary: Summary
    buys: list[BuyRow]
    daily: list[DailyRow]


@dataclass(frozen=True, slots=True)
class ChartSeries:
    """그래프 한 종목. 첫 매수 전 날짜는 None. drawdown은 그날 평가금 낙폭(%, 9-1, 0 이하)."""

    value: list[float | None]
    invested: list[float | None]
    return_pct: list[float | None]
    price: list[float | None]
    avg_cost: list[float | None]
    drawdown: list[float | None]


@dataclass(frozen=True, slots=True)
class Chart:
    """모든 종목이 같은 날짜축을 쓰는 그래프 데이터. total_days는 줄이기 전 날짜 수."""

    dates: list[date]
    series: dict[str, ChartSeries]
    total_days: int


# ---------- 매수일 (계산 규칙 2절) ----------


def _check_anchor(freq: Freq, anchor: int | None) -> int:
    if freq == "weekly":
        if anchor is None or not 0 <= anchor <= 4:
            raise ValueError("매주 매수의 기준 요일은 0(월)~4(금)이어야 합니다")
        return anchor
    if anchor is None or not 1 <= anchor <= 31:
        raise ValueError("매월 매수의 기준 날짜는 1~31이어야 합니다")
    return anchor


def buy_days(
    dates: Sequence[date], start: date, end: date, freq: Freq, anchor: int | None
) -> list[date]:
    """매수일. 거래일 전체로 기간마다 고른 뒤 [start, end] 안의 것만 남긴다 (계산 규칙 2절).

    매주는 그 주(월~일), 매월은 그 달에서 기준 이후 첫 거래일, 없으면 그 기간의 마지막 거래일.
    데이터가 아직 그 기간 끝까지 없으면(진행 중인 주·달) 기준 이후 거래일이 올 수 있으니 당겨 사지 않는다.
    """
    if freq == "daily":
        return [d for d in dates if start <= d <= end]
    target = _check_anchor(freq, anchor)
    groups: dict[tuple[int, int], list[date]] = {}
    for d in dates:
        key = d.isocalendar()[:2] if freq == "weekly" else (d.year, d.month)
        groups.setdefault(key, []).append(d)

    def position(d: date) -> int:
        return d.weekday() if freq == "weekly" else d.day

    def period_end(d: date) -> date:
        if freq == "weekly":
            return d + timedelta(days=6 - d.weekday())
        return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])

    picked: list[date] = []
    for days in groups.values():
        choice = next((d for d in days if position(d) >= target), None)
        if choice is None:
            if period_end(days[-1]) > dates[-1]:
                continue  # 진행 중인 기간
            choice = days[-1]
        if start <= choice <= end:
            picked.append(choice)
    return sorted(picked)


# ---------- XIRR ----------


def xirr(flows: Sequence[tuple[date, float]]) -> float | None:
    """현금흐름의 연 내부수익률(소수). 연 365일 기준 (계산 규칙 5절).

    뉴턴법으로 풀고, 수렴하지 않으면 −99.99% ~ +10,000% 이분법. 해가 없으면 None.
    """
    if len(flows) < 2:
        return None
    first = min(d for d, _ in flows)
    years = [(d - first).days / 365 for d, _ in flows]
    amounts = [a for _, a in flows]
    if not (any(a < 0 for a in amounts) and any(a > 0 for a in amounts)):
        return None

    def npv(rate: float) -> float:
        return sum(a / math.pow(1 + rate, t) for a, t in zip(amounts, years, strict=True))

    def slope(rate: float) -> float:
        return sum(-t * a / math.pow(1 + rate, t + 1) for a, t in zip(amounts, years, strict=True))

    rate = 0.1
    for _ in range(50):
        try:
            value, d_value = npv(rate), slope(rate)
        except (OverflowError, ZeroDivisionError):
            break
        if d_value == 0 or not math.isfinite(value):
            break
        step = value / d_value
        rate -= step
        if not math.isfinite(rate) or rate <= _XIRR_LOW:
            break
        if abs(step) < 1e-12:
            if _XIRR_LOW < rate < _XIRR_HIGH:
                return rate
            break  # 구간 밖의 해는 받지 않는다. 이분법이 None을 낸다

    low, high = _XIRR_LOW, _XIRR_HIGH
    f_low = npv(low)
    if f_low * npv(high) > 0:
        return None
    for _ in range(200):
        mid = (low + high) / 2
        f_mid = npv(mid)
        if f_low * f_mid <= 0:
            high = mid
        else:
            low, f_low = mid, f_mid
    return (low + high) / 2


# ---------- 시뮬레이션 (계산 규칙 3~5절) ----------


def _asof_index(dates: Sequence[date], day: date) -> int:
    """day 당일 또는 그 이전 마지막 위치. 없으면 -1."""
    return bisect_right(dates, day) - 1


def rate_on(fx: Series | None, day: date) -> float:
    """환율. 계산 규칙 3절: day 당일 또는 그 이전 마지막 종가.

    fx가 None이면(종목 통화와 투자 통화가 같으면) 1이다. day 이전 값이 없으면 EngineError.
    9-5 양도세 환율(USDKRW=X)도 같은 규칙이라 main이 이 함수로 찾는다.
    """
    if fx is None:
        return 1.0
    i = _asof_index(fx.dates, day)
    if i < 0:
        raise EngineError(f"{fx.symbol} 환율이 {day.isoformat()} 이전에는 없습니다")
    return fx.close[i]


def _check_params(p: Params) -> None:
    if p.start >= p.end:
        raise EngineError("시작일은 끝날짜보다 앞이어야 합니다")
    if not p.amount > 0:
        raise ValueError("금액은 0보다 커야 합니다")
    if not 0 <= p.fee < 1:
        raise ValueError("수수료율은 0 이상 1 미만이어야 합니다")


def simulate(asset: Series, fx: Series | None, p: Params) -> SimResult:
    """종목 하나에 매번 p.amount씩 산 결과. fx는 종목 통화 → 투자 통화 환율 (같으면 None)."""
    _check_params(p)
    if (fx is None) != (asset.currency == p.currency):
        raise ValueError(
            f"{asset.symbol}: 종목 통화 {asset.currency}와 투자 통화 {p.currency}에 맞는 환율이 필요합니다"
        )
    picked = buy_days(asset.dates, p.start, p.end, p.freq, p.anchor)
    if not picked:
        raise EngineError(f"{asset.symbol}: 기간 안에 매수일이 없습니다")
    buy_set = set(picked)

    shares = cash = cost_asset = cost_invest = invested = 0.0
    buys: list[BuyRow] = []
    daily: list[DailyRow] = []
    flows: list[tuple[date, float]] = []

    first_index = _asof_index(asset.dates, picked[0])
    last_index = _asof_index(asset.dates, p.end)
    for i in range(first_index, last_index + 1):
        day, price = asset.dates[i], asset.close[i]
        fx_rate = rate_on(fx, day)
        if day in buy_set:
            invested += p.amount
            flows.append((day, -p.amount))
            net = p.amount * (1 - p.fee) / fx_rate  # 수수료를 뺀 종목 통화 금액
            if p.fractional:
                qty = net / price
                cost_asset += p.amount / fx_rate
                cost_invest += p.amount
            else:
                cash += net
                qty = float(math.floor(cash / price + 1e-9))
                cash -= qty * price
                cost_asset += qty * price / (1 - p.fee)
                cost_invest += qty * price / (1 - p.fee) * fx_rate
            shares += qty
            buys.append(
                BuyRow(
                    date=day,
                    price=price,
                    fx=fx_rate,
                    qty=qty,
                    cum_qty=shares,
                    avg_cost_asset=cost_asset / shares if shares > 0 else None,
                    avg_cost_invest=cost_invest / shares if shares > 0 else None,
                    invested=invested,
                    cash=cash,
                )
            )
        value = (shares * price + cash) * fx_rate
        daily.append(
            DailyRow(
                date=day,
                price=price,
                fx=fx_rate,
                value=value,
                invested=invested,
                return_pct=(value / invested - 1) * 100,
                avg_cost_asset=cost_asset / shares if shares > 0 else None,
            )
        )

    eval_index = _asof_index(asset.dates, p.end)
    eval_price = asset.close[eval_index]
    eval_fx = rate_on(fx, p.end)
    value = (shares * eval_price + cash) * eval_fx
    flows.append((p.end, value))
    annual_rate = xirr(flows)
    # 마지막 거래일은 요약과 같은 평가 환율(끝날 기준)로 다시 평가해 그래프 끝과 요약을 맞춘다
    daily[-1] = replace(daily[-1], fx=eval_fx, value=value, return_pct=(value / invested - 1) * 100)

    best = max(daily, key=lambda r: r.return_pct)
    worst = min(daily, key=lambda r: r.return_pct)
    peak = max(daily, key=lambda r: r.value)
    summary = Summary(
        buys=len(picked),
        first_buy=picked[0],
        last_buy=picked[-1],
        invested=invested,
        shares=shares,
        leftover_cash=cash,
        avg_cost_asset=cost_asset / shares if shares > 0 else None,
        avg_cost_invest=cost_invest / shares if shares > 0 else None,
        eval_date=asset.dates[eval_index],
        eval_price=eval_price,
        eval_fx=eval_fx,
        value=value,
        profit=value - invested,
        return_pct=(value / invested - 1) * 100,
        xirr_pct=None if annual_rate is None else annual_rate * 100,
        best=Extreme(best.date, best.return_pct),
        worst=Extreme(worst.date, worst.return_pct),
        peak_value=Extreme(peak.date, peak.value),
        listed_after_start=asset.dates[0] > p.start,
    )
    return SimResult(asset.symbol, asset.currency, summary, buys, daily)


# ---------- 그래프 날짜축 (계산 규칙 6절, 상세 설계 3절) ----------


def _pick_indices(count: int, max_points: int, must: set[int]) -> list[int]:
    """일정 간격 위치에 꼭 남길 위치를 더한다. 합쳐도 max_points를 넘지 않게 간격 수를 줄인다."""
    if count <= max_points:
        return list(range(count))
    room = max(max_points - len(must), 2)
    even = {round(k * (count - 1) / (room - 1)) for k in range(room)}
    return sorted(even | must)


def _drawdown_pct(rows: Sequence[DailyRow]) -> list[float]:
    """9-1 평가금 낙폭(%). 그날 평가금 ÷ 첫 행부터 그날까지 평가금 최댓값 − 1. rows와 같은 순서, 0 이하."""
    out: list[float] = []
    peak = 0.0
    for row in rows:
        peak = max(peak, row.value)
        out.append((row.value / peak - 1) * 100 if peak > 0 else 0.0)
    return out


def _max_drawdown(rows: Sequence[DailyRow], drawdown_pct: Sequence[float]) -> Extreme | None:
    """가장 깊은 낙폭과 그날. 같은 값이면 앞의 날. 0 아래로 내려간 적이 없으면 None (결정 d25)."""
    if not drawdown_pct:
        return None
    i = min(range(len(drawdown_pct)), key=drawdown_pct.__getitem__)
    return Extreme(rows[i].date, drawdown_pct[i]) if drawdown_pct[i] < 0 else None


def build_chart(results: Mapping[str, SimResult], max_points: int = 1000) -> Chart:
    """모든 종목 거래일을 합친 날짜축. 거래가 없는 날은 직전 값, 첫 매수 전은 None.

    max_points보다 길면 일정 간격으로 줄이되 첫날, 마지막 날, 종목마다 최고·최저 수익률 날짜와
    평가금 최대 낙폭 날짜는 남긴다.
    """
    all_dates = sorted({row.date for result in results.values() for row in result.daily})
    position = {d: i for i, d in enumerate(all_dates)}
    full: dict[str, ChartSeries] = {}
    must = {0, len(all_dates) - 1} if all_dates else set()
    for symbol, result in results.items():
        columns: dict[str, list[float | None]] = {
            "value": [None] * len(all_dates),
            "invested": [None] * len(all_dates),
            "return_pct": [None] * len(all_dates),
            "price": [None] * len(all_dates),
            "avg_cost": [None] * len(all_dates),
            "drawdown": [None] * len(all_dates),
        }
        drawdowns = _drawdown_pct(result.daily)
        rows = iter(enumerate(result.daily))
        current = next(rows, None)
        last: tuple[int, DailyRow] | None = None
        for i, d in enumerate(all_dates):
            while current is not None and current[1].date <= d:
                last, current = current, next(rows, None)
            if last is None:
                continue
            j, row = last
            columns["value"][i] = row.value
            columns["invested"][i] = row.invested
            columns["return_pct"][i] = row.return_pct
            columns["price"][i] = row.price
            columns["avg_cost"][i] = row.avg_cost_asset
            columns["drawdown"][i] = drawdowns[j]
        full[symbol] = ChartSeries(**columns)
        must |= {position[result.summary.best.date], position[result.summary.worst.date]}
        deepest = _max_drawdown(result.daily, drawdowns)
        if deepest is not None:
            must.add(position[deepest.date])

    keep = _pick_indices(len(all_dates), max_points, must)
    return Chart(
        dates=[all_dates[i] for i in keep],
        series={
            symbol: ChartSeries(
                value=[s.value[i] for i in keep],
                invested=[s.invested[i] for i in keep],
                return_pct=[s.return_pct[i] for i in keep],
                price=[s.price[i] for i in keep],
                avg_cost=[s.avg_cost[i] for i in keep],
                drawdown=[s.drawdown[i] for i in keep],
            )
            for symbol, s in full.items()
        },
        total_days=len(all_dates),
    )


# ---------- v2 분석 (계산 규칙 9-1 ~ 9-5) ----------

TAX_FREE_KRW = 2_500_000.0  # 양도세 기본 공제 (9-5절)
TAX_RATE = 0.22


@dataclass(frozen=True, slots=True)
class Underwater:
    """원금 아래가 이어진 구간. recovered는 다시 원금 위로 올라온 날 (끝날까지 못 올라왔으면 None)."""

    days: int
    start: date
    recovered: date | None


@dataclass(frozen=True, slots=True)
class YearResult:
    """연도별 (9-2절). price_change_pct는 전해 데이터가 없으면 None."""

    year: int
    return_pct: float
    price_change_pct: float | None


@dataclass(frozen=True, slots=True)
class MonthResult:
    """월 수익률 (9-3절). month는 "YYYY-MM", 투자 통화 기준의 종목 자체 수익률."""

    month: str
    return_pct: float


@dataclass(frozen=True, slots=True)
class Analysis:
    """v2 지표 (9-1 ~ 9-5절). 금액은 투자 통화, 비율은 %."""

    max_drawdown: Extreme | None  # value는 평가금 낙폭 %, 낙폭이 없으면 None
    underwater_days: int
    trading_days: int
    underwater_pct: float
    longest_underwater: Underwater | None
    last_underwater: date | None
    buys_below_eval_price: int
    buys_below_avg_cost: int
    years: list[YearResult]
    months: list[MonthResult]
    price_effect: float
    fx_effect: float
    avg_buy_fx: float | None  # 투자 통화와 종목 통화가 같으면 None
    tax: float
    profit_after_tax: float


def _is_underwater(row: DailyRow) -> bool:
    """평가금 < 투자금 (9-1절). 부동소수점 오차만큼의 차이는 같다고 본다."""
    return row.value < row.invested * (1 - 1e-12)


def _longest_run(rows: Sequence[DailyRow], flags: Sequence[bool]) -> Underwater | None:
    """flags가 이어진 가장 긴 구간. 같은 길이면 앞의 것 (결정 d25)."""
    best: Underwater | None = None
    i = 0
    while i < len(rows):
        if not flags[i]:
            i += 1
            continue
        j = i
        while j < len(rows) and flags[j]:
            j += 1
        if best is None or j - i > best.days:
            best = Underwater(j - i, rows[i].date, rows[j].date if j < len(rows) else None)
        i = j
    return best


def _months(asset: Series, fx: Series | None, first_buy: date, end: date) -> list[MonthResult]:
    """9-3절: 월말 값 = 그 달 마지막 거래일 종가 × 그날 환율. 첫 매수 달부터 끝난 달까지.

    끝난 달은 말일이 끝날짜 이하이고 종목 데이터도 그 말일까지 있는 달이다. 2절 매수일의 진행 중인 달과
    같은 판정이다 (결정 d24). asset은 끝날짜로 자르기 전 전체 데이터이고, 환율 데이터의 끝은 보지 않는다.
    첫 매수 달 전의 마지막 거래일부터만 본다 (종목 이력이 환율 이력보다 길 수 있다). 그 앞 달에
    거래가 없었으면 그보다 앞의 월말과 비교한다 (두 달치 변화). 환율이 없는 날은 건너뛴다.
    """
    before = _asof_index(asset.dates, first_buy.replace(day=1) - timedelta(days=1))
    from_day = asset.dates[max(before, 0)]
    month_end: dict[tuple[int, int], float] = {}
    for day, close in zip(asset.dates, asset.close, strict=True):
        if from_day <= day <= end and (fx is None or _asof_index(fx.dates, day) >= 0):
            month_end[(day.year, day.month)] = close * rate_on(fx, day)
    # 말일 ≤ 끝날짜 그리고 말일 ≤ 데이터 마지막 날  ⇔  말일 ≤ cutoff.
    # cutoff가 말일이 아니면 그 달은 진행 중이다
    cutoff = min(end, asset.dates[-1])
    last = (cutoff.year, cutoff.month)
    if (cutoff + timedelta(days=1)).month == cutoff.month:
        last = (cutoff.year, cutoff.month - 1) if cutoff.month > 1 else (cutoff.year - 1, 12)
    keys = sorted(month_end)
    return [
        MonthResult(f"{b[0]}-{b[1]:02d}", (month_end[b] / month_end[a] - 1) * 100)
        for a, b in pairwise(keys)
        if (first_buy.year, first_buy.month) <= b <= last
    ]


def _years(result: SimResult, asset: Series, end: date) -> list[YearResult]:
    """9-2절: 그해 마지막 거래일의 수익률 추이 값, 주가 등락은 전해 마지막 종가 대비."""
    year_end: dict[int, float] = {}
    for day, close in zip(asset.dates, asset.close, strict=True):
        if day <= end:
            year_end[day.year] = close
    last_row: dict[int, DailyRow] = {row.date.year: row for row in result.daily}
    out = []
    for year in sorted(last_row):
        before = year_end.get(year - 1)
        change = (year_end[year] / before - 1) * 100 if before else None
        out.append(YearResult(year, last_row[year].return_pct, change))
    return out


def analyze(
    result: SimResult, asset: Series, fx: Series | None, end: date, *, tax_fx: float
) -> Analysis:
    """v2 지표. 계산 규칙 9-1 ~ 9-5절.

    result는 simulate(asset, fx, params) 또는 simulate_with_rule(...)의 결과이고 end는 params.end다.
    asset은 끝날짜로 자르지 않은 전체 데이터다. 9-3 끝난 달은 2절 매수일처럼 데이터 마지막 날을 본다 (결정 d24).
    tax_fx는 투자 통화 1단위의 원화 값이다 (원화 투자면 1, 달러 투자면 끝날짜 당일 또는 그 이전 마지막
    USDKRW=X 종가, 9-5절).
    엔진은 투자 통화를 모르므로 기본값을 두지 않는다. 0 이하면 ValueError.
    양도세는 원화로 계산해 투자 통화로 돌려준다. 종목 통화가 원화(한국 종목)면 0이다.
    """
    if not (tax_fx > 0 and math.isfinite(tax_fx)):
        raise ValueError(f"tax_fx는 0보다 큰 유한한 값이어야 합니다: {tax_fx}")
    rows, s = result.daily, result.summary
    # 9-1 흔들림
    drawdown = _max_drawdown(rows, _drawdown_pct(rows))
    flags = [_is_underwater(row) for row in rows]
    under = [row.date for row, flag in zip(rows, flags, strict=True) if flag]
    # 9-4 수익 분해. 달러 원가 = 넣은 돈을 매수일 환율로 바꾼 종목 통화 금액의 합 (결정 d26).
    # 소수점 매수면 매수원가(종목)와 같고, 정수 주의 남은 현금도 같은 날 같은 환율로 바꾼 돈이라 포함한다.
    amount = s.invested / s.buys
    dollar_cost = sum(amount / b.fx for b in result.buys)
    asset_value = s.shares * s.eval_price + s.leftover_cash
    if fx is None:  # 투자 통화와 종목 통화가 같으면 환율 효과 0
        price_effect, fx_effect = s.profit, 0.0
    else:
        price_effect = (asset_value - dollar_cost) * s.eval_fx
        fx_effect = dollar_cost * s.eval_fx - s.invested
    # 9-5 양도세
    taxable = result.currency != "KRW"
    tax = max(0.0, s.profit * tax_fx - TAX_FREE_KRW) * TAX_RATE / tax_fx if taxable else 0.0
    return Analysis(
        max_drawdown=drawdown,
        underwater_days=len(under),
        trading_days=len(rows),
        underwater_pct=len(under) / len(rows) * 100,
        longest_underwater=_longest_run(rows, flags),
        last_underwater=under[-1] if under else None,
        buys_below_eval_price=sum(1 for b in result.buys if b.price < s.eval_price),
        buys_below_avg_cost=sum(
            1 for b in result.buys if s.avg_cost_asset is not None and b.price < s.avg_cost_asset
        ),
        years=_years(result, asset, end),
        months=_months(asset, fx, s.first_buy, end),
        price_effect=price_effect,
        fx_effect=fx_effect,
        avg_buy_fx=s.invested / dollar_cost if fx is not None else None,
        tax=tax,
        profit_after_tax=s.profit - tax,
    )


# ---------- v2 전략 (계산 규칙 9-6) ----------

Rule = Literal["none", "ma_dip", "ma_hot", "switch", "lump_sum"]
RULES: tuple[Rule, ...] = ("none", "ma_dip", "ma_hot", "switch", "lump_sum")
RULE_MULTIPLIER: dict[str, tuple[float, float]] = {
    "ma_dip": (2.0, 0.5),  # 종가 < 이평선이면 2, 아니면 0.5
    "ma_hot": (0.5, 1.0),  # 종가 > 이평선 × 1.2면 0.5, 아니면 1
}


@dataclass(frozen=True, slots=True)
class StrategyResult:
    """같은 예산 전략 하나의 결과 (9-6절). 금액은 투자 통화, daily는 그래프용 날마다 평가."""

    rule: Rule
    value: float
    invested: float
    return_pct: float
    xirr_pct: float | None
    avg_cost_asset: float | None
    worst_return_pct: float
    leftover_cash_invest: float
    rule_days: int  # 규칙이 걸린 매수일 수 (이평선 아래·과열·쉰 날)
    daily: list[DailyRow]


def _moving_average(series: Series, day: date, n: int) -> float | None:
    """day까지(그날 포함) n거래일 종가 평균. 시작일 이전 주가도 쓴다. 모자라면 None."""
    i = bisect_right(series.dates, day)
    return sum(series.close[i - n : i]) / n if i >= n else None


def same_exchange(a: Series, b: Series) -> bool:
    """두 종목이 같은 거래소인지. exchange_tz가 둘 다 비어 있지 않고 같을 때만 True (9-6절, 결정 d29)."""
    return a.exchange_tz != "" and a.exchange_tz == b.exchange_tz


def simulate_rule(
    asset: Series, fx: Series | None, ref: Series | None, p: Params, rule: Rule, ma_days: int = 200
) -> StrategyResult:
    """같은 예산 전략. 계산 규칙 9-6절.

    매수일마다 넣는 돈(A)은 기본 적립과 같고, 살 돈만 규칙대로 정한다. 넣고 안 쓴 돈은 현금(종목 통화)으로
    쌓였다가 다음 매수일에 쓰인다. 소수점 매수로 계산한다 (9-6 공식). 일시금은 첫 매수일에 A × 매수 횟수.
    ref는 레버리지 전환의 기준 종목(종가와 이평선을 본다). 두 종목의 exchange_tz가 같으면 매수일의 종가·
    이평선을, 다르거나 하나라도 비어 있으면 매수일보다 앞선 마지막 거래일 기준을 본다 (결정 d29). 같은 날짜의
    기준 종목 종가가 사는 종목 장이 끝난 뒤에 나올 수 있어서다. simulate_with_rule과 같은 계산 루프를 쓴다.
    """
    sim, rule_days = _run_rule(asset, fx, ref, p, rule, ma_days)
    s = sim.summary
    return StrategyResult(
        rule=rule,
        value=s.value,
        invested=s.invested,
        return_pct=s.return_pct,
        xirr_pct=s.xirr_pct,
        avg_cost_asset=s.avg_cost_asset,
        worst_return_pct=s.worst.value,
        leftover_cash_invest=s.leftover_cash * s.eval_fx,
        rule_days=rule_days,
        daily=sim.daily,
    )


def simulate_with_rule(
    asset: Series, fx: Series | None, ref: Series | None, p: Params, rule: Rule, ma_days: int = 200
) -> SimResult:
    """매수 규칙(F-17)으로 산 결과를 simulate와 같은 모양으로 돌려준다. 계산 규칙 9-6절.

    rule은 none·ma_dip·ma_hot·switch이고, lump_sum(전략 비교 전용)이면 ValueError다. 소수점 매수로 계산하고
    p.fractional은 보지 않는다. buys는 매수일마다 한 줄이고, 레버리지 전환에서 쉰 날은 qty 0이다.
    cash는 남은 현금(종목 통화), avg_cost_invest는 None이다 (결정 d39). ref는 switch에서만 쓴다.
    """
    if rule == "lump_sum":
        raise ValueError("일시금은 매수 규칙으로 쓸 수 없습니다 (전략 비교 전용)")
    return _run_rule(asset, fx, ref, p, rule, ma_days)[0]


def _run_rule(
    asset: Series, fx: Series | None, ref: Series | None, p: Params, rule: Rule, ma_days: int
) -> tuple[SimResult, int]:
    """9-6 계산 루프 하나. simulate_rule·simulate_with_rule이 같이 부른다. int는 rule_days."""
    _check_params(p)
    if rule not in RULES:
        raise ValueError(f"알 수 없는 전략입니다: {rule}")
    if ma_days < 1:
        raise ValueError(f"이평선 기간은 1 이상이어야 합니다: {ma_days}")
    if rule == "switch" and ref is None:
        raise ValueError("레버리지 전환에는 기준 종목이 필요합니다")
    if (fx is None) != (asset.currency == p.currency):
        raise ValueError(
            f"{asset.symbol}: 종목 통화 {asset.currency}와 투자 통화 {p.currency}에 맞는 환율이 필요합니다"
        )
    picked = buy_days(asset.dates, p.start, p.end, p.freq, p.anchor)
    if not picked:
        raise EngineError(f"{asset.symbol}: 기간 안에 매수일이 없습니다")
    buy_set = set(picked)
    on_buy_day = ref is not None and same_exchange(asset, ref)  # 모르면 다른 거래소로 본다
    keep = 1 - p.fee
    shares = cash = cost = invested = 0.0
    rule_days = 0
    flows: list[tuple[date, float]] = []
    buys: list[BuyRow] = []
    daily: list[DailyRow] = []
    for i in range(_asof_index(asset.dates, picked[0]), _asof_index(asset.dates, p.end) + 1):
        day, price = asset.dates[i], asset.close[i]
        fx_rate = rate_on(fx, day)
        if day in buy_set:
            if rule == "lump_sum":
                put = p.amount * len(picked) if day == picked[0] else 0.0
                spend = put * keep / fx_rate
            else:
                put = p.amount
                unit = put * keep / fx_rate
                cash += unit
                spend = min(cash, unit)  # 기본 적립, 이평선이 모자라면 배수 1
                if rule in RULE_MULTIPLIER:
                    avg = _moving_average(asset, day, ma_days)
                    if avg is not None:
                        hit = price < avg if rule == "ma_dip" else price > avg * 1.2
                        rule_days += hit
                        spend = min(cash, RULE_MULTIPLIER[rule][0 if hit else 1] * unit)
                elif rule == "switch" and ref is not None:
                    # 날짜에 시각이 없으니 "전날 당일 또는 그 이전" = 매수일보다 앞선 마지막 거래일
                    ref_day = day if on_buy_day else day - timedelta(days=1)
                    avg = _moving_average(ref, ref_day, ma_days)
                    if avg is not None:
                        on = ref.close[_asof_index(ref.dates, ref_day)] > avg
                        rule_days += not on
                        spend = cash if on else 0.0
                cash -= spend
            if put:
                invested += put
                flows.append((day, -put))
            qty = spend / price
            shares += qty
            cost += spend / keep
            buys.append(
                BuyRow(
                    date=day,
                    price=price,
                    fx=fx_rate,
                    qty=qty,
                    cum_qty=shares,
                    avg_cost_asset=cost / shares if shares > 0 else None,
                    avg_cost_invest=None,  # 같은 예산 규칙은 넣은 돈과 쓴 돈이 달라 정하지 않는다 (결정 d39)
                    invested=invested,
                    cash=cash,
                )
            )
        value = (shares * price + cash) * fx_rate
        daily.append(
            DailyRow(
                date=day,
                price=price,
                fx=fx_rate,
                value=value,
                invested=invested,
                return_pct=(value / invested - 1) * 100,
                avg_cost_asset=cost / shares if shares > 0 else None,
            )
        )
    eval_index = _asof_index(asset.dates, p.end)
    eval_price = asset.close[eval_index]
    eval_fx = rate_on(fx, p.end)
    value = (shares * eval_price + cash) * eval_fx
    total = p.amount * len(picked)
    flows.append((p.end, value))
    annual_rate = xirr(flows)
    # 마지막 거래일은 평가 환율로 다시 평가한다 (5절 끝, simulate와 같다)
    daily[-1] = replace(daily[-1], fx=eval_fx, value=value, return_pct=(value / total - 1) * 100)
    best = max(daily, key=lambda r: r.return_pct)
    worst = min(daily, key=lambda r: r.return_pct)
    peak = max(daily, key=lambda r: r.value)
    summary = Summary(
        buys=len(picked),
        first_buy=picked[0],
        last_buy=picked[-1],
        invested=total,
        shares=shares,
        leftover_cash=cash,
        avg_cost_asset=cost / shares if shares > 0 else None,
        avg_cost_invest=None,  # 결정 d39
        eval_date=asset.dates[eval_index],
        eval_price=eval_price,
        eval_fx=eval_fx,
        value=value,
        profit=value - total,
        return_pct=(value / total - 1) * 100,
        xirr_pct=None if annual_rate is None else annual_rate * 100,
        best=Extreme(best.date, best.return_pct),
        worst=Extreme(worst.date, worst.return_pct),
        peak_value=Extreme(peak.date, peak.value),
        listed_after_start=asset.dates[0] > p.start,
    )
    result = SimResult(
        symbol=asset.symbol, currency=asset.currency, summary=summary, buys=buys, daily=daily
    )
    return result, rule_days


@dataclass(frozen=True, slots=True)
class StrategyChartSeries:
    """전략 그래프 하나. value·invested는 투자 통화, return_pct는 %. 날짜축이 같아 빈 값이 없다."""

    value: list[float]
    invested: list[float]
    return_pct: list[float]


@dataclass(frozen=True, slots=True)
class StrategyChart:
    """전략 그래프. dates는 전략의 daily 날짜, total_days는 줄이기 전 날짜 수."""

    dates: list[date]
    series: dict[Rule, StrategyChartSeries]  # 받은 순서
    total_days: int


def build_strategy_chart(
    results: Sequence[StrategyResult], max_points: int = 1000
) -> StrategyChart:
    """전략별 평가금 추이를 그래프용으로 줄인다 (기능 명세 F-07·F-15, 상세 설계 3절).

    같은 asset·fx·Params로 계산한 전략은 daily 날짜가 모두 같아서, build_chart처럼 날짜를 합치거나
    직전 값으로 채우지 않는다. max_points보다 길면 일정 간격으로 줄이되 첫날, 마지막 날, 전략마다
    최고·최저 수익률 날짜(같은 값이면 앞의 날)는 남긴다. 날짜축이 다르거나 같은 전략이 두 번이면 ValueError.
    """
    if not results:
        return StrategyChart(dates=[], series={}, total_days=0)
    rules = [result.rule for result in results]
    if len(set(rules)) != len(rules):
        raise ValueError(f"같은 전략이 두 번 들어 있습니다: {rules}")
    dates = [row.date for row in results[0].daily]
    must = {0, len(dates) - 1}
    for result in results:
        if [row.date for row in result.daily] != dates:
            raise ValueError(f"{result.rule}: 전략마다 날짜축이 같아야 합니다")
        returns = [row.return_pct for row in result.daily]
        must |= {returns.index(max(returns)), returns.index(min(returns))}
    keep = _pick_indices(len(dates), max_points, must)
    return StrategyChart(
        dates=[dates[i] for i in keep],
        series={
            result.rule: StrategyChartSeries(
                value=[result.daily[i].value for i in keep],
                invested=[result.daily[i].invested for i in keep],
                return_pct=[result.daily[i].return_pct for i in keep],
            )
            for result in results
        },
        total_days=len(dates),
    )


# ---------- v2 바꿔 보기 (계산 규칙 9-7) ----------


def anchor_sweep(asset: Series, fx: Series | None, p: Params) -> dict[int, float | None]:
    """매월 기준일을 1~28일과 말일(31)로 바꿨을 때의 평단가(종목 통화). 9-7절.

    주기와 상관없이 매월로 계산한다. 그 기준일로는 기간 안에 매수일이 없으면 None이다.
    정수 주만 살 때 한 주도 사지 못하면 보유 수량이 0이라 평단가가 없어 None이다 (결정 d35).
    """
    out: dict[int, float | None] = {}
    for anchor in [*range(1, 29), 31]:
        q = replace(p, freq="monthly", anchor=anchor)
        if not buy_days(asset.dates, q.start, q.end, q.freq, q.anchor):
            out[anchor] = None
            continue
        out[anchor] = simulate(asset, fx, q).summary.avg_cost_asset
    return out


def start_sweep(asset: Series, fx: Series | None, p: Params) -> dict[str, float]:
    """시작일을 각 달 1일로 바꿔 끝날짜까지 계산한 수익률. 끝날짜가 든 달의 6개월 전 달까지. 9-7절.

    상장 달보다 앞선 달은 뺀다 (상장 달은 남긴다). 그 달부터 매수일이 없으면 뺀다. 그 밖의 오류(환율 없음 등)는
    그대로 올린다.
    """
    listed = asset.dates[0].year * 12 + asset.dates[0].month - 1
    first_index = max(p.start.year * 12 + p.start.month - 1, listed)
    last = p.end.year * 12 + p.end.month - 1 - 6
    out: dict[str, float] = {}
    for index in range(first_index, last + 1):
        first = date(index // 12, index % 12 + 1, 1)
        if first < p.start or not buy_days(asset.dates, first, p.end, p.freq, p.anchor):
            continue
        out[f"{first:%Y-%m}"] = simulate(asset, fx, replace(p, start=first)).summary.return_pct
    return out
