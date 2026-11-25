// web/insights.js 한눈에 요약 문장과 하이라이트 (F-12, 결정 d42·d43). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import { highlights, josa, sentenceText, summaryParts } from "../../web/insights.js";

const MINUS = "−"; // U+2212

/**
 * /api/backtest 응답의 results 한 줄. 문장과 하이라이트가 읽는 summary 필드만 채운다.
 * worst는 [날짜, 최저 수익률], under는 [원금 아래였던 날, 전체 거래일, 비율 %].
 */
function result(symbol, { ret, xirr, worst, price, avg, under }) {
  const invested = 120_000_000;
  const value = Math.round(invested * (1 + ret / 100));
  return {
    symbol,
    name: `${symbol} 이름`,
    currency: "USD",
    summary: {
      buys: 60,
      invested,
      value,
      profit: value - invested,
      avg_cost_asset: avg,
      eval_price: price,
      return_pct: ret,
      xirr_pct: xirr,
      worst: { date: worst[0], return_pct: worst[1] },
      underwater_days: under[0],
      trading_days: under[1],
      underwater_pct: under[2],
    },
  };
}

/**
 * 예시: QQQ·QLD·TQQQ·SOXL, 매월 1일 200만원, 2021-11-25 ~ 2026-11-24.
 * - 수익률·XIRR: 계산 규칙 7절. 현재가·평단가: expected.json 7절 "매월 1일 200만원" 사례
 * - 최저 수익률: TQQQ 2022-06-16 −55.9%는 F-12 예 문장, QLD −39.39%는 상세 설계 4절 응답 예,
 *   QQQ −19.0%(2022-12-28)·SOXL −65.0%(2022-10-14)는 시안 v2
 * - 원금 아래였던 날: QLD 331일(26.48%)은 상세 설계 4절, 나머지 일수는 시안 v2 (1,250 거래일 중)
 */
const QQQ = result("QQQ", {
  ret: 54.22,
  xirr: 17.47,
  worst: ["2022-12-28", -19.0],
  price: 651.03,
  avg: 419.5291,
  under: [285, 1250, 22.8],
});
const QLD = result("QLD", {
  ret: 88.19,
  xirr: 25.75,
  worst: ["2022-06-16", -39.39],
  price: 71.91,
  avg: 37.9743,
  under: [331, 1250, 26.48],
});
const TQQQ = result("TQQQ", {
  ret: 99.4,
  xirr: 28.19,
  worst: ["2022-06-16", -55.9],
  price: 49.1,
  avg: 24.4708,
  under: [345, 1250, 27.6],
});
const SOXL = result("SOXL", {
  ret: 68.86,
  xirr: 21.22,
  worst: ["2022-10-14", -65.0],
  price: 43.21,
  avg: 25.4295,
  under: [424, 1250, 33.92],
});

/** 응답 모양 객체 (params·chart는 이 모듈이 읽지 않아 줄였다). */
const EXAMPLE = {
  params: { symbols: ["QQQ", "QLD", "TQQQ", "SOXL"], freq: "monthly", anchor: 1 },
  results: [QQQ, QLD, TQQQ, SOXL],
  errors: [],
};

/** summary 일부만 바꾼 결과. */
function changed(base, patch) {
  return { ...base, summary: { ...base.summary, ...patch } };
}

function sentence(results) {
  return sentenceText(summaryParts(results));
}

// ---------- 조사 ----------

test("josa: 코드 끝 글자를 읽는 소리로 이/가를 고른다", () => {
  const subject = (code) => `${code}${josa(code, "이/가")}`;
  assert.equal(subject("TQQQ"), "TQQQ가");
  assert.equal(subject("SOXL"), "SOXL이");
  assert.equal(subject("QLD"), "QLD가");
  assert.equal(subject("QQQM"), "QQQM이");
  assert.equal(subject("005930.KS"), "005930.KS가");
});

test("josa: 은/는도 같은 규칙", () => {
  assert.equal(josa("QLD", "은/는"), "는");
  assert.equal(josa("SOXL", "은/는"), "은");
  assert.equal(josa("TQQQ", "은/는"), "는");
});

test("josa: 엘·엠·엔·알과 영·일·삼·육·칠·팔은 받침이 있다", () => {
  for (const code of ["AAL", "QQQM", "SPYN", "VTR", "A0", "B1", "C3", "D6", "E7", "F8"]) {
    assert.equal(josa(code, "이/가"), "이", code);
  }
  for (const code of ["QQQ", "SPY", "BRK-B", "KRW=X", "^GSPC", "A2", "B4", "C5", "D9"]) {
    assert.equal(josa(code, "이/가"), "가", code);
  }
});

// ---------- 문장: 시안 예 ----------

test("summaryParts: 예시 4종목은 시안 문장과 글자까지 같다", () => {
  assert.equal(
    sentence(EXAMPLE.results),
    "4개 종목 모두 이익입니다. " +
      `TQQQ가 수익률 +99.40%, 연환산 28.19%로 가장 높았지만 2022-06-16에는 ${MINUS}55.9%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 QQQ(최저 ${MINUS}19.0%)입니다.`,
  );
});

test("summaryParts: 종목 코드와 숫자는 굵게, 수익률과 최저 수익률은 손익 색", () => {
  const strong = summaryParts(EXAMPLE.results)
    .filter((part) => part.strong)
    .map((part) => [part.text, part.tone]);
  assert.deepEqual(strong, [
    ["TQQQ", ""],
    ["+99.40%", "pos"],
    ["28.19%", ""],
    [`${MINUS}55.9%`, "neg"],
    ["QQQ", ""],
  ]);
});

test("summaryParts: 굵지 않은 조각은 손익 색이 없다", () => {
  for (const part of summaryParts(EXAMPLE.results)) {
    if (!part.strong) assert.ok(!part.tone, part.text);
  }
});

// ---------- 문장: 다른 경우 (결정 d42) ----------

test("summaryParts: 일부 손실이면 이익·손실 개수를 적는다", () => {
  const loss = changed(SOXL, { return_pct: -12.34, xirr_pct: -5.67 });
  assert.equal(
    sentence([QQQ, loss, QLD]),
    "3개 종목 중 2개는 이익, 1개는 손실입니다. " +
      `QLD가 수익률 +88.19%, 연환산 25.75%로 가장 높았지만 2022-06-16에는 ${MINUS}39.4%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 QQQ(최저 ${MINUS}19.0%)입니다.`,
  );
});

test("summaryParts: 모두 손실이면 수익률·연환산에 빼기 부호", () => {
  const soxl = changed(SOXL, { return_pct: -12.34, xirr_pct: -5.67 });
  const tqqq = changed(TQQQ, {
    return_pct: -3.21,
    xirr_pct: -1.5,
    worst: { date: "2022-12-28", return_pct: -70.12 },
  });
  const parts = summaryParts([soxl, tqqq]);
  assert.equal(
    sentenceText(parts),
    "2개 종목 모두 손실입니다. " +
      `TQQQ가 수익률 ${MINUS}3.21%, 연환산 ${MINUS}1.50%로 가장 높았지만 ` +
      `2022-12-28에는 ${MINUS}70.1%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 SOXL(최저 ${MINUS}65.0%)입니다.`,
  );
  assert.equal(parts.find((part) => part.text === `${MINUS}3.21%`).tone, "neg");
});

test("summaryParts: 종목이 1개면 은/는으로 쓰고 덜 흔들린 종목 문장은 없다", () => {
  assert.equal(
    sentence([QLD]),
    `QLD는 수익률 +88.19%, 연환산 25.75%입니다. 2022-06-16에는 ${MINUS}39.4%까지 빠졌습니다.`,
  );
  assert.equal(
    sentence([SOXL]),
    `SOXL은 수익률 +68.86%, 연환산 21.22%입니다. 2022-10-14에는 ${MINUS}65.0%까지 빠졌습니다.`,
  );
});

test("summaryParts: 종목 1개, 최저 수익률이 0 이상이고 XIRR이 없으면 수익률만", () => {
  const flat = changed(QQQ, {
    return_pct: 1.23,
    xirr_pct: null,
    worst: { date: "2026-11-02", return_pct: 0 },
  });
  assert.equal(sentence([flat]), "QQQ는 수익률 +1.23%입니다.");
});

test("summaryParts: 수익률 1위와 XIRR 1위가 다르면 연환산 1위를 따로 쓴다", () => {
  // QQQM은 늦게 상장해 수익률은 낮아도 연환산은 높을 수 있다
  const qqqm = result("QQQM", {
    ret: 40.0,
    xirr: 19.5,
    worst: ["2023-01-05", -10.5],
    price: 210.0,
    avg: 150.0,
    under: [120, 900, 13.33],
  });
  assert.equal(
    sentence([QQQ, qqqm]),
    "2개 종목 모두 이익입니다. " +
      "QQQ가 수익률 +54.22%로 가장 높았고, 연환산은 QQQM이 19.50%로 가장 높았습니다. " +
      `QQQ는 2022-12-28에 ${MINUS}19.0%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 QQQM(최저 ${MINUS}10.5%)입니다.`,
  );
});

test("summaryParts: XIRR 1위가 다르고 최저 수익률이 0 이상이면 빠진 문장 없이 끝낸다", () => {
  // 수익률 1위(QQQ)가 가장 덜 흔들린 종목이기도 해서 마지막 문장도 없다
  const steady = changed(QQQ, { worst: { date: "2021-12-01", return_pct: 0 } });
  const qqqm = changed(QLD, { return_pct: 40.0, xirr_pct: 19.5 });
  assert.equal(
    sentence([steady, { ...qqqm, symbol: "QQQM" }]),
    "2개 종목 모두 이익입니다. " +
      "QQQ가 수익률 +54.22%로 가장 높았고, 연환산은 QQQM이 19.50%로 가장 높았습니다.",
  );
});

test("summaryParts: 수익률 1위의 최저 수익률이 0 이상이면 '빠졌습니다'를 뺀다", () => {
  const steady = changed(TQQQ, { worst: { date: "2021-12-01", return_pct: 0 } });
  assert.equal(
    sentence([QQQ, steady]),
    "2개 종목 모두 이익입니다. TQQQ가 수익률 +99.40%, 연환산 28.19%로 가장 높았습니다.",
  );
});

test("summaryParts: 최저 수익률이 1자리로 0.0%면(−0.05와 0 사이) 빠졌다고 쓰지 않는다", () => {
  const tiny = { date: "2024-01-02", return_pct: -0.04 };
  const flat = changed(QQQ, { return_pct: 1.23, xirr_pct: 0.8, worst: tiny });
  assert.equal(sentence([flat]), "QQQ는 수익률 +1.23%, 연환산 0.80%입니다.");

  const steady = changed(TQQQ, { worst: tiny });
  const parts = summaryParts([QQQ, steady]);
  assert.equal(
    sentenceText(parts),
    "2개 종목 모두 이익입니다. TQQQ가 수익률 +99.40%, 연환산 28.19%로 가장 높았습니다.",
  );
  assert.ok(!parts.some((part) => part.tone === "neg"));

  // XIRR 1위가 다를 때도 "TQQQ는 …에 0.0%까지 빠졌습니다"를 붙이지 않는다
  assert.equal(
    sentence([QLD, changed(steady, { xirr_pct: null })]),
    "2개 종목 모두 이익입니다. " +
      "TQQQ가 수익률 +99.40%로 가장 높았고, 연환산은 QLD가 25.75%로 가장 높았습니다.",
  );
});

test("summaryParts: 최저 수익률이 1자리로 −0.1%면 빠졌다고 쓴다", () => {
  const dipped = changed(QQQ, {
    return_pct: 1.23,
    xirr_pct: 0.8,
    worst: { date: "2024-01-02", return_pct: -0.06 },
  });
  assert.equal(
    sentence([dipped]),
    `QQQ는 수익률 +1.23%, 연환산 0.80%입니다. 2024-01-02에는 ${MINUS}0.1%까지 빠졌습니다.`,
  );
});

test("summaryParts: 수익률 1위의 XIRR이 최고 XIRR과 같으면(2자리) 문장을 나누지 않는다", () => {
  // 앞 종목 QQQ의 XIRR이 같은 값이어도 수익률 1위 QLD로 이어 쓴다
  const qqq = changed(QQQ, { return_pct: 50.0, xirr_pct: 20.0 });
  const qld = changed(QLD, { return_pct: 60.0, xirr_pct: 20.0 });
  const expected =
    "2개 종목 모두 이익입니다. " +
    `QLD가 수익률 +60.00%, 연환산 20.00%로 가장 높았지만 2022-06-16에는 ${MINUS}39.4%까지 빠졌습니다. ` +
    `가장 덜 흔들린 종목은 QQQ(최저 ${MINUS}19.0%)입니다.`;
  assert.equal(sentence([qqq, qld]), expected);
  // 원값이 조금 달라도 화면에 보이는 2자리가 같으면 같다고 본다
  assert.equal(sentence([changed(qqq, { xirr_pct: 20.004 }), qld]), expected);
});

test("summaryParts: 수익률 1위가 가장 덜 흔들린 종목이면 마지막 문장을 뺀다", () => {
  const calm = changed(TQQQ, { worst: { date: "2022-06-16", return_pct: -10.0 } });
  assert.equal(
    sentence([QQQ, calm]),
    "2개 종목 모두 이익입니다. " +
      `TQQQ가 수익률 +99.40%, 연환산 28.19%로 가장 높았지만 2022-06-16에는 ${MINUS}10.0%까지 빠졌습니다.`,
  );
  // XIRR 1위가 달라 문장을 나눌 때도 같다
  const qqqm = result("QQQM", {
    ret: 40.0,
    xirr: 19.5,
    worst: ["2023-01-05", -25.0],
    price: 210.0,
    avg: 150.0,
    under: [120, 900, 13.33],
  });
  assert.equal(
    sentence([QQQ, qqqm]),
    "2개 종목 모두 이익입니다. " +
      "QQQ가 수익률 +54.22%로 가장 높았고, 연환산은 QQQM이 19.50%로 가장 높았습니다. " +
      `QQQ는 2022-12-28에 ${MINUS}19.0%까지 빠졌습니다.`,
  );
});

test("summaryParts: XIRR이 null인 종목은 연환산 1위에서 뺀다", () => {
  const noXirr = changed(TQQQ, { xirr_pct: null });
  assert.equal(
    sentence([QLD, noXirr]),
    "2개 종목 모두 이익입니다. " +
      "TQQQ가 수익률 +99.40%로 가장 높았고, 연환산은 QLD가 25.75%로 가장 높았습니다. " +
      `TQQQ는 2022-06-16에 ${MINUS}55.9%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 QLD(최저 ${MINUS}39.4%)입니다.`,
  );
});

test("summaryParts: XIRR이 모두 null이면 연환산을 쓰지 않는다", () => {
  const results = [QLD, TQQQ].map((r) => changed(r, { xirr_pct: null }));
  assert.equal(
    sentence(results),
    "2개 종목 모두 이익입니다. " +
      `TQQQ가 수익률 +99.40%로 가장 높았지만 2022-06-16에는 ${MINUS}55.9%까지 빠졌습니다. ` +
      `가장 덜 흔들린 종목은 QLD(최저 ${MINUS}39.4%)입니다.`,
  );
});

test("summaryParts: 수익률·최저 수익률이 같으면 결과 순서가 앞인 종목", () => {
  const twin = { ...QLD, symbol: "QLD2" };
  assert.match(sentence([QLD, twin]), /^2개 종목 모두 이익입니다\. QLD가 /);
  assert.match(sentence([twin, QLD]), /^2개 종목 모두 이익입니다\. QLD2가 /);
  // 수익률 1위(TQQQ)와 다른 두 종목의 최저 수익률이 같다
  assert.match(sentence([TQQQ, QLD, twin]), /가장 덜 흔들린 종목은 QLD\(/);
  assert.match(sentence([TQQQ, twin, QLD]), /가장 덜 흔들린 종목은 QLD2\(/);
});

test("summaryParts: 결과가 없으면 빈 목록", () => {
  assert.deepEqual(summaryParts([]), []);
});

// ---------- 하이라이트 4개 ----------

test("highlights: 예시 4종목은 시안 순서와 값", () => {
  assert.deepEqual(highlights(EXAMPLE.results), [
    {
      key: "xirr",
      label: "가장 높은 XIRR",
      symbol: "TQQQ",
      value: "28.19%",
      tone: "",
      note: null,
    },
    {
      key: "ratio",
      label: "현재가가 평단가의 몇 배 (최고)",
      symbol: "TQQQ",
      value: "2.01배", // 49.1 ÷ 24.4708
      tone: "",
      note: null,
    },
    {
      key: "worst",
      label: "가장 깊은 손실",
      symbol: "SOXL",
      value: `${MINUS}65.0%`,
      tone: "neg",
      note: "2022-10-14",
    },
    {
      key: "underwater",
      label: "원금 아래였던 날이 가장 적음",
      symbol: "QQQ",
      value: "285일",
      tone: "",
      note: "(22.8%)",
    },
  ]);
});

/** key → 고른 종목. */
function picks(results) {
  return Object.fromEntries(highlights(results).map((item) => [item.key, item.symbol]));
}

test("highlights: XIRR이 null인 종목은 가장 높은 XIRR에서 빠진다", () => {
  const noXirr = changed(TQQQ, { xirr_pct: null });
  assert.equal(picks([QQQ, QLD, noXirr, SOXL]).xirr, "QLD");
});

test("highlights: XIRR이 모두 null이면 그 칸은 없다", () => {
  const results = EXAMPLE.results.map((r) => changed(r, { xirr_pct: null }));
  assert.deepEqual(
    highlights(results).map((item) => item.key),
    ["ratio", "worst", "underwater"],
  );
});

test("highlights: 평단가가 없으면 평단가의 몇 배에서 뺀다", () => {
  const noAvg = changed(TQQQ, { avg_cost_asset: null });
  assert.equal(picks([QQQ, QLD, noAvg, SOXL]).ratio, "QLD");
});

test("highlights: 같은 값이면 결과 순서가 앞인 종목", () => {
  const twin = (base, symbol) => ({ ...base, symbol });
  assert.deepEqual(picks([QQQ, twin(QQQ, "QQQ2")]), {
    xirr: "QQQ",
    ratio: "QQQ",
    worst: "QQQ",
    underwater: "QQQ",
  });
  assert.deepEqual(picks([twin(QQQ, "QQQ2"), QQQ]), {
    xirr: "QQQ2",
    ratio: "QQQ2",
    worst: "QQQ2",
    underwater: "QQQ2",
  });
});

test("highlights: 가장 깊은 손실은 최저 수익률이 가장 낮은 종목과 그날 (결정 d43)", () => {
  const deeper = changed(QLD, { worst: { date: "2022-12-28", return_pct: -70.25 } });
  const item = highlights([QQQ, deeper, TQQQ, SOXL]).find((h) => h.key === "worst");
  assert.equal(item.symbol, "QLD");
  assert.equal(item.value, `${MINUS}70.3%`);
  assert.equal(item.note, "2022-12-28");
});

test("highlights: 가장 깊은 손실이 1자리로 0.0%면 손익 색을 칠하지 않는다", () => {
  const tiny = (base, value) => changed(base, { worst: { date: "2024-01-02", return_pct: value } });
  const item = highlights([tiny(QQQ, -0.04), tiny(QLD, -0.02)]).find((h) => h.key === "worst");
  assert.equal(item.symbol, "QQQ");
  assert.equal(item.value, "0.0%");
  assert.equal(item.tone, "");
});

test("highlights: 원금 아래였던 날은 일수로 고르고 천 단위 쉼표", () => {
  const long = (base, days, pct) =>
    changed(base, { underwater_days: days, trading_days: 2500, underwater_pct: pct });
  const item = highlights([long(QQQ, 1234, 49.36), long(QLD, 1200, 48.0)]).find(
    (h) => h.key === "underwater",
  );
  assert.equal(item.symbol, "QLD");
  assert.equal(item.value, "1,200일");
  assert.equal(item.note, "(48.0%)");
});

test("highlights: 원금 아래였던 적이 없으면 0일", () => {
  const never = changed(QQQ, { underwater_days: 0, underwater_pct: 0 });
  const item = highlights([QLD, never]).find((h) => h.key === "underwater");
  assert.equal(item.symbol, "QQQ");
  assert.equal(item.value, "0일");
  assert.equal(item.note, "(0.0%)");
});

test("highlights: 결과가 없으면 빈 목록", () => {
  assert.deepEqual(highlights([]), []);
});

test("highlights: 화면에서 같아 보이면(1자리) 앞 종목을 가장 깊은 손실로 고른다", () => {
  const base = { ret: 10, xirr: 5, price: 100, avg: 90, under: [10, 100, 10] };
  const results = [
    result("AAA", { ...base, worst: ["2022-01-03", -55.92] }),
    result("BBB", { ...base, worst: ["2022-02-03", -55.94] }),
  ];
  const deepest = highlights(results).find((h) => h.key === "worst");
  assert.equal(deepest.symbol, "AAA");
});
