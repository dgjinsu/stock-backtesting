// web/results.js 카드·비교 표·안내의 DOM 없는 부분 (F-12, F-20, F-10). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SORT_HINT,
  afterTax,
  avgInvestNote,
  avgInvestReason,
  avgInvestTip,
  bestIndexes,
  compareColumns,
  costNotice,
  fxNote,
  nextSort,
  refStaleAlert,
  sortRows,
  staleAlerts,
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

// ---------- 가장 좋은 값: 손익 열은 money가 보여 주는 자리로 (#53, PR #47 권장 1) ----------

test("bestIndexes: 셋째 인자가 함수면 null이 아닌 값마다 그 함수로 바꾼 화면 값으로 견준다", () => {
  const seen = [];
  const byTenThousand = (v) => {
    seen.push(v);
    return Math.round(v / 1e4) * 1e4; // 시험용: 만 단위로 보인다고 친다
  };
  const values = [105_824_590, null, 105_821_000, undefined, 105_814_000];
  assert.deepEqual(bestIndexes(values, "high", byTenThousand), new Set([0, 2]));
  assert.ok(seen.length > 0, "함수를 부르지 않았다");
  assert.ok(
    seen.every((v) => v !== null && v !== undefined),
    `null에도 함수를 불렀다: ${seen}`,
  );
  const byTen = (v) => Math.round(v / 10) * 10; // 12와 14는 둘 다 10
  assert.deepEqual(bestIndexes([12, 14, 25], "low", byTen), new Set([0, 1]));
});

test("compareColumns: 손익·세후 손익 열은 투자 통화 화면 금액으로 견주고, 다른 열 자리는 그대로", () => {
  for (const key of ["profit", "profit_after_tax"]) {
    assert.equal(typeof column(key, "KRW").digits, "function", key);
    assert.equal(column(key, "KRW").digits(105_824_590), 105_820_000, `${key} 원화`);
    assert.equal(column(key, "USD").digits(12_345.4), 12_345, `${key} 달러`);
  }
  const digits = Object.fromEntries(
    compareColumns("KRW", { tax: true })
      .filter((c) => !["profit", "profit_after_tax"].includes(c.key))
      .map((c) => [c.key, c.digits]),
  );
  assert.deepEqual(digits, {
    avg_cost_asset: 2,
    avg_cost_invest: 2,
    eval_price: 2,
    shares: 2,
    value: 2,
    return_pct: 2,
    xirr_pct: 2,
    worst: 1,
    from_peak_pct: 1,
    underwater_days: 0,
  });
});

/** 열 key의 결과 줄. c.value가 읽는 summary 필드 하나만 채운다. */
const moneyRow = (key, amount) => ({ summary: { [key]: amount } });

/** compareColumns 열 그대로(value, better, digits) 견준 가장 좋은 값 위치. */
function bestMoney(key, invest, amounts) {
  const c = column(key, invest);
  const rows = amounts.map((amount) => moneyRow(key, amount));
  return {
    read: rows.map(c.value),
    texts: rows.map(c.text),
    best: [...bestIndexes(rows.map(c.value), c.better, c.digits)],
  };
}

/** 이슈 #53 완료 기준. texts는 칸에 보이는 글(money), best는 굵은 위치다. */
const BEST_MONEY_CASES = [
  {
    id: "원화 105,824,590원과 105,821,000원은 둘 다 +1억 582만원이라 둘 다",
    key: "profit",
    invest: "KRW",
    amounts: [105_824_590, 105_821_000],
    texts: ["+1억 582만원", "+1억 582만원"],
    best: [0, 1],
  },
  {
    id: "원화 105,824,590원과 105,814,000원(+1억 581만원)은 앞의 것만",
    key: "profit",
    invest: "KRW",
    amounts: [105_824_590, 105_814_000],
    texts: ["+1억 582만원", "+1억 581만원"],
    best: [0],
  },
  {
    id: "원화 1만원 아래는 원 단위라 5,000원과 5,001원은 5,001원만",
    key: "profit",
    invest: "KRW",
    amounts: [5_000, 5_001],
    texts: ["+5,000원", "+5,001원"],
    best: [1],
  },
  {
    id: "원화 손실 −1억 582만원 둘은 둘 다",
    key: "profit",
    invest: "KRW",
    amounts: [-105_824_590, -105_821_000],
    texts: [`${MINUS}1억 582만원`, `${MINUS}1억 582만원`],
    best: [0, 1],
  },
  {
    id: "달러 $12,345.40과 $12,345.20은 둘 다 $12,345라 둘 다",
    key: "profit",
    invest: "USD",
    amounts: [12_345.4, 12_345.2],
    texts: ["+$12,345", "+$12,345"],
    best: [0, 1],
  },
  {
    id: "달러 $123.454($123.45)와 $123.456($123.46)은 뒤의 것만",
    key: "profit",
    invest: "USD",
    amounts: [123.454, 123.456],
    texts: ["+$123.45", "+$123.46"],
    best: [1],
  },
  {
    id: "세후 손익 원화도 +1억 582만원 둘은 둘 다, 양도세를 끈 줄(null)은 건너뛴다",
    key: "profit_after_tax",
    invest: "KRW",
    amounts: [105_824_590, null, 105_821_000],
    texts: ["+1억 582만원", "—", "+1억 582만원"],
    best: [0, 2],
  },
  {
    id: "세후 손익 달러도 $12,345 둘은 둘 다",
    key: "profit_after_tax",
    invest: "USD",
    amounts: [12_345.4, 12_345.2],
    texts: ["+$12,345", "+$12,345"],
    best: [0, 1],
  },
];

for (const { id, key, invest, amounts, texts, best } of BEST_MONEY_CASES) {
  test(`bestIndexes: ${id}`, () => {
    const got = bestMoney(key, invest, amounts);
    assert.deepEqual(got.read, amounts, "c.value가 이 열의 금액을 읽는다");
    assert.deepEqual(got.texts, texts, "칸 글자 (money)");
    assert.deepEqual(got.best, best, "굵은 위치");
  });
}

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

/**
 * 레버리지 전환 결과의 switch_ref (상세 설계 4절, /api/strategy와 같은 모양). data_through는 기준 종목의
 * 끝날짜 당일 또는 그 이전 마지막 거래일이고, 없으면 null이다 (이슈 #59).
 */
const ref = (stale, dataThrough = null) => ({
  symbol: "QQQ",
  basis: "same_day",
  stale,
  data_through: dataThrough,
});
const RULE_PARAMS = {
  currency: "KRW",
  tax: false,
  rule: "switch",
  ma_days: 200,
  switch_ref: "QQQ",
};

test("refStaleAlert: 기준 종목이 저장본이고 기준일(data_through)이 null이면 지금 글", () => {
  const results = [{ ...QLD, switch_ref: ref(true) }];
  assert.deepEqual(refStaleAlert(results, RULE_PARAMS), {
    title: "기준 종목 QQQ는 저장된 데이터로 판단했습니다.",
    detail: "Yahoo Finance에서 새로 받지 못해 저장해 둔 주가로 200일선 위아래를 봤습니다.",
  });
});

test("refStaleAlert: 기준일(data_through)이 있으면 제목에 그 날짜 (이슈 #59)", () => {
  const results = [{ ...QLD, switch_ref: ref(true, "2026-11-20") }];
  assert.deepEqual(refStaleAlert(results, RULE_PARAMS), {
    title: "기준 종목 QQQ는 2026-11-20까지 저장된 데이터로 판단했습니다.",
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

// ---------- 저장본 노랑 알림: 종목·환율·양도세 환율·기준 종목 (F-10, 이슈 #59) ----------

/** stale_sources 한 줄 (상세 설계 4절). 기준일은 이슈 #59 알림 문구 예의 2026-11-20이다. */
const source = (symbol, kind) => ({ symbol, kind, data_through: "2026-11-20" });

/**
 * 저장본 출처를 단 결과. stale은 stale_sources가 비어 있지 않은 것과 같다 (상세 설계 4절).
 * 종목 주가(price)가 저장본이면 결과의 data_through는 그 줄과 같고, 아니면 새로 받은 날(11-23)이다.
 */
function withSources(base, sources, switchRef = null) {
  const price = sources.find((s) => s.kind === "price");
  return {
    ...base,
    data_through: price ? price.data_through : "2026-11-23",
    stale: sources.length > 0,
    stale_sources: sources,
    switch_ref: switchRef,
  };
}

const KRW_PARAMS = { currency: "KRW", tax: false, rule: "none" };
const USD_TAX_PARAMS = { currency: "USD", tax: true, rule: "none" };
const SAMSUNG = { ...QQQ, symbol: "005930.KS", currency: "KRW" };

// 이슈 #59 "할 일 (다)"의 문구 그대로. 굵은 글이 title, 나머지가 detail이다
const QQQ_PRICE_ALERT = {
  title: "QQQ는 2026-11-20까지 저장된 데이터로 계산했습니다.",
  detail: "Yahoo Finance에서 새로 받지 못했습니다. 평가 기준일도 2026-11-20입니다.",
};
const QLD_PRICE_ALERT = {
  title: "QLD는 2026-11-20까지 저장된 데이터로 계산했습니다.",
  detail: "Yahoo Finance에서 새로 받지 못했습니다. 평가 기준일도 2026-11-20입니다.",
};
const FX_ALERT = {
  title: "환율 USDKRW=X는 2026-11-20까지 저장된 데이터로 계산했습니다.",
  detail: "Yahoo Finance에서 새로 받지 못했습니다. 평가 환율도 2026-11-20 값입니다.",
};
const KRWUSD_FX_ALERT = {
  title: "환율 KRWUSD=X는 2026-11-20까지 저장된 데이터로 계산했습니다.",
  detail: "Yahoo Finance에서 새로 받지 못했습니다. 평가 환율도 2026-11-20 값입니다.",
};
const TAX_FX_ALERT = {
  title: "양도세 환율 USDKRW=X는 2026-11-20까지 저장된 데이터로 계산했습니다.",
  detail:
    "Yahoo Finance에서 새로 받지 못했습니다. 양도세 원화 환산에 쓴 환율도 2026-11-20 값입니다.",
};
const REF_ALERT = {
  title: "기준 종목 QQQ는 2026-11-20까지 저장된 데이터로 판단했습니다.",
  detail: "Yahoo Finance에서 새로 받지 못해 저장해 둔 주가로 200일선 위아래를 봤습니다.",
};

test("staleAlerts: 종목 주가(price)만 저장본이면 지금 종목 알림 하나", () => {
  const results = [withSources(QLD, [source("QLD", "price")])];
  assert.deepEqual(staleAlerts(results, KRW_PARAMS), [QLD_PRICE_ALERT]);
});

test("staleAlerts: QQQ·QLD가 같은 환율(fx) USDKRW=X를 저장본으로 쓰면 환율 알림 하나", () => {
  const results = [
    withSources(QQQ, [source("USDKRW=X", "fx")]),
    withSources(QLD, [source("USDKRW=X", "fx")]),
  ];
  assert.deepEqual(staleAlerts(results, KRW_PARAMS), [FX_ALERT]);
});

test("staleAlerts: 달러 투자 양도세 환율(tax_fx)이면 양도세 환율 알림", () => {
  const results = [withSources(QQQ, [source("USDKRW=X", "tax_fx")])];
  assert.deepEqual(staleAlerts(results, USD_TAX_PARAMS), [TAX_FX_ALERT]);
});

test("staleAlerts: price와 fx가 섞이면 종목 알림을 먼저, 환율 알림은 하나", () => {
  const results = [
    withSources(QQQ, [source("USDKRW=X", "fx")]), // 환율이 결과 순서로 먼저 나와도 종목 알림이 앞
    withSources(QLD, [source("QLD", "price"), source("USDKRW=X", "fx")]),
  ];
  assert.deepEqual(staleAlerts(results, KRW_PARAMS), [QLD_PRICE_ALERT, FX_ALERT]);
});

test("staleAlerts: 종목 알림은 결과 순서대로 종목마다 하나", () => {
  const results = [
    withSources(QQQ, [source("QQQ", "price"), source("USDKRW=X", "fx")]),
    withSources(QLD, [source("QLD", "price"), source("USDKRW=X", "fx")]),
  ];
  const want = [QQQ_PRICE_ALERT, QLD_PRICE_ALERT, FX_ALERT];
  assert.deepEqual(staleAlerts(results, KRW_PARAMS), want);
});

test("staleAlerts: 서로 다른 환율 코드는 처음 나온 순서로 하나씩", () => {
  const results = [
    withSources(SAMSUNG, [source("KRWUSD=X", "fx")]),
    withSources(QQQ, [source("USDKRW=X", "tax_fx")]),
    withSources(QLD, [source("USDKRW=X", "tax_fx")]),
  ];
  assert.deepEqual(staleAlerts(results, USD_TAX_PARAMS), [KRWUSD_FX_ALERT, TAX_FX_ALERT]);
});

test("staleAlerts: 모두 새로 받았으면 []", () => {
  const results = [withSources(QQQ, []), withSources(QLD, [])];
  assert.deepEqual(staleAlerts(results, KRW_PARAMS), []);
});

test("staleAlerts: 기준 종목 알림은 종목·환율 알림 뒤 맨 끝에 하나", () => {
  const stale = ref(true, "2026-11-20");
  const results = [
    withSources(QQQ, [source("USDKRW=X", "fx")], stale),
    withSources(QLD, [source("QLD", "price"), source("USDKRW=X", "fx")], stale),
  ];
  assert.deepEqual(staleAlerts(results, RULE_PARAMS), [QLD_PRICE_ALERT, FX_ALERT, REF_ALERT]);
});

test("staleAlerts: 기준 종목만 저장본이면 기준 종목 알림 하나", () => {
  const results = [withSources(QLD, [], ref(true, "2026-11-20"))];
  assert.deepEqual(staleAlerts(results, RULE_PARAMS), [REF_ALERT]);
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

test("avgInvestNote: 매수 규칙 결과에서 값이 없을 때만 이유를 단다 (결정 d39)", () => {
  const ruled = { currency: "KRW", rule: "ma_dip" };
  assert.equal(avgInvestNote(ruled, null), avgInvestReason("KRW"));
  assert.equal(avgInvestNote(ruled, 51363), null);
});

test("avgInvestNote: 기본 규칙에서 정수 주로 아직 못 사 값이 없으면 규칙 이유를 달지 않는다", () => {
  assert.equal(avgInvestNote({ currency: "KRW", rule: "none" }, null), null);
  assert.equal(avgInvestNote({ currency: "KRW" }, null), null);
});

// ---------- 카드 원화(달러) 평단가 ⓘ 툴팁 (F-06, 결정 d39, d52 ⑥) ----------

/** 기본 규칙·소수점 매수 params와 QLD summary (평단가는 상세 설계 4절, 환율은 계산 규칙 7절). */
const TIP_PARAMS = { currency: "KRW", rule: "none", fractional: true };
const BOUGHT = { avg_cost_invest: 51_363, eval_fx: 1344.16 };
const NOT_BOUGHT = { avg_cost_invest: null, eval_fx: 1344.16 };

const WHOLE_SHARE_TIP =
  "정수 주만 사서 모은 돈이 한 주 값보다 적어 끝날짜까지 한 주도 사지 못했습니다. " +
  "그래서 평단가가 없습니다.";
const FX_TIP =
  "매수할 때마다 그날 환율로 계산한 원화 평단가입니다. " +
  "달러 평단가 × 지금 환율(1,344.16)과 다릅니다.";

test("avgInvestTip: 매수 규칙 결과라 값이 없으면 규칙 이유 (결정 d39)", () => {
  for (const rule of ["ma_dip", "ma_hot", "switch"]) {
    const tip = avgInvestTip({ ...TIP_PARAMS, rule }, NOT_BOUGHT, "USD");
    assert.equal(tip, avgInvestReason("KRW"), rule);
  }
  const usd = { ...TIP_PARAMS, currency: "USD", rule: "ma_dip" };
  assert.equal(avgInvestTip(usd, NOT_BOUGHT, "KRW"), avgInvestReason("USD"));
});

test("avgInvestTip: 매수 규칙은 정수 주만을 골랐어도 규칙 이유 (규칙은 소수점 매수, 9-6)", () => {
  const ruled = { ...TIP_PARAMS, rule: "ma_dip", fractional: false };
  assert.equal(avgInvestTip(ruled, NOT_BOUGHT, "USD"), avgInvestReason("KRW"));
});

test("avgInvestTip: 기본 규칙에 정수 주만이라 끝날짜까지 한 주도 못 사면 그 이유 (결정 d52 ⑥)", () => {
  const whole = { ...TIP_PARAMS, fractional: false };
  assert.equal(avgInvestTip(whole, NOT_BOUGHT, "USD"), WHOLE_SHARE_TIP);
});

test("avgInvestTip: rule이 없으면(v1 응답) 기본 규칙과 같다", () => {
  const v1 = { currency: "KRW", fractional: false };
  assert.equal(avgInvestTip(v1, NOT_BOUGHT, "USD"), WHOLE_SHARE_TIP);
});

test("avgInvestTip: 값이 있으면 그날 환율로 계산했다는 설명과 지금 환율", () => {
  assert.equal(avgInvestTip(TIP_PARAMS, BOUGHT, "USD"), FX_TIP);
  const whole = { ...TIP_PARAMS, fractional: false };
  assert.equal(avgInvestTip(whole, BOUGHT, "USD"), FX_TIP); // 정수 주로 샀다
});

test("avgInvestTip: 매수 규칙 결과라도 값이 있으면 평소 설명", () => {
  assert.equal(avgInvestTip({ ...TIP_PARAMS, rule: "ma_dip" }, BOUGHT, "USD"), FX_TIP);
});

/**
 * 값이 있을 때 투자 통화 × 종목 통화 (이슈 #59 표). 앞 문장은 투자 통화 이름, 뒤 문장은 종목 통화 이름이다.
 * 이름은 원화·달러이고 그 밖의 통화는 코드 그대로다. 환율은 지금 환율(eval_fx) 표시 그대로.
 * 평단가 값은 있는지만 본다.
 */
const TIP_PAIRS = [
  {
    label: "원화 × 달러 (QLD): 지금 글 그대로",
    invest: "KRW",
    asset: "USD",
    evalFx: 1344.16,
    want: FX_TIP,
  },
  {
    label: "달러 × 원화 (005930.KS): 원화 평단가 × 지금 환율",
    invest: "USD",
    asset: "KRW",
    evalFx: 0.000743959,
    want:
      "매수할 때마다 그날 환율로 계산한 달러 평단가입니다. " +
      "원화 평단가 × 지금 환율(0.000744)과 다릅니다.",
  },
  {
    label: "원화 × JPY: 그 밖의 통화는 코드 그대로",
    invest: "KRW",
    asset: "JPY",
    evalFx: 9.12,
    want:
      "매수할 때마다 그날 환율로 계산한 원화 평단가입니다. " +
      "JPY 평단가 × 지금 환율(9.12)과 다릅니다.",
  },
  {
    label: "달러 × JPY: 그 밖의 통화는 코드 그대로",
    invest: "USD",
    asset: "JPY",
    evalFx: 0.006412,
    want:
      "매수할 때마다 그날 환율로 계산한 달러 평단가입니다. " +
      "JPY 평단가 × 지금 환율(0.006412)과 다릅니다.",
  },
];

for (const { label, invest, asset, evalFx, want } of TIP_PAIRS) {
  test(`avgInvestTip: 값이 있으면 투자 통화·종목 통화 이름을 쓴다, ${label}`, () => {
    const params = { ...TIP_PARAMS, currency: invest };
    assert.equal(avgInvestTip(params, { ...BOUGHT, eval_fx: evalFx }, asset), want);
  });
}
