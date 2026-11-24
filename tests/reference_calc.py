"""설계 단계에서 기준값을 만든 참고 계산 스크립트.

docs/2_계산규칙.md 를 가장 단순하게 옮긴 것이다. 본 개발의 계산 엔진은
tests/fixtures/yahoo/ 의 저장된 주가로 돌렸을 때 tests/fixtures/expected.json 과 같은 값을 내야 한다.

    python tests/reference_calc.py          # 기준값을 화면에 출력
    python tests/reference_calc.py --write  # expected.json 을 다시 만든다

표준 라이브러리만 쓴다.
"""
import datetime as dt
import json
import math
import os
import sys
from bisect import bisect_right

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures", "yahoo")
OUT = os.path.join(HERE, "fixtures", "expected.json")


# ---------- 데이터 ----------
def load(symbol):
    """Yahoo chart 응답 → 날짜·종가 목록. 종가는 분할 반영, 배당 미반영."""
    with open(os.path.join(FIX, f"{symbol}.json"), encoding="utf-8") as f:
        r = json.load(f)["chart"]["result"][0]
    off = r["meta"].get("gmtoffset", 0)
    dates, close = [], []
    for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]):
        if c is None:
            continue
        # 일봉 시각은 현지 자정 또는 개장 시각. 서머타임으로 1시간 어긋나도 날짜가 안 바뀌게 3시간을 더한다.
        d = dt.datetime.fromtimestamp(t + off + 3 * 3600, dt.timezone.utc).date()
        if dates and dates[-1] == d:
            close[-1] = c
            continue
        dates.append(d)
        close.append(c)
    return {"symbol": symbol, "currency": r["meta"]["currency"], "dates": dates, "close": close}


def asof(series, day):
    """day 당일 또는 그 이전 마지막 값."""
    i = bisect_right(series["dates"], day) - 1
    if i < 0:
        raise ValueError(f"{series['symbol']}: {day} 이전 데이터가 없다")
    return series["close"][i]


# ---------- 매수일 ----------
def buy_days(dates, start, end, freq, anchor=None):
    """freq: daily | weekly (anchor 0=월 … 4=금) | monthly (anchor 1~31).

    주·월 단위: 그 기간 안에서 anchor 이후 첫 거래일, 없으면 그 기간의 마지막 거래일.
    매수일은 전체 거래일로 정한 뒤 [start, end] 안에 드는 것만 남긴다.
    """
    if freq == "daily":
        return [d for d in dates if start <= d <= end]
    groups = {}
    for d in dates:
        key = d.isocalendar()[:2] if freq == "weekly" else (d.year, d.month)
        groups.setdefault(key, []).append(d)
    out = []
    for ds in groups.values():
        if freq == "weekly":
            hit = [d for d in ds if d.weekday() >= anchor]
        else:
            hit = [d for d in ds if d.day >= anchor]
        target = hit[0] if hit else ds[-1]
        if start <= target <= end:
            out.append(target)
    return sorted(out)


# ---------- 수익률 ----------
def xirr(flows):
    """flows: [(date, amount)], 투자는 음수, 평가금은 양수. 연 수익률(소수)."""
    d0 = flows[0][0]

    def npv(rate):
        return sum(a / (1 + rate) ** ((d - d0).days / 365) for d, a in flows)

    lo, hi = -0.9999, 100.0
    if npv(lo) * npv(hi) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if npv(lo) * npv(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


# ---------- 시뮬레이션 ----------
def simulate(asset, fx, start, end, freq, anchor, amount, fractional=True, fee=0.0):
    """종목 하나에 매번 amount(투자 통화)씩. fx=None 이면 종목 통화 = 투자 통화."""
    buys = buy_days(asset["dates"], start, end, freq, anchor)
    if not buys:
        raise ValueError("기간 안에 매수일이 없다")
    shares = cash = cost_asset = cost_inv = invested = 0.0
    flows = []
    for d in buys:
        p = asof(asset, d)
        r = asof(fx, d) if fx else 1.0
        invested += amount
        flows.append((d, -amount))
        net = amount * (1 - fee) / r  # 수수료를 뺀 뒤 종목 통화 금액
        if fractional:
            shares += net / p
            cost_asset += amount / r
            cost_inv += amount
        else:
            cash += net
            q = math.floor(cash / p + 1e-9)
            shares += q
            cash -= q * p
            cost_asset += q * p / (1 - fee)
            cost_inv += q * p / (1 - fee) * r
    pe = asof(asset, end)
    re_ = asof(fx, end) if fx else 1.0
    value = (shares * pe + cash) * re_
    flows.append((end, value))
    return {
        "buys": len(buys),
        "first_buy": buys[0].isoformat(),
        "last_buy": buys[-1].isoformat(),
        "invested": round(invested, 2),
        "shares": round(shares, 6),
        "leftover_cash_asset": round(cash, 4),
        "avg_cost_asset": round(cost_asset / shares, 4),
        "avg_cost_invest": round(cost_inv / shares, 2),
        "eval_price": round(pe, 4),
        "eval_fx": round(re_, 4),
        "value": round(value, 0),
        "return_pct": round((value / invested - 1) * 100, 2),
        "xirr_pct": round(xirr(flows) * 100, 2),
    }


# ---------- v2 (계산 규칙 9절) ----------
def daily_rows(asset, fx, buys, end, buy_qty):
    """첫 매수일부터 end까지 거래일마다 (날짜, 평가금, 투자금). buy_qty(d, p, r) → (투자금, 산 수량, 남는 현금)."""
    bset = set(buys)
    shares = cash = invested = 0.0
    rows = []
    for d, p in zip(asset["dates"], asset["close"]):
        if d < buys[0] or d > end:
            continue
        r = asof(fx, d) if fx else 1.0
        if d in bset:
            add, q, cash_delta = buy_qty(d, p, r)
            invested += add
            shares += q
            cash += cash_delta
        rows.append((d, (shares * p + cash) * r, invested))
    return rows


def moving_average(series, day, n):
    """day까지(그날 포함) n거래일 종가 평균. 모자라면 None. 9-6절."""
    i = bisect_right(series["dates"], day)
    return sum(series["close"][i - n:i]) / n if i >= n else None


def strategy(asset, fx, ref, start, end, anchor, amount, rule, ma_days=200):
    """9-6절 같은 예산 전략. rule: none | ma_dip | ma_hot | switch | lump_sum. 수수료 0, 소수점 매수."""
    buys = buy_days(asset["dates"], start, end, "monthly", anchor)
    state = {"cash": 0.0, "cost": 0.0, "shares": 0.0, "days": 0}
    flows = []

    def buy_qty(d, p, r):
        if rule == "lump_sum":
            if d != buys[0]:
                return 0.0, 0.0, 0.0
            total = amount * len(buys)
            flows.append((d, -total))
            state["cost"] += total / r
            state["shares"] += total / r / p
            return total, total / r / p, 0.0
        flows.append((d, -amount))
        unit = amount / r
        cash = state["cash"] + unit
        mult = 1.0
        if rule in ("ma_dip", "ma_hot"):
            avg = moving_average(asset, d, ma_days)
            if avg is not None:
                hit = p < avg if rule == "ma_dip" else p > avg * 1.2
                state["days"] += hit
                mult = (2.0 if hit else 0.5) if rule == "ma_dip" else (0.5 if hit else 1.0)
        spend = min(cash, mult * unit)
        if rule == "switch":
            avg = moving_average(ref, d, ma_days)
            if avg is not None:
                on = asof(ref, d) > avg
                state["days"] += not on
                spend = cash if on else 0.0
        state["cash"] = cash - spend
        state["cost"] += spend
        state["shares"] += spend / p
        return amount, spend / p, unit - spend

    rows = daily_rows(asset, fx, buys, end, buy_qty)
    pe = asof(asset, end)
    re_ = asof(fx, end) if fx else 1.0
    value = (state["shares"] * pe + state["cash"]) * re_
    flows.append((end, value))
    invested = amount * len(buys)
    return {
        "value": round(value, 0),
        "return_pct": round((value / invested - 1) * 100, 2),
        "xirr_pct": round(xirr(flows) * 100, 2),
        "avg_cost_asset": round(state["cost"] / state["shares"], 4),
        "worst_return_pct": round(min(v / inv - 1 for _, v, inv in rows) * 100, 2),
        "leftover_cash_invest": round(state["cash"] * re_, 0),
        "rule_days": state["days"],
    }


def v2_metrics(asset, fx, start, end, anchor, amount):
    """9-1 ~ 9-5절. 기본 적립(소수점 매수, 수수료 0)."""
    buys = buy_days(asset["dates"], start, end, "monthly", anchor)
    rows = daily_rows(asset, fx, buys, end, lambda d, p, r: (amount, amount / r / p, 0.0))
    # 9-1 흔들림
    peak, mdd, mdd_day = 0.0, 0.0, None
    for d, v, _ in rows:
        peak = max(peak, v)
        if v / peak - 1 < mdd:
            mdd, mdd_day = v / peak - 1, d
    under = [v < inv for _, v, inv in rows]
    longest, i = {"days": 0, "start": None, "recovered": None}, 0
    while i < len(rows):
        j = i
        while j < len(rows) and under[j]:
            j += 1
        if j - i > longest["days"]:
            back = rows[j][0].isoformat() if j < len(rows) else None
            longest = {"days": j - i, "start": rows[i][0].isoformat(), "recovered": back}
        i = j + 1
    # 9-2 연도별
    years = {}
    for year in sorted({d.year for d, _, _ in rows}):
        last = [row for row in rows if row[0].year == year][-1]
        closes = {y: [c for d, c in zip(asset["dates"], asset["close"]) if d.year == y and d <= end] for y in (year - 1, year)}
        change = round((closes[year][-1] / closes[year - 1][-1] - 1) * 100, 2) if closes[year - 1] else None
        years[str(year)] = {"return_pct": round((last[1] / last[2] - 1) * 100, 2), "price_change_pct": change}
    # 9-3 월별 (투자 통화)
    month_end = {}
    for d, c in zip(asset["dates"], asset["close"]):
        if d <= end:
            month_end[(d.year, d.month)] = (d, c * (asof(fx, d) if fx else 1.0))
    keys = sorted(month_end)
    monthly = [(f"{b[0]}-{b[1]:02d}", month_end[b][1] / month_end[a][1] - 1)
               for a, b in zip(keys, keys[1:]) if month_end[b][0] >= start]
    best, worst = max(monthly, key=lambda m: m[1]), min(monthly, key=lambda m: m[1])
    # 9-4 수익 분해, 9-5 양도세
    basic = simulate(asset, fx, start, end, "monthly", anchor, amount)
    shares = sum(amount / (asof(fx, d) if fx else 1.0) / asof(asset, d) for d in buys)
    cost = sum(amount / (asof(fx, d) if fx else 1.0) for d in buys)
    pe = asof(asset, end)
    re_ = asof(fx, end) if fx else 1.0
    value = shares * pe * re_
    profit = value - amount * len(buys)
    tax = max(0.0, profit - 2_500_000) * 0.22 if asset["currency"] != "KRW" else 0.0
    return {
        "max_drawdown_pct": round(mdd * 100, 2),
        "max_drawdown_date": mdd_day.isoformat(),
        "underwater_days": sum(under),
        "trading_days": len(rows),
        "underwater_pct": round(sum(under) / len(rows) * 100, 2),
        "longest_underwater": longest,
        "last_underwater": max(d for (d, _, _), u in zip(rows, under) if u).isoformat(),
        "years": years,
        "months": {
            "count": len(monthly),
            "best": {"month": best[0], "return_pct": round(best[1] * 100, 2)},
            "worst": {"month": worst[0], "return_pct": round(worst[1] * 100, 2)},
        },
        "profit": round(profit, 0),
        "price_effect": round((shares * pe - cost) * re_, 0),
        "fx_effect": round(cost * re_ - amount * len(buys), 0),
        "avg_buy_fx": round(amount * len(buys) / cost, 2),
        "tax": round(tax, 0),
        "profit_after_tax": round(profit - tax, 0),
        "buys": basic["buys"],
        "buys_below_eval_price": sum(1 for d in buys if asof(asset, d) < pe),
        "buys_below_avg_cost": sum(1 for d in buys if asof(asset, d) < cost / shares),
    }


def v2_case(start, end):
    """9-8절 v2 기준값: QLD, 매월 1일 200만원, 원화, 수수료 0, 소수점 매수."""
    qld, qqq, fx = load("QLD"), load("QQQ"), load("USDKRW=X")
    amount = 2_000_000
    anchors = list(range(1, 29)) + [31]
    starts, y, m = {}, start.year, start.month
    while True:
        first = dt.date(y, m, 1)
        if first >= start:
            six_before = dt.date(end.year if end.month > 6 else end.year - 1, (end.month - 7) % 12 + 1, end.day)
            if first > six_before:
                break
            starts[f"{y}-{m:02d}"] = simulate(qld, fx, first, end, "monthly", 1, amount)["return_pct"]
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return {
        "symbol": "QLD", "invest_currency": "KRW", "freq": "monthly", "anchor": 1, "amount": amount,
        "ma_days": 200, "switch_ref": "QQQ",
        "metrics": v2_metrics(qld, fx, start, end, 1, amount),
        "strategies": {rule: strategy(qld, fx, qqq, start, end, 1, amount, rule)
                       for rule in ("none", "ma_dip", "ma_hot", "switch", "lump_sum")},
        "anchor_sweep": {str(a): simulate(qld, fx, start, end, "monthly", a, amount)["avg_cost_asset"] for a in anchors},
        "start_sweep": starts,
    }


CASES = [
    # (이름, 종목들, 투자통화, 주기, anchor, 금액, 소수점 매수, 수수료)
    ("월1일_200만원_5년", ["QQQ", "QLD", "TQQQ", "SOXL"], "KRW", "monthly", 1, 2_000_000, True, 0.0),
    ("월1일_200만원_5년_정수주", ["QQQ", "QLD", "TQQQ", "SOXL"], "KRW", "monthly", 1, 2_000_000, False, 0.0),
    ("월15일_200만원_5년_수수료0.25%", ["QLD"], "KRW", "monthly", 15, 2_000_000, True, 0.0025),
    ("매주월요일_50만원_5년", ["QQQ", "QLD", "TQQQ", "SOXL"], "KRW", "weekly", 0, 500_000, True, 0.0),
    ("매일_10만원_5년", ["QQQ", "QLD", "TQQQ", "SOXL"], "KRW", "daily", None, 100_000, True, 0.0),
    ("월1일_1500달러_5년", ["QQQ"], "USD", "monthly", 1, 1_500, True, 0.0),
    ("월1일_200만원_5년_삼성전자", ["005930.KS"], "KRW", "monthly", 1, 2_000_000, True, 0.0),
]
START, END = dt.date(2021, 11, 24), dt.date(2026, 11, 24)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    fx_cache = {}
    out = {
        "data_snapshot": "Yahoo Finance 일별 종가, 2026-11-24 저장 (tests/fixtures/yahoo)",
        "period": [START.isoformat(), END.isoformat()],
        "cases": [],
    }
    for name, syms, inv, freq, anchor, amount, frac, fee in CASES:
        case = {"name": name, "invest_currency": inv, "freq": freq, "anchor": anchor, "amount": amount,
                "fractional": frac, "fee": fee, "results": {}}
        for s in syms:
            a = load(s)
            fx = None
            if a["currency"] != inv:
                pair = f"{a['currency']}{inv}=X"
                fx = fx_cache.setdefault(pair, load(pair))
            case["results"][s] = simulate(a, fx, START, END, freq, anchor, amount, frac, fee)
        out["cases"].append(case)
    out["v2"] = v2_case(START, END)
    text = json.dumps(out, ensure_ascii=False, indent=2)
    if "--write" in sys.argv:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print("저장:", OUT)
    else:
        print(text)


if __name__ == "__main__":
    main()
