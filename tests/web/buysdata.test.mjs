// web/buysdata.js 매수 내역 탭의 DOM 없는 부분 (F-16, #68): 거르기, 15줄 쪽, 분할 줄 자리, 위 요약,
// 두 열 칸, 열 설명, 머리·카드 매수 글, 칸 글. node --test로 돈다.
// 함수 이름·반환 모양·규칙은 이슈 #68의 설계 메모(architect)를 따른다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BUYS_INTRO,
  CHEAP_LABEL,
  NO_ROWS,
  PAGE_ROWS,
  RETURN_COLUMNS,
  buyCell,
  buyYears,
  buysPage,
  buysSummary,
  cardBuysText,
  cheapLocked,
  columnsNote,
  headerBuysText,
  nextView,
  pageItems,
  returnCell,
} from "../../web/buysdata.js";
import { NO_WHOLE_SHARE_REASON, avgInvestReason } from "../../web/results.js";

const MINUS = "−"; // U+2212 (format.js MINUS)
const DASH = "–"; // U+2013, "60회 중 1–15회 표시"의 사이 표시

const EXPECTED = JSON.parse(
  readFileSync(new URL("../fixtures/expected.json", import.meta.url), "utf8"),
);
const V2 = EXPECTED.v2;
const caseOf = (name) => EXPECTED.cases.find((c) => c.name === name).results;

// ---------- 9-8 조건의 데이터 (결정 d68: expected.json 값은 거기서, 60줄은 상수로) ----------

/**
 * QLD 9-8 조건(매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화, 기본 규칙)의 매수 60회:
 * [날짜, 매수 가격(달러), 이 회차 지금(lot_return_pct, %)].
 * 출처: tests/fixtures/yahoo로 부른 POST /api/backtest(위 조건, 종목 QQQ·QLD·TQQQ·SOXL, rule none)
 * 응답의 results[QLD].buys에서 date·price·lot_return_pct만 옮겼다. 스냅숏 파일은 두지 않는다.
 * 맞는지는 아래 "QLD_ROWS:"·"SWITCH_RESTS:" 테스트가 expected.json v2와 맞춰 본다.
 */
const QLD_ROWS = [
  ["2021-12-01", 42.32, 93.09],
  ["2022-01-03", 45.435, 79.11],
  ["2022-02-01", 37.295, 115.06],
  ["2022-03-01", 32.24, 149.65],
  ["2022-04-01", 35.935, 121.48],
  ["2022-05-02", 27.495, 178.45],
  ["2022-06-01", 24.965, 211.8],
  ["2022-07-01", 20.975, 257.87],
  ["2022-08-01", 25.98, 185.69],
  ["2022-09-01", 23.2, 210.4],
  ["2022-10-03", 19.195, 249.88],
  ["2022-11-01", 19.145, 254.38],
  ["2022-12-01", 21.49, 251.45],
  ["2023-01-03", 17.275, 340.54],
  ["2023-02-01", 22.155, 254.08],
  ["2023-03-01", 20.53, 256.25],
  ["2023-04-03", 24.66, 200.25],
  ["2023-05-01", 24.805, 191.42],
  ["2023-06-01", 29.37, 148.99],
  ["2023-07-03", 32.345, 127.2],
  ["2023-08-01", 34.32, 120.39],
  ["2023-09-01", 33.095, 120.49],
  ["2023-10-02", 30.15, 137.13],
  ["2023-11-01", 29.19, 145.26],
  ["2023-12-01", 34.555, 115.73],
  ["2024-01-02", 36.72, 103.5],
  ["2024-02-01", 40.03, 81.02],
  ["2024-03-01", 44.305, 63.4],
  ["2024-04-01", 43.945, 63.5],
  ["2024-05-01", 39.075, 78.54],
  ["2024-06-03", 44.845, 55.95],
  ["2024-07-01", 50.515, 38.63],
  ["2024-08-01", 45.445, 55.49],
  ["2024-09-03", 45.31, 59.49],
  ["2024-10-01", 48.925, 50.2],
  ["2024-11-01", 49.825, 41.3],
  ["2024-12-02", 55.285, 24.9],
  ["2025-01-02", 53.88, 21.75],
  ["2025-02-03", 55.115, 20.39],
  ["2025-03-03", 50.395, 31.39],
  ["2025-04-01", 45.135, 45.49],
  ["2025-05-01", 45.375, 49.62],
  ["2025-06-02", 53.17, 31.54],
  ["2025-07-01", 57.83, 23.95],
  ["2025-08-01", 58.935, 17.86],
  ["2025-09-02", 61.08, 13.61],
  ["2025-10-01", 69.26, -0.54],
  ["2025-11-03", 75.41, -10.19],
  ["2025-12-01", 71.35, -7.57],
  ["2026-01-02", 70.1, -4.49],
  ["2026-02-02", 72.73, -8.27],
  ["2026-03-02", 68.13, -1.37],
  ["2026-04-01", 62.49, 2.89],
  ["2026-05-01", 82.6, -20.61],
  ["2026-06-01", 99.63, -35.62],
  ["2026-07-01", 93.9, -33.53],
  ["2026-08-03", 86.62, -22.28],
  ["2026-09-01", 87.92, -19.55],
  ["2026-10-01", 96.24, -25.98],
  ["2026-11-02", 80.3, -9.19],
];

/**
 * 같은 조건 rule=switch(기준 종목 QQQ 200일선)에서 쉰 회차 번호 (lot_return_pct가 null인 줄).
 * 출처: 같은 조건 rule=switch로 부른 POST /api/backtest 응답의 results[QLD].buys. 나머지 45회의
 * date·price·lot_return_pct는 기본 규칙(QLD_ROWS)과 같다 (이 회차 지금은 매수 가격·환율과 끝날짜 값만 본다).
 */
const SWITCH_RESTS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 41, 42, 53];

/** QLD_ROWS를 API buys 줄 모양으로. rests의 회차는 쉰 줄(lot_return_pct null)로 바꾼다. */
function rowsOf(rests = []) {
  return QLD_ROWS.map(([date, price, lot], i) => ({
    date,
    price,
    lot_return_pct: rests.includes(i + 1) ? null : lot,
  }));
}

const NONE_ROWS = rowsOf();
const SWITCH_ROWS = rowsOf(SWITCH_RESTS);

/**
 * 9-8 조건 QLD summary. expected.json에서 읽는다.
 * - 매수 횟수·평균 매수 환율: v2.metrics. 평단가: v2.strategies.none.avg_cost_asset
 * - 첫·마지막 매수일, 보유 수량, 원화 평단가, 평가 가격·환율: cases "월1일_200만원_5년"의 QLD.
 *   그 사례는 시작일이 하루 이르지만(2021-11-24) 첫 매수가 같은 2021-12-01이라 값이 같다
 *   (아래 "QLD_ROWS:" 테스트가 평단가로 맞춰 본다)
 */
const CASE_QLD = caseOf("월1일_200만원_5년").QLD;
const QLD_SUMMARY = {
  buys: V2.metrics.buys,
  first_buy: CASE_QLD.first_buy,
  last_buy: CASE_QLD.last_buy,
  shares: CASE_QLD.shares,
  avg_cost_asset: V2.strategies.none.avg_cost_asset,
  avg_cost_invest: CASE_QLD.avg_cost_invest,
  avg_buy_fx: V2.metrics.avg_buy_fx,
  eval_price: CASE_QLD.eval_price,
  eval_fx: CASE_QLD.eval_fx,
};

/**
 * 같은 조건 rule=switch의 QLD summary. 평단가는 v2.strategies.switch.avg_cost_asset.
 * 보유 수량 2393.9329는 expected.json에 없어 rule=switch 응답의 summary.shares에서 옮겼다.
 * 매수 규칙은 투자 통화 평단가를 정하지 않는다 (null, 결정 d39).
 */
const SWITCH_SUMMARY = {
  ...QLD_SUMMARY,
  shares: 2393.9329,
  avg_cost_asset: V2.strategies.switch.avg_cost_asset,
  avg_cost_invest: null,
};

/** API 응답의 params (요청 그대로): 9-8 조건. */
const PARAMS = {
  symbols: ["QQQ", "QLD", "TQQQ", "SOXL"],
  start: V2.period[0],
  end: V2.period[1],
  freq: V2.freq,
  anchor: V2.anchor,
  amount: V2.amount,
  currency: V2.invest_currency,
  fractional: true,
  fee_pct: 0,
  tax: false,
  rule: "none",
  ma_days: V2.ma_days,
  switch_ref: V2.switch_ref,
  include_daily: false,
};
const SWITCH_PARAMS = { ...PARAMS, rule: "switch" };

/** 응답의 notes 모양 그대로 (QLD는 분할 하나, TQQQ는 둘. 같은 응답의 results[].notes). */
const QLD_NOTES = ["2025-11-20 2:1 분할 반영"];
const TQQQ_NOTES = ["2022-01-13 2:1 분할 반영", "2025-11-20 2:1 분할 반영"];

/** results 한 줄. 기본은 9-8 QLD 기본 규칙. */
function result({
  symbol = "QLD",
  currency = "USD",
  notes = QLD_NOTES,
  summary = QLD_SUMMARY,
  buys = NONE_ROWS,
} = {}) {
  return { symbol, name: `${symbol} 이름`, currency, notes, summary, buys };
}

const QLD = result();
const QLD_SWITCH = result({ summary: SWITCH_SUMMARY, buys: SWITCH_ROWS });
/** TQQQ도 9-8 조건에서 QLD와 같은 날 산다 (같은 응답). 분할 줄 자리는 날짜만 보므로 QLD 줄을 쓴다. */
const TQQQ = result({ symbol: "TQQQ", notes: TQQQ_NOTES });

/** 처음 보기: 연도 전체(null), 싸게 산 회차만 끔, 1쪽. */
const ALL = { year: null, cheap: false, page: 1 };
const view = (change) => ({ ...ALL, ...change });

/** 쪽의 줄을 짧게: 산 줄은 회차 번호, 분할 줄은 "분할 날짜". */
function shape(lines) {
  return lines.map((line) => (line.kind === "buy" ? line.no : `분할 ${line.date}`));
}

/** a부터 b까지 (b 포함). */
function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

const SPLIT_TEXT = "2025-11-20 2:1 분할. 이 위의 가격·수량은 분할 반영값입니다.";

// ---------- 상수가 맞는지 (expected.json과 맞춰 본다) ----------

test("QLD_ROWS: 60회이고 첫·마지막 매수일, 평단가가 expected.json 9-8 값과 같다", () => {
  assert.equal(QLD_ROWS.length, V2.metrics.buys);
  assert.equal(QLD_ROWS[0][0], CASE_QLD.first_buy);
  assert.equal(QLD_ROWS.at(-1)[0], CASE_QLD.last_buy);
  assert.equal(CASE_QLD.avg_cost_asset, V2.strategies.none.avg_cost_asset);
});

test("QLD_ROWS: 1·14·60회의 이 회차 지금이 expected.json v2.buy_rows와 같다", () => {
  const dates = Object.keys(V2.buy_rows);
  assert.deepEqual(
    dates.map((d) => QLD_ROWS.findIndex((r) => r[0] === d) + 1),
    [1, 14, 60],
  );
  for (const date of dates) {
    const row = QLD_ROWS.find((r) => r[0] === date);
    assert.equal(row[2], V2.buy_rows[date].lot_return_pct, date);
  }
});

test("QLD_ROWS: 평단가보다 싸게 산 줄 24회, 평가 가격보다 싸게 산 줄 51회 (v2.metrics)", () => {
  const below = (limit) => QLD_ROWS.filter(([, price]) => price < limit).length;
  assert.equal(below(V2.strategies.none.avg_cost_asset), V2.metrics.buys_below_avg_cost);
  assert.equal(below(CASE_QLD.eval_price), V2.metrics.buys_below_eval_price);
});

test("SWITCH_RESTS: 산 줄 45회, 그중 평단가보다 싼 줄 12회·평가 가격보다 싼 줄 36회", () => {
  const bought = SWITCH_ROWS.filter((r) => r.lot_return_pct !== null);
  const below = (limit) => bought.filter((r) => r.price < limit).length;
  const expected = V2.rule_bought.switch;
  assert.equal(bought.length, expected.bought);
  assert.equal(below(V2.strategies.switch.avg_cost_asset), expected.buys_below_avg_cost);
  assert.equal(below(CASE_QLD.eval_price), expected.buys_below_eval_price);
});

// ---------- 문구 ----------

test("PAGE_ROWS·BUYS_INTRO·CHEAP_LABEL·NO_ROWS: 15줄 쪽과 이슈 #68 문구", () => {
  assert.equal(PAGE_ROWS, 15);
  assert.equal(BUYS_INTRO, "한 번 살 때마다의 가격, 환율, 수량과 그때까지의 평단가");
  assert.equal(CHEAP_LABEL, "지금 평단가보다 싸게 산 회차만");
  assert.equal(NO_ROWS, "조건에 맞는 회차가 없습니다");
});

test("RETURN_COLUMNS: '그날 수익률'과 굵은 '이 회차 지금'", () => {
  assert.deepEqual(RETURN_COLUMNS, [
    { key: "return_pct", title: "그날 수익률" },
    { key: "lot_return_pct", title: "이 회차 지금", strong: true },
  ]);
});

// ---------- 보기 상태 ----------

test("nextView: 종목·연도·체크를 바꾸면 1쪽으로 가고, 쪽을 바꾸면 그 쪽", () => {
  const before = { symbol: "QLD", year: "2022", cheap: false, page: 3 };
  assert.deepEqual(nextView(before, { cheap: true }), {
    symbol: "QLD",
    year: "2022",
    cheap: true,
    page: 1,
  });
  assert.deepEqual(nextView(before, { year: null }), {
    symbol: "QLD",
    year: null,
    cheap: false,
    page: 1,
  });
  assert.deepEqual(nextView(before, { symbol: "TQQQ" }), {
    symbol: "TQQQ",
    year: "2022",
    cheap: false,
    page: 1,
  });
  assert.deepEqual(nextView(before, { page: 2 }), { ...before, page: 2 });
  // 받은 보기는 바꾸지 않는다
  assert.deepEqual(before, { symbol: "QLD", year: "2022", cheap: false, page: 3 });
});

test("buyYears: 그 종목의 매수 연도, 오름차순·중복 없음", () => {
  assert.deepEqual(buyYears(QLD.buys), ["2021", "2022", "2023", "2024", "2025", "2026"]);
  const shuffled = [{ date: "2024-03-01" }, { date: "2022-01-03" }, { date: "2024-01-02" }];
  assert.deepEqual(buyYears(shuffled), ["2022", "2024"]);
  assert.deepEqual(buyYears([]), []);
});

test("cheapLocked: 평단가(summary.avg_cost_asset)가 없을 때만 잠근다", () => {
  assert.equal(cheapLocked(QLD), false);
  assert.equal(cheapLocked(QLD_SWITCH), false);
  assert.equal(cheapLocked(result({ summary: { ...QLD_SUMMARY, avg_cost_asset: null } })), true);
});

// ---------- 거르기·쪽 (QLD 9-8) ----------

test("buysPage: 처음에는 1쪽에 1~15회, '60회 중 1–15회 표시', 쪽 4개", () => {
  const page = buysPage(QLD, ALL);
  assert.equal(page.year, null);
  assert.equal(page.cheap, false);
  assert.equal(page.page, 1);
  assert.equal(page.total, 60);
  assert.equal(page.pages, 4);
  assert.equal(page.first, 1);
  assert.equal(page.last, 15);
  assert.equal(page.status, `60회 중 1${DASH}15회 표시`);
  assert.deepEqual(shape(page.lines), range(1, 15));
  assert.deepEqual(page.lines[0], { kind: "buy", no: 1, row: QLD.buys[0] });
});

test("buysPage: 4쪽은 46~60회, '60회 중 46–60회 표시'", () => {
  const page = buysPage(QLD, view({ page: 4 }));
  assert.equal(page.page, 4);
  assert.equal(page.first, 46);
  assert.equal(page.last, 60);
  assert.equal(page.status, `60회 중 46${DASH}60회 표시`);
  const buys = page.lines.filter((line) => line.kind === "buy");
  assert.deepEqual(
    buys.map((line) => line.no),
    range(46, 60),
  );
  assert.deepEqual(buys.at(-1).row, QLD.buys[59]);
});

test("buysPage: 연도 2022는 12회, '12회 중 1–12회 표시', 회차 번호는 거르기 전 번호", () => {
  const page = buysPage(QLD, view({ year: "2022" }));
  assert.equal(page.year, "2022");
  assert.equal(page.total, 12);
  assert.equal(page.pages, 1);
  assert.equal(page.status, `12회 중 1${DASH}12회 표시`);
  assert.deepEqual(
    page.lines.filter((line) => line.kind === "buy").map((line) => line.no),
    range(2, 13),
  );
});

test("buysPage: 싸게 산 회차만은 24회(v2 buys_below_avg_cost), '24회 중 1–15회 표시', 쪽 2개", () => {
  const page = buysPage(QLD, view({ cheap: true }));
  assert.equal(page.cheap, true);
  assert.equal(page.total, V2.metrics.buys_below_avg_cost);
  assert.equal(page.pages, 2);
  assert.equal(page.status, `24회 중 1${DASH}15회 표시`);
  assert.deepEqual(shape(page.lines), range(3, 17));
});

test("buysPage: 싸게 산 회차만 2쪽은 18~26회, '24회 중 16–24회 표시'", () => {
  const page = buysPage(QLD, view({ cheap: true, page: 2 }));
  assert.equal(page.first, 16);
  assert.equal(page.last, 24);
  assert.equal(page.status, `24회 중 16${DASH}24회 표시`);
  assert.deepEqual(
    page.lines.filter((line) => line.kind === "buy").map((line) => line.no),
    range(18, 26),
  );
});

test("buysPage: 평단가와 같은 가격에 산 회차는 싸게 산 회차가 아니다", () => {
  const rows = [
    { date: "2024-01-02", price: 10, lot_return_pct: 5 },
    { date: "2024-02-01", price: 9.99, lot_return_pct: 5.1 },
    { date: "2024-03-01", price: 10.01, lot_return_pct: 4.9 },
  ];
  const same = result({ notes: [], summary: { ...QLD_SUMMARY, avg_cost_asset: 10 }, buys: rows });
  const page = buysPage(same, view({ cheap: true }));
  assert.equal(page.total, 1);
  assert.deepEqual(shape(page.lines), [2]);
});

test("buysPage: 레버리지 전환의 싸게 산 회차만은 쉰 줄을 빼고 12회 (v2.rule_bought.switch)", () => {
  const page = buysPage(QLD_SWITCH, view({ cheap: true }));
  assert.equal(page.total, V2.rule_bought.switch.buys_below_avg_cost);
  assert.equal(page.status, `12회 중 1${DASH}12회 표시`);
  // 3~14회는 평단가보다 싸지만 쉰 줄이라 빠진다
  assert.deepEqual(
    page.lines.filter((line) => line.kind === "buy").map((line) => line.no),
    range(15, 26),
  );
});

test("buysPage: 없는 쪽(9쪽)은 마지막 쪽(4쪽)으로, 0쪽은 1쪽으로 맞춘다", () => {
  const last = buysPage(QLD, view({ page: 9 }));
  assert.equal(last.page, 4);
  assert.equal(last.status, `60회 중 46${DASH}60회 표시`);
  assert.equal(buysPage(QLD, view({ page: 0 })).page, 1);
});

test("buysPage: 연도 2021과 싸게 산 회차만을 같이 고르면 0회, '조건에 맞는 회차가 없습니다'", () => {
  const page = buysPage(QLD, view({ year: "2021", cheap: true }));
  assert.equal(page.total, 0);
  assert.equal(page.status, NO_ROWS);
  assert.deepEqual(page.lines, []);
});

test("buysPage: 평단가가 없어 잠긴 결과는 싸게 산 회차만을 켜도 거르지 않는다", () => {
  // 정수 주만 사서 끝날짜까지 한 주도 못 산 결과: 모든 줄이 쉼이고 평단가가 없다 (결정 d52 ⑥)
  const rows = NONE_ROWS.slice(0, 3).map((row) => ({ ...row, lot_return_pct: null }));
  const locked = result({
    notes: [],
    summary: { ...QLD_SUMMARY, buys: 3, avg_cost_asset: null, avg_cost_invest: null },
    buys: rows,
  });
  const page = buysPage(locked, view({ cheap: true }));
  assert.equal(page.cheap, false);
  assert.equal(page.total, 3);
  assert.equal(page.status, `3회 중 1${DASH}3회 표시`);
});

test("buysPage: 매일 10년쯤(2,500회)이면 167쪽, 글의 회차 수에 천 단위 쉼표", () => {
  const start = Date.UTC(2016, 0, 4);
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    price: 10,
    lot_return_pct: 0,
  }));
  const daily = result({ notes: [], summary: { ...QLD_SUMMARY, buys: 2500 }, buys: rows });
  const first = buysPage(daily, ALL);
  assert.equal(first.pages, 167);
  assert.equal(first.status, `2,500회 중 1${DASH}15회 표시`);
  const last = buysPage(daily, view({ page: 167 }));
  assert.equal(last.first, 2491);
  assert.equal(last.last, 2500);
  assert.equal(last.status, `2,500회 중 2,491${DASH}2,500회 표시`);
});

// ---------- 분할 줄 자리 ----------

test("buysPage 분할 줄: QLD 4쪽 48회(2025-11-03)와 49회(2025-12-01) 사이에 2025-11-20 2:1 분할", () => {
  const page = buysPage(QLD, view({ page: 4 }));
  assert.deepEqual(shape(page.lines), [46, 47, 48, "분할 2025-11-20", ...range(49, 60)]);
  assert.deepEqual(page.lines[3], {
    kind: "split",
    date: "2025-11-20",
    ratio: "2:1",
    text: SPLIT_TEXT,
  });
  for (const no of [1, 2, 3]) {
    const lines = buysPage(QLD, view({ page: no })).lines;
    assert.ok(
      lines.every((line) => line.kind === "buy"),
      `${no}쪽에는 분할 줄이 없다`,
    );
  }
});

test("buysPage 분할 줄: TQQQ는 1쪽 2·3회 사이에 2022-01-13, 4쪽 48·49회 사이에 2025-11-20", () => {
  const first = buysPage(TQQQ, ALL);
  assert.deepEqual(shape(first.lines), [1, 2, "분할 2022-01-13", ...range(3, 15)]);
  assert.deepEqual(first.lines[2], {
    kind: "split",
    date: "2022-01-13",
    ratio: "2:1",
    text: "2022-01-13 2:1 분할. 이 위의 가격·수량은 분할 반영값입니다.",
  });
  const last = buysPage(TQQQ, view({ page: 4 }));
  assert.deepEqual(shape(last.lines), [46, 47, 48, "분할 2025-11-20", ...range(49, 60)]);
  assert.equal(last.lines[3].text, SPLIT_TEXT);
});

test("buysPage 분할 줄: 쪽의 15번째 줄 바로 뒤 분할은 그 쪽 끝에 두고 다음 쪽 맨 앞에는 없다", () => {
  // 가정한 분할: 15회(2023-02-01)와 16회(2023-03-01) 사이
  const boundary = result({ notes: ["2023-02-15 2:1 분할 반영"] });
  const first = buysPage(boundary, ALL);
  assert.deepEqual(shape(first.lines), [...range(1, 15), "분할 2023-02-15"]);
  assert.equal(first.status, `60회 중 1${DASH}15회 표시`); // 분할 줄은 15줄에 세지 않는다
  const second = buysPage(boundary, view({ page: 2 }));
  assert.deepEqual(shape(second.lines), range(16, 30));
});

test("buysPage 분할 줄: 분할일에 산 줄은 분할 뒤라 그 줄 앞에 둔다", () => {
  // 가정한 분할: 3회 매수일(2022-02-01)과 같은 날
  const sameDay = result({ notes: ["2022-02-01 2:1 분할 반영"] });
  assert.deepEqual(shape(buysPage(sameDay, ALL).lines), [1, 2, "분할 2022-02-01", ...range(3, 15)]);
});

test("buysPage 분할 줄: 분할일 전에 산 줄이 없으면 두지 않는다", () => {
  // 가정한 분할: 첫 매수(2021-12-01)보다 앞
  const before = result({ notes: ["2021-11-26 2:1 분할 반영"] });
  for (const no of [1, 2, 3, 4]) {
    const lines = buysPage(before, view({ page: no })).lines;
    assert.ok(
      lines.every((line) => line.kind === "buy"),
      `${no}쪽`,
    );
  }
});

test("buysPage 분할 줄: 싸게 산 회차만이면 분할 전 마지막 보이는 줄(26회) 뒤, 2쪽 끝", () => {
  const first = buysPage(QLD, view({ cheap: true }));
  assert.ok(first.lines.every((line) => line.kind === "buy"));
  const second = buysPage(QLD, view({ cheap: true, page: 2 }));
  assert.deepEqual(shape(second.lines), [...range(18, 26), "분할 2025-11-20"]);
});

test("buysPage 분할 줄: 연도 2025면 48회(2025-11-03) 뒤, 2022면 끝(13회) 뒤, 2026이면 없다", () => {
  const y2025 = buysPage(QLD, view({ year: "2025" }));
  assert.deepEqual(shape(y2025.lines), [...range(38, 48), "분할 2025-11-20", 49]);
  // 거른 목록에서 분할일 전에 산 마지막 보이는 줄이 13회라 그 뒤 (싸게 산 회차만과 같은 규칙)
  const y2022 = buysPage(QLD, view({ year: "2022" }));
  assert.deepEqual(shape(y2022.lines), [...range(2, 13), "분할 2025-11-20"]);
  const y2026 = buysPage(QLD, view({ year: "2026" }));
  assert.equal(y2026.total, 11);
  assert.deepEqual(shape(y2026.lines), range(50, 60));
});

test("buysPage 분할 줄: 쉰 회차도 보이는 줄로 센다 (레버리지 전환 42회 쉼 바로 뒤)", () => {
  // 가정한 분할: 42회(2025-05-01, 쉼)와 43회(2025-06-02) 사이
  const rest = result({
    notes: ["2025-05-15 2:1 분할 반영"],
    summary: SWITCH_SUMMARY,
    buys: SWITCH_ROWS,
  });
  const page = buysPage(rest, view({ page: 3 }));
  assert.deepEqual(shape(page.lines), [...range(31, 42), "분할 2025-05-15", 43, 44, 45]);
});

// ---------- 쪽 번호 ----------

const PAGE_ITEMS = [
  [1, 1, [1]],
  [1, 4, [1, 2, 3, 4]],
  [7, 7, [1, 2, 3, 4, 5, 6, 7]],
  [1, 167, [1, 2, 3, null, 167]],
  [4, 167, [1, 2, 3, 4, 5, 6, null, 167]],
  [6, 167, [1, null, 4, 5, 6, 7, 8, null, 167]],
  [167, 167, [1, null, 165, 166, 167]],
];

for (const [page, pages, items] of PAGE_ITEMS) {
  test(`pageItems: ${pages}쪽 중 ${page}쪽 → ${items.map((i) => i ?? "…").join(" ")}`, () => {
    assert.deepEqual(pageItems(page, pages), items);
  });
}

// ---------- 위 요약 ----------

/** 요약 칸 하나. */
function itemOf(items, key) {
  const item = items.find((i) => i.key === key);
  assert.ok(item, `요약에 ${key} 칸이 없다`);
  return item;
}

test("buysSummary: QLD 기본 규칙 60회 · 2,336.31주 · $37.97(51,363원) · 1,352.57원 · $17.28/$99.63", () => {
  const items = buysSummary(QLD, PARAMS);
  assert.deepEqual(
    items.map((i) => [i.key, i.label, i.text]),
    [
      ["buys", "매수", "60회"],
      ["shares", "보유 수량", "2,336.31주"],
      ["avg", "평단가", "$37.97"],
      ["avg_fx", "평균 매수 환율", "1,352.57원"],
      ["range", "가장 싸게 / 비싸게", "$17.28 / $99.63"],
    ],
  );
  const avg = itemOf(items, "avg");
  assert.equal(avg.sub, "51,363원");
  assert.equal(avg.title, null); // 기본 규칙은 원화 평단가가 있어 이유를 달지 않는다
});

test("buysSummary: 레버리지 전환은 '매수일 60회 · 산 날 45회', 원화 평단가 '—'과 이유(결정 d39)", () => {
  const items = buysSummary(QLD_SWITCH, SWITCH_PARAMS);
  assert.equal(itemOf(items, "buys").text, "매수일 60회 · 산 날 45회");
  assert.equal(itemOf(items, "shares").text, "2,393.93주");
  const avg = itemOf(items, "avg");
  assert.equal(avg.text, "$37.06");
  assert.equal(avg.sub, "—");
  assert.equal(avg.title, avgInvestReason("KRW"));
  assert.equal(itemOf(items, "avg_fx").text, "1,352.57원");
});

test("buysSummary: 가장 싸게 / 비싸게는 산 줄만 본다 (14회 $17.28은 쉼이라 $20.53)", () => {
  assert.equal(itemOf(buysSummary(QLD_SWITCH, SWITCH_PARAMS), "range").text, "$20.53 / $99.63");
});

test("buysSummary: 기본 규칙 정수 주만에 한 주도 못 사 평단가가 없으면 '—'와 그 이유 (결정 d52 ⑥)", () => {
  // 카드 ⓘ(avgInvestTip)와 같은 이유를 요약 평단가 칸에 단다 (PR #79 Actions 리뷰 참고 1)
  const none = result({
    summary: { ...QLD_SUMMARY, avg_cost_asset: null, avg_cost_invest: null, shares: 0 },
    buys: NONE_ROWS.map((row) => ({ ...row, lot_return_pct: null })),
  });
  const avg = itemOf(buysSummary(none, { ...PARAMS, fractional: false }), "avg");
  assert.equal(avg.text, "—");
  assert.equal(avg.sub, "—");
  assert.equal(avg.title, NO_WHOLE_SHARE_REASON);
});

test("buysSummary: 통화가 같으면 평균 매수 환율 칸이 없고 평단가 작은 글씨도 없다", () => {
  // 달러 투자에 달러 종목: cases "월1일_1500달러_5년" QQQ. 원화 투자에 한국 종목: "…_삼성전자".
  // summary는 그 사례 값, avg_buy_fx는 통화가 같아 null (상세 설계 4절). buys는 칸 모양만 보려고
  // 1·60회 두 줄만 둔다: 가격은 QQQ는 9-8 응답, 삼성전자는 tests/fixtures/yahoo/005930.KS.json 종가.
  // lot_return_pct는 산 줄이라는 표시로만 0을 둔다 (값은 이 테스트에서 보지 않는다)
  const usd = caseOf("월1일_1500달러_5년").QQQ;
  const qqq = result({
    symbol: "QQQ",
    notes: [],
    summary: { ...usd, avg_buy_fx: null },
    buys: [
      { date: "2021-12-01", price: 387.12, lot_return_pct: 0 },
      { date: "2026-11-02", price: 681.09, lot_return_pct: 0 },
    ],
  });
  const usdItems = buysSummary(qqq, { ...PARAMS, currency: "USD", amount: 1500 });
  assert.deepEqual(
    usdItems.map((i) => i.key),
    ["buys", "shares", "avg", "range"],
  );
  assert.equal(itemOf(usdItems, "avg").text, "$424.06");
  assert.equal(itemOf(usdItems, "avg").sub, null);

  const krw = caseOf("월1일_200만원_5년_삼성전자")["005930.KS"];
  const samsung = result({
    symbol: "005930.KS",
    currency: "KRW",
    notes: [],
    summary: { ...krw, avg_buy_fx: null },
    buys: [
      { date: "2021-12-01", price: 74_400, lot_return_pct: 0 },
      { date: "2026-11-02", price: 229_000, lot_return_pct: 0 },
    ],
  });
  const krwItems = buysSummary(samsung, PARAMS);
  assert.deepEqual(
    krwItems.map((i) => i.key),
    ["buys", "shares", "avg", "range"],
  );
  assert.equal(itemOf(krwItems, "avg").text, "76,325원");
  assert.equal(itemOf(krwItems, "avg").sub, null);
  assert.equal(itemOf(krwItems, "range").text, "74,400원 / 229,000원");
});

// ---------- 두 열 칸 (그날 수익률, 이 회차 지금) ----------

/** 이슈 #68 완료 기준의 화면 글과 색: [그날 수익률, 이 회차 지금]. */
const SHOWN = {
  "2021-12-01": [
    { text: "0.0%", tone: "" },
    { text: "+93.1%", tone: "pos" },
  ],
  "2023-01-03": [
    { text: `${MINUS}33.5%`, tone: "neg" },
    { text: "+340.5%", tone: "pos" },
  ],
  "2026-11-02": [
    { text: "+107.2%", tone: "pos" },
    { text: `${MINUS}9.2%`, tone: "neg" },
  ],
};

test("returnCell: QLD 1·14·60회 두 열은 소수 1자리, 손익 기호와 색 (v2.buy_rows)", () => {
  for (const [date, row] of Object.entries(V2.buy_rows)) {
    const [day, lot] = SHOWN[date];
    assert.deepEqual(returnCell(row.return_pct), day, `${date} 그날 수익률`);
    assert.deepEqual(returnCell(row.lot_return_pct), lot, `${date} 이 회차 지금`);
  }
});

test("returnCell: 값이 없으면(쉰 회차의 이 회차 지금) '—'에 색 없음", () => {
  assert.deepEqual(returnCell(null), { text: "—", tone: "" });
});

test("returnCell: 0.0%로 보이는 작은 값은 부호와 색이 없다", () => {
  assert.deepEqual(returnCell(-0.04), { text: "0.0%", tone: "" });
  assert.deepEqual(returnCell(0.04), { text: "0.0%", tone: "" });
});

// ---------- 표 아래 열 설명 ----------

const NOTE_HEAD =
  "'그날 수익률'은 그 매수일까지 넣은 돈 기준, '이 회차 지금'은 그날 산 몫만 지금 팔았을 때";

test("columnsNote: 원화 투자는 '(원화)'로 끝난다 (결정 d59, 투자 통화)", () => {
  assert.equal(
    columnsNote(PARAMS, QLD),
    "'그날 수익률'은 그 매수일까지 넣은 돈 기준, '이 회차 지금'은 그날 산 몫만 지금 팔았을 때(원화)",
  );
  assert.equal(columnsNote({ ...PARAMS, include_fx: true }, QLD), `${NOTE_HEAD}(원화)`);
});

test("columnsNote: 달러 투자에 달러 종목은 '(달러)'", () => {
  assert.equal(columnsNote({ ...PARAMS, currency: "USD" }, QLD), `${NOTE_HEAD}(달러)`);
});

test("columnsNote: include_fx가 false이고 통화가 다르면 '(달러, 환율 변동 제외)'", () => {
  assert.equal(
    columnsNote({ ...PARAMS, include_fx: false }, QLD),
    `${NOTE_HEAD}(달러, 환율 변동 제외)`,
  );
});

test("columnsNote: include_fx가 false여도 통화가 같으면 '(달러)'", () => {
  const usd = { ...PARAMS, currency: "USD", include_fx: false };
  assert.equal(columnsNote(usd, QLD), `${NOTE_HEAD}(달러)`);
});

// ---------- 머리·카드의 매수 글 (산 횟수와 매수일 수, PR #48 참고 1) ----------

/** 9-8 조건의 네 종목. 모두 같은 날 60번 산다 (같은 응답). 머리 글은 summary와 쉰 줄만 본다. */
function four(summary, buys) {
  return ["QQQ", "QLD", "TQQQ", "SOXL"].map((symbol) => result({ symbol, summary, buys }));
}

test("headerBuysText: 종목마다 같고 쉰 줄이 없으면 지금 글 그대로", () => {
  assert.equal(
    headerBuysText(four(QLD_SUMMARY, NONE_ROWS)),
    "종목마다 60회 매수 (2021-12-01 ~ 2026-11-02)",
  );
});

test("headerBuysText: 쉰 줄이 있으면 '종목마다 매수일 60회 (…)'", () => {
  assert.equal(
    headerBuysText(four(SWITCH_SUMMARY, SWITCH_ROWS)),
    "종목마다 매수일 60회 (2021-12-01 ~ 2026-11-02)",
  );
});

test("headerBuysText: 매수 횟수가 종목마다 다르면 '매수 58~60회', 쉰 줄이 있으면 '매수일 58~60회'", () => {
  const later = { ...QLD_SUMMARY, buys: 58, first_buy: "2022-02-01" };
  const none = [QLD, result({ symbol: "QQQM", summary: later, buys: NONE_ROWS.slice(2) })];
  assert.equal(headerBuysText(none), "매수 58~60회 (종목마다 다름)");
  const rests = [
    QLD_SWITCH,
    result({ symbol: "QQQM", summary: later, buys: SWITCH_ROWS.slice(2) }),
  ];
  assert.equal(headerBuysText(rests), "매수일 58~60회 (종목마다 다름)");
});

test("cardBuysText: 쉰 줄이 없으면 '60회', 있으면 '매수일 60회 (15회 쉼)'", () => {
  assert.equal(cardBuysText(QLD), "60회");
  assert.equal(cardBuysText(QLD_SWITCH), "매수일 60회 (15회 쉼)");
});

// ---------- 칸 글 (charts.js cell()에서 옮긴 규칙) ----------

/** QLD 9-8 1회 줄 전체 (같은 응답의 results[QLD].buys[0]). */
const QLD_FIRST = {
  date: "2021-12-01",
  price: 42.32,
  fx: 1182.86,
  qty: 39.9531,
  cum_qty: 39.9531,
  avg_cost_asset: 42.32,
  avg_cost_invest: 50059.0,
  invested: 2_000_000.0,
  return_pct: 0.0,
  lot_return_pct: 93.09,
};

test("buyCell: QLD 1회 줄의 칸 글", () => {
  const text = (key) => buyCell(key, QLD_FIRST, QLD, PARAMS);
  assert.equal(text("date"), "2021-12-01");
  assert.equal(text("price"), "$42.32");
  assert.equal(text("fx"), "1,182.86");
  assert.equal(text("qty"), "39.9531");
  assert.equal(text("cum_qty"), "39.9531");
  assert.equal(text("avg_cost_asset"), "$42.32");
  assert.equal(text("avg_cost_invest"), "50,059원"); // 원화 평단가는 줄이지 않는다
  assert.equal(text("invested"), "200만원"); // 누적 투자금은 억·만으로 줄인다
});

test("buyCell: 통화가 같으면 환율은 '—'", () => {
  const usd = { ...PARAMS, currency: "USD" };
  assert.equal(buyCell("fx", { ...QLD_FIRST, fx: 1 }, QLD, usd), "—");
});

test("buyCell: 기본 규칙 정수 주만은 수량 자리를 채우지 않고, 매수 규칙은 4자리를 채운다 (9-6)", () => {
  const row = { ...QLD_FIRST, qty: 47, cum_qty: 47 };
  assert.equal(buyCell("qty", row, QLD, { ...PARAMS, fractional: false }), "47");
  const rule = { ...SWITCH_PARAMS, fractional: false };
  assert.equal(buyCell("qty", row, QLD_SWITCH, rule), "47.0000");
});

test("buyCell: 매수 규칙이라 투자 통화 평단가가 없으면 '—'", () => {
  const row = { ...QLD_FIRST, avg_cost_invest: null };
  assert.equal(buyCell("avg_cost_invest", row, QLD_SWITCH, SWITCH_PARAMS), "—");
});
