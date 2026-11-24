"""바깥 데이터 출처: Yahoo 일봉 받기, 날짜 보정, 캐시 파일 읽기·쓰기, 종목 검색.

바깥 데이터를 아는 곳은 이 모듈 하나다. 바깥에 보이는 것은 `Market.get_series`와
`Market.search`뿐이라, 출처를 바꿔도 엔진과 화면은 그대로다 (아키텍처 3절).
규격은 docs/4_상세설계.md 1·2절, 날짜 규칙은 docs/2_계산규칙.md 1절.
"""

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
HEADERS = {"User-Agent": "Mozilla/5.0"}  # 없으면 Yahoo가 막는다
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9.\-=^]{1,20}$")
SEARCH_TYPES = {"EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY"}
DAY_SHIFT = timedelta(hours=3)  # 서머타임으로 1시간 어긋나도 날짜가 안 바뀌게 (계산 규칙 1절)
# 받기 실패로 보는 예외: 네트워크·HTTP 상태(httpx), 깨진 JSON·예상과 다른 응답 모양
_FETCH_ERRORS = (httpx.HTTPError, ValueError, KeyError, TypeError)


class MarketError(Exception):
    """주가를 받거나 검색하지 못했다. 메시지는 사용자에게 보여 줄 한국어다."""


@dataclass(frozen=True, slots=True)
class PriceHistory:
    """한 종목의 일별 종가. dates는 거래소 현지 날짜, 오름차순, 중복 없음.

    close는 분할 반영, adjclose는 배당까지 반영(v2). stale이면 받기에 실패해 저장본을 쓴 것이다.
    """

    symbol: str
    name: str
    currency: str
    exchange_tz: str
    fetched_at: int
    dates: list[date]
    close: list[float]
    adjclose: list[float]
    splits: list[tuple[date, str]] = field(default_factory=list)
    stale: bool = False


@dataclass(frozen=True, slots=True)
class SearchHit:
    """검색 결과 한 줄."""

    symbol: str
    name: str
    exchange: str
    type: str


def normalize_symbol(symbol: str) -> str:
    """종목 코드를 대문자로 바꾸고 형식을 검사한다. 파일 이름으로 써도 안전한 글자만 받는다."""
    cleaned = symbol.strip().upper()
    if not SYMBOL_PATTERN.fullmatch(cleaned):
        raise MarketError(f"종목 코드 형식이 올바르지 않습니다: '{symbol}'")
    return cleaned


def _local_date(timestamp: int, offset_s: int) -> date:
    return (datetime.fromtimestamp(timestamp, UTC) + timedelta(seconds=offset_s) + DAY_SHIFT).date()


def parse_chart(symbol: str, payload: dict[str, Any], fetched_at: int) -> PriceHistory:
    """Yahoo chart 응답을 PriceHistory로 바꾼다. null 종가는 건너뛰고, 같은 날이 두 번이면 뒤의 값."""
    chart = payload.get("chart") or {}
    results = chart.get("result") or []
    if not results:
        raise MarketError(f"'{symbol}' 종목을 찾을 수 없습니다.")
    result = results[0]
    meta = result.get("meta") or {}
    offset = int(meta.get("gmtoffset") or 0)
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    closes = (indicators.get("quote") or [{}])[0].get("close") or []
    adjusted = (indicators.get("adjclose") or [{}])[0].get("adjclose") or [None] * len(closes)

    dates: list[date] = []
    close: list[float] = []
    adjclose: list[float] = []
    for ts, price, adj in zip(timestamps, closes, adjusted, strict=False):
        if price is None:
            continue
        day = _local_date(int(ts), offset)
        value, adj_value = float(price), float(adj if adj is not None else price)
        if dates and dates[-1] == day:
            close[-1], adjclose[-1] = value, adj_value
            continue
        dates.append(day)
        close.append(value)
        adjclose.append(adj_value)
    if not dates:
        raise MarketError(f"'{symbol}' 종목의 가격 데이터가 없습니다.")

    splits = sorted(
        (_local_date(int(event["date"]), offset), _split_ratio(event))
        for event in ((result.get("events") or {}).get("splits") or {}).values()
    )
    return PriceHistory(
        symbol=symbol,
        name=str(meta.get("longName") or meta.get("shortName") or symbol),
        currency=str(meta.get("currency") or ""),
        exchange_tz=str(meta.get("exchangeTimezoneName") or ""),
        fetched_at=fetched_at,
        dates=dates,
        close=close,
        adjclose=adjclose,
        splits=splits,
    )


def _split_ratio(event: dict[str, Any]) -> str:
    if event.get("splitRatio"):
        return str(event["splitRatio"])
    return f"{float(event['numerator']):g}:{float(event['denominator']):g}"


class Market:
    """주가와 검색. 캐시 파일은 data_dir/prices/{종목}.json (상세 설계 2절)."""

    def __init__(
        self,
        data_dir: Path,
        client: httpx.AsyncClient,
        *,
        clock: Callable[[], float] = time.time,
        max_age_s: int = 6 * 3600,
        concurrency: int = 2,
        search_ttl_s: int = 24 * 3600,
    ) -> None:
        self._prices = Path(data_dir) / "prices"
        self._client = client
        self._clock = clock
        self._max_age_s = max_age_s
        self._yahoo = asyncio.Semaphore(concurrency)
        self._locks: dict[str, asyncio.Lock] = {}
        self._search_ttl_s = search_ttl_s
        self._search_cache: dict[str, tuple[float, list[SearchHit]]] = {}

    # ---------- 주가 ----------

    async def get_series(self, symbol: str) -> PriceHistory:
        """종목의 상장 이후 전체 일봉. 저장본이 6시간 안이면 파일에서, 아니면 Yahoo에서 받는다.

        받기에 실패하면 저장본을 stale=True로 돌려주고, 저장본도 없으면 MarketError.
        """
        code = normalize_symbol(symbol)
        lock = self._locks.setdefault(code, asyncio.Lock())
        async with lock:
            cached = self._read_cache(code)
            if cached is not None and self._clock() - cached.fetched_at < self._max_age_s:
                return cached
            try:
                fresh = await self._download(code)
            except _FETCH_ERRORS as error:  # 네트워크·HTTP·응답 형식 문제는 받기 실패로 본다
                if cached is not None:
                    logger.warning(
                        "%s 받기 실패, 저장본(%s)을 씁니다: %s", code, cached.dates[-1], error
                    )
                    return replace(cached, stale=True)
                raise MarketError(
                    f"'{code}' 주가를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요."
                ) from error
            self._write_cache(fresh)
            return fresh

    async def _download(self, code: str) -> PriceHistory:
        now = self._clock()
        params = {
            "period1": "0",
            "period2": str(int(now) + 86_400),
            "interval": "1d",
            "events": "split",
        }
        started = time.monotonic()
        async with self._yahoo:
            response = await self._client.get(
                CHART_URL.format(symbol=code), params=params, headers=HEADERS, timeout=15.0
            )
        logger.info(
            "Yahoo %s: HTTP %s, %.2fs", code, response.status_code, time.monotonic() - started
        )
        if response.status_code == 404:
            raise MarketError(f"'{code}' 종목을 찾을 수 없습니다.")
        response.raise_for_status()
        return parse_chart(code, response.json(), int(now))

    def _cache_path(self, code: str) -> Path:
        return self._prices / f"{code}.json"

    def _read_cache(self, code: str) -> PriceHistory | None:
        path = self._cache_path(code)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return PriceHistory(
                symbol=str(raw["symbol"]),
                name=str(raw["name"]),
                currency=str(raw["currency"]),
                exchange_tz=str(raw["exchange_tz"]),
                fetched_at=int(raw["fetched_at"]),
                dates=[date.fromisoformat(d) for d in raw["dates"]],
                close=[float(v) for v in raw["close"]],
                adjclose=[float(v) for v in raw["adjclose"]],
                splits=[(date.fromisoformat(d), str(r)) for d, r in raw.get("splits", [])],
            )
        except FileNotFoundError:
            return None
        except (OSError, ValueError, KeyError, TypeError) as error:
            logger.warning("%s 저장본을 읽지 못해 다시 받습니다: %s", code, error)
            return None

    def _write_cache(self, series: PriceHistory) -> None:
        """임시 파일에 다 쓴 뒤 바꿔치기한다. 쓰다가 죽어도 깨진 파일이 남지 않는다."""
        self._prices.mkdir(parents=True, exist_ok=True)
        path = self._cache_path(series.symbol)
        temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        payload = {
            "symbol": series.symbol,
            "name": series.name,
            "currency": series.currency,
            "exchange_tz": series.exchange_tz,
            "fetched_at": series.fetched_at,
            "dates": [d.isoformat() for d in series.dates],
            "close": series.close,
            "adjclose": series.adjclose,
            "splits": [[d.isoformat(), ratio] for d, ratio in series.splits],
        }
        try:
            temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, path)
        except OSError as error:
            logger.warning("%s 저장본을 쓰지 못했습니다: %s", series.symbol, error)
            temp.unlink(missing_ok=True)

    # ---------- 검색 ----------

    async def search(self, query: str) -> list[SearchHit]:
        """종목 코드나 영문 이름으로 찾는다. 결과는 메모리에 하루 둔다 (한글 이름은 Yahoo가 못 찾는다)."""
        text = query.strip()
        if not text:
            return []
        key = text.lower()
        now = self._clock()
        cached = self._search_cache.get(key)
        if cached is not None and cached[0] > now:
            return cached[1]
        try:
            async with self._yahoo:
                response = await self._client.get(
                    SEARCH_URL,
                    params={"q": text, "quotesCount": "8", "newsCount": "0"},
                    headers=HEADERS,
                    timeout=10.0,
                )
            response.raise_for_status()
            quotes = response.json().get("quotes") or []
        except _FETCH_ERRORS as error:
            raise MarketError("종목을 검색하지 못했습니다. 잠시 뒤 다시 시도해 주세요.") from error
        hits = [
            SearchHit(
                symbol=str(q["symbol"]),
                name=str(q.get("longname") or q.get("shortname") or q["symbol"]),
                exchange=str(q.get("exchDisp") or q.get("exchange") or ""),
                type=str(q.get("quoteType")),
            )
            for q in quotes
            if q.get("quoteType") in SEARCH_TYPES and q.get("symbol")
        ]
        self._search_cache[key] = (now + self._search_ttl_s, hits)
        return hits
