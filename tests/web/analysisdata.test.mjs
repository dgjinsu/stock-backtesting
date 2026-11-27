// web/analysisdata.js 분석 탭의 DOM 없는 부분 (F-14 얼마나 흔들렸나, #60). node --test로 돈다.
// 함수 이름·반환 모양·규칙은 이슈 #60의 설계 메모(architect)를 따른다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  RISK_COLUMNS,
  analysisIntro,
  analysisNotes,
  drawdownAria,
  drawdownChart,
  drawdownLegend,
  riskIntro,
  riskRow,
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
