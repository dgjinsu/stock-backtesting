// web/analysisdata.js 분석 탭의 DOM 없는 부분 (F-14 얼마나 흔들렸나 #60, 연도별 결과·달마다
// 얼마나 움직였나 #61, 수익은 어디서 왔나·얼마에 샀나 #64). node --test로 돈다.
// 함수 이름·반환 모양·규칙은 이슈 #60·#61·#64의 설계 메모(architect)를 따른다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NO_BUYS,
  NO_MONTHS,
  RISK_COLUMNS,
  analysisIntro,
  analysisNotes,
  buyPriceDist,
  buyPriceIntro,
  buyPriceText,
  drawdownAria,
  drawdownChart,
  drawdownLegend,
  fxIncluded,
  monthsGrid,
  monthsIntro,
  monthsStats,
  profitIntro,
  profitNotes,
  profitRows,
  riskIntro,
  riskRow,
  yearsFoot,
  yearsIntro,
  yearsTable,
} from "../../web/analysisdata.js";
import { underwaterText } from "../../web/results.js";

const MINUS = "−"; // U+2212 (format.js MINUS)

const EXPECTED = JSON.parse(
  readFileSync(new URL("../fixtures/expected.json", import.meta.url), "utf8"),
);

/** /api/backtest 응답의 results 한 줄. 분석 탭이 읽는 summary 필드만 채운다 (src/schemas.py SummaryOut). */
function result(symbol, summary) {
  return { symbol, name: `${symbol} 이름`, currency: "USD", summary };
}

/**
 * QLD, 매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화 (계산 규칙 9-8, expected.json v2와 같은 조건).
 * - 낙폭·원금 아래: expected.json v2.metrics (9-8 표)
 * - 최저 수익률: expected.json v2.strategies.none.worst_return_pct (−39.39, 기본 규칙이 곧 이 계산).
 *   그 날짜 2022-06-16은 expected.json에 없어 상세 설계 4절 응답 예의 summary.worst에서 옮겼다
 */
const METRICS = EXPECTED.v2.metrics;
const QLD_SUMMARY = {
  worst: { date: "2022-06-16", return_pct: EXPECTED.v2.strategies.none.worst_return_pct },
  max_drawdown: METRICS.max_drawdown,
  underwater_days: METRICS.underwater_days,
  trading_days: METRICS.trading_days,
  underwater_pct: METRICS.underwater_pct,
  longest_underwater: METRICS.longest_underwater,
  last_underwater: METRICS.last_underwater,
};
const QLD = result("QLD", QLD_SUMMARY);

/** QLD summary에서 일부만 바꾼 결과 한 줄. */
function qldWith(changes) {
  return result("QLD", { ...QLD_SUMMARY, ...changes });
}

/** 표 한 줄을 화면처럼 이은 글: 칸은 "text sub"(sub가 없으면 text), 칸 사이는 " · ". */
function rowText(row) {
  return row.cells.map((c) => (c.sub === null ? c.text : `${c.text} ${c.sub}`)).join(" · ");
}

/** key 열의 칸. RISK_COLUMNS 순서대로 cells가 놓인다 (설계 메모). */
function cellOf(row, key) {
  const index = RISK_COLUMNS.findIndex((c) => c.key === key);
  assert.ok(index >= 0, `RISK_COLUMNS에 ${key} 열이 없다`);
  return row.cells[index];
}

// ---------- 탭 맨 위 한 줄과 탭 끝 안내 ----------

/** API 응답의 params (요청 그대로): 예시 조건. */
const PARAMS = {
  symbols: ["QQQ", "QLD", "TQQQ", "SOXL"],
  start: "2021-11-25",
  end: "2026-11-24",
  freq: "monthly",
  anchor: 1,
  amount: 2_000_000,
  currency: "KRW",
};

// 이슈 #60: 시안의 "숫자는 모두 원화 기준" 대신 "금액은 {투자 통화} 기준" (format.js investLabel 이름)
const INTRO_CASES = [
  {
    id: "원화 투자는 원화 기준",
    params: PARAMS,
    want: "결과를 여러 각도로 나눠 봅니다. 금액은 원화 기준입니다.",
  },
  {
    id: "달러 투자는 달러 기준",
    params: { ...PARAMS, amount: 1500, currency: "USD" },
    want: "결과를 여러 각도로 나눠 봅니다. 금액은 달러 기준입니다.",
  },
];

for (const { id, params, want } of INTRO_CASES) {
  test(`analysisIntro: ${id}`, () => {
    assert.equal(analysisIntro(params), want);
  });
}

test("analysisNotes: 탭 끝 안내는 지금 MDD 문장 하나 (계산 규칙 9-1 화면에 적는다)", () => {
  const data = { params: PARAMS, results: [QLD], chart: { dates: [], series: {} }, errors: [] };
  assert.deepEqual(analysisNotes(data), [
    "평가금 낙폭은 넣은 돈이 계속 더해지는 상태의 값이라, 한 번에 넣은 투자의 낙폭(MDD)과 다릅니다.",
  ]);
});

// ---------- 얼마나 흔들렸나 표 (F-14, 계산 규칙 9-1) ----------

test("RISK_COLUMNS: 열은 최저 수익률 → 낙폭 → 원금 아래였던 날 → 가장 길게 → 마지막 순서", () => {
  assert.deepEqual(
    RISK_COLUMNS.map((c) => [c.key, c.title]),
    [
      ["worst", "최저 수익률"],
      ["drawdown", "평가금 최대 낙폭"],
      ["underwater", "원금 아래였던 날"],
      ["longest", "가장 길게 원금 아래"],
      ["last", "마지막으로 원금 아래"],
    ],
  );
});

test("riskRow: QLD 줄은 expected.json 값으로 이슈 완료 기준(시안)과 같은 글", () => {
  const row = riskRow(QLD);
  assert.equal(row.symbol, "QLD");
  assert.equal(
    rowText(row),
    `${MINUS}39.4% 22-06-16 · ${MINUS}42.2% 26-11-20 · 331일 (26.5%) · ` +
      "253 거래일 22-03 ~ 23-04 · 2023-05-04",
  );
});

test("riskRow: QLD 칸마다 text·sub·tone. 손실인 최저 수익률과 낙폭만 neg", () => {
  // 원금 아래·가장 길게·마지막 칸은 손익 값이 아니라 색이 없다 (설계 메모 표: tone은 worst·drawdown만)
  assert.deepEqual(riskRow(QLD).cells, [
    { text: `${MINUS}39.4%`, sub: "22-06-16", tone: "neg" },
    { text: `${MINUS}42.2%`, sub: "26-11-20", tone: "neg" },
    { text: "331일", sub: "(26.5%)", tone: "" },
    { text: "253 거래일", sub: "22-03 ~ 23-04", tone: "" },
    { text: "2023-05-04", sub: null, tone: "" },
  ]);
});

const UNDERWATER_CASES = [
  { id: "QLD 331일 (26.48%)", summary: QLD_SUMMARY },
  {
    id: "원금 아래였던 적이 없음",
    summary: { ...QLD_SUMMARY, underwater_days: 0, underwater_pct: 0 },
  },
  {
    id: "천 일을 넘음",
    summary: { ...QLD_SUMMARY, underwater_days: 1234, underwater_pct: 33.92 },
  },
];

for (const { id, summary } of UNDERWATER_CASES) {
  test(`riskRow: 원금 아래 칸 "text sub"는 카드의 underwaterText와 같다 (${id})`, () => {
    const cell = cellOf(riskRow(result("QLD", summary)), "underwater");
    assert.equal(`${cell.text} ${cell.sub}`, underwaterText(summary));
  });
}

/** 값이 없을 때 (결정 d25, 상세 설계 4절)와 경계. key 열의 칸이 want와 같다. */
const NO_VALUE = {
  underwater_days: 0,
  underwater_pct: 0,
  longest_underwater: null,
  last_underwater: null,
};
const EMPTY_CASES = [
  {
    id: "낙폭이 없으면(max_drawdown null) 없음, 날짜 없음",
    changes: { max_drawdown: null },
    key: "drawdown",
    want: { text: "없음", sub: null, tone: "" },
  },
  {
    id: "원금 아래였던 적이 없으면 0일 (0.0%)",
    changes: NO_VALUE,
    key: "underwater",
    want: { text: "0일", sub: "(0.0%)", tone: "" },
  },
  {
    id: "원금 아래였던 적이 없으면(longest_underwater null) 가장 길게는 없음",
    changes: NO_VALUE,
    key: "longest",
    want: { text: "없음", sub: null, tone: "" },
  },
  {
    id: "원금 아래였던 적이 없으면(last_underwater null) 마지막은 없음",
    changes: NO_VALUE,
    key: "last",
    want: { text: "없음", sub: null, tone: "" },
  },
  {
    id: "끝까지 원금 위로 못 올라왔으면(recovered null) 회복 전",
    changes: { longest_underwater: { days: 253, start: "2022-03-30", recovered: null } },
    key: "longest",
    want: { text: "253 거래일", sub: "22-03 ~ 회복 전", tone: "" },
  },
  {
    id: "최저 수익률이 0%면 색 없음",
    changes: { worst: { date: "2021-12-01", return_pct: 0 } },
    key: "worst",
    want: { text: "0.0%", sub: "21-12-01", tone: "" },
  },
  {
    // 일수 형식은 카드의 underwaterText(천 단위 쉼표)와 같게 둔다
    id: "가장 길게가 천 거래일을 넘으면 쉼표",
    changes: { longest_underwater: { days: 1234, start: "2021-12-01", recovered: "2026-11-02" } },
    key: "longest",
    want: { text: "1,234 거래일", sub: "21-12 ~ 26-11", tone: "" },
  },
];

for (const { id, changes, key, want } of EMPTY_CASES) {
  test(`riskRow: ${id}`, () => {
    assert.deepEqual(cellOf(riskRow(qldWith(changes)), key), want);
  });
}

test("riskRow: 원금 아래였던 적이 없는 줄 전체는 0일과 없음 둘", () => {
  const row = riskRow(qldWith(NO_VALUE));
  assert.equal(
    rowText(row),
    `${MINUS}39.4% 22-06-16 · ${MINUS}42.2% 26-11-20 · 0일 (0.0%) · 없음 · 없음`,
  );
});

test("riskRow: v2 필드가 빠진 옛 응답(undefined)도 null처럼 없음으로 쓴다", () => {
  const summary = { ...QLD_SUMMARY };
  delete summary.max_drawdown;
  delete summary.longest_underwater;
  delete summary.last_underwater;
  const row = riskRow(result("QLD", summary));
  for (const key of ["drawdown", "longest", "last"]) {
    assert.deepEqual(cellOf(row, key), { text: "없음", sub: null, tone: "" }, key);
  }
});

const RISK_LEAD = "적립식은 넣은 돈이 계속 늘어서, 수익률과 평가금 기준 낙폭을 같이 봅니다.";
const INTRO_RESULTS = [
  {
    id: "4종목 모두 1,250 거래일이면 전체 거래일 수",
    results: ["QQQ", "QLD", "TQQQ", "SOXL"].map((s) => result(s, QLD_SUMMARY)),
    want: `${RISK_LEAD} 전체 1,250 거래일 기준.`,
  },
  {
    id: "종목이 하나면 그 거래일 수",
    results: [qldWith({ trading_days: 250 })],
    want: `${RISK_LEAD} 전체 250 거래일 기준.`,
  },
  {
    id: "거래일 수가 종목마다 다르면 다르다고 쓴다",
    results: [
      qldWith({ trading_days: 1250 }),
      result("NEW", { ...QLD_SUMMARY, trading_days: 812 }),
    ],
    want: `${RISK_LEAD} 거래일 수는 종목마다 다릅니다.`,
  },
];

for (const { id, results, want } of INTRO_RESULTS) {
  test(`riskIntro: ${id}`, () => {
    assert.equal(riskIntro(results), want);
  });
}

// ---------- 낙폭 그래프 (F-14 "아래에 낙폭 그래프") ----------

/** path "M0 1L2 3M5 6"의 점을 [x, y] 숫자로. */
function pointsOf(path) {
  return [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** path에서 x 자리 점의 y. */
function yAt(path, x) {
  const point = pointsOf(path).find(([px]) => px === x);
  assert.ok(point, `x ${x} 자리 점이 없다: ${path}`);
  return point[1];
}

/** 선에서 화면에 가장 낮게 그린 점의 y (y는 아래로 갈수록 크다). */
function lowestY(path) {
  return Math.max(...pointsOf(path).map(([, y]) => y));
}

/** yTicks를 {label, top}으로. 0 / floor는 −0이 되므로 0으로 맞춰 견준다 (deepStrictEqual은 둘을 가른다). */
function ticksOf(dd) {
  return dd.yTicks.map(({ label, top }) => ({ label, top: top + 0 }));
}

/** 손으로 만든 chart (상세 설계 4절 chart 모양에서 drawdown만). */
function chartOf(dates, drawdowns) {
  const series = Object.fromEntries(
    Object.entries(drawdowns).map(([symbol, drawdown]) => [symbol, { drawdown }]),
  );
  return { dates, series, total_days: dates.length };
}

/**
 * 5년 날짜축 11점: 기본 상자 1000×300에서 x는 위치 × 100. QLD·SOXL 최대 낙폭은 2026-11-20
 * (QLD −42.2%는 expected.json, SOXL −90.9%는 이슈 #60 완료 기준). SOXL은 첫 날 null(첫 매수 전).
 * 공통 축 확인용으로 QLD 4번째(2023-06-01)와 SOXL 5번째(2024-01-02)가 같은 −10이다.
 */
const DATES_5Y = [
  "2021-12-01",
  "2022-01-03",
  "2022-06-16",
  "2023-01-03",
  "2023-06-01",
  "2024-01-02",
  "2025-01-02",
  "2026-01-02",
  "2026-06-02",
  "2026-11-20",
  "2026-11-23",
];
const CHART_5Y = chartOf(DATES_5Y, {
  QLD: [0, -8, -35.5, -20, -10, 0, -5, -3, 0, METRICS.max_drawdown.pct, -40.1],
  SOXL: [null, 0, -45, -60, -30, -10, -20, -15, 0, -90.9, -88],
});

test("drawdownChart: 예시(최저 −90.9%)는 바닥 −100%, 눈금 0·−25·−50·−75·−100 (시안)", () => {
  const dd = drawdownChart(CHART_5Y, ["QLD", "SOXL"]);
  assert.equal(dd.floor, -100);
  // 눈금 글은 format.js처럼 U+2212 빼기 기호. top은 판 위에서의 비율 (value / floor)
  assert.deepEqual(ticksOf(dd), [
    { label: "0%", top: 0 },
    { label: `${MINUS}25%`, top: 0.25 },
    { label: `${MINUS}50%`, top: 0.5 },
    { label: `${MINUS}75%`, top: 0.75 },
    { label: `${MINUS}100%`, top: 1 },
  ]);
});

test("drawdownChart: 선은 symbols 순서, 종목마다 하나", () => {
  assert.deepEqual(
    drawdownChart(CHART_5Y, ["QLD", "SOXL"]).lines.map((l) => l.symbol),
    ["QLD", "SOXL"],
  );
  assert.deepEqual(
    drawdownChart(CHART_5Y, ["SOXL", "QLD"]).lines.map((l) => l.symbol),
    ["SOXL", "QLD"],
  );
});

test("drawdownChart: 세로축은 모든 선이 같이 쓴다 (다른 종목의 같은 값은 같은 y)", () => {
  const [qld, soxl] = drawdownChart(CHART_5Y, ["QLD", "SOXL"]).lines;
  // −10%는 바닥 −100% 판에서 높이 300의 10%
  assert.equal(yAt(qld.path, 400), 30);
  assert.equal(yAt(soxl.path, 500), 30);
});

test("drawdownChart: 종목마다 가장 낮은 점이 표의 최대 낙폭 (QLD −42.2%, SOXL −90.9%)", () => {
  const [qld, soxl] = drawdownChart(CHART_5Y, ["QLD", "SOXL"]).lines;
  assert.deepEqual(qld.low, { index: 9, date: "2026-11-20", value: METRICS.max_drawdown.pct });
  assert.deepEqual(soxl.low, { index: 9, date: "2026-11-20", value: -90.9 });
  // low 자리의 점이 그 선에서 가장 낮게 그린 점이고, 높이는 공통 바닥 −100% 기준 비율
  assert.equal(yAt(qld.path, 900), 126.6);
  assert.equal(lowestY(qld.path), 126.6);
  assert.equal(yAt(soxl.path, 900), 272.7);
  assert.equal(lowestY(soxl.path), 272.7);
});

test("drawdownChart: 첫 매수 전 null은 건너뛰고 첫 점의 x는 날짜축 자리", () => {
  const soxl = drawdownChart(CHART_5Y, ["QLD", "SOXL"]).lines[1];
  assert.ok(soxl.path.startsWith("M100 0L"), soxl.path);
});

/** 6점(x는 위치 × 200): 앞 null, 가운데 null. 최저 −20%는 5 간격이라 바닥도 −20%. */
const CHART_GAPS = chartOf(
  ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-08"],
  { QLD: [null, 0, -10, null, -20, -10] },
);

test("drawdownChart: 가운데 null 뒤에서는 M으로 선을 새로 시작한다", () => {
  const dd = drawdownChart(CHART_GAPS, ["QLD"]);
  assert.equal(dd.floor, -20);
  assert.equal(dd.lines[0].path, "M200 0L400 150M800 300L1000 150");
});

test("drawdownChart: 상자 크기를 주면 그 크기로 그린다", () => {
  const dd = drawdownChart(CHART_GAPS, ["QLD"], { width: 500, height: 100 });
  assert.equal(dd.lines[0].path, "M100 0L200 50M400 100L500 50");
});

test("drawdownChart: 가장 낮은 값이 눈금에 딱 떨어지면 그 종목의 가장 낮은 점은 판 바닥(height)", () => {
  // QLD −50%는 10 간격 눈금이라 바닥이 −50%. QQQ −24.9%는 같은 축에서 높이의 49.8%
  const chart = chartOf(["2022-06-01", "2022-06-16", "2022-07-01"], {
    QQQ: [0, -24.9, -10],
    QLD: [0, -50, -30],
  });
  const dd = drawdownChart(chart, ["QQQ", "QLD"]);
  assert.equal(dd.floor, -50);
  const [qqq, qld] = dd.lines;
  assert.deepEqual(qld.low, { index: 1, date: "2022-06-16", value: -50 });
  assert.equal(yAt(qld.path, 500), 300);
  assert.equal(yAt(qqq.path, 500), 149.4);
});

test("drawdownChart: 가장 낮은 값이 여러 번이면 low는 앞의 것", () => {
  const dates = ["2022-06-01", "2022-06-02", "2022-06-03", "2022-06-06", "2022-06-07"];
  const dd = drawdownChart(chartOf(dates, { QLD: [null, -5, -20, -10, -20] }), ["QLD"]);
  assert.deepEqual(dd.lines[0].low, { index: 2, date: "2022-06-03", value: -20 });
});

test("drawdownChart: 그릴 값이 없는 종목은 low가 null", () => {
  const chart = chartOf(["2026-06-01", "2026-06-02"], { QLD: [0, -10], NEW: [null, null] });
  const dd = drawdownChart(chart, ["QLD", "NEW"]);
  assert.equal(dd.lines[1].symbol, "NEW");
  assert.equal(dd.lines[1].low, null);
});

/**
 * 바닥과 눈금 간격 (설계 메모): 모든 선의 최저 m에서 |m| ≤ 20이면 5, ≤ 50이면 10, 그 밖은 25 간격.
 * 바닥은 m을 그 간격으로 내린 값이고, 낙폭이 모두 0이면 한 칸(−5%) 내려 0% 선이 맨 위에 온다.
 * 최저값은 이슈 #60 완료 기준의 예시 4종목 최대 낙폭과 경계값이다.
 */
const minusPct = (n) => `${MINUS}${n}%`;
const FLOOR_CASES = [
  { id: "SOXL −90.9%는 25 간격, 바닥 −100%", low: -90.9, floor: -100, ticks: [25, 50, 75, 100] },
  { id: "TQQQ −57.1%는 25 간격, 바닥 −75%", low: -57.1, floor: -75, ticks: [25, 50, 75] },
  { id: "QLD −42.2%는 10 간격, 바닥 −50%", low: -42.2, floor: -50, ticks: [10, 20, 30, 40, 50] },
  { id: "QQQ −24.9%는 10 간격, 바닥 −30%", low: -24.9, floor: -30, ticks: [10, 20, 30] },
  { id: "−19%는 5 간격, 바닥 −20%", low: -19, floor: -20, ticks: [5, 10, 15, 20] },
  { id: "−20%는 20 이하라 5 간격", low: -20, floor: -20, ticks: [5, 10, 15, 20] },
  { id: "−50%는 50 이하라 10 간격", low: -50, floor: -50, ticks: [10, 20, 30, 40, 50] },
  { id: "−50.1%는 50을 넘어 25 간격", low: -50.1, floor: -75, ticks: [25, 50, 75] },
  { id: "낙폭이 모두 0이면 바닥 −5%", low: 0, floor: -5, ticks: [5] },
];

for (const { id, low, floor, ticks } of FLOOR_CASES) {
  test(`drawdownChart: ${id}`, () => {
    const dd = drawdownChart(chartOf(["2026-06-01", "2026-06-02"], { QLD: [0, low] }), ["QLD"]);
    assert.equal(dd.floor, floor);
    assert.deepEqual(
      dd.yTicks.map((t) => t.label),
      ["0%", ...ticks.map(minusPct)],
    );
  });
}

test("drawdownChart: 낙폭이 모두 0이면 선은 0% 선(맨 위)에 붙고 low는 첫 점", () => {
  const dd = drawdownChart(chartOf(["2026-06-01", "2026-06-02"], { QQQ: [0, 0] }), ["QQQ"]);
  assert.deepEqual(ticksOf(dd), [
    { label: "0%", top: 0 },
    { label: `${MINUS}5%`, top: 1 },
  ]);
  assert.equal(dd.lines[0].path, "M0 0L1000 0");
  assert.deepEqual(dd.lines[0].low, { index: 0, date: "2026-06-01", value: 0 });
});

test("drawdownChart: 5년 축은 해가 바뀌는 첫 날짜마다 연도 눈금, left는 날짜축 비율", () => {
  // left = 위치 / (11 − 1): 2022-01-03은 1번째, 2023-01-03은 3번째 …
  assert.deepEqual(drawdownChart(CHART_5Y, ["QLD", "SOXL"]).xTicks, [
    { label: "2022", left: 0.1 },
    { label: "2023", left: 0.3 },
    { label: "2024", left: 0.5 },
    { label: "2025", left: 0.6 },
    { label: "2026", left: 0.7 },
  ]);
});

test("drawdownChart: 해가 두 번 바뀌면 연도 눈금 둘", () => {
  const dates = ["2024-12-02", "2025-01-02", "2025-06-02", "2026-01-02", "2026-02-02"];
  const dd = drawdownChart(chartOf(dates, { QLD: [0, -1, -2, -3, -4] }), ["QLD"]);
  assert.deepEqual(dd.xTicks, [
    { label: "2025", left: 0.25 },
    { label: "2026", left: 0.75 },
  ]);
});

test("drawdownChart: 연도 눈금이 둘보다 적으면(1년 안쪽) 달이 바뀌는 날에 YY-MM 눈금", () => {
  // 해는 2026-01-02에 한 번만 바뀐다 → 달 눈금 25-12, 26-01, 26-02
  const dates = ["2025-11-28", "2025-12-01", "2025-12-15", "2026-01-02", "2026-02-02"];
  const dd = drawdownChart(chartOf(dates, { QLD: [0, -1, -2, -3, -4] }), ["QLD"]);
  assert.deepEqual(dd.xTicks, [
    { label: "25-12", left: 0.25 },
    { label: "26-01", left: 0.75 },
    { label: "26-02", left: 1 },
  ]);
});

test("drawdownChart: 연도 눈금이 10개를 넘으면 10개 이하로 솎는다", () => {
  // 2000-01-03 ~ 2026-07-01, 해마다 두 점 → 해가 바뀌는 날 26번
  const dates = [];
  for (let year = 2000; year <= 2026; year += 1) dates.push(`${year}-01-03`, `${year}-07-01`);
  const dd = drawdownChart(chartOf(dates, { QQQ: dates.map(() => -1) }), ["QQQ"]);
  assert.ok(dd.xTicks.length >= 2 && dd.xTicks.length <= 10, `${dd.xTicks.length}개`);
  for (const tick of dd.xTicks) {
    assert.match(tick.label, /^20\d\d$/);
    // 눈금은 그해 첫 날짜(1월 3일) 자리에 놓인다
    const index = dates.indexOf(`${tick.label}-01-03`);
    assert.equal(tick.left, index / (dates.length - 1), tick.label);
  }
  const lefts = dd.xTicks.map((t) => t.left);
  assert.deepEqual(
    lefts,
    [...lefts].sort((a, b) => a - b),
  );
});

test("drawdownChart: 날짜가 없으면 null", () => {
  assert.equal(drawdownChart(chartOf([], { QLD: [] }), ["QLD"]), null);
});

// ---------- 낙폭 그래프 aria-label ----------

const QQQ = result("QQQ", {
  ...QLD_SUMMARY,
  max_drawdown: { date: "2026-11-20", pct: -24.9 },
});
const SOXL = result("SOXL", {
  ...QLD_SUMMARY,
  max_drawdown: { date: "2026-11-20", pct: -90.9 },
});

test("drawdownAria: 그래프 이름과 종목별 최대 낙폭·날짜(전부)를 결과 순서로", () => {
  const text = drawdownAria([QQQ, QLD, SOXL]);
  assert.ok(text.startsWith("평가금 최고점 대비 낙폭 그래프."), text);
  // 설계 메모: "…그래프. QQQ 최대 −24.9% (2026-11-20), …". 낭독용이라 날짜를 다 쓴다
  assert.ok(
    text.includes(
      `QQQ 최대 ${MINUS}24.9% (2026-11-20), QLD 최대 ${MINUS}42.2% (2026-11-20), ` +
        `SOXL 최대 ${MINUS}90.9% (2026-11-20)`,
    ),
    text,
  );
});

test("drawdownAria: 낙폭이 없는 종목(max_drawdown null)은 낙폭 없음", () => {
  const flat = result("QQQ", { ...QLD_SUMMARY, max_drawdown: null });
  const text = drawdownAria([flat, QLD]);
  assert.ok(text.includes(`QQQ 낙폭 없음, QLD 최대 ${MINUS}42.2% (2026-11-20)`), text);
  assert.ok(!text.includes("QQQ 최대"), text);
});

// ---------- 낙폭 그래프 범례 (#71 리뷰 권장 2) ----------

test("drawdownLegend: 범례 값은 최대 낙폭 1자리, 표의 낙폭 칸 글과 같다", () => {
  assert.equal(drawdownLegend(QLD), `${MINUS}42.2%`);
  assert.equal(drawdownLegend(QLD), cellOf(riskRow(QLD), "drawdown").text);
});

test("drawdownLegend: 낙폭이 없으면(null, 옛 응답의 undefined) 낙폭 없음 (결정 d25)", () => {
  assert.equal(drawdownLegend(qldWith({ max_drawdown: null })), "낙폭 없음");
  const summary = { ...QLD_SUMMARY };
  delete summary.max_drawdown;
  assert.equal(drawdownLegend(result("QLD", summary)), "낙폭 없음");
});

// ---------- 연도별 결과 (F-14, 계산 규칙 9-2, #61) ----------

/** "YYYY-MM"부터 count달의 "YYYY-MM" 목록 ("2021-12", 2 → 2021-12, 2022-01). */
function monthKeys(first, count) {
  const [year, month] = first.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const index = year * 12 + month - 1 + i;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * 날짜마다 amount씩 산 buys. 연도별 표가 읽는 date·invested만 채운다 (상세 설계 4절 buys[]).
 * invested는 그 줄까지 넣은 돈이다.
 */
function buysOn(dates, amount) {
  return dates.map((date, i) => ({ date, invested: amount * (i + 1) }));
}

/** first 달부터 count달 동안 매월 amount씩 산 buys. 날짜는 그달 1일로 둔다 (표는 연도만 본다). */
function monthlyBuys(first, count, amount) {
  return buysOn(
    monthKeys(first, count).map((month) => `${month}-01`),
    amount,
  );
}

/** {연도: [그해 누적 수익률, 주가 등락]} → analysis.years 모양 (계산 규칙 9-2). */
function yearsOf(table) {
  return Object.fromEntries(
    Object.entries(table).map(([year, [ret, change]]) => [
      year,
      { return_pct: ret, price_change_pct: change },
    ]),
  );
}

/** 연도별·월별 구역이 읽는 결과 한 줄 (상세 설계 4절 results[]: data_through, analysis, buys). */
function analyzed(symbol, options = {}) {
  const { currency = "USD", through = "2026-11-23", years = {}, months = {}, buys = [] } = options;
  return {
    symbol,
    name: `${symbol} 이름`,
    currency,
    data_through: through,
    analysis: { years, months },
    buys,
  };
}

/**
 * 예시 4종목: 매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화 (이슈 #61 완료 기준).
 * 첫 매수는 2021-12-01이고 60번 산다. QLD 연도별은 expected.json v2.metrics.years,
 * 나머지 셋은 fixture로 부른 /api/backtest 응답의 analysis.years 값이다.
 */
const EXAMPLE_BUYS = monthlyBuys("2021-12", 60, 2_000_000);
const EXAMPLE_YEARS = {
  QQQ: yearsOf({
    2021: [3.38, 26.81],
    2022: [-17.88, -33.07],
    2023: [23.8, 53.79],
    2024: [59.51, 24.84],
    2025: [70.0, 20.16],
    2026: [54.22, 5.98],
  }),
  QLD: METRICS.years,
  TQQQ: yearsOf({
    2021: [7.88, 82.98],
    2022: [-50.82, -79.2],
    2023: [54.42, 193.06],
    2024: [131.62, 56.07],
    2025: [161.19, 33.25],
    2026: [99.4, -6.87],
  }),
  SOXL: yearsOf({
    2021: [8.32, 118.69],
    2022: [-50.95, -85.78],
    2023: [67.34, 224.72],
    2024: [39.59, -13.03],
    2025: [104.19, 53.9],
    2026: [68.86, 2.81],
  }),
};
const EXAMPLE_RESULTS = Object.entries(EXAMPLE_YEARS).map(([symbol, years]) =>
  analyzed(symbol, { years, buys: EXAMPLE_BUYS }),
);
const [EX_QQQ, EX_QLD] = EXAMPLE_RESULTS;
const QLD_COL = 1;
const TQQQ_COL = 2;

/** 한국 종목 (원화). 연도 값은 칸 모양만 보려고 둔 값이다. */
const KS = analyzed("005930.KS", {
  currency: "KRW",
  through: "2026-11-24",
  years: yearsOf({ 2025: [10.5, 20.25], 2026: [5.5, 3.25] }),
  buys: monthlyBuys("2025-01", 23, 2_000_000),
});

const YEARS_LEAD = "그해 마지막 거래일 기준 누적 수익률. 아래 작은 글씨는 그해 주가 등락";
const YEARS_INTRO_CASES = [
  { id: "종목이 모두 달러면 (달러)", results: EXAMPLE_RESULTS, want: `${YEARS_LEAD}(달러)` },
  { id: "원화 종목만이면 (원화)", results: [KS], want: `${YEARS_LEAD}(원화)` },
  {
    id: "종목 통화가 여럿이면 (종목 통화)",
    results: [EX_QQQ, KS],
    want: `${YEARS_LEAD}(종목 통화)`,
  },
];

for (const { id, results, want } of YEARS_INTRO_CASES) {
  test(`yearsIntro: ${id}`, () => {
    assert.equal(yearsIntro(results), want);
  });
}

test("yearsTable: 예시 4종목은 2021~2026 여섯 줄, 줄마다 종목 넷", () => {
  const table = yearsTable(EXAMPLE_RESULTS, "KRW");
  assert.deepEqual(
    table.rows.map((r) => r.year),
    ["2021", "2022", "2023", "2024", "2025", "2026"],
  );
  for (const row of table.rows) assert.equal(row.cells.length, 4, row.year);
});

test("yearsTable: 예시 4종목은 투자금이 모두 같아 열 하나 (200만원 … 1억 2,000만원, 결정 d66)", () => {
  const table = yearsTable(EXAMPLE_RESULTS, "KRW");
  assert.equal(table.sharedInvested, true);
  // 그해 마지막 매수 줄의 buys[].invested (이슈 #61 완료 기준)
  assert.deepEqual(
    table.rows.map((r) => r.invested),
    ["200만원", "2,600만원", "5,000만원", "7,400만원", "9,800만원", "1억 2,000만원"],
  );
  // 열 하나로 쓰면 칸마다 따로 적지 않는다
  for (const row of table.rows) {
    assert.deepEqual(
      row.cells.map((c) => c.invested),
      [null, null, null, null],
      row.year,
    );
  }
});

test("yearsTable: QLD 칸은 expected.json 값으로 이슈 완료 기준과 같은 글", () => {
  const table = yearsTable(EXAMPLE_RESULTS, "KRW");
  assert.deepEqual(
    table.rows.map((r) => r.cells[QLD_COL]),
    [
      { text: "+5.8%", sub: "주가 +54.7%", tone: "pos", invested: null },
      { text: `${MINUS}35.7%`, sub: `주가 ${MINUS}60.6%`, tone: "neg", invested: null },
      { text: "+41.0%", sub: "주가 +116.9%", tone: "pos", invested: null },
      { text: "+98.3%", sub: "주가 +42.4%", tone: "pos", invested: null },
      { text: "+121.7%", sub: "주가 +30.1%", tone: "pos", invested: null },
      { text: "+88.2%", sub: "주가 +2.1%", tone: "pos", invested: null },
    ],
  );
});

test("yearsTable: TQQQ 2025 주가 33.25는 화면 반올림으로 +33.3% (결정 d61, 시안 +33.2%)", () => {
  const row2025 = yearsTable(EXAMPLE_RESULTS, "KRW").rows[4];
  assert.equal(row2025.year, "2025");
  assert.deepEqual(row2025.cells[TQQQ_COL], {
    text: "+161.2%",
    sub: "주가 +33.3%",
    tone: "pos",
    invested: null,
  });
});

test("yearsTable: 칸은 results 순서 (종목 순서를 뒤집으면 칸도 뒤집힌다)", () => {
  const forward = yearsTable(EXAMPLE_RESULTS, "KRW");
  const backward = yearsTable([...EXAMPLE_RESULTS].reverse(), "KRW");
  forward.rows.forEach((row, i) => {
    assert.deepEqual(backward.rows[i].cells, [...row.cells].reverse(), row.year);
  });
});

/**
 * 상장이 늦은 종목: 2024-06 상장, 2024-07부터 매월 200만원 29번 (2024 6번, 2025 12번, 2026 11번).
 * 상장한 해는 전해 마지막 종가가 없어 주가 등락이 null이다 (계산 규칙 9-2).
 */
const LATE = analyzed("LATE", {
  years: yearsOf({ 2024: [12.34, null], 2025: [-3.21, -15.5], 2026: [20.0, 7.77] }),
  buys: monthlyBuys("2024-07", 29, 2_000_000),
});
const NO_YEAR = { text: "—", sub: null, tone: "", invested: null };

test("yearsTable: 상장이 늦어 투자금이 다르면 열 없이 칸마다 투자금 (결정 d66)", () => {
  const table = yearsTable([EX_QLD, LATE], "KRW");
  assert.equal(table.sharedInvested, false);
  assert.deepEqual(
    table.rows.map((r) => r.invested),
    [null, null, null, null, null, null],
  );
  assert.deepEqual(
    table.rows.map((r) => r.cells.map((c) => c.invested)),
    [
      ["투자금 200만원", null],
      ["투자금 2,600만원", null],
      ["투자금 5,000만원", null],
      ["투자금 7,400만원", "투자금 1,200만원"],
      ["투자금 9,800만원", "투자금 3,600만원"],
      ["투자금 1억 2,000만원", "투자금 5,800만원"],
    ],
  );
});

test("yearsTable: 그해 값이 없는 종목 칸은 — (주가·투자금 없음)", () => {
  const table = yearsTable([EX_QLD, LATE], "KRW");
  for (const row of table.rows.slice(0, 3)) {
    assert.deepEqual(row.cells[1], NO_YEAR, row.year);
  }
});

test("yearsTable: price_change_pct가 null이면 주가 — (상장한 해)", () => {
  const row2024 = yearsTable([EX_QLD, LATE], "KRW").rows[3];
  assert.equal(row2024.year, "2024");
  assert.deepEqual(row2024.cells[1], {
    text: "+12.3%",
    sub: "주가 —",
    tone: "pos",
    invested: "투자금 1,200만원",
  });
});

test("yearsTable: 줄은 모든 종목 연도를 합쳐 오름차순 (첫 종목에 없는 해도)", () => {
  const table = yearsTable([LATE, EX_QLD], "KRW");
  assert.deepEqual(
    table.rows.map((r) => r.year),
    ["2021", "2022", "2023", "2024", "2025", "2026"],
  );
  assert.deepEqual(table.rows[0].cells[0], NO_YEAR);
  assert.equal(table.rows[0].cells[1].text, "+5.8%");
});

/**
 * 매주 수요일 50만원, 2025-12-01 ~ 2026-01-07. 2025-12-31(수)에 한국거래소가 쉬어 005930.KS는
 * 그 주 다음 거래일 2026-01-02(금)에 산다 (계산 규칙 2절). 2025년 투자금만 다르고 2026년은 같다.
 */
const WEEKLY_US = analyzed("QQQ", {
  years: yearsOf({ 2025: [1.23, -0.5], 2026: [2.0, 3.1] }),
  buys: buysOn(
    ["2025-12-03", "2025-12-10", "2025-12-17", "2025-12-24", "2025-12-31", "2026-01-07"],
    500_000,
  ),
});
const WEEKLY_KS = analyzed("005930.KS", {
  currency: "KRW",
  years: yearsOf({ 2025: [-0.8, 2.4], 2026: [1.5, 4.0] }),
  buys: buysOn(
    ["2025-12-03", "2025-12-10", "2025-12-17", "2025-12-24", "2026-01-02", "2026-01-07"],
    500_000,
  ),
});

test("yearsTable: 거래소가 달라 한 해만 투자금이 달라도 표 전체를 칸마다 (결정 d66)", () => {
  const table = yearsTable([WEEKLY_US, WEEKLY_KS], "KRW");
  assert.equal(table.sharedInvested, false);
  assert.deepEqual(
    table.rows.map((r) => [r.year, r.invested, ...r.cells.map((c) => c.invested)]),
    [
      ["2025", null, "투자금 250만원", "투자금 200만원"],
      ["2026", null, "투자금 300만원", "투자금 300만원"],
    ],
  );
});

test("yearsTable: 그해에 매수가 없으면 앞 해 마지막 투자금 (매월 말일, 끝날짜 2025-01-15)", () => {
  // 2024-10-15 ~ 2025-01-15 매월 말일 200만원: 마지막 매수는 2024-12-31이다. 2025년에는 사지 않았지만
  // 01-02 ~ 01-14 거래일이 있어 2025 줄이 있다
  const only = analyzed("QQQ", {
    through: "2025-01-14",
    years: yearsOf({ 2024: [1.5, 2.0], 2025: [0.8, 0.6] }),
    buys: buysOn(["2024-10-31", "2024-11-29", "2024-12-31"], 2_000_000),
  });
  const table = yearsTable([only], "KRW");
  assert.equal(table.sharedInvested, true);
  assert.deepEqual(
    table.rows.map((r) => [r.year, r.invested]),
    [
      ["2024", "600만원"],
      ["2025", "600만원"],
    ],
  );
});

test("yearsTable: 달러 투자면 투자금도 달러 ($1,500.00 … $90,000)", () => {
  // QQQ 매월 1일 $1,500 (계산 규칙 7절 "매월 1일 1,500달러" 줄, 투자금 $90,000).
  // 연도 값은 fixture로 부른 /api/backtest(currency USD) 응답의 analysis.years다
  const usd = analyzed("QQQ", {
    years: yearsOf({
      2021: [2.77, 26.81],
      2022: [-16.72, -33.07],
      2023: [25.09, 53.79],
      2024: [42.0, 24.84],
      2025: [56.76, 20.16],
      2026: [53.52, 5.98],
    }),
    buys: monthlyBuys("2021-12", 60, 1500),
  });
  assert.deepEqual(
    yearsTable([usd], "USD").rows.map((r) => r.invested),
    ["$1,500.00", "$19,500", "$37,500", "$55,500", "$73,500", "$90,000"],
  );
});

test("yearsTable: 0.0%로 보이는 값은 색 없음, −0.0%가 아니라 0.0%", () => {
  const flat = analyzed("QQQ", {
    years: yearsOf({ 2025: [-0.04, -0.04], 2026: [0.04, 0] }),
    buys: monthlyBuys("2025-01", 23, 2_000_000),
  });
  assert.deepEqual(
    yearsTable([flat], "KRW").rows.map((r) => r.cells[0]),
    [
      { text: "0.0%", sub: "주가 0.0%", tone: "", invested: null },
      { text: "0.0%", sub: "주가 0.0%", tone: "", invested: null },
    ],
  );
});

const YEARS_FOOT_CASES = [
  {
    id: "종목 기준일이 모두 같으면 날짜 하나",
    results: EXAMPLE_RESULTS,
    want: "2026년은 11-23까지.",
  },
  {
    id: "기준일이 다르면 종목마다 (결과 순서)",
    results: [EX_QQQ, KS],
    want: "2026년은 QQQ 11-23, 005930.KS 11-24까지.",
  },
  {
    id: "마지막 연도 전에 끝난 종목은 빼고 쓴다",
    results: [
      EX_QQQ,
      analyzed("OLD", {
        through: "2025-06-30",
        years: yearsOf({ 2024: [3.0, 4.0], 2025: [-1.0, -2.0] }),
        buys: monthlyBuys("2024-01", 18, 2_000_000),
      }),
    ],
    want: "2026년은 11-23까지.",
  },
];

for (const { id, results, want } of YEARS_FOOT_CASES) {
  test(`yearsFoot: ${id}`, () => {
    assert.equal(yearsFoot(results), want);
  });
}

// ---------- 달마다 얼마나 움직였나 (F-14, 계산 규칙 9-3, #61) ----------

/**
 * 요약({count, up, best, worst}, expected.json v2.metrics.months 모양)에 맞춘 analysis.months.
 * first 달부터 count달이고 0인 달은 없다. 가장 크게 오른·내린 달 말고는 앞에서부터
 * 오른 달 +2.5, 그 뒤는 내린 달 −2.5로 채운다.
 */
function monthsLike(first, { count, up, best, worst }) {
  let ups = up - 1; // 가장 크게 오른 달도 오른 달이다
  const months = {};
  for (const month of monthKeys(first, count)) {
    if (month === best.month) months[month] = best.return_pct;
    else if (month === worst.month) months[month] = worst.return_pct;
    else if (ups > 0) {
      months[month] = 2.5;
      ups -= 1;
    } else months[month] = -2.5;
  }
  return months;
}

/** QLD 59달 (2021-12 ~ 2026-10): expected.json v2.metrics.months 요약 (36달 오름, 23달 내림). */
const QLD_MONTHS = monthsLike("2021-12", METRICS.months);
/** QQQ 59달: fixture로 부른 /api/backtest(예시 조건) 응답의 analysis.months 요약 (이슈 #61). */
const QQQ_MONTHS_SUMMARY = {
  count: 59,
  up: 37,
  best: { month: "2026-04", return_pct: 13.5 },
  worst: { month: "2026-07", return_pct: -13.91 },
};
const QQQ_MONTHS = monthsLike("2021-12", QQQ_MONTHS_SUMMARY);

const MONTHS_FIXTURES = [
  { id: "QLD", months: QLD_MONTHS, summary: METRICS.months, down: 23 },
  { id: "QQQ", months: QQQ_MONTHS, summary: QQQ_MONTHS_SUMMARY, down: 22 },
];

for (const { id, months, summary, down } of MONTHS_FIXTURES) {
  test(`monthsLike(테스트 도구): ${id} 59달이 요약과 맞다 (2021-12 ~ 2026-10, 오른·내린 달, 최고·최저)`, () => {
    const keys = Object.keys(months);
    const values = Object.values(months);
    assert.equal(keys.length, summary.count);
    assert.equal(keys[0], "2021-12");
    assert.equal(keys.at(-1), "2026-10");
    assert.equal(values.filter((v) => v > 0).length, summary.up);
    assert.equal(values.filter((v) => v < 0).length, down);
    assert.equal(values.filter((v) => v === 0).length, 0);
    assert.equal(Math.max(...values), summary.best.return_pct);
    assert.equal(months[summary.best.month], summary.best.return_pct);
    assert.equal(Math.min(...values), summary.worst.return_pct);
    assert.equal(months[summary.worst.month], summary.worst.return_pct);
  });
}

const USD_PARAMS = { ...PARAMS, amount: 1500, currency: "USD" };
const MONTHS_INTRO_CASES = [
  {
    id: "달러 종목을 원화로 사면 × 환율 (원화)",
    row: EX_QLD,
    params: PARAMS,
    want: "월말 종가 × 환율 기준 월 수익률 (원화)",
  },
  {
    id: "달러 종목을 달러로 사면 환율 없이 (달러)",
    row: EX_QQQ,
    params: USD_PARAMS,
    want: "월말 종가 기준 월 수익률 (달러)",
  },
  {
    id: "원화 종목을 원화로 사면 환율 없이 (원화)",
    row: KS,
    params: PARAMS,
    want: "월말 종가 기준 월 수익률 (원화)",
  },
  {
    id: "원화 종목을 달러로 사면 × 환율 (달러)",
    row: KS,
    params: USD_PARAMS,
    want: "월말 종가 × 환율 기준 월 수익률 (달러)",
  },
];

for (const { id, row, params, want } of MONTHS_INTRO_CASES) {
  test(`monthsIntro: ${id}`, () => {
    assert.equal(monthsIntro(row, params), want);
  });
}

test("monthsGrid: QLD 59달은 2021~2026 여섯 줄, 줄마다 1~12월 열두 칸", () => {
  const grid = monthsGrid(QLD_MONTHS);
  assert.deepEqual(
    grid.map((r) => r.year),
    ["2021", "2022", "2023", "2024", "2025", "2026"],
  );
  for (const row of grid) assert.equal(row.cells.length, 12, row.year);
});

test("monthsGrid: QLD는 2021-12부터 2026-10까지 59칸, 그 밖의 달은 빈칸(null)", () => {
  const grid = monthsGrid(QLD_MONTHS);
  assert.equal(grid.flatMap((r) => r.cells).filter((c) => c !== null).length, 59);
  // 2021년은 12월만, 2026년은 11·12월이 빈칸
  assert.deepEqual(
    grid[0].cells.map((c) => c !== null),
    [...Array(11).fill(false), true],
  );
  assert.deepEqual(
    grid[5].cells.map((c) => c !== null),
    [...Array(10).fill(true), false, false],
  );
});

test("monthsGrid: QLD 2022-12는 −22.3% neg, 진하기 0.893", () => {
  const row2022 = monthsGrid(QLD_MONTHS)[1];
  assert.equal(row2022.year, "2022");
  assert.deepEqual(row2022.cells[11], { text: `${MINUS}22.3%`, tone: "neg", level: 0.893 });
});

test("monthsGrid: QLD 2026-04는 +30.4% pos, 25%를 넘어 진하기 1 (결정 d61, 시안 +30.3%)", () => {
  const row2026 = monthsGrid(QLD_MONTHS)[5];
  assert.equal(row2026.year, "2026");
  assert.deepEqual(row2026.cells[3], { text: "+30.4%", tone: "pos", level: 1 });
});

test("monthsGrid: 칸 글은 늘 기호와 숫자이거나 0.0% (색만으로 알리지 않는다)", () => {
  const cells = monthsGrid(QLD_MONTHS)
    .flatMap((r) => r.cells)
    .filter((c) => c !== null);
  for (const c of cells) assert.match(c.text, /^(?:[+−]\d+\.\d%|0\.0%)$/);
});

/** 진하기 = min(|v|, 25) / 25, 소수 3자리. 화면에 0.0%로 보이는 값은 색 없이 0 (설계 메모). */
const LEVEL_CASES = [
  {
    id: "−22.33(QLD 2022-12)은 22.33/25",
    value: -22.33,
    want: { text: `${MINUS}22.3%`, tone: "neg", level: 0.893 },
  },
  {
    id: "30.35(QLD 2026-04)는 25%에서 멈춰 1",
    value: 30.35,
    want: { text: "+30.4%", tone: "pos", level: 1 },
  },
  { id: "12.5는 절반", value: 12.5, want: { text: "+12.5%", tone: "pos", level: 0.5 } },
  { id: "−25는 딱 1", value: -25, want: { text: `${MINUS}25.0%`, tone: "neg", level: 1 } },
  { id: "160.01도 1", value: 160.01, want: { text: "+160.0%", tone: "pos", level: 1 } },
  {
    id: "+0.06은 +0.1%로 보여 pos",
    value: 0.06,
    want: { text: "+0.1%", tone: "pos", level: 0.002 },
  },
  {
    id: "+0.04는 0.0%로 보여 색 없음, 진하기 0",
    value: 0.04,
    want: { text: "0.0%", tone: "", level: 0 },
  },
  {
    id: "−0.04는 −0.0%가 아니라 0.0%, 색 없음, 진하기 0",
    value: -0.04,
    want: { text: "0.0%", tone: "", level: 0 },
  },
  { id: "0은 0.0%, 색 없음", value: 0, want: { text: "0.0%", tone: "", level: 0 } },
];

for (const { id, value, want } of LEVEL_CASES) {
  test(`monthsGrid: 칸 진하기 ${id}`, () => {
    const [row] = monthsGrid({ "2024-05": value });
    assert.equal(row.year, "2024");
    assert.deepEqual(row.cells[4], want);
  });
}

test("monthsGrid: 데이터가 없는 달은 빈칸(null) (계산 규칙 9-3 거래가 없는 달)", () => {
  assert.deepEqual(monthsGrid({ "2024-01": 1, "2024-03": -2 }), [
    {
      year: "2024",
      cells: [
        { text: "+1.0%", tone: "pos", level: 0.04 },
        null,
        { text: `${MINUS}2.0%`, tone: "neg", level: 0.08 },
        ...Array(9).fill(null),
      ],
    },
  ]);
});

test("monthsGrid: months가 비면 줄이 없다", () => {
  assert.deepEqual(monthsGrid({}), []);
});

test("NO_MONTHS: 끝난 달이 없을 때 글", () => {
  assert.equal(NO_MONTHS, "끝난 달이 없어 월별 수익률이 없습니다");
});

const UP_DOWN = "오른 달 / 내린 달";

/** monthsStats 세 칸 (설계 메모): 오른·내린 달 수는 색 없음, 가장 크게 오른·내린 달은 손익 색. */
function stats(counts, best, bestTone, worst, worstTone) {
  return [
    { title: UP_DOWN, text: counts, tone: "" },
    { title: "가장 크게 오른 달", text: best, tone: bestTone },
    { title: "가장 크게 내린 달", text: worst, tone: worstTone },
  ];
}

const STATS_CASES = [
  {
    id: "QLD는 36달 / 23달, 2026-04 +30.4%(결정 d61, 시안 +30.3%), 2022-12 −22.3%",
    months: QLD_MONTHS,
    want: stats("36달 / 23달", "2026-04 +30.4%", "pos", `2022-12 ${MINUS}22.3%`, "neg"),
  },
  {
    id: "QQQ는 37달 / 22달, 2026-04 +13.5%, 2026-07 −13.9%",
    months: QQQ_MONTHS,
    want: stats("37달 / 22달", "2026-04 +13.5%", "pos", `2026-07 ${MINUS}13.9%`, "neg"),
  },
  {
    id: "오른 달이 없으면 가장 크게 오른 달은 없음",
    months: { "2024-01": -1, "2024-02": -3 },
    want: stats("0달 / 2달", "없음", "", `2024-02 ${MINUS}3.0%`, "neg"),
  },
  {
    id: "내린 달이 없으면 가장 크게 내린 달은 없음",
    months: { "2024-01": 1, "2024-02": 3 },
    want: stats("2달 / 0달", "2024-02 +3.0%", "pos", "없음", ""),
  },
  {
    id: "모두 0이면 0달 / 0달, 둘 다 없음",
    months: { "2024-01": 0, "2024-02": 0 },
    want: stats("0달 / 0달", "없음", "", "없음", ""),
  },
  {
    id: "같은 값이면 앞의 달",
    months: { "2024-01": 5, "2024-02": -3, "2024-03": 5, "2024-04": -3 },
    want: stats("2달 / 2달", "2024-01 +5.0%", "pos", `2024-02 ${MINUS}3.0%`, "neg"),
  },
];

for (const { id, months, want } of STATS_CASES) {
  test(`monthsStats: ${id}`, () => {
    assert.deepEqual(monthsStats(months), want);
  });
}

test("monthsStats: 오른·내린 달은 원래 값으로 센다 (+0.04는 오른 달, −0.04는 내린 달, 0은 빼고)", () => {
  // 칸은 둘 다 색 없는 0.0%지만 expected months.up과 같은 기준(0보다 큰 달)으로 센다 (설계 메모 6)
  const [counts] = monthsStats({ "2024-01": 0.04, "2024-02": -0.04, "2024-03": 0 });
  assert.deepEqual(counts, { title: UP_DOWN, text: "1달 / 1달", tone: "" });
});

test("monthsStats: 끝난 달이 없어 months가 비면 null", () => {
  assert.equal(monthsStats({}), null);
});

// ---------- 수익은 어디서 왔나 (F-14, 계산 규칙 9-4, #64) ----------

/** expected.json 7절 사례의 종목별 값 (buys·first_buy·last_buy·invested·value·평단가·평가 가격·환율). */
function caseOf(name) {
  const found = EXPECTED.cases.find((c) => c.name === name);
  assert.ok(found, `expected.json에 ${name} 사례가 없다`);
  return found.results;
}

/** 예시 4종목: 매월 1일 200만원, 2021-11-25 ~ 2026-11-24, 원화 (9-8과 같은 조건, 이슈 #64 완료 기준). */
const KRW_CASE = caseOf("월1일_200만원_5년");

/**
 * 예시 조건의 매수일 60번 (2021-12 ~ 2026-11 매달 1일, 휴장이면 다음 거래일): 그달 며칠에 샀는지.
 * 아래 환율·가격과 함께 fixture로 부른 /api/backtest(예시 조건) 응답의 buys[]에서 옮겼다.
 */
const BUY_DAYS = [
  1, 3, 1, 1, 1, 2, 1, 1, 1, 1, 3, 1, 1, 3, 1, 1, 3, 1, 1, 3, 1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 3, 1, 1,
  3, 1, 1, 2, 2, 3, 3, 1, 1, 2, 1, 1, 2, 1, 3, 1, 2, 2, 2, 1, 1, 1, 1, 3, 1, 1, 2,
];
const BUY_DATES = monthKeys("2021-12", BUY_DAYS.length).map(
  (month, i) => `${month}-${String(BUY_DAYS[i]).padStart(2, "0")}`,
);

/** 그날 환율 buys[].fx (원/달러). 같은 날 같은 원화를 바꾸므로 4종목이 같다 (9-4). */
const BUY_FX = [
  1182.86, 1187.78, 1205.12, 1200.93, 1214.5, 1262.53, 1241.74, 1287.71, 1302.28, 1342.26, 1439.23,
  1424.67, 1279.8, 1270.1, 1232.15, 1321.6, 1305.48, 1337.17, 1321.74, 1315.3, 1277.93, 1324.64,
  1351.94, 1350.16, 1296.66, 1293.54, 1333.91, 1335.2, 1345.31, 1385.46, 1382.1, 1380.29, 1367.92,
  1337.55, 1315.33, 1372.93, 1399.86, 1473.52, 1456.78, 1459.8, 1471.96, 1423.75, 1381.99, 1348.5,
  1391.51, 1392.94, 1403.15, 1427.17, 1465.62, 1443.64, 1448.8, 1438.5, 1503.33, 1474.01, 1506.84,
  1548.61, 1435.7, 1366.62, 1356.84, 1325.52,
];

/** 그날 매수 가격 buys[].price (달러, 분할 반영). */
const BUY_PRICES = {
  QQQ: [
    387.12, 401.68, 365.52, 341.49, 361.85, 318.48, 306, 282.13, 315.27, 299.4, 273.53, 275.11,
    293.72, 264.48, 300.92, 291.2, 320.15, 322.19, 352.01, 370.29, 382.79, 377.59, 361.26, 356.96,
    389.94, 402.59, 421.88, 445.61, 444.95, 421.52, 453.13, 481.92, 459.66, 461.81, 481.27, 487.43,
    515.29, 510.23, 518.11, 497.05, 472.7, 481.68, 523.21, 546.99, 553.88, 565.62, 603.25, 632.08,
    617.17, 613.12, 626.14, 608.09, 584.31, 674.15, 742.74, 725.17, 700.07, 707.64, 742.03, 681.09,
  ],
  QLD: [
    42.32, 45.435, 37.295, 32.24, 35.935, 27.495, 24.965, 20.975, 25.98, 23.2, 19.195, 19.145,
    21.49, 17.275, 22.155, 20.53, 24.66, 24.805, 29.37, 32.345, 34.32, 33.095, 30.15, 29.19, 34.555,
    36.72, 40.03, 44.305, 43.945, 39.075, 44.845, 50.515, 45.445, 45.31, 48.925, 49.825, 55.285,
    53.88, 55.115, 50.395, 45.135, 45.375, 53.17, 57.83, 58.935, 61.08, 69.26, 75.41, 71.35, 70.1,
    72.73, 68.13, 62.49, 82.6, 99.63, 93.9, 86.62, 87.92, 96.24, 80.3,
  ],
  TQQQ: [
    38.775, 42.7825, 31.505, 25.02, 28.965, 19.125, 16.14, 12.195, 16.655, 13.92, 10.33, 10.15,
    11.845, 8.455, 12.195, 10.795, 14.03, 14.085, 18.005, 20.64, 22.48, 21.145, 18.235, 17.235,
    22.12, 24.065, 27.25, 31.565, 30.97, 25.8, 31.57, 37.515, 31.68, 31.175, 34.71, 35.465, 41.24,
    39.315, 40.36, 35.04, 29.31, 28.385, 35.805, 40.445, 41.46, 43.54, 52.43, 59.16, 54.05, 52.35,
    55.1, 49.7, 43.23, 65.3, 86.04, 77.46, 67.96, 69.15, 78.73, 59.46,
  ],
  SOXL: [
    63.16, 72.1, 45.91, 36.58, 36.29, 24.5, 23.71, 11.6, 20.01, 13.22, 9.7, 9.1, 13.5, 9.36, 16.8,
    14.68, 17.81, 14.66, 22.16, 25.49, 28.53, 24.02, 19.08, 15.95, 23.07, 28.04, 32.45, 48.33,
    47.99, 34.37, 48.59, 55.36, 35, 30.07, 33.83, 30.83, 30.2, 27.67, 25.61, 20.51, 15.95, 12.1,
    16.9, 24.71, 24.08, 25.25, 36.86, 48.58, 41.31, 47.24, 65.2, 62.76, 52.26, 130.4, 227.03,
    217.55, 116.71, 105.91, 153.69, 68.17,
  ],
};

/**
 * 예시 매수일마다 한 줄인 buys[] (상세 설계 4절)에서 두 묶음이 읽는 date·price·fx·lot_return_pct.
 * 산 줄인지는 lot_return_pct가 null이 아닌지로만 가린다 (4절, 결정 d58). 산 줄의 값은 이 구역이
 * 쓰지 않아 1로 둔다. skipped는 사지 않은 매수일(lot_return_pct null)이다.
 */
function exampleBuys(prices, { fx = BUY_FX, skipped = [] } = {}) {
  return BUY_DATES.map((date, i) => ({
    date,
    price: prices[i],
    fx: fx[i],
    lot_return_pct: skipped.includes(date) ? null : 1,
  }));
}

/** 손으로 만든 결과 한 줄 (상세 설계 4절 results[]): 두 묶음이 읽는 summary·analysis·buys만. */
function holding(symbol, currency, summary, { buys = [], analysis = {} } = {}) {
  return { symbol, name: `${symbol} 이름`, currency, summary, analysis, buys };
}

/** 결과 한 줄에서 summary 일부만 바꾼 것. */
function withSummary(row, changes) {
  return { ...row, summary: { ...row.summary, ...changes } };
}

/** 주가 효과. QQQ·TQQQ·SOXL은 expected.json에 없어 fixture 응답의 summary.price_effect에서 옮겼다. */
const PRICE_EFFECT = {
  QQQ: 65_805_493,
  QLD: METRICS.price_effect,
  TQQQ: 120_025_457,
  SOXL: 83_383_114,
};

/** 싸게 산 횟수 [지금 가격보다, 평단가보다]. QLD는 expected.json, 나머지는 fixture 응답의 analysis. */
const BELOW = {
  QQQ: [53, 26],
  QLD: [METRICS.buys_below_eval_price, METRICS.buys_below_avg_cost],
  TQQQ: [47, 21],
  SOXL: [41, 25],
};

/**
 * 예시 조건 결과 한 줄. summary는 expected.json 사례 값이고 손익은 평가금 − 투자금(응답 summary.profit과
 * 같다). 환율 효과·평균 매수 환율은 종목과 상관없어(9-4) v2.metrics(QLD) 값을 4종목에 쓴다
 * (fixture 응답도 4종목 모두 −746,367원·1,352.57원).
 */
function exampleResult(symbol) {
  const c = KRW_CASE[symbol];
  const [belowEval, belowAvg] = BELOW[symbol];
  return holding(
    symbol,
    "USD",
    {
      buys: c.buys,
      first_buy: c.first_buy,
      last_buy: c.last_buy,
      avg_cost_asset: c.avg_cost_asset,
      eval_price: c.eval_price,
      eval_fx: c.eval_fx,
      profit: c.value - c.invested,
      price_effect: PRICE_EFFECT[symbol],
      fx_effect: METRICS.fx_effect,
      avg_buy_fx: METRICS.avg_buy_fx,
    },
    {
      buys: exampleBuys(BUY_PRICES[symbol]),
      analysis: { buys_below_eval_price: belowEval, buys_below_avg_cost: belowAvg },
    },
  );
}

const KRW4 = Object.fromEntries(Object.keys(BUY_PRICES).map((s) => [s, exampleResult(s)]));
const KRW4_RESULTS = Object.values(KRW4);

/**
 * QQQ를 달러로 산 결과 (매월 1일 $1,500, expected.json "월1일_1500달러_5년"). 종목 통화가 투자 통화와
 * 같아 환율 효과 0, 평균 매수 환율 null이다 (상세 설계 4절). 주가 효과는 fixture 응답(달러) 값이다.
 */
const USD_CASE = caseOf("월1일_1500달러_5년").QQQ;
const USD_QQQ = holding(
  "QQQ",
  "USD",
  {
    buys: USD_CASE.buys,
    first_buy: USD_CASE.first_buy,
    last_buy: USD_CASE.last_buy,
    avg_cost_asset: USD_CASE.avg_cost_asset,
    eval_price: USD_CASE.eval_price,
    eval_fx: USD_CASE.eval_fx,
    profit: USD_CASE.value - USD_CASE.invested,
    price_effect: 48_170.85,
    fx_effect: 0,
    avg_buy_fx: null,
  },
  { buys: exampleBuys(BUY_PRICES.QQQ, { fx: BUY_FX.map(() => USD_CASE.eval_fx) }) },
);

/**
 * 같은 조건 rule=switch (QLD, QQQ 200일선 아래인 매수일은 쉰다). 쉰 매수일 15번은 fixture 응답
 * (rule switch)의 buys에서 lot_return_pct가 null인 날이고, 매수일·가격·환율은 기본 적립과 같다.
 * summary.buys는 쉰 날도 세어 60이다 (fixture 응답, 9-4). 평단가·평가금은 expected.json
 * v2.strategies.switch, 싸게 산 횟수는 v2.rule_bought.switch, 주가 효과는 fixture 응답 값이다.
 */
const SWITCH = EXPECTED.v2.strategies.switch;
const SWITCH_BOUGHT = EXPECTED.v2.rule_bought.switch;
const SWITCH_SKIPPED = [
  "2022-02-01",
  "2022-03-01",
  "2022-04-01",
  "2022-05-02",
  "2022-06-01",
  "2022-07-01",
  "2022-08-01",
  "2022-09-01",
  "2022-10-03",
  "2022-11-01",
  "2022-12-01",
  "2023-01-03",
  "2025-04-01",
  "2025-05-01",
  "2026-04-01",
];
const SWITCH_QLD = {
  ...withSummary(KRW4.QLD, {
    avg_cost_asset: SWITCH.avg_cost_asset,
    profit: SWITCH.value - KRW_CASE.QLD.invested,
    price_effect: 112_140_459,
  }),
  analysis: {
    buys_below_eval_price: SWITCH_BOUGHT.buys_below_eval_price,
    buys_below_avg_cost: SWITCH_BOUGHT.buys_below_avg_cost,
  },
  buys: exampleBuys(BUY_PRICES.QLD, { skipped: SWITCH_SKIPPED }),
};

/** 원화 종목을 원화로 산 결과: 통화가 같아 환율 효과 0, 평균 매수 환율 null (상세 설계 4절). */
const KS_KRW = holding("005930.KS", "KRW", {
  buys: 60,
  price_effect: 50_000_000,
  fx_effect: 0,
  profit: 50_000_000,
  avg_buy_fx: null,
});

/**
 * 원화 종목을 달러로 산 결과 (3번). 환율은 원 1당 달러라 1보다 작다 (format.js fx는 유효숫자 4자리).
 * 값은 문장 모양만 보려고 둔 것이다.
 */
const KS_USD = holding(
  "005930.KS",
  "KRW",
  {
    buys: 3,
    first_buy: "2026-09-01",
    last_buy: "2026-11-02",
    eval_fx: 0.000744,
    avg_buy_fx: 0.000741,
    price_effect: 1234.5,
    fx_effect: 12.34,
    profit: 1246.84,
  },
  {
    buys: [
      { date: "2026-09-01", price: 71_000, fx: 0.000752, lot_return_pct: 1 },
      { date: "2026-10-01", price: 74_500, fx: 0.000731, lot_return_pct: 1 },
      { date: "2026-11-02", price: 76_200, fx: 0.000741, lot_return_pct: 1 },
    ],
  },
);

/** 엔화 종목을 원화로 산 결과 (종목 통화가 여럿인 경우를 보려고 둔 값). */
const JP = holding("7203.T", "JPY", {
  buys: 60,
  price_effect: 3_000_000,
  fx_effect: -500_000,
  profit: 2_500_000,
  avg_buy_fx: 9.12,
});

test("예시 매수일(테스트 도구): 60번이고 첫날·끝날이 expected.json과 같다. 가격·환율도 60개", () => {
  assert.equal(BUY_DATES.length, KRW_CASE.QLD.buys);
  assert.equal(BUY_DATES[0], KRW_CASE.QLD.first_buy);
  assert.equal(BUY_DATES.at(-1), KRW_CASE.QLD.last_buy);
  assert.ok(BUY_DATES.includes("2023-01-03") && BUY_DATES.includes("2026-07-01"));
  assert.equal(BUY_FX.length, BUY_DATES.length);
  for (const [symbol, prices] of Object.entries(BUY_PRICES)) {
    assert.equal(prices.length, BUY_DATES.length, symbol);
  }
});

test("SWITCH_QLD(테스트 도구): 쉰 날 15번(v2.strategies.switch.rule_days), 산 날 45번(v2.rule_bought)", () => {
  assert.equal(SWITCH_SKIPPED.length, SWITCH.rule_days);
  for (const date of SWITCH_SKIPPED) assert.ok(BUY_DATES.includes(date), date);
  const bought = SWITCH_QLD.buys.filter((b) => b.lot_return_pct !== null);
  assert.equal(bought.length, SWITCH_BOUGHT.bought);
});

// 위 글 (이슈 #64 할 일): "원화"는 투자 통화, "달러"는 수익 줄 종목 통화 이름 (여럿이면 "종목 통화")
const KRW_VS_USD =
  "원화 손익 = 주가 효과(달러로 번 돈 × 지금 환율) + " +
  `환율 효과(산 달러를 지금 환율로 바꾼 값 ${MINUS} 넣은 원화)`;
const PROFIT_INTRO_CASES = [
  {
    id: "원화로 달러 종목을 사면 원화 손익, 달러로 번 돈 (예시 4종목)",
    results: KRW4_RESULTS,
    currency: "KRW",
    want: KRW_VS_USD,
  },
  {
    id: "달러로 원화 종목을 사면 달러 손익, 원화로 번 돈",
    results: [KS_USD],
    currency: "USD",
    want:
      "달러 손익 = 주가 효과(원화로 번 돈 × 지금 환율) + " +
      `환율 효과(산 원화를 지금 환율로 바꾼 값 ${MINUS} 넣은 달러)`,
  },
  {
    id: "수익 줄의 종목 통화가 여럿이면 종목 통화",
    results: [KRW4.QQQ, JP],
    currency: "KRW",
    want:
      "원화 손익 = 주가 효과(종목 통화로 번 돈 × 지금 환율) + " +
      `환율 효과(산 종목 통화를 지금 환율로 바꾼 값 ${MINUS} 넣은 원화)`,
  },
  {
    id: "투자 통화와 같은 원화 종목은 수익 줄이 아니라 통화 이름에 들지 않는다",
    results: [KRW4.QQQ, KS_KRW],
    currency: "KRW",
    want: KRW_VS_USD,
  },
];

for (const { id, results, currency, want } of PROFIT_INTRO_CASES) {
  test(`profitIntro: ${id}`, () => {
    assert.equal(profitIntro(results, currency), want);
  });
}

test("profitRows: 예시 4종목은 네 줄, 주가 효과 · 환율 효과 → 손익이 이슈 완료 기준(시안)과 같다", () => {
  // QLD는 9-8 값 +106,570,957원 / −746,367원. 폭은 |손익| ÷ 가장 큰 |손익|(TQQQ), 소수 4자리
  assert.deepEqual(profitRows(KRW4_RESULTS, "KRW"), [
    {
      symbol: "QQQ",
      price: "+6,581만원",
      priceTone: "pos",
      fx: `${MINUS}75만원`,
      fxTone: "neg",
      total: "+6,506만원",
      tone: "pos",
      width: 0.5454,
    },
    {
      symbol: "QLD",
      price: "+1억 657만원",
      priceTone: "pos",
      fx: `${MINUS}75만원`,
      fxTone: "neg",
      total: "+1억 582만원",
      tone: "pos",
      width: 0.8872,
    },
    {
      symbol: "TQQQ",
      price: "+1억 2,003만원",
      priceTone: "pos",
      fx: `${MINUS}75만원`,
      fxTone: "neg",
      total: "+1억 1,928만원",
      tone: "pos",
      width: 1,
    },
    {
      symbol: "SOXL",
      price: "+8,338만원",
      priceTone: "pos",
      fx: `${MINUS}75만원`,
      fxTone: "neg",
      total: "+8,264만원",
      tone: "pos",
      width: 0.6928,
    },
  ]);
});

test("profitRows: 줄은 results 순서", () => {
  const rows = profitRows([...KRW4_RESULTS].reverse(), "KRW");
  assert.deepEqual(
    rows.map((r) => r.symbol),
    ["SOXL", "TQQQ", "QLD", "QQQ"],
  );
});

test("profitRows: 손익은 summary.profit이다 (두 효과의 합과 1원 다를 수 있다, 상세 설계 4절)", () => {
  // 합 9,999원이면 "+9,999원"이지만 손익 10,000원은 "+1만원"
  const row = holding("QQQ", "USD", { price_effect: 5000, fx_effect: 4999, profit: 10_000 });
  const [shown] = profitRows([row], "KRW");
  assert.deepEqual([shown.price, shown.fx, shown.total], ["+5,000원", "+4,999원", "+1만원"]);
});

test("profitRows: QQQ를 달러로 산 결과는 줄이 없다 (종목 통화 = 투자 통화, 9-4, 이슈 완료 기준)", () => {
  assert.deepEqual(profitRows([USD_QQQ], "USD"), []);
});

test("profitRows: 원화 종목만 원화로 사면 줄이 없다", () => {
  assert.deepEqual(profitRows([KS_KRW], "KRW"), []);
});

test("profitRows: price_effect가 없는 옛 응답(v1)은 줄이 아니고, 폭은 남은 줄끼리 견준다", () => {
  const old = { ...KRW4.TQQQ, summary: { ...KRW4.TQQQ.summary } };
  delete old.summary.price_effect;
  const rows = profitRows([KRW4.QQQ, old], "KRW");
  assert.deepEqual(
    rows.map((r) => [r.symbol, r.width]),
    [["QQQ", 1]],
  );
});

test("profitRows: 손실이면 폭은 |손익|, 세 값의 색은 보이는 값의 부호 (0원은 색 없음)", () => {
  const loss = holding("LOSS", "USD", {
    price_effect: -19_253_633,
    fx_effect: -746_367,
    profit: -20_000_000,
  });
  const gain = holding("GAIN", "USD", {
    price_effect: 10_000_000,
    fx_effect: 0,
    profit: 10_000_000,
  });
  assert.deepEqual(profitRows([loss, gain], "KRW"), [
    {
      symbol: "LOSS",
      price: `${MINUS}1,925만원`,
      priceTone: "neg",
      fx: `${MINUS}75만원`,
      fxTone: "neg",
      total: `${MINUS}2,000만원`,
      tone: "neg",
      width: 1,
    },
    {
      symbol: "GAIN",
      price: "+1,000만원",
      priceTone: "pos",
      fx: "0원",
      fxTone: "",
      total: "+1,000만원",
      tone: "pos",
      width: 0.5,
    },
  ]);
});

test("profitRows: 손익이 모두 0이면 폭 0 (가장 큰 |손익|이 0)", () => {
  const flat = holding("FLAT", "USD", { price_effect: 0, fx_effect: 0, profit: 0 });
  assert.deepEqual(profitRows([flat], "KRW"), [
    {
      symbol: "FLAT",
      price: "0원",
      priceTone: "",
      fx: "0원",
      fxTone: "",
      total: "0원",
      tone: "",
      width: 0,
    },
  ]);
});

// 상자 글 (이슈 #64 완료 기준, 결정 d62). 조각은 한 <p>에 잇고 strong 조각만 굵게 쓴다
const FX_SAME = `환율 효과는 4개 종목 모두 ${MINUS}75만원으로 같습니다.`;
const FX_WHY = "같은 날 같은 원화를 달러로 바꿨기 때문입니다.";
const AVG_FX_LEAD =
  "60번 평균 매수 환율은 1,352.57원(가장 쌀 때 1,182.86원 2021-12-01, 가장 비쌀 때 1,548.61원 " +
  "2026-07-01)이고, ";
const AVG_FX = `${AVG_FX_LEAD}평가 환율 1,344.16원이 그보다 낮습니다.`;

test("profitNotes: 예시 4종목은 굵은 첫 문장, 그 이유, 평균 매수 환율 문장 (이슈 완료 기준)", () => {
  assert.deepEqual(profitNotes(KRW4_RESULTS, "KRW"), [
    { text: FX_SAME, strong: true },
    { text: FX_WHY, strong: false },
    { text: AVG_FX, strong: false },
  ]);
});

test("profitNotes: QQQ를 달러로 산 결과는 빈 목록 (상자가 없다)", () => {
  assert.deepEqual(profitNotes([USD_QQQ], "USD"), []);
});

test("profitNotes: 레버리지 전환 QLD 하나는 평균 매수 환율 문장만. 60번은 산 45번이 아니라 매수일 수 (9-4)", () => {
  // 줄이 하나라 첫 문장이 없다. 쉰 날도 그날 환율로 바꾸므로 summary.buys(60)를 쓴다
  assert.deepEqual(profitNotes([SWITCH_QLD], "KRW"), [{ text: AVG_FX, strong: false }]);
});

test("profitNotes: 환율 효과 원래 값이 달라도 보이는 글(−75만원)이 같으면 첫 문장을 쓴다", () => {
  const results = [withSummary(KRW4.QQQ, { fx_effect: -746_400 }), ...KRW4_RESULTS.slice(1)];
  assert.deepEqual(
    profitNotes(results, "KRW").map((n) => n.text),
    [FX_SAME, FX_WHY, AVG_FX],
  );
});

/** 첫 문장 조건(설계 메모): 줄 2개 이상, 환율 효과 글·종목 통화·매수일(횟수·첫날·끝날)이 모두 같다. */
const NO_FIRST_CASES = [
  { id: "환율 효과 글이 다르면 (−80만원)", soxl: withSummary(KRW4.SOXL, { fx_effect: -800_000 }) },
  { id: "첫 매수일이 다르면", soxl: withSummary(KRW4.SOXL, { first_buy: "2021-12-02" }) },
  { id: "끝 매수일이 다르면", soxl: withSummary(KRW4.SOXL, { last_buy: "2026-10-01" }) },
  { id: "종목 통화가 다르면", soxl: { ...KRW4.SOXL, currency: "JPY" } },
];

for (const { id, soxl } of NO_FIRST_CASES) {
  test(`profitNotes: ${id} 첫 문장 없이 평균 매수 환율 문장만`, () => {
    const results = [...KRW4_RESULTS.slice(0, 3), soxl];
    assert.deepEqual(profitNotes(results, "KRW"), [{ text: AVG_FX, strong: false }]);
  });
}

test("profitNotes: 매수 횟수가 달라 문장이 다르면 줄마다 종목 코드를 앞에 붙인다", () => {
  // 2024-07 상장이라 예시 매수일 가운데 뒤 29번만 산 종목. 환율 효과 글은 같게 두어 매수일만 다르다.
  // 평균 매수 환율 1,421.07은 문장 모양만 보려고 둔 값이다
  const late = holding(
    "LATE",
    "USD",
    {
      buys: 29,
      first_buy: "2024-07-01",
      last_buy: "2026-11-02",
      eval_fx: KRW_CASE.QQQ.eval_fx,
      avg_buy_fx: 1421.07,
      price_effect: 10_000_000,
      fx_effect: METRICS.fx_effect,
      profit: 9_253_633,
    },
    { buys: exampleBuys(BUY_PRICES.QQQ).slice(31) },
  );
  assert.deepEqual(profitNotes([KRW4.QQQ, late], "KRW"), [
    { text: `QQQ ${AVG_FX}`, strong: false },
    {
      text:
        "LATE 29번 평균 매수 환율은 1,421.07원(가장 쌀 때 1,315.33원 2024-10-01, 가장 비쌀 때 " +
        "1,548.61원 2026-07-01)이고, 평가 환율 1,344.16원이 그보다 낮습니다.",
      strong: false,
    },
  ]);
});

const EVAL_FX_CASES = [
  {
    id: "평가 환율이 평균보다 높으면 높습니다",
    evalFx: 1400,
    tail: "평가 환율 1,400.00원이 그보다 높습니다.",
  },
  {
    id: "평가 환율이 보이는 값(1,352.57원)으로 같으면 같습니다",
    evalFx: 1352.574,
    tail: "평가 환율 1,352.57원이 그와 같습니다.",
  },
  {
    id: "원래 값은 낮아도(1,352.566) 보이는 값이 같으면 같습니다",
    evalFx: 1352.566,
    tail: "평가 환율 1,352.57원이 그와 같습니다.",
  },
];

for (const { id, evalFx, tail } of EVAL_FX_CASES) {
  test(`profitNotes: ${id}`, () => {
    const notes = profitNotes([withSummary(KRW4.QLD, { eval_fx: evalFx })], "KRW");
    assert.deepEqual(notes, [{ text: `${AVG_FX_LEAD}${tail}`, strong: false }]);
  });
}

test("profitNotes: 가장 쌀 때·비쌀 때는 쉰 매수일의 환율도 본다 (쉰 날도 그날 환전, 9-4)", () => {
  // 2026-02-02는 쉬었지만(lot_return_pct null) 환율이 가장 비싸다. 평균 1,443.65는 모양만 보려는 값
  const row = holding(
    "QLD",
    "USD",
    {
      buys: 3,
      first_buy: "2026-01-02",
      last_buy: "2026-03-02",
      eval_fx: KRW_CASE.QLD.eval_fx,
      avg_buy_fx: 1443.65,
      price_effect: 1_000_000,
      fx_effect: -500_000,
      profit: 500_000,
    },
    {
      buys: [
        { date: "2026-01-02", price: 70.1, fx: 1443.64, lot_return_pct: 1 },
        { date: "2026-02-02", price: 72.73, fx: 1448.8, lot_return_pct: null },
        { date: "2026-03-02", price: 68.13, fx: 1438.5, lot_return_pct: 1 },
      ],
    },
  );
  assert.deepEqual(profitNotes([row], "KRW"), [
    {
      text:
        "3번 평균 매수 환율은 1,443.65원(가장 쌀 때 1,438.50원 2026-03-02, 가장 비쌀 때 1,448.80원 " +
        "2026-02-02)이고, 평가 환율 1,344.16원이 그보다 낮습니다.",
      strong: false,
    },
  ]);
});

test("profitNotes: 환율이 같은 날이 여럿이면 가장 쌀 때·비쌀 때는 앞 날짜", () => {
  const fxs = [1300, 1250, 1400, 1250, 1400];
  const dates = ["2025-01-02", "2025-02-03", "2025-03-03", "2025-04-01", "2025-05-01"];
  const row = holding(
    "QLD",
    "USD",
    {
      buys: 5,
      first_buy: dates[0],
      last_buy: dates[4],
      eval_fx: 1344.16,
      avg_buy_fx: 1315.79,
      price_effect: 1_000_000,
      fx_effect: 100_000,
      profit: 1_100_000,
    },
    { buys: dates.map((date, i) => ({ date, price: 50, fx: fxs[i], lot_return_pct: 1 })) },
  );
  const [note] = profitNotes([row], "KRW");
  assert.ok(
    note.text.includes("(가장 쌀 때 1,250.00원 2025-02-03, 가장 비쌀 때 1,400.00원 2025-03-03)"),
    note.text,
  );
});

test("profitNotes: 달러로 원화 종목을 사면 환율 뒤에 원을 붙이지 않는다", () => {
  const notes = profitNotes([KS_USD], "USD");
  assert.equal(notes.length, 1);
  const [{ text, strong }] = notes;
  assert.equal(strong, false);
  assert.ok(
    text.startsWith(
      "3번 평균 매수 환율은 0.000741(가장 쌀 때 0.000731 2026-10-01, 가장 비쌀 때 0.000752 " +
        "2026-09-01)이고, 평가 환율 0.000744",
    ),
    text,
  );
  assert.ok(text.endsWith("그보다 높습니다."), text);
  assert.ok(!text.includes("원"), text);
});

const SKIP_NOTE_CASES = [
  { id: "avg_buy_fx가 null", row: withSummary(KRW4.QLD, { avg_buy_fx: null }) },
  {
    id: "avg_buy_fx가 빠진 응답(undefined)",
    row: withSummary(KRW4.QLD, { avg_buy_fx: undefined }),
  },
  { id: "buys가 빈 목록", row: { ...KRW4.QLD, buys: [] } },
];

for (const { id, row } of SKIP_NOTE_CASES) {
  test(`profitNotes: ${id}이면 그 줄의 평균 매수 환율 문장을 건너뛴다`, () => {
    assert.deepEqual(profitNotes([row], "KRW"), []);
  });
}

// ---------- 얼마에 샀나 (F-14, 계산 규칙 9-1, #64) ----------

/**
 * 손으로 만든 매수 가격 분포용 결과: prices마다 산 줄 하나 (날짜는 2025-01부터 매달 2일).
 * 싸게 산 횟수는 below로 준다.
 */
function priced(prices, options = {}) {
  const { evalPrice, avgCost = null, currency = "USD", symbol = "TEST", below = [0, 0] } = options;
  const buys = monthKeys("2025-01", prices.length).map((month, i) => ({
    date: `${month}-02`,
    price: prices[i],
    fx: 1400,
    lot_return_pct: 1,
  }));
  return holding(
    symbol,
    currency,
    { buys: prices.length, eval_price: evalPrice, avg_cost_asset: avgCost },
    { buys, analysis: { buys_below_eval_price: below[0], buys_below_avg_cost: below[1] } },
  );
}

/** 원화 종목 (경계 글은 원화 정수). */
const KS_PRICED = priced([51_000, 60_000, 72_000, 88_000], {
  evalPrice: 80_000,
  avgCost: 66_000,
  currency: "KRW",
  symbol: "005930.KS",
});

/** 정수 주만으로 한 주도 못 산 결과: 매수일은 있지만 산 줄이 없고 평단가도 없다. */
const NONE_BOUGHT = holding(
  "BRK-A",
  "USD",
  { buys: 3, eval_price: 720_000, avg_cost_asset: null },
  {
    buys: [
      { date: "2026-09-01", price: 690_000, fx: 1392.94, lot_return_pct: null },
      { date: "2026-10-01", price: 701_000, fx: 1403.15, lot_return_pct: null },
      { date: "2026-11-02", price: 712_500, fx: 1427.17, lot_return_pct: null },
    ],
    analysis: { buys_below_eval_price: 0, buys_below_avg_cost: 0 },
  },
);

test("NO_BUYS: 산 날이 없을 때 글", () => {
  assert.equal(NO_BUYS, "산 날이 없어 매수 가격 분포가 없습니다");
});

const BUY_INTRO_CASES = [
  { id: "QLD는 산 60번, 달러", row: KRW4.QLD, want: "60번 매수 가격의 분포 (달러, 분할 반영)" },
  {
    id: "레버리지 전환 QLD는 쉰 날을 빼고 산 45번",
    row: SWITCH_QLD,
    want: "45번 매수 가격의 분포 (달러, 분할 반영)",
  },
  { id: "원화 종목은 원화", row: KS_PRICED, want: "4번 매수 가격의 분포 (원화, 분할 반영)" },
  {
    id: "산 날이 없으면 횟수 없이",
    row: NONE_BOUGHT,
    want: "매수 가격의 분포 (달러, 분할 반영)",
  },
];

for (const { id, row, want } of BUY_INTRO_CASES) {
  test(`buyPriceIntro: ${id}`, () => {
    assert.equal(buyPriceIntro(row), want);
  });
}

/** 칸 개수 목록. */
function countsOf(dist) {
  return dist.bins.map((b) => b.count);
}

/** 칸 개수 합. */
function totalOf(dist) {
  return countsOf(dist).reduce((a, b) => a + b, 0);
}

const QLD_COUNTS = [8, 8, 8, 8, 7, 6, 2, 5, 2, 2, 2, 2];

test("buyPriceDist: QLD는 $17 ~ $102를 12칸, 칸 합 60 (이슈 완료 기준, 시안)", () => {
  const dist = buyPriceDist(KRW4.QLD);
  assert.equal(dist.count, METRICS.buys);
  assert.deepEqual([dist.lo, dist.hi, dist.loLabel, dist.hiLabel], [17, 102, "$17", "$102"]);
  assert.deepEqual(countsOf(dist), QLD_COUNTS);
  assert.equal(totalOf(dist), METRICS.buys);
});

test("buyPriceDist: QLD는 칸 위 끝이 지금 가격 $71.91 이하인 앞 7칸만 색칠", () => {
  assert.deepEqual(
    buyPriceDist(KRW4.QLD).bins.map((b) => b.filled),
    [...Array(7).fill(true), ...Array(5).fill(false)],
  );
});

test("buyPriceDist: QLD 칸 높이는 가장 많은 칸(8번) 기준", () => {
  assert.deepEqual(
    buyPriceDist(KRW4.QLD).bins.map((b) => b.height),
    [1, 1, 1, 1, 0.875, 0.75, 0.25, 0.625, 0.25, 0.25, 0.25, 0.25],
  );
});

test("buyPriceDist: 칸 높이는 소수 3자리 (레버리지 전환 QLD, 가장 많은 칸 7번)", () => {
  assert.deepEqual(
    buyPriceDist(SWITCH_QLD).bins.map((b) => b.height),
    [0.571, 0.714, 0.714, 1, 0.857, 0.571, 0.143, 0.714, 0.286, 0.429, 0.143, 0.286],
  );
});

test("buyPriceDist: 칸은 lo에서 hi까지 빈틈없이 [from, to)로 잇는다", () => {
  const { bins, lo, hi } = buyPriceDist(KRW4.QLD);
  assert.equal(bins[0].from, lo);
  assert.ok(Math.abs(bins.at(-1).to - hi) < 1e-9, `${bins.at(-1).to}`);
  for (let i = 1; i < bins.length; i += 1) {
    assert.ok(Math.abs(bins[i].from - bins[i - 1].to) < 1e-9, `${i}번째 칸`);
    assert.ok(bins[i].from > bins[i - 1].from, `${i}번째 칸`);
  }
});

test("buyPriceDist: QLD 막대 title은 정수 경계 가격과 횟수 (칸 너비 85 ÷ 12 ≥ 1)", () => {
  const { bins } = buyPriceDist(KRW4.QLD);
  // 설계 메모 4: 이슈의 "$17 ~ $24: 7번"은 예시이고 첫 칸은 8번이다
  assert.equal(bins[0].title, "$17 ~ $24: 8번");
  assert.equal(bins.at(-1).title, "$95 ~ $102: 2번");
});

test("buyPriceDist: QLD 평단가 선 $37.97, 지금 선 $71.91 (이슈 완료 기준)", () => {
  const dist = buyPriceDist(KRW4.QLD);
  // left = (값 − 17) ÷ (102 − 17), 소수 4자리. 0.8을 넘지 않아 글은 선 오른쪽
  assert.deepEqual(dist.avg, { left: 0.2468, label: "평단가 $37.97", flip: false });
  assert.deepEqual(dist.now, { left: 0.646, label: "지금 $71.91", flip: false });
});

test("buyPriceDist: QLD aria-label은 가격 범위·칸별 횟수·평단가·지금 가격", () => {
  assert.equal(
    buyPriceDist(KRW4.QLD).aria,
    "QLD 매수 가격 분포 그래프. $17 ~ $102를 12칸으로 나눈 칸별 횟수 " +
      "8, 8, 8, 8, 7, 6, 2, 5, 2, 2, 2, 2. 평단가 $37.97, 지금 $71.91.",
  );
});

for (const symbol of ["QQQ", "TQQQ", "SOXL"]) {
  test(`buyPriceDist: ${symbol} 막대 12칸의 합은 산 60번`, () => {
    const dist = buyPriceDist(KRW4[symbol]);
    assert.equal(dist.bins.length, 12);
    assert.equal(dist.count, KRW_CASE[symbol].buys);
    assert.equal(totalOf(dist), KRW_CASE[symbol].buys);
  });
}

test("buyPriceDist: 레버리지 전환 QLD는 산 45번만 센다 (쉰 2023-01-03 $17.275를 빼 lo $20, #62)", () => {
  const dist = buyPriceDist(SWITCH_QLD);
  assert.equal(dist.count, SWITCH_BOUGHT.bought);
  assert.deepEqual([dist.lo, dist.hi, dist.loLabel], [20, 102, "$20"]);
  assert.deepEqual(countsOf(dist), [4, 5, 5, 7, 6, 4, 1, 5, 2, 3, 1, 2]);
  assert.equal(totalOf(dist), SWITCH_BOUGHT.bought);
});

test("buyPriceDist: bins를 주면 그 칸 수 (QLD 6칸은 12칸을 둘씩 합친 값)", () => {
  const dist = buyPriceDist(KRW4.QLD, { bins: 6 });
  assert.deepEqual([dist.lo, dist.hi], [17, 102]);
  assert.deepEqual(countsOf(dist), [16, 16, 13, 7, 4, 4]);
  assert.ok(
    dist.aria.includes("$17 ~ $102를 6칸으로 나눈 칸별 횟수 16, 16, 13, 7, 4, 4."),
    dist.aria,
  );
});

// 칸 너비 1: lo 10, hi = ceil(21.5 × 1.02) = 22. 칸 i는 [10 + i, 11 + i)
const WIDTH_ONE = priced([10.5, 13, 21.5], { evalPrice: 15, avgCost: 15 });

test("buyPriceDist: 경계에 걸린 가격은 위 칸 ($13은 [$13, $14) 칸)", () => {
  const dist = buyPriceDist(WIDTH_ONE);
  assert.deepEqual([dist.lo, dist.hi], [10, 22]);
  assert.deepEqual(countsOf(dist), [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(dist.bins[3].title, "$13 ~ $14: 1번");
});

test("buyPriceDist: 칸 위 끝이 지금 가격과 같으면 색칠 ($14 ~ $15 칸, 지금 $15)", () => {
  assert.deepEqual(
    buyPriceDist(WIDTH_ONE).bins.map((b) => b.filled),
    [...Array(5).fill(true), ...Array(7).fill(false)],
  );
});

test("buyPriceDist: 지금 가격이 가장 높은 매수 가격보다 높으면 hi는 지금 가격 × 1.02 올림", () => {
  // 가장 높은 매수 가격 $30이면 hi 31이지만 지금 $49라 ceil(49.98) = 50
  const dist = buyPriceDist(priced([10, 20, 30], { evalPrice: 49, avgCost: 20 }));
  assert.deepEqual([dist.lo, dist.hi, dist.hiLabel], [10, 50, "$50"]);
  assert.deepEqual(countsOf(dist), [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]);
  // 마지막 칸 위 끝 $50만 지금 가격 위라 회색
  assert.deepEqual(
    dist.bins.map((b) => b.filled),
    [...Array(11).fill(true), false],
  );
  // 지금 선은 0.975로 오른쪽 끝(0.8 넘음)이라 글을 선 왼쪽에 둔다
  assert.deepEqual(dist.now, { left: 0.975, label: "지금 $49.00", flip: true });
  assert.deepEqual(dist.avg, { left: 0.25, label: "평단가 $20.00", flip: false });
});

test("buyPriceDist: 칸 너비가 1보다 작으면 경계 글은 소수 2자리", () => {
  // lo 10, hi = ceil(12.5 × 1.02) = 13, 칸 너비 0.25
  const dist = buyPriceDist(priced([10.2, 12.5], { evalPrice: 12 }));
  assert.deepEqual([dist.lo, dist.hi, dist.loLabel, dist.hiLabel], [10, 13, "$10.00", "$13.00"]);
  assert.equal(dist.bins[0].title, "$10.00 ~ $10.25: 1번");
  assert.equal(dist.bins[10].title, "$12.50 ~ $12.75: 1번");
});

test("buyPriceDist: 원화 종목 경계 글은 원화 정수", () => {
  // lo 51,000, hi = ceil(88,000 × 1.02) = 89,760, 칸 너비 3,230
  const dist = buyPriceDist(KS_PRICED);
  assert.deepEqual(
    [dist.lo, dist.hi, dist.loLabel, dist.hiLabel],
    [51_000, 89_760, "51,000원", "89,760원"],
  );
  assert.equal(dist.bins[0].title, "51,000원 ~ 54,230원: 1번");
  assert.equal(dist.avg.label, "평단가 66,000원");
  assert.equal(dist.now.label, "지금 80,000원");
});

test("buyPriceDist: 선 글은 left가 0.8을 넘을 때만 왼쪽 (0.8은 그대로 오른쪽)", () => {
  // lo 0, hi = ceil(9.8 × 1.02) = 10: 평단가 $8은 0.8, $8.01은 0.801
  const at = buyPriceDist(priced([0.5, 9.8], { evalPrice: 5, avgCost: 8 }));
  assert.deepEqual([at.lo, at.hi], [0, 10]);
  assert.deepEqual([at.avg.left, at.avg.flip], [0.8, false]);
  const over = buyPriceDist(priced([0.5, 9.8], { evalPrice: 5, avgCost: 8.01 }));
  assert.deepEqual([over.avg.left, over.avg.flip], [0.801, true]);
});

test("buyPriceDist: 평단가가 없으면 평단가 선(avg)이 null이고 aria-label에도 없다", () => {
  const dist = buyPriceDist(withSummary(KRW4.QLD, { avg_cost_asset: null }));
  assert.equal(dist.avg, null);
  assert.deepEqual(dist.now, { left: 0.646, label: "지금 $71.91", flip: false });
  assert.ok(!dist.aria.includes("평단가"), dist.aria);
  assert.ok(dist.aria.includes("지금 $71.91"), dist.aria);
});

test("buyPriceDist: 산 날이 없으면(정수 주만으로 한 주도 못 삼) null", () => {
  assert.equal(buyPriceDist(NONE_BOUGHT), null);
});

test("buyPriceDist: buys가 비면 null", () => {
  assert.equal(buyPriceDist({ ...KRW4.QLD, buys: [] }), null);
});

test("buyPriceIntro·Dist·Text: 산 줄은 lot_return_pct로 센다 (qty가 0으로 보여도, 값이 0.0이어도 산 줄)", () => {
  // qty는 소수 4자리 반올림이라 아주 적게 산 회차가 0으로 보일 수 있다 (설계 메모 1)
  const row = holding(
    "QLD",
    "USD",
    { buys: 4, eval_price: 12.5, avg_cost_asset: 10.2 },
    {
      buys: [
        { date: "2025-01-02", price: 10, fx: 1456.78, qty: 0, lot_return_pct: 25.12 },
        { date: "2025-02-03", price: 12, fx: 1459.8, qty: 1.5, lot_return_pct: 0 },
        { date: "2025-03-03", price: 11, fx: 1471.96, qty: 0, lot_return_pct: null },
        { date: "2025-04-01", price: 9, fx: 1423.75, qty: 2, lot_return_pct: -3.2 },
      ],
      analysis: { buys_below_eval_price: 3, buys_below_avg_cost: 2 },
    },
  );
  assert.equal(buyPriceIntro(row), "3번 매수 가격의 분포 (달러, 분할 반영)");
  assert.equal(buyPriceDist(row).count, 3);
  assert.ok(buyPriceText(row).startsWith("3번 중 3번은 지금 가격보다 싸게"), buyPriceText(row));
});

const SHINE = "색칠한 막대는 지금 가격보다 싸게 산 구간입니다.";

/** 아래 글 (이슈 #64 완료 기준). QLD 51·24는 9-8 값, $17.28은 결정 d61(시안 $17.27)이다. */
const BUY_TEXT_CASES = [
  {
    id: "QLD 60번 중 51번·24번, 2023-01-03 $17.28 ~ 2026-06-01 $99.63",
    row: KRW4.QLD,
    want:
      "60번 중 51번은 지금 가격보다 싸게, 24번은 평단가보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2023-01-03 $17.28, 가장 비싸게 산 날은 2026-06-01 $99.63입니다. ${SHINE}`,
  },
  {
    id: "QQQ 53번·26번",
    row: KRW4.QQQ,
    want:
      "60번 중 53번은 지금 가격보다 싸게, 26번은 평단가보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2023-01-03 $264.48, 가장 비싸게 산 날은 2026-06-01 $742.74입니다. ${SHINE}`,
  },
  {
    id: "TQQQ 47번·21번, $8.455는 $8.46 (결정 d61, 시안 $8.45)",
    row: KRW4.TQQQ,
    want:
      "60번 중 47번은 지금 가격보다 싸게, 21번은 평단가보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2023-01-03 $8.46, 가장 비싸게 산 날은 2026-06-01 $86.04입니다. ${SHINE}`,
  },
  {
    id: "SOXL 41번·25번",
    row: KRW4.SOXL,
    want:
      "60번 중 41번은 지금 가격보다 싸게, 25번은 평단가보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2022-11-01 $9.10, 가장 비싸게 산 날은 2026-06-01 $227.03입니다. ${SHINE}`,
  },
  {
    id: "레버리지 전환 QLD 45번 중 36번·12번, 가장 싸게 산 날은 쉰 2023-01-03이 아니라 2023-03-01 (#62)",
    row: SWITCH_QLD,
    want:
      "45번 중 36번은 지금 가격보다 싸게, 12번은 평단가보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2023-03-01 $20.53, 가장 비싸게 산 날은 2026-06-01 $99.63입니다. ${SHINE}`,
  },
  {
    id: "평단가가 없으면 평단가보다 부분을 뺀다",
    row: withSummary(KRW4.QLD, { avg_cost_asset: null }),
    want:
      "60번 중 51번은 지금 가격보다 싸게 샀습니다. 가장 싸게 산 날은 " +
      `2023-01-03 $17.28, 가장 비싸게 산 날은 2026-06-01 $99.63입니다. ${SHINE}`,
  },
];

for (const { id, row, want } of BUY_TEXT_CASES) {
  test(`buyPriceText: ${id}`, () => {
    assert.equal(buyPriceText(row), want);
  });
}

test("buyPriceText: 같은 가격이면 앞 날짜 (가장 싸게 2025-02-02, 가장 비싸게 2025-03-02)", () => {
  const row = priced([12, 10, 15, 10, 15], { evalPrice: 14, avgCost: 12.4, below: [3, 2] });
  const text = buyPriceText(row);
  assert.ok(
    text.includes(
      "가장 싸게 산 날은 2025-02-02 $10.00, 가장 비싸게 산 날은 2025-03-02 $15.00입니다.",
    ),
    text,
  );
});

test("buyPriceText: 산 날이 없으면 null", () => {
  assert.equal(buyPriceText(NONE_BOUGHT), null);
});

// ---------- 환율 변동 제외 (F-24, 결정 d74·d75) ----------
// 응답 params.include_fx === false면 통화가 다른 종목은 그날까지의 평균 매수 환율로 평가돼 fx_effect 0,
// price_effect = 손익, eval_fx = avg_buy_fx다 (#74). 수익 상자는 "환율 변동 제외로 계산" 안내를 넣고,
// 끔에서 틀린 두 글(환율 효과가 같은 이유, 평가 환율과 평균 매수 환율 비교)을 뺀다. include_fx가 없으면 켬이다

/** 예시 결과를 끔 응답 모양으로: 환율 효과 0, 주가 효과 = 손익, 평가 환율 = 평균 매수 환율. */
function fxOff(result) {
  const s = result.summary;
  return withSummary(result, { fx_effect: 0, price_effect: s.profit, eval_fx: s.avg_buy_fx });
}
const FX_OFF4 = KRW4_RESULTS.map(fxOff);

test("profitIntro: 환율 변동 제외면 지금 환율 대신 평균 매수 환율, 환율 효과는 0", () => {
  assert.equal(
    profitIntro(FX_OFF4, "KRW", { includeFx: false }),
    "원화 손익 = 주가 효과(달러로 번 돈 × 평균 매수 환율) + 환율 효과(환율 변동 제외라 0)",
  );
});

test("profitIntro: includeFx를 true로 주면 주지 않은 것과 같다 (include_fx가 없는 응답은 켬)", () => {
  assert.equal(profitIntro(KRW4_RESULTS, "KRW", { includeFx: true }), KRW_VS_USD);
});

test("profitNotes: 환율 변동 제외면 안내 두 조각과 평균 매수 환율 사실만 (같은 이유·평가 환율 비교는 뺀다, 결정 d75)", () => {
  // 평균 매수 환율은 끔에서도 그대로이고 평가에 쓴 환율이다 (#74). 비교 문장만 틀린 말이 된다
  assert.deepEqual(profitNotes(FX_OFF4, "KRW", { includeFx: false }), [
    { text: "환율 변동 제외로 계산했습니다.", strong: true },
    {
      text: "통화가 다른 종목은 지금 환율 대신 그날까지의 평균 매수 환율로 평가해 환율 효과가 0입니다.",
      strong: false,
    },
    {
      text:
        "60번 평균 매수 환율은 1,352.57원(가장 쌀 때 1,182.86원 2021-12-01, " +
        "가장 비쌀 때 1,548.61원 2026-07-01)입니다.",
      strong: false,
    },
  ]);
});

test("profitNotes: includeFx를 true로 주면 주지 않은 것과 같다", () => {
  assert.deepEqual(
    profitNotes(KRW4_RESULTS, "KRW", { includeFx: true }),
    profitNotes(KRW4_RESULTS, "KRW"),
  );
});

test("profitNotes: 환율 변동 제외여도 수익 줄이 없으면 빈 목록 (상자가 없다)", () => {
  assert.deepEqual(profitNotes([USD_QQQ], "USD", { includeFx: false }), []);
});

test("profitRows: 환율 변동 제외 응답은 환율 효과 0원(색 없음), 주가 효과 = 손익", () => {
  const qld = profitRows(FX_OFF4, "KRW")[1];
  assert.equal(qld.symbol, "QLD");
  assert.equal(qld.fx, "0원");
  assert.equal(qld.fxTone, "");
  assert.equal(qld.price, qld.total);
  assert.equal(qld.priceTone, qld.tone);
});

// include_fx가 없는 응답(#74 전, v1)은 켬이다. false일 때만 끔 (결정 d75)
const FX_INCLUDED_CASES = [
  { id: "false면 끔", params: { currency: "KRW", include_fx: false }, want: false },
  { id: "true면 켬", params: { currency: "KRW", include_fx: true }, want: true },
  { id: "키가 없으면 켬", params: { currency: "KRW" }, want: true },
];

for (const { id, params, want } of FX_INCLUDED_CASES) {
  test(`fxIncluded: ${id}`, () => {
    assert.equal(fxIncluded(params), want);
  });
}

// ---------- 분포 양 끝: 지금 가격·평단가도 범위에 든다 (PR #77 리뷰 필수 1) ----------

test("buyPriceDist: 지금 가격이 가장 낮은 매수 가격보다 낮으면 lo는 지금 가격 내림, 선은 판 안, 칸은 모두 회색", () => {
  // 하락장 한 구간만 적립한 경우. 시안 식(lo = 가장 낮은 매수 가격 내림)이면 now.left가 음수였다
  const dist = buyPriceDist(priced([10, 12, 15], { evalPrice: 5, avgCost: 12.1 }));
  assert.equal(dist.lo, 5);
  assert.equal(dist.hi, 16);
  assert.equal(dist.now.left, 0);
  assert.ok(dist.avg.left >= 0 && dist.avg.left <= 1, `avg.left ${dist.avg.left}`);
  assert.deepEqual(
    dist.bins.map((b) => b.filled),
    Array(12).fill(false),
  );
  assert.equal(
    dist.bins.reduce((n, b) => n + b.count, 0),
    3,
  );
});

test("buyPriceDist: 평단가가 가장 높은 가격보다 높으면(큰 수수료) hi는 평단가 기준, 평단가 선은 판 안", () => {
  // 한 번에 $100을 수수료 10%로 사면 평단가 $111.11, 지금 $95
  const dist = buyPriceDist(priced([100], { evalPrice: 95, avgCost: 111.11 }));
  assert.equal(dist.lo, 95);
  assert.equal(dist.hi, 114);
  assert.ok(dist.avg.left > 0.8 && dist.avg.left <= 1, `avg.left ${dist.avg.left}`);
  assert.equal(dist.avg.flip, true);
  assert.ok(dist.now.left >= 0, `now.left ${dist.now.left}`);
});
