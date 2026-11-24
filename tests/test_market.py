"""주가 받기·캐시·검색(src/market.py)을 확인한다. Yahoo는 httpx.MockTransport로 흉내 낸다."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.market import Market, MarketError, PriceHistory, SearchHit
from tests.helpers import YAHOO, load_series

T0 = 1_795_500_000.0  # 2026-11-24 무렵의 유닉스초
SIX_HOURS = 6 * 3600

Handler = Callable[[httpx.Request], Awaitable[httpx.Response]]


class FakeYahoo:
    """저장한 fixture로 답하는 가짜 Yahoo. 부른 횟수와 동시에 처리 중인 요청 수를 센다."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.fail = False
        self.search_payload: dict[str, Any] = {"quotes": []}

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
            symbol = request.url.path.rsplit("/", 1)[-1]
            fixture = YAHOO / f"{symbol}.json"
            if not fixture.exists():
                return httpx.Response(
                    404, json={"chart": {"result": None, "error": {"code": "Not Found"}}}
                )
            return httpx.Response(200, content=fixture.read_bytes())
        finally:
            self.in_flight -= 1


class Clock:
    def __init__(self, now: float = T0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def _run(tmp_path: Path, scenario: Callable[[Market, FakeYahoo, Clock], Awaitable[Any]]) -> Any:
    yahoo, clock = FakeYahoo(), Clock()

    async def main() -> Any:
        async with httpx.AsyncClient(transport=httpx.MockTransport(yahoo)) as client:
            market = Market(tmp_path, client, clock=clock)
            return await scenario(market, yahoo, clock)

    return asyncio.run(main())


# ---------- 파싱 (계산 규칙 1절, 상세 설계 1절) ----------


def test_get_series_qld_close_is_split_adjusted(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        return await market.get_series("qld")

    series: PriceHistory = _run(tmp_path, scenario)
    assert series.symbol == "QLD"
    assert series.currency == "USD"
    assert series.name == "ProShares Ultra QQQ"
    assert series.exchange_tz == "America/New_York"
    assert series.close[series.dates.index(date(2021, 12, 1))] == pytest.approx(42.32, abs=0.005)
    assert (date(2025, 11, 20), "2:1") in series.splits
    assert len(series.adjclose) == len(series.dates)
    assert series.stale is False


def test_get_series_usdkrw_summer_bars_fall_on_weekdays(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        return await market.get_series("USDKRW=X")

    series: PriceHistory = _run(tmp_path, scenario)
    assert all(d.weekday() < 5 for d in series.dates)
    assert date(2024, 7, 1) in series.dates  # 월요일 막대는 일요일 23:00 UTC로 찍힌다


def test_get_series_skips_null_close_like_reference(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        return await market.get_series("USDKRW=X")

    series: PriceHistory = _run(tmp_path, scenario)
    reference = load_series("USDKRW=X")
    assert series.dates == reference.dates
    assert series.close == reference.close


# ---------- 캐시 (상세 설계 2절) ----------


def test_get_series_second_call_within_six_hours_uses_cache(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        await market.get_series("QLD")
        clock.now += SIX_HOURS - 1
        await market.get_series("QLD")
        return len(yahoo.calls)

    assert _run(tmp_path, scenario) == 1
    saved = json.loads((tmp_path / "prices" / "QLD.json").read_text(encoding="utf-8"))
    assert set(saved) >= {
        "symbol",
        "name",
        "currency",
        "exchange_tz",
        "fetched_at",
        "dates",
        "close",
    }
    assert saved["fetched_at"] == int(T0)
    assert list((tmp_path / "prices").glob("*.tmp")) == []


def test_get_series_after_six_hours_downloads_again(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        await market.get_series("QLD")
        clock.now += SIX_HOURS + 1
        await market.get_series("QLD")
        return len(yahoo.calls)

    assert _run(tmp_path, scenario) == 2


def test_get_series_reads_cache_written_by_another_market(tmp_path: Path) -> None:
    async def first(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        return await market.get_series("QLD")

    async def second(market: Market, yahoo: FakeYahoo, clock: Clock) -> tuple[PriceHistory, int]:
        return await market.get_series("QLD"), len(yahoo.calls)

    fetched: PriceHistory = _run(tmp_path, first)
    cached, calls = _run(tmp_path, second)
    assert calls == 0
    assert cached.dates == fetched.dates
    assert cached.close == fetched.close
    assert cached.splits == fetched.splits


def test_get_series_failure_with_old_cache_returns_stale(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        await market.get_series("QLD")
        clock.now += SIX_HOURS + 1
        yahoo.fail = True
        return await market.get_series("QLD")

    series: PriceHistory = _run(tmp_path, scenario)
    assert series.stale is True
    assert series.dates[-1] == date(2026, 11, 23)


def test_get_series_failure_without_cache_raises_market_error(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        yahoo.fail = True
        return await market.get_series("QLD")

    with pytest.raises(MarketError, match="QLD"):
        _run(tmp_path, scenario)


def test_get_series_broken_cache_file_is_downloaded_again(tmp_path: Path) -> None:
    (tmp_path / "prices").mkdir()
    (tmp_path / "prices" / "QLD.json").write_text("{not json", encoding="utf-8")

    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        await market.get_series("QLD")
        return len(yahoo.calls)

    assert _run(tmp_path, scenario) == 1
    json.loads((tmp_path / "prices" / "QLD.json").read_text(encoding="utf-8"))


def test_get_series_unknown_symbol_raises_not_found(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> PriceHistory:
        return await market.get_series("XXXX")

    with pytest.raises(MarketError, match="'XXXX' 종목을 찾을 수 없습니다"):
        _run(tmp_path, scenario)


@pytest.mark.parametrize(
    "symbol", ["../etc", "", "A" * 21, "QQQ QLD"], ids=["path", "empty", "long", "space"]
)
def test_get_series_rejects_bad_symbol_without_network(tmp_path: Path, symbol: str) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        with pytest.raises(MarketError, match="종목 코드"):
            await market.get_series(symbol)
        return len(yahoo.calls)

    assert _run(tmp_path, scenario) == 0


# ---------- 동시 호출 ----------


def test_get_series_same_symbol_at_once_downloads_once(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        await asyncio.gather(market.get_series("QLD"), market.get_series("qld"))
        return len(yahoo.calls)

    assert _run(tmp_path, scenario) == 1


def test_get_series_sends_at_most_two_requests_to_yahoo_at_once(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> int:
        await asyncio.gather(*(market.get_series(s) for s in ("QQQ", "QLD", "TQQQ", "SOXL")))
        return yahoo.max_in_flight

    assert _run(tmp_path, scenario) == 2


# ---------- 검색 (상세 설계 1절) ----------

SEARCH_PAYLOAD = {
    "quotes": [
        {
            "symbol": "QLD",
            "shortname": "ProShares Ultra QQQ",
            "exchDisp": "NYSEArca",
            "quoteType": "ETF",
        },
        {
            "symbol": "QLD240119C00050000",
            "shortname": "QLD Jan 2024 50 Call",
            "exchDisp": "OPR",
            "quoteType": "OPTION",
        },
        {
            "symbol": "005930.KS",
            "longname": "Samsung Electronics Co., Ltd.",
            "exchDisp": "KSE",
            "quoteType": "EQUITY",
        },
    ]
}


def test_search_keeps_supported_types_and_caches_for_a_day(tmp_path: Path) -> None:
    async def scenario(
        market: Market, yahoo: FakeYahoo, clock: Clock
    ) -> tuple[list[SearchHit], int]:
        yahoo.search_payload = SEARCH_PAYLOAD
        first = await market.search(" qld ")
        clock.now += 3600
        await market.search("QLD")
        return first, len(yahoo.calls)

    hits, calls = _run(tmp_path, scenario)
    assert calls == 1
    assert hits == [
        SearchHit("QLD", "ProShares Ultra QQQ", "NYSEArca", "ETF"),
        SearchHit("005930.KS", "Samsung Electronics Co., Ltd.", "KSE", "EQUITY"),
    ]


def test_search_blank_query_returns_nothing_without_network(tmp_path: Path) -> None:
    async def scenario(
        market: Market, yahoo: FakeYahoo, clock: Clock
    ) -> tuple[list[SearchHit], int]:
        return await market.search("   "), len(yahoo.calls)

    assert _run(tmp_path, scenario) == ([], 0)


def test_search_failure_raises_market_error(tmp_path: Path) -> None:
    async def scenario(market: Market, yahoo: FakeYahoo, clock: Clock) -> list[SearchHit]:
        yahoo.fail = True
        return await market.search("qld")

    with pytest.raises(MarketError, match="검색"):
        _run(tmp_path, scenario)
