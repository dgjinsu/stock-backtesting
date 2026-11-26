// web/results.js 카드·비교 표·안내의 DOM 없는 부분 (F-12, F-20, F-10). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SORT_HINT,
  afterTax,
  avgInvestReason,
  bestIndexes,
  compareColumns,
  costNotice,
  fxNote,
  nextSort,
  refStaleAlert,
  sortRows,
  underwaterText,
} from "../../web/results.js";

const MINUS = "−"; // U+2212

/**
 * /api/backtest 응답의 results 한 줄. 표와 카드가 읽는 summary 필드만 채운다.
 * worst는 최저 수익률, under는 [원금 아래였던 날, 비율 %], tax는 [양도세, 세후 손익] (끄면 null).
 */
function result(symbol, { ret, xirr, worst, peak, under, profit, tax = null, currency = "USD" }) {
  return {
    symbol,
    name: `${symbol} 이름`,
    currency,
    summary: {
      avg_cost_asset: 10,
      avg_cost_invest: 13_000,
      eval_price: 20,
      shares: 100,
      value: 120_000_000 + profit,
      profit,
      return_pct: ret,
      xirr_pct: xirr,
      worst: { date: "2022-06-16", return_pct: worst },
      from_peak_pct: peak,
      underwater_days: under[0],
      trading_days: 1250,
      underwater_pct: under[1],
      tax: tax ? tax[0] : null,
      profit_after_tax: tax ? tax[1] : null,
    },
  };
}

/**
 * 예시: QQQ·QLD·TQQQ·SOXL, 매월 1일 200만원, 2021-11-25 ~ 2026-11-24 (결과 순서 그대로).
 * - 수익률·XIRR·손익(평가금 − 1억 2,000만원): 계산 규칙 7절 (expected.json "월1일_200만원_5년")
 * - 최저 수익률·원금 아래: insights.test.mjs와 같다 (QLD는 상세 설계 4절, 나머지는 시안 v2)
 * - QLD 고점 대비·양도세: 상세 설계 4절·계산 규칙 9-8. 다른 종목의 고점 대비는 시험용 값
 */
const QQQ = result("QQQ", {
  ret: 54.22,
  xirr: 17.47,
  worst: -19.0,
  peak: -18.6,
  under: [285, 22.8],
  profit: 65_059_126,
});
const QLD = result("QLD", {
  ret: 88.19,
  xirr: 25.75,
  worst: -39.39,
  peak: -34.11,
  under: [331, 26.48],
  profit: 105_824_590,
  tax: [22_731_410, 83_093_180],
});
const TQQQ = result("TQQQ", {
  ret: 99.4,
  xirr: 28.19,
  worst: -55.9,
  peak: -47.3,
  under: [345, 27.6],
  profit: 119_279_090,
});
const SOXL = result("SOXL", {
  ret: 68.86,
  xirr: 21.22,
  worst: -65.0,
  peak: -62.2,
  under: [424, 33.92],
  profit: 82_636_747,
});
const EXAMPLE = [QQQ, QLD, TQQQ, SOXL];

const symbols = (rows) => rows.map((r) => r.symbol);
const column = (key, invest = "KRW", tax = true) =>
  compareColumns(invest, { tax }).find((c) => c.key === key);

// ---------- 비교 표 열 ----------

test("compareColumns: 시안 v2 순서에 원화 평단가·보유 수량을 둔다. 세후 손익은 양도세를 켰을 때만", () => {
  const titles = (invest, tax) => compareColumns(invest, { tax }).map((c) => c.title);
  assert.deepEqual(titles("KRW", true), [
    "평단가",
    "원화 평단가",
    "현재가",
    "보유 수량",
    "평가금",
    "손익",
    "세후 손익",
    "수익률",
    "XIRR",
    "최저 수익률",
    "고점 대비",
    "원금 아래",
  ]);
  assert.equal(titles("KRW", false).includes("세후 손익"), false);
  assert.equal(titles("KRW", false).length, 11);
  assert.equal(titles("USD", false)[1], "달러 평단가");
});

test("compareColumns: 높을수록 좋은 열, 적을수록 좋은 열, 견줄 수 없는 열", () => {
  const columns = compareColumns("KRW", { tax: true });
  const better = Object.fromEntries(columns.map((c) => [c.title, c.better]));
  for (const title of ["손익", "세후 손익", "수익률", "XIRR", "최저 수익률", "고점 대비"]) {
    assert.equal(better[title], "high", title);
  }
  assert.equal(better["원금 아래"], "low");
  for (const title of ["평단가", "원화 평단가", "현재가", "보유 수량", "평가금"]) {
    assert.equal(better[title], null, title);
  }
});

test("compareColumns: 칸 글자는 카드와 같은 형식이다", () => {
  const text = (key, row, invest = "KRW") => column(key, invest).text(row);
  assert.equal(text("return_pct", QLD), "+88.19%");
  assert.equal(text("worst", QLD), `${MINUS}39.4%`);
  assert.equal(text("from_peak_pct", QLD), `${MINUS}34.1%`);
  assert.equal(text("profit", QLD), "+1억 582만원");
  assert.equal(text("profit_after_tax", QLD), "+8,309만원");
  assert.equal(text("eval_price", QLD), "$20.00");
  assert.equal(text("underwater_days", QLD), "331일");
  assert.equal(
    text("xirr_pct", { ...QLD, summary: { ...QLD.summary, xirr_pct: null } }),
    "계산 불가",
  );
});

test("compareColumns: 손익 색을 칠하는 열은 손익·세후 손익·수익률·최저 수익률·고점 대비", () => {
  const toned = compareColumns("KRW", { tax: true })
    .filter((c) => c.tone)
    .map((c) => c.title);
  assert.deepEqual(toned, ["손익", "세후 손익", "수익률", "최저 수익률", "고점 대비"]);
});

test("SORT_HINT: 표 위 안내 (시안 v2)", () => {
  assert.equal(SORT_HINT, "열 제목을 누르면 정렬 · 굵은 값은 그 열에서 가장 좋은 값");
});

// ---------- 정렬 ----------

test("nextSort: 처음 누르면 좋은 값이 위로, 다시 누르면 반대로", () => {
  const ret = column("return_pct");
  const first = nextSort(null, ret);
  assert.deepEqual(first, { key: "return_pct", dir: "desc" });
  assert.deepEqual(nextSort(first, ret), { key: "return_pct", dir: "asc" });
  assert.deepEqual(nextSort(nextSort(first, ret), ret), { key: "return_pct", dir: "desc" });
});

test("nextSort: 적을수록 좋은 열(원금 아래)은 처음에 작은 값이 위", () => {
  assert.deepEqual(nextSort(null, column("underwater_days")), {
    key: "underwater_days",
    dir: "asc",
  });
});

test("nextSort: 견줄 수 없는 열은 처음에 큰 값이 위", () => {
  assert.deepEqual(nextSort(null, column("value")), { key: "value", dir: "desc" });
});

test("nextSort: 다른 열을 누르면 그 열의 처음 방향", () => {
  const sorted = { key: "return_pct", dir: "asc" };
  assert.deepEqual(nextSort(sorted, column("underwater_days")), {
    key: "underwater_days",
    dir: "asc",
  });
  assert.deepEqual(nextSort(sorted, column("xirr_pct")), { key: "xirr_pct", dir: "desc" });
});

test("sortRows: 예시 4종목 수익률은 TQQQ → QLD → SOXL → QQQ, 반대로 누르면 거꾸로", () => {
  const ret = column("return_pct");
  assert.deepEqual(symbols(sortRows(EXAMPLE, ret.value, "desc")), ["TQQQ", "QLD", "SOXL", "QQQ"]);
  assert.deepEqual(symbols(sortRows(EXAMPLE, ret.value, "asc")), ["QQQ", "SOXL", "QLD", "TQQQ"]);
});

test("sortRows: 원래 배열은 그대로 둔다", () => {
  sortRows(EXAMPLE, column("return_pct").value, "desc");
  assert.deepEqual(symbols(EXAMPLE), ["QQQ", "QLD", "TQQQ", "SOXL"]);
});

test("sortRows: null(계산 불가 등)은 오름·내림 모두 맨 아래", () => {
  const rows = [{ v: 3 }, { v: null }, { v: 1 }, { v: undefined }, { v: 2 }, { v: Number.NaN }];
  const values = (sorted) => sorted.map((r) => r.v);
  const valueOf = (r) => r.v;
  assert.deepEqual(values(sortRows(rows, valueOf, "desc")).slice(0, 3), [3, 2, 1]);
  assert.deepEqual(values(sortRows(rows, valueOf, "asc")).slice(0, 3), [1, 2, 3]);
  for (const dir of ["asc", "desc"]) {
    const tail = values(sortRows(rows, valueOf, dir)).slice(3);
    assert.equal(tail.length, 3);
    assert.ok(
      tail.every((v) => v === null || v === undefined || Number.isNaN(v)),
      dir,
    );
  }
});

test("sortRows: 같은 값은 원래 순서를 지킨다", () => {
  const rows = [
    { s: "A", v: 1 },
    { s: "B", v: 2 },
    { s: "C", v: 1 },
    { s: "D", v: 2 },
  ];
  const order = (dir) => sortRows(rows, (r) => r.v, dir).map((r) => r.s);
  assert.deepEqual(order("desc"), ["B", "D", "A", "C"]);
  assert.deepEqual(order("asc"), ["A", "C", "B", "D"]);
});

test("sortRows: XIRR이 null인 종목은 맨 아래", () => {
  const noXirr = { ...SOXL, summary: { ...SOXL.summary, xirr_pct: null } };
  const rows = [QQQ, noXirr, TQQQ];
  const xirr = column("xirr_pct");
  assert.deepEqual(symbols(sortRows(rows, xirr.value, "desc")), ["TQQQ", "QQQ", "SOXL"]);
  assert.deepEqual(symbols(sortRows(rows, xirr.value, "asc")), ["QQQ", "TQQQ", "SOXL"]);
});

// ---------- 가장 좋은 값 ----------

test("bestIndexes: 높을수록 좋은 열은 가장 큰 값", () => {
  assert.deepEqual(bestIndexes([54.22, 88.19, 99.4, 68.86], "high"), new Set([2]));
});

test("bestIndexes: 적을수록 좋은 열은 가장 작은 값", () => {
  assert.deepEqual(bestIndexes([285, 331, 345, 424], "low", 0), new Set([0]));
});

test("bestIndexes: 같은 값이 여럿이면 모두", () => {
  assert.deepEqual(bestIndexes([3, 1, 3, 2], "high"), new Set([0, 2]));
  assert.deepEqual(bestIndexes([5, 2, 2], "low", 0), new Set([1, 2]));
});

test("bestIndexes: 화면 자리로 반올림해 같아 보이면 같은 값", () => {
  // 최저 수익률은 소수 1자리로 보인다: −19.04%와 −19.01%는 둘 다 −19.0%
  assert.deepEqual(bestIndexes([-19.04, -19.01, -39.39], "high", 1), new Set([0, 1]));
  assert.deepEqual(bestIndexes([-19.04, -19.01, -39.39], "high", 2), new Set([1]));
});

test("bestIndexes: null은 건너뛴다", () => {
  assert.deepEqual(bestIndexes([null, 17.47, undefined, 28.19], "high"), new Set([3]));
  assert.deepEqual(bestIndexes([null, null], "high"), new Set());
});

test("bestIndexes: 견줄 수 없는 열이거나 줄이 하나면 굵게 하지 않는다", () => {
  assert.deepEqual(bestIndexes([1, 2, 3], null), new Set());
  assert.deepEqual(bestIndexes([88.19], "high"), new Set());
  assert.deepEqual(bestIndexes([], "high"), new Set());
});

test("bestIndexes: 예시 4종목은 수익률·XIRR 열에서 TQQQ, 원금 아래 열에서 QQQ", () => {
  const best = (key) => {
    const c = column(key);
    return [...bestIndexes(EXAMPLE.map(c.value), c.better, c.digits)].map((i) => EXAMPLE[i].symbol);
  };
  assert.deepEqual(best("return_pct"), ["TQQQ"]);
  assert.deepEqual(best("xirr_pct"), ["TQQQ"]);
  assert.deepEqual(best("profit"), ["TQQQ"]);
  assert.deepEqual(best("worst"), ["QQQ"]);
  assert.deepEqual(best("from_peak_pct"), ["QQQ"]);
  assert.deepEqual(best("underwater_days"), ["QQQ"]);
  assert.deepEqual(best("profit_after_tax"), ["QLD"]); // 나머지는 양도세를 끈 값(null)
  for (const key of ["avg_cost_asset", "avg_cost_invest", "eval_price", "shares", "value"]) {
    assert.deepEqual(best(key), [], key);
  }
});

// ---------- 카드 ----------

test("underwaterText: 일수와 비율(소수 1자리)", () => {
  assert.equal(underwaterText(QLD.summary), "331일 (26.5%)");
  assert.equal(underwaterText({ underwater_days: 1234, underwater_pct: 0 }), "1,234일 (0.0%)");
});

test("afterTax: 양도세를 끄면(null) 칸이 없다", () => {
  assert.equal(afterTax(QQQ, "KRW"), null);
});

test("afterTax: 해외 종목은 세후 손익, 어림값, 양도세", () => {
  assert.deepEqual(afterTax(QLD, "KRW"), {
    label: "세후 손익 · 어림값",
    text: "+8,309만원",
    tone: "pos",
    note: "양도세 2,273만원",
  });
});

test("afterTax: 세후 손익 = 손익 − 양도세", () => {
  const s = QLD.summary;
  assert.equal(s.profit - s.tax, s.profit_after_tax);
});

test("afterTax: 한국 종목은 양도세 0과 한국 종목 문구", () => {
  const samsung = result("005930.KS", {
    ret: 30,
    xirr: 10,
    worst: -10,
    peak: -5,
    under: [100, 8],
    profit: 36_000_000,
    tax: [0, 36_000_000],
    currency: "KRW",
  });
  const cell = afterTax(samsung, "KRW");
  assert.equal(cell.text, "+3,600만원");
  assert.equal(cell.note, "한국 종목은 양도세 0으로 둡니다");
  assert.match(cell.label, /어림값/);
});

test("afterTax: 달러 투자는 달러로 (QQQ $1,500, 계산 규칙 9-5 달러 양도세)", () => {
  const qqq = result("QQQ", {
    ret: 53.52,
    xirr: 17.3,
    worst: -19,
    peak: -18,
    under: [285, 22.8],
    profit: 48_171,
    tax: [10_188, 37_982],
  });
  const cell = afterTax(qqq, "USD");
  assert.equal(cell.text, "+$37,982");
  assert.equal(cell.note, "양도세 $10,188");
});

test("afterTax: 손실이면 빼기와 손실 색", () => {
  const loss = { ...QLD, summary: { ...QLD.summary, tax: 0, profit_after_tax: -1_500_000 } };
  const cell = afterTax(loss, "KRW");
  assert.equal(cell.text, `${MINUS}150만원`);
  assert.equal(cell.tone, "neg");
});

// ---------- 매수 규칙 결과 (F-17) ----------

test("compareColumns: 원화 평단가가 없으면(매수 규칙, 결정 d39) 칸은 —", () => {
  const ruled = { ...QLD, summary: { ...QLD.summary, avg_cost_invest: null } };
  assert.equal(column("avg_cost_invest").text(ruled), "—");
  assert.equal(column("avg_cost_invest").value(ruled), null);
});

test("avgInvestReason: 원화 평단가가 없는 이유 (결정 d39). 투자 통화 이름을 쓴다", () => {
  assert.equal(
    avgInvestReason("KRW"),
    "매수 규칙은 넣은 돈 일부를 현금으로 두었다가 나중에 사서 넣은 돈과 산 돈이 달라, " +
      "원화 평단가는 정하지 않습니다. 평단가(종목 통화)는 그대로입니다.",
  );
  assert.match(avgInvestReason("USD"), /달러 평단가는 정하지 않습니다/);
});

/** 레버리지 전환 결과의 switch_ref (상세 설계 4절, /api/strategy와 같은 모양). */
const ref = (stale) => ({ symbol: "QQQ", basis: "same_day", stale });
const RULE_PARAMS = {
  currency: "KRW",
  tax: false,
  rule: "switch",
  ma_days: 200,
  switch_ref: "QQQ",
};

test("refStaleAlert: 기준 종목이 저장본이면 F-10 노랑 알림 문구", () => {
  const results = [{ ...QLD, switch_ref: ref(true) }];
  assert.deepEqual(refStaleAlert(results, RULE_PARAMS), {
    title: "기준 종목 QQQ는 저장된 데이터로 판단했습니다.",
    detail: "Yahoo Finance에서 새로 받지 못해 저장해 둔 주가로 200일선 위아래를 봤습니다.",
  });
});

test("refStaleAlert: 종목이 여럿이어도 기준 종목 알림은 하나", () => {
  const results = [
    { ...QQQ, switch_ref: ref(true) },
    { ...QLD, switch_ref: ref(true) },
  ];
  assert.equal(
    refStaleAlert(results, RULE_PARAMS).title,
    "기준 종목 QQQ는 저장된 데이터로 판단했습니다.",
  );
});

test("refStaleAlert: 새로 받았거나 레버리지 전환이 아니면(switch_ref null) null", () => {
  assert.equal(refStaleAlert([{ ...QLD, switch_ref: ref(false) }], RULE_PARAMS), null);
  assert.equal(
    refStaleAlert([{ ...QLD, switch_ref: null }], { ...RULE_PARAMS, rule: "none" }),
    null,
  );
  assert.equal(refStaleAlert([QLD], { currency: "KRW", tax: false }), null); // switch_ref 없음
});

// ---------- 결과 아래 안내 (F-10) ----------

const PARAMS = { currency: "KRW", tax: false };

test("fxNote: 종목 통화와 투자 통화가 다른 쌍을 적는다", () => {
  assert.equal(fxNote(EXAMPLE, PARAMS), "환율은 USDKRW=X.");
  assert.equal(fxNote(EXAMPLE, { ...PARAMS, tax: true }), "환율은 USDKRW=X.");
});

test("fxNote: 바꿀 환율이 없으면 null", () => {
  assert.equal(fxNote(EXAMPLE, { currency: "USD", tax: false }), null);
});

test("fxNote: 양도세를 켠 달러 투자는 양도세용 USDKRW=X도 적는다 (#39)", () => {
  assert.equal(fxNote([QQQ], { currency: "USD", tax: true }), "환율은 USDKRW=X(양도세 원화 환산).");
  const samsung = { ...QQQ, symbol: "005930.KS", currency: "KRW" };
  assert.equal(
    fxNote([samsung, QQQ], { currency: "USD", tax: true }),
    "환율은 KRWUSD=X, USDKRW=X(양도세 원화 환산).",
  );
});

test("fxNote: 한국 종목만 달러로 사면 양도세가 0이라 양도세 환율은 없다", () => {
  const samsung = { ...QQQ, symbol: "005930.KS", currency: "KRW" };
  assert.equal(fxNote([samsung], { currency: "USD", tax: true }), "환율은 KRWUSD=X.");
});

test("costNotice: 양도세를 끄면 세금·환전 비용 미반영", () => {
  assert.equal(
    costNotice(false),
    "세금과 환전 비용은 반영하지 않았습니다. 환전 비용은 고급 설정의 수수료에 합쳐 넣으세요.",
  );
});

test("costNotice: 양도세를 켜면 어림값이라고 적고 환전 비용 안내는 그대로", () => {
  const text = costNotice(true);
  assert.ok(text.startsWith("양도세는 끝날짜에 한 번에 판다고 보고 어림한 값입니다."), text);
  assert.ok(text.endsWith("환전 비용은 고급 설정의 수수료에 합쳐 넣으세요."), text);
  assert.ok(!text.includes("세금과"), text);
});
