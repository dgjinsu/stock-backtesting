// web/analysisdata.js 분석 탭의 DOM 없는 부분 (F-14 얼마나 흔들렸나 #60, 연도별 결과·달마다
// 얼마나 움직였나 #61). node --test로 돈다.
// 함수 이름·반환 모양·규칙은 이슈 #60·#61의 설계 메모(architect)를 따른다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  NO_MONTHS,
  RISK_COLUMNS,
  analysisIntro,
  analysisNotes,
  drawdownAria,
  drawdownChart,
  drawdownLegend,
  monthsGrid,
  monthsIntro,
  monthsStats,
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
