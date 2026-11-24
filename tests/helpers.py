"""테스트 공통 도우미: 기준값, fixture 읽기, 사례 id, 가짜 Yahoo."""

import asyncio
import json
from datetime import UTC, date, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

import httpx

from src.engine import Series

FIXTURES = Path(__file__).resolve().parent / "fixtures"
YAHOO = FIXTURES / "yahoo"

# expected.json 사례 이름 → 테스트 이름에 쓸 ASCII id. 사례를 더하면 여기에도 더한다
CASE_IDS = {
    "월1일_200만원_5년": "monthly1-krw2m",
    "월1일_200만원_5년_정수주": "monthly1-krw2m-whole-shares",
    "월15일_200만원_5년_수수료0.25%": "monthly15-krw2m-fee0.25",
    "매주월요일_50만원_5년": "weekly-mon-krw500k",
    "매일_10만원_5년": "daily-krw100k",
    "월1일_1500달러_5년": "monthly1-usd1500",
    "월1일_200만원_5년_삼성전자": "monthly1-krw2m-005930",
}


@cache
def load_expected() -> dict[str, Any]:
    """기준값 expected.json."""
    data: dict[str, Any] = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
    return data


@cache
def load_series(symbol: str) -> Series:
    """저장한 Yahoo 응답을 엔진 입력으로 바꾼다. 날짜 규칙은 계산 규칙 1절.

    market.py가 생기기 전까지 엔진 테스트가 쓰는 최소 파서다 (reference_calc.load와 같은 규칙).
    """
    raw = json.loads((YAHOO / f"{symbol}.json").read_text(encoding="utf-8"))
    result = raw["chart"]["result"][0]
    offset = result["meta"].get("gmtoffset", 0)
    dates: list[date] = []
    close: list[float] = []
    for ts, price in zip(
        result["timestamp"], result["indicators"]["quote"][0]["close"], strict=True
    ):
        if price is None:
            continue
        day = (datetime.fromtimestamp(ts, UTC) + timedelta(seconds=offset + 3 * 3600)).date()
        if dates and dates[-1] == day:
            close[-1] = price
            continue
        dates.append(day)
        close.append(price)
    return Series(symbol=symbol, currency=result["meta"]["currency"], dates=dates, close=close)


class FakeYahoo:
    """저장한 fixture로 답하는 가짜 Yahoo (httpx.MockTransport의 handler).

    부른 경로와 동시에 처리 중인 요청 수를 센다. fail이면 500, fixture가 없거나 missing에
    넣은 종목은 404, chart_override가 있으면 차트 요청에 그 JSON을 200으로 돌려준다.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.fail = False
        self.missing: set[str] = set()
        self.chart_override: Any = None
        self.search_payload: Any = {"quotes": []}

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.url.path)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            if self.fail:
                return httpx.Response(500, json={"error": "down"})
            if request.url.path.startswith("/v1/finance/search"):
                return httpx.Response(200, json=self.search_payload)
            if self.chart_override is not None:
                return httpx.Response(200, json=self.chart_override)
            symbol = request.url.path.rsplit("/", 1)[-1]
            fixture = YAHOO / f"{symbol}.json"
            if symbol in self.missing or not fixture.exists():
                return httpx.Response(
                    404, json={"chart": {"result": None, "error": {"code": "Not Found"}}}
                )
            return httpx.Response(200, content=fixture.read_bytes())
        finally:
            self.in_flight -= 1
