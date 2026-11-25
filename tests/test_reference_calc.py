"""기준 스크립트(reference_calc.py)가 저장된 기준값(expected.json)을 그대로 내는지 확인한다.

둘이 어긋나면 엔진 테스트의 기준이 흔들린다. 기준값을 바꿔야 하면 계산 규칙 문서를 먼저 고치고
`python tests/reference_calc.py --write`로 다시 만든다.
"""

import json
import subprocess
import sys
from bisect import bisect_right
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from tests import reference_calc
from tests.helpers import CASE_IDS, MONTH_END_CASES

TESTS = Path(__file__).resolve().parent
EXPECTED: dict[str, Any] = json.loads(
    (TESTS / "fixtures" / "expected.json").read_text(encoding="utf-8")
)
EXPECTED_CASES: dict[str, Any] = {case["name"]: case for case in EXPECTED["cases"]}


@pytest.fixture(scope="module")
def reference_output() -> dict[str, Any]:
    """기준 스크립트를 그대로 실행해 화면 출력(JSON)을 받는다."""
    completed = subprocess.run(
        [sys.executable, str(TESTS / "reference_calc.py")],
        capture_output=True,
        check=True,
        timeout=120,
    )
    output: dict[str, Any] = json.loads(completed.stdout.decode("utf-8"))
    return output


def test_reference_metadata_matches_expected(reference_output: dict[str, Any]) -> None:
    assert reference_output["data_snapshot"] == EXPECTED["data_snapshot"]
    assert reference_output["period"] == EXPECTED["period"]


def test_reference_case_names_match_expected(reference_output: dict[str, Any]) -> None:
    assert [case["name"] for case in reference_output["cases"]] == list(EXPECTED_CASES)


@pytest.mark.parametrize("name", list(EXPECTED_CASES), ids=[CASE_IDS[n] for n in EXPECTED_CASES])
def test_reference_case_matches_expected(reference_output: dict[str, Any], name: str) -> None:
    actual = {case["name"]: case for case in reference_output["cases"]}
    assert actual[name] == EXPECTED_CASES[name]


# ---------- v2 (계산 규칙 9절) ----------


def test_reference_v2_matches_expected(reference_output: dict[str, Any]) -> None:
    assert reference_output["v2"] == EXPECTED["v2"]


def test_v2_metrics_match_rules_table() -> None:
    """계산 규칙 9-8 표. 표는 수익률을 소수 1자리로 적었고 저장값은 2자리라 ±0.055(반올림 두 번)로 비교한다."""
    m = EXPECTED["v2"]["metrics"]
    assert m["max_drawdown"]["pct"] == pytest.approx(-42.2, abs=0.055)
    assert m["max_drawdown"]["date"] == "2026-11-20"
    assert (m["underwater_days"], m["trading_days"]) == (331, 1250)
    assert m["underwater_pct"] == pytest.approx(26.5, abs=0.055)
    assert m["longest_underwater"] == {
        "days": 253,
        "start": "2022-03-30",
        "recovered": "2023-04-03",
    }
    assert m["last_underwater"] == "2023-05-04"
    assert m["years"]["2022"]["return_pct"] == pytest.approx(-35.7, abs=0.055)
    assert m["years"]["2022"]["price_change_pct"] == pytest.approx(-60.6, abs=0.055)
    assert m["months"]["best"]["month"] == "2026-04"
    assert m["months"]["best"]["return_pct"] == pytest.approx(30.3, abs=0.055)
    assert m["months"]["worst"]["month"] == "2022-12"
    assert m["months"]["worst"]["return_pct"] == pytest.approx(-22.3, abs=0.055)
    assert m["price_effect"] == pytest.approx(106_570_957, abs=1)
    assert m["fx_effect"] == pytest.approx(-746_367, abs=1)
    assert m["avg_buy_fx"] == pytest.approx(1352.57, abs=0.01)
    assert m["tax"] == pytest.approx(22_731_410, abs=1)
    assert m["profit_after_tax"] == pytest.approx(83_093_180, abs=1)
    assert (m["buys"], m["buys_below_eval_price"], m["buys_below_avg_cost"]) == (60, 51, 24)


def test_v2_last_year_return_equals_summary_return() -> None:
    """9-2: 올해 누적 수익률은 수익률 추이의 마지막 값이고, 마지막 날은 평가 환율로 본다 (5절)."""
    v2 = EXPECTED["v2"]
    assert v2["metrics"]["years"]["2026"]["return_pct"] == v2["strategies"]["none"]["return_pct"]


def test_v2_months_cover_first_buy_month_to_last_ended_month() -> None:
    """9-3: 2021-12(첫 매수) ~ 2026-10(끝날짜가 든 11월은 아직 안 끝났다) = 59달."""
    months = EXPECTED["v2"]["metrics"]["months"]
    assert months["count"] == 59
    assert 0 < months["up"] < months["count"]


def test_v2_price_and_fx_effects_add_up_to_profit() -> None:
    """9-4: 주가 효과 + 환율 효과 = 손익 (반올림 1원 안쪽)."""
    m = EXPECTED["v2"]["metrics"]
    assert m["price_effect"] + m["fx_effect"] == pytest.approx(m["profit"], abs=1)


STRATEGY_TABLE = {
    # 전략: (평가금, 수익률 %, XIRR %, 평단가 $, 최저 수익률 %, 남은 현금 원, 규칙이 걸린 매수일)
    "none": (225_824_590, 88.19, 25.75, 37.97, -39.4, 0, 0),
    "ma_dip": (209_192_663, 74.33, 22.55, 36.09, -38.2, 28_640_107, 18),
    "ma_hot": (217_195_427, 81.00, 24.12, 36.95, -35.4, 15_752_467, 16),
    "switch": (231_394_092, 92.83, 26.78, 37.06, -24.8, 0, 15),
    "lump_sum": (231_708_806, 93.09, 14.11, 42.32, -57.5, 0, 0),
}


@pytest.mark.parametrize("rule", list(STRATEGY_TABLE))
def test_v2_strategy_matches_rules_table(rule: str) -> None:
    """계산 규칙 9-8 전략 표 (200일선, 레버리지 전환의 기준 종목은 QQQ)."""
    value, ret, xirr, avg, worst, cash, days = STRATEGY_TABLE[rule]
    s = EXPECTED["v2"]["strategies"][rule]
    assert s["value"] == pytest.approx(value, abs=1)
    assert s["return_pct"] == pytest.approx(ret, abs=0.01)
    assert s["xirr_pct"] == pytest.approx(xirr, abs=0.01)
    assert s["avg_cost_asset"] == pytest.approx(avg, abs=0.01)
    assert s["worst_return_pct"] == pytest.approx(worst, abs=0.055)
    assert s["leftover_cash_invest"] == pytest.approx(cash, abs=1)
    assert s["rule_days"] == days


def test_v2_sweeps_match_rules_table() -> None:
    """9-7: 평단가가 가장 낮은 기준일 24일 $37.57, 가장 높은 15일 $38.27. 2025-04 시작부터 원금 아래."""
    anchors = EXPECTED["v2"]["anchor_sweep"]
    low = min(anchors, key=lambda a: anchors[a])
    high = max(anchors, key=lambda a: anchors[a])
    assert (low, round(anchors[low], 2)) == ("24", 37.57)
    assert (high, round(anchors[high], 2)) == ("15", 38.27)
    starts = EXPECTED["v2"]["start_sweep"]
    assert starts["2025-03"] == pytest.approx(0.82, abs=0.01)
    assert starts["2025-04"] == pytest.approx(-0.71, abs=0.01)
    assert all(ret < 0 for month, ret in starts.items() if month >= "2025-04")
    assert EXPECTED["v2"]["period"] == ["2021-11-25", "2026-11-24"]
    assert min(starts) == "2021-12"
    assert max(starts) == "2026-05"  # 끝날짜 6개월 전까지


# ---------- 결정 d24·d25·d29 (2026-11-25) ----------

V2_KEYS_BEFORE_D25_D29 = [
    "symbol",
    "invest_currency",
    "freq",
    "anchor",
    "amount",
    "period",
    "ma_days",
    "switch_ref",
    "metrics",
    "strategies",
    "anchor_sweep",
    "start_sweep",
]


def test_v2_keys_keep_existing_and_append_dollar_tax_and_switch_cross_exchange() -> None:
    """기존 v2 키는 그대로 두고 새 묶음 두 개만 뒤에 더한다 (기존 값은 위 9-8 표 테스트가 지킨다)."""
    assert list(EXPECTED["v2"]) == [*V2_KEYS_BEFORE_D25_D29, "dollar_tax", "switch_cross_exchange"]


# 9-8 달러 양도세 줄: tax_fx(원), 손익·양도세·세후 손익($, 정수)
DOLLAR_TAX_ROW = {"tax_fx": 1344.16, "profit": 48_171, "tax": 10_188, "profit_after_tax": 37_982}


def test_v2_dollar_tax_matches_rules_table() -> None:
    """9-8 달러 양도세 줄 (결정 d25): QQQ 매월 1일 $1,500, 9-8 기간, 달러 투자, tax_fx는 7절 평가 환율.
    손익은 7절 "매월 1일 1,500달러" 줄의 평가금 − 투자금과 같다."""
    got = EXPECTED["v2"]["dollar_tax"]
    usd_qqq = next(c for c in EXPECTED["cases"] if c["invest_currency"] == "USD")["results"]["QQQ"]
    assert set(got) == set(DOLLAR_TAX_ROW)
    assert got["tax_fx"] == pytest.approx(DOLLAR_TAX_ROW["tax_fx"], abs=0.01)
    for key in ("profit", "tax", "profit_after_tax"):
        assert got[key] == pytest.approx(DOLLAR_TAX_ROW[key], abs=1), key
    assert got["profit"] == pytest.approx(usd_qqq["value"] - usd_qqq["invested"], abs=1)
    assert got["profit"] - got["tax"] == pytest.approx(got["profit_after_tax"], abs=1)


# 9-8 다른 거래소 레버리지 전환 줄: STRATEGY_TABLE과 같은 순서
CROSS_EXCHANGE_ROW = (298_106_846, 148.42, 37.64, 76_241.12, -26.24, 0, 14)


def test_v2_switch_cross_exchange_matches_rules_table() -> None:
    """9-8 다른 거래소 레버리지 전환 줄 (결정 d29): 005930.KS 매월 1일 200만원, QQQ 200일선.
    기준 종목은 매수일보다 앞선 마지막 거래일 종가로 본다. 키는 v2.strategies와 같다."""
    value, ret, xirr, avg, worst, cash, days = CROSS_EXCHANGE_ROW
    s = EXPECTED["v2"]["switch_cross_exchange"]
    assert list(s) == list(EXPECTED["v2"]["strategies"]["switch"])
    assert s["value"] == pytest.approx(value, abs=1)
    assert s["return_pct"] == pytest.approx(ret, abs=0.01)
    assert s["xirr_pct"] == pytest.approx(xirr, abs=0.01)
    assert s["avg_cost_asset"] == pytest.approx(avg, abs=0.01)
    assert s["worst_return_pct"] == pytest.approx(worst, abs=0.01)
    assert s["leftover_cash_invest"] == pytest.approx(cash, abs=1)
    assert s["rule_days"] == days


@pytest.fixture(scope="module")
def reference_qld_fx() -> tuple[dict[str, Any], dict[str, Any]]:
    """참고 스크립트의 load로 읽은 QLD와 USDKRW=X."""
    return reference_calc.load("QLD"), reference_calc.load("USDKRW=X")


@pytest.mark.parametrize(
    ("cut", "end", "count"),
    [(cut, end, count) for cut, end, _, count in MONTH_END_CASES.values()],
    ids=list(MONTH_END_CASES),
)
def test_reference_v2_months_ended_month_matches_engine_rule(
    reference_qld_fx: tuple[dict[str, Any], dict[str, Any]],
    cut: date | None,
    end: date,
    count: int,
) -> None:
    """9-3, 결정 d24: 참고 스크립트 v2_metrics도 끝날짜와 데이터 마지막 날을 둘 다 본다 (엔진 테스트와 같은 사례)."""
    qld, fx = reference_qld_fx
    if cut is not None:
        k = bisect_right(qld["dates"], cut)
        qld = {**qld, "dates": qld["dates"][:k], "close": qld["close"][:k]}
    v2 = EXPECTED["v2"]
    start = date.fromisoformat(v2["period"][0])
    got = reference_calc.v2_metrics(qld, fx, start, end, v2["anchor"], v2["amount"])
    assert got["months"]["count"] == count
