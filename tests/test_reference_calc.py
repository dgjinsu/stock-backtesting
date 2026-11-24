"""기준 스크립트(reference_calc.py)가 저장된 기준값(expected.json)을 그대로 내는지 확인한다.

둘이 어긋나면 엔진 테스트의 기준이 흔들린다. 기준값을 바꿔야 하면 계산 규칙 문서를 먼저 고치고
`python tests/reference_calc.py --write`로 다시 만든다.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

TESTS = Path(__file__).resolve().parent
EXPECTED: dict[str, Any] = json.loads(
    (TESTS / "fixtures" / "expected.json").read_text(encoding="utf-8")
)
EXPECTED_CASES: dict[str, Any] = {case["name"]: case for case in EXPECTED["cases"]}

# 테스트 이름에 쓸 ASCII id. 사례를 더하면 여기에도 더한다 (빠지면 수집 단계에서 KeyError)
CASE_IDS = {
    "월1일_200만원_5년": "monthly1-krw2m",
    "월1일_200만원_5년_정수주": "monthly1-krw2m-whole-shares",
    "월15일_200만원_5년_수수료0.25%": "monthly15-krw2m-fee0.25",
    "매주월요일_50만원_5년": "weekly-mon-krw500k",
    "매일_10만원_5년": "daily-krw100k",
    "월1일_1500달러_5년": "monthly1-usd1500",
    "월1일_200만원_5년_삼성전자": "monthly1-krw2m-005930",
}


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
