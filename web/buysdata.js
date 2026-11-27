// 매수 내역 탭(F-16)의 DOM 없는 부분: 거르기, 15줄 쪽, 분할 줄 자리, 요약 칸, 두 열 글, 그리고 결과 머리·
// 카드의 매수 횟수 글. 그리기는 buys.js가 한다. 산 회차와 쉰 회차는 chartdata.js isRest 한 기준을 쓴다
// (lot_return_pct가 null이면 쉼, 상세 설계 4절, 결정 d76).

import { boughtFractional, isRest, restCount, splitsOf } from "./chartdata.js";
import { fx, investLabel, money, pct, price, qty } from "./format.js";
import { avgInvestNote } from "./results.js";

/** 한 쪽에 보이는 회차 수 (F-16). */
export const PAGE_ROWS = 15;
export const BUYS_INTRO = "한 번 살 때마다의 가격, 환율, 수량과 그때까지의 평단가";
export const CHEAP_LABEL = "지금 평단가보다 싸게 산 회차만";
export const NO_ROWS = "조건에 맞는 회차가 없습니다";

/**
 * 표 끝 두 열 (F-16, 결정 d59). BUY_COLUMNS에 넣지 않는다: BUY_COLUMNS는 CSV와 같이 쓰고, 이 두 열은
 * CSV에 넣지 않는다 (#69). strong은 굵게 보이는 열이다.
 */
export const RETURN_COLUMNS = [
  { key: "return_pct", title: "그날 수익률" },
  { key: "lot_return_pct", title: "이 회차 지금", strong: true },
];

const n = (value) => value.toLocaleString("ko-KR");

/**
 * 보기 상태를 바꾼다. view = { symbol, year(null이면 전체), cheap, page(1부터) }.
 * 종목·연도·체크를 바꾸면 1쪽으로 가고, change에 page가 있을 때만 그 쪽으로 간다 (F-16).
 */
export function nextView(view, change) {
  return { ...view, ...change, page: change.page ?? 1 };
}

/** 매수 연도들 ("2021" …), 오름차순·중복 없음. 쉰 회차도 센다. */
export function buyYears(buys) {
  return [...new Set(buys.map((row) => row.date.slice(0, 4)))].sort();
}

/** 지금 평단가가 없어(정수 주만에서 한 주도 못 삼) "싸게 산 회차만"을 쓸 수 없는지. */
export function cheapLocked(result) {
  const avg = result.summary.avg_cost_asset;
  return avg === null || avg === undefined;
}

/** 지금 평단가보다 싸게 산 회차: 산 회차이고 매수 가격 < 지금 평단가 (같으면 아니다, 결정 d58). */
function boughtCheap(row, avg) {
  return !isRest(row) && row.price < avg;
}

/** 분할 줄 글 (F-16). */
function splitText(split) {
  return `${split.date} ${split.ratio} 분할. 이 위의 가격·수량은 분할 반영값입니다.`;
}

/**
 * 한 쪽의 표. result는 /api/backtest results[] 한 줄, view는 nextView의 보기 상태.
 * - 거르기: 연도는 date 앞 4자리, 싸게는 boughtCheap. 회차 번호(no)는 거르기 전 번호다.
 * - 맞춘 값을 돌려준다: 그 종목에 없는 연도는 전체(null), 잠긴 체크는 false, 쪽은 1..pages.
 * - 분할 줄: 분할마다 거른 목록에서 분할일 전 마지막 줄 바로 뒤에 둔다. 그 줄이 이 쪽에 있을 때만 이 쪽에
 *   들어가고, 그런 줄이 없으면 두지 않는다. 쉰 회차도 보이는 줄로 센다 (그 줄의 종가도 분할 반영값이다).
 * 돌려주는 값: { year, cheap, page, total, pages, first, last, status, lines }.
 * lines는 { kind: "buy", no, row } 또는 { kind: "split", date, ratio, text }다.
 */
export function buysPage(result, view) {
  const year = view.year && buyYears(result.buys).includes(view.year) ? view.year : null;
  const cheap = Boolean(view.cheap) && !cheapLocked(result);
  const avg = result.summary.avg_cost_asset;
  const rows = result.buys.flatMap((row, i) => {
    if (year !== null && row.date.slice(0, 4) !== year) return [];
    if (cheap && !boughtCheap(row, avg)) return [];
    return [{ no: i + 1, row }];
  });
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_ROWS));
  const page = Math.min(Math.max(1, Math.trunc(view.page) || 1), pages);
  const start = (page - 1) * PAGE_ROWS;
  const shown = rows.slice(start, start + PAGE_ROWS);
  // 분할을 거른 목록의 몇 번째 줄 뒤에 둘지 (-1이면 그 앞에 산 줄이 없어 두지 않는다)
  const after = new Map();
  const splits = splitsOf(result.notes).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const split of splits) {
    const at = rows.findLastIndex((item) => item.row.date < split.date);
    if (at >= 0) after.set(at, [...(after.get(at) ?? []), split]);
  }
  const lines = shown.flatMap((item, i) => [
    { kind: "buy", ...item },
    ...(after.get(start + i) ?? []).map((split) => ({
      kind: "split",
      ...split,
      text: splitText(split),
    })),
  ]);
  const first = total ? start + 1 : 0;
  const last = total ? start + shown.length : 0;
  const status = total ? `${n(total)}회 중 ${n(first)}–${n(last)}회 표시` : NO_ROWS;
  return { year, cheap, page, total, pages, first, last, status, lines };
}

/**
 * 쪽 번호 버튼들. null은 "…"다. 7쪽 이하면 모두, 넘으면 첫 쪽·끝 쪽과 지금 쪽 앞뒤 2쪽만 둔다
 * (매일 10년이면 약 167쪽). 한 쪽만 건너뛰면 "…" 대신 그 번호를 둔다.
 */
export function pageItems(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const keep = new Set([1, pages]);
  for (let p = page - 2; p <= page + 2; p += 1) if (p >= 1 && p <= pages) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const items = [];
  for (const p of sorted) {
    const previous = items.at(-1);
    if (previous !== undefined && p - previous === 2) items.push(p - 1);
    else if (previous !== undefined && p - previous > 2) items.push(null);
    items.push(p);
  }
  return items;
}

/**
 * 위 요약 칸 (F-16). 종목 전체 기준이고 연도·체크 거르기를 따르지 않는다. params는 API 응답의 params.
 * 돌려주는 값: [{ key, label, text, sub, title }]. sub는 작은 글씨, title은 툴팁(없으면 null).
 * - 매수: 쉰 회차가 있으면 "매수일 60회 · 산 날 45회"
 * - 평단가: 종목 통화, 작은 글씨로 투자 통화 평단가. 매수 규칙이라 없으면 "—"와 이유 (결정 d39)
 * - 평균 매수 환율: 종목 통화가 투자 통화와 같으면 칸이 없다
 * - 가장 싸게 / 비싸게: 산 회차만 본다
 */
export function buysSummary(result, params) {
  const s = result.summary;
  const cur = result.currency;
  const invest = params.currency;
  const rests = restCount(result.buys);
  const bought = result.buys.filter((row) => !isRest(row)).map((row) => row.price);
  const avgInvest =
    s.avg_cost_invest === null || s.avg_cost_invest === undefined
      ? "—"
      : money(s.avg_cost_invest, invest, { short: false });
  const cells = [
    {
      key: "buys",
      label: "매수",
      text: rests ? `매수일 ${n(s.buys)}회 · 산 날 ${n(s.buys - rests)}회` : `${n(s.buys)}회`,
      sub: null,
      title: null,
    },
    { key: "shares", label: "보유 수량", text: `${qty(s.shares)}주`, sub: null, title: null },
    {
      key: "avg",
      label: "평단가",
      text: price(s.avg_cost_asset, cur),
      sub: cur === invest ? null : avgInvest,
      title: cur === invest ? null : avgInvestNote(params, s.avg_cost_invest),
    },
  ];
  if (cur !== invest && s.avg_buy_fx !== null && s.avg_buy_fx !== undefined) {
    cells.push({
      key: "avg_fx",
      label: "평균 매수 환율",
      text: `${fx(s.avg_buy_fx)}${invest === "KRW" ? "원" : ""}`,
      sub: null,
      title: null,
    });
  }
  cells.push({
    key: "range",
    label: "가장 싸게 / 비싸게",
    text: bought.length
      ? `${price(Math.min(...bought), cur)} / ${price(Math.max(...bought), cur)}`
      : "—",
    sub: null,
    title: null,
  });
  return cells;
}

/** 매수 내역 칸 글 (BUY_COLUMNS의 key). 같은 통화면 환율은 "—", 수량은 소수점이면 4자리를 채운다. */
export function buyCell(key, row, result, params) {
  const value = row[key];
  const invest = params.currency;
  switch (key) {
    case "date":
      return value;
    case "price":
    case "avg_cost_asset":
      return price(value, result.currency);
    case "fx":
      return result.currency === invest ? "—" : fx(value);
    case "qty":
    case "cum_qty":
      return qty(value, 4, { fixed: boughtFractional(params) });
    case "avg_cost_invest":
      return money(value, invest, { short: false });
    default:
      return money(value, invest);
  }
}

/**
 * 두 열 칸 (F-16): 소수 1자리와 손익 기호. 색은 화면에 보이는 1자리 값의 부호다 (−0.04는 "0.0%"라 색 없음).
 * 값이 없으면(쉰 회차의 이 회차 지금) "—".
 */
export function returnCell(value) {
  if (value === null || value === undefined) return { text: "—", tone: "" };
  const shown = Number(value.toFixed(1));
  return { text: pct(value, 1), tone: shown > 0 ? "pos" : shown < 0 ? "neg" : "" };
}

/**
 * 표 아래 두 열 설명. 괄호는 투자 통화 이름이다. 환율 변동 제외(F-24, include_fx false)에서 종목 통화가
 * 다르면 이 회차 지금은 종목 통화 수익률이라(결정 d72) 괄호를 "(달러, 환율 변동 제외)"로 쓴다.
 * include_fx가 없는 응답은 켬으로 본다.
 */
export function columnsNote(params, result) {
  const fxOff = params.include_fx === false && result.currency !== params.currency;
  const unit = fxOff
    ? `${investLabel(result.currency)}, 환율 변동 제외`
    : investLabel(params.currency);
  return (
    "'그날 수익률'은 그 매수일까지 넣은 돈 기준, " +
    `'이 회차 지금'은 그날 산 몫만 지금 팔았을 때(${unit})`
  );
}

/**
 * 결과 머리 둘째 줄의 매수 부분 (F-06). 쉰 회차가 없으면 v1 글 그대로이고, 있으면 "매수일"이라고 쓴다
 * (산 횟수는 카드와 매수 내역 요약에 있다). 종목마다 횟수·첫·끝 매수일이 다르면 범위로 쓴다.
 */
export function headerBuysText(results) {
  const rests = results.some((r) => restCount(r.buys) > 0);
  const kinds = new Set(
    results.map((r) => `${r.summary.buys}|${r.summary.first_buy}|${r.summary.last_buy}`),
  );
  const first = results[0].summary;
  if (kinds.size === 1) {
    const span = `(${first.first_buy} ~ ${first.last_buy})`;
    return rests
      ? `종목마다 매수일 ${n(first.buys)}회 ${span}`
      : `종목마다 ${n(first.buys)}회 매수 ${span}`;
  }
  const counts = results.map((r) => r.summary.buys);
  // 범위 숫자는 v1처럼 천 단위 쉼표 없이 쓴다 (쉰 회차가 없을 때 글이 바뀌지 않게)
  return `${rests ? "매수일" : "매수"} ${Math.min(...counts)}~${Math.max(...counts)}회 (종목마다 다름)`;
}

/** 카드 매수 줄 앞부분: "60회", 쉰 회차가 있으면 "매수일 60회 (15회 쉼)". */
export function cardBuysText(result) {
  const s = result.summary;
  const rests = restCount(result.buys);
  return rests ? `매수일 ${n(s.buys)}회 (${n(rests)}회 쉼)` : `${n(s.buys)}회`;
}
