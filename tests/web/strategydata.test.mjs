// web/strategydata.js 전략 비교 탭(F-15)의 DOM 없는 부분 (#65). node --test로 돈다.
// 함수 이름·인자·반환 모양·규칙은 이슈 #65의 설계 메모(architect)를 따른다.
// 카드 모델 모양 (이 테스트가 정한다):
//   { key, name, rule, base, value, cells: [{ key, label, text, best }], foot, error }
//   value는 평가금 글(크게), cells는 수익률·XIRR·평단가·최저 수익률·남은 현금 순서, foot는 바닥 한 줄.
//   계산하지 못한 카드는 error { title, detail }, value null, cells []이고, 성공한 카드는 error null.
// 응답 묶음(strategyRequests)의 reply 모양: 연결 실패면 null, 아니면 { status, json }.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BUY_RULES, backtestBody } from "../../web/conditions.js";
import { basisText, refStaleAlert } from "../../web/results.js";
import {
  MA_CHOICES,
  STRATEGY_KEYS,
  STRATEGY_LOADING,
  STRATEGY_NOTES,
  STRATEGY_TITLE,
  canStore,
  failureOf,
  fractionalNote,
  methodCells,
  pickSymbol,
  refFetchedNote,
  strategyBody,
  strategyCards,
  strategyIntro,
  strategyKey,
  strategyName,
  strategyRequests,
  strategyStale,
} from "../../web/strategydata.js";

const MINUS = "−"; // U+2212 (format.js MINUS)

const EXPECTED = JSON.parse(
  readFileSync(new URL("../fixtures/expected.json", import.meta.url), "utf8"),
);
const V2 = EXPECTED.v2;

/** 9-8 응답의 invested: 상세 설계 4절 응답 예 (5개 모두 같은 총액, 9-6). expected.json에는 없다. */
const INVESTED = 120_000_000;
/** 같은 종목 /api/backtest의 summary.buys (9-8 조건은 매수 60번, 계산 규칙 7절, 결정 d57). */
const BUYS = 60;
/** 첫 매수일: expected.json v2.buy_rows의 1회 날짜 (상세 설계 4절 chart.dates 첫날과 같다). */
const FIRST_BUY = Object.keys(V2.buy_rows)[0];

/** 전략 값에 invested를 붙인다. 계산하지 못한 전략(null)은 그대로 둔다. */
function withInvested(strategies) {
  return Object.fromEntries(
    Object.entries(strategies).map(([key, s]) => [
      key,
      s === null ? null : { ...s, invested: INVESTED },
    ]),
  );
}

/**
 * 9-8 조건의 /api/strategy params (요청 그대로, expected.json v2 조건).
 * 소수점·수수료 0은 계산 규칙 9-8 머리말이다.
 */
const PARAMS = {
  symbol: V2.symbol,
  start: V2.period[0],
  end: V2.period[1],
  freq: V2.freq,
  anchor: V2.anchor,
  amount: V2.amount,
  currency: V2.invest_currency,
  fractional: true,
  fee_pct: 0,
  ma_days: V2.ma_days,
  switch_ref: V2.switch_ref,
};

/** 9-8 응답의 switch_ref (상세 설계 4절 응답 예). QLD·QQQ는 같은 거래소라 same_day. */
const SWITCH_REF = { symbol: "QQQ", basis: "same_day", stale: false, data_through: "2026-11-23" };

/**
 * /api/strategy 응답 (상세 설계 4절 모양). 기본은 9-8 응답이고 strategies는 expected.json v2.strategies.
 * 그래프(#66)와 바꿔 보기(#67)는 이 조각에서 읽지 않지만 응답 모양대로 채운다.
 */
function response({ params = {}, result = {}, strategies = {}, errors = [] } = {}) {
  return {
    params: { ...PARAMS, ...params },
    result: {
      symbol: "QLD",
      name: "ProShares Ultra QQQ",
      currency: "USD",
      notes: ["2025-11-20 2:1 분할 반영"],
      data_through: "2026-11-23",
      stale: false,
      listed_from: null,
      switch_ref: SWITCH_REF,
      strategies: withInvested({ ...V2.strategies, ...strategies }),
      chart: { dates: [FIRST_BUY, "2026-11-23"], series: {}, total_days: 1250 },
      anchor_sweep: V2.anchor_sweep,
      start_sweep: V2.start_sweep,
      ...result,
    },
    errors,
  };
}

const R98 = response();
/** 같은 결과를 20일선으로 계산한 응답. 글이 응답의 params.ma_days를 따르는지만 본다. */
const R20 = response({ params: { ma_days: 20 } });
/** 005930.KS, 같은 조건 (계산 규칙 9-8 다른 거래소 사례). 레버리지 전환은 v2.switch_cross_exchange. */
const KS = response({
  params: { symbol: "005930.KS" },
  result: {
    symbol: "005930.KS",
    name: "Samsung Electronics Co., Ltd.",
    currency: "KRW",
    notes: [],
    switch_ref: { ...SWITCH_REF, basis: "previous_day" },
  },
  strategies: { switch: V2.switch_cross_exchange },
});
/** 기준 종목만 받지 못한 응답 (상세 설계 4절 오류, 결정 d31). */
const REF_ERROR = { symbol: "QQQ", message: "'QQQ' 종목을 찾을 수 없습니다." };
const REF_FAILED = response({
  result: { switch_ref: null },
  strategies: { switch: null },
  errors: [REF_ERROR],
});
/** 종목을 받지 못한 응답: result null. */
function failed(errors) {
  return { params: PARAMS, result: null, errors };
}
const QLD_ERROR = { symbol: "QLD", message: "'QLD' 종목을 찾을 수 없습니다." };

const CELL_KEYS = [
  "return_pct",
  "xirr_pct",
  "avg_cost_asset",
  "worst_return_pct",
  "leftover_cash_invest",
];

/** 카드 한 장을 화면처럼 이은 글: "평가금 · 수익률 · XIRR · 평단가 · 최저 수익률 · 남은 현금 · 바닥". */
function cardLine(card) {
  return [card.value, ...card.cells.map((c) => c.text), card.foot].join(" · ");
}

/** key 카드. */
function cardOf(cards, key) {
  const card = cards.find((c) => c.key === key);
  assert.ok(card, `${key} 카드가 없다`);
  return card;
}

/** 칸마다 굵은(best) 카드 key들: { return_pct: ["lump_sum"], ... }. */
function bestKeys(cards) {
  const best = Object.fromEntries(CELL_KEYS.map((k) => [k, []]));
  for (const card of cards) {
    for (const cell of card.cells) if (cell.best) best[cell.key].push(card.key);
  }
  return best;
}

const ruleName = (key) => BUY_RULES.find((r) => r.key === key).name;

// ---------- 상수와 이름 ----------

test("STRATEGY_KEYS: engine.RULES 순서 none·ma_dip·ma_hot·switch·lump_sum", () => {
  assert.deepEqual(STRATEGY_KEYS, ["none", "ma_dip", "ma_hot", "switch", "lump_sum"]);
});

test("MA_CHOICES: 이평선은 20·60·120·200일 (상세 설계 4절 ma_days)", () => {
  assert.deepEqual(MA_CHOICES, [20, 60, 120, 200]);
});

test("STRATEGY_TITLE·STRATEGY_LOADING: 탭 맨 위 제목과 계산 중 글", () => {
  assert.equal(STRATEGY_TITLE, "같은 돈, 다른 규칙");
  assert.equal(STRATEGY_LOADING, "전략 5개를 계산하는 중…");
});

test("STRATEGY_NOTES: 탭 끝 안내 두 문장 (F-15)", () => {
  assert.deepEqual(STRATEGY_NOTES, [
    "전략은 사기만 합니다. 이평선 아래로 내려갈 때 파는 전략은 다루지 않습니다.",
    "과거에 잘 맞은 규칙이 앞으로도 맞는다는 뜻이 아닙니다. 기간을 바꿔 보면 순위가 바뀔 수 있습니다.",
  ]);
});

test("strategyName: 기본 적립, BUY_RULES 이름 셋, 일시금 (결정 d64)", () => {
  assert.equal(strategyName("none"), "기본 적립");
  for (const key of ["ma_dip", "ma_hot", "switch"]) assert.equal(strategyName(key), ruleName(key));
  assert.equal(strategyName("lump_sum"), "일시금");
});

// ---------- 탭 맨 위 한 줄 ----------

const INTRO_TAIL = "넣는 건 같고, 언제 얼마나 살지만 바꿔 봅니다. 전략은 종목 하나씩 계산합니다.";

test("strategyIntro: 원화 200만원은 이슈 글 그대로 (시안의 '매달' 대신 '매번')", () => {
  assert.equal(strategyIntro(PARAMS), `매번 200만원을 ${INTRO_TAIL}`);
});

test("strategyIntro: 주기가 매주·매일이어도 '매번'", () => {
  const weekly = { ...PARAMS, freq: "weekly", anchor: 0 };
  const daily = { ...PARAMS, freq: "daily", anchor: null };
  assert.equal(strategyIntro(weekly), `매번 200만원을 ${INTRO_TAIL}`);
  assert.equal(strategyIntro(daily), `매번 200만원을 ${INTRO_TAIL}`);
});

test("strategyIntro: 달러 투자는 달러 금액 (format.js money 글)", () => {
  const text = strategyIntro({ ...PARAMS, currency: "USD", amount: 1500 });
  assert.match(text, /^매번 \$1,500\.00(을|를) /);
  assert.ok(text.endsWith(INTRO_TAIL), text);
});

// ---------- 요청 본문 (상세 설계 4절 /api/strategy) ----------

/** 보이는 결과를 계산한 조건(resultView.shown, conditions.js cond 모양). 9-8 조건에 레버리지 전환·양도세. */
const COND = {
  codes: ["QQQ", "QLD"],
  start: "2021-11-25",
  end: "2026-11-24",
  freq: "monthly",
  monthDay: 1,
  weekDay: 0,
  amount: 2_000_000,
  currency: "KRW",
  fractional: true,
  fee: 0,
  tax: true,
  rule: "switch",
};
/** 상세 설계 4절 /api/strategy 요청 예. */
const STRATEGY_REQUEST = {
  symbol: "QLD",
  start: "2021-11-25",
  end: "2026-11-24",
  freq: "monthly",
  anchor: 1,
  amount: 2_000_000,
  currency: "KRW",
  fractional: true,
  fee_pct: 0,
  ma_days: 200,
  switch_ref: "QQQ",
};
/** backtestBody에서 빼는 키 (설계 메모). 그 밖의 키는 strategyBody에 같은 값으로 따라온다. */
const BACKTEST_ONLY = ["symbols", "rule", "tax", "ma_days", "switch_ref", "include_daily"];

test("strategyBody: 9-8 조건은 상세 설계 4절 /api/strategy 요청 예와 같다", () => {
  assert.deepEqual(strategyBody(COND, "QLD", 200), STRATEGY_REQUEST);
});

test("strategyBody: 종목 목록·매수 규칙·양도세·include_daily는 싣지 않는다", () => {
  const body = strategyBody(COND, "QLD", 200);
  for (const key of ["symbols", "rule", "tax", "include_daily"]) {
    assert.equal(Object.hasOwn(body, key), false, `${key}가 실렸다`);
  }
});

test("strategyBody: 매주는 요일, 매일은 anchor null", () => {
  assert.equal(strategyBody({ ...COND, freq: "weekly", weekDay: 4 }, "QLD", 200).anchor, 4);
  assert.equal(strategyBody({ ...COND, freq: "daily" }, "QLD", 200).anchor, null);
});

test("strategyBody: 고른 종목과 이평선을 싣고, 기준 종목은 늘 QQQ (결정 d43)", () => {
  const body = strategyBody(COND, "QQQ", 20);
  assert.equal(body.symbol, "QQQ");
  assert.equal(body.ma_days, 20);
  assert.equal(body.switch_ref, "QQQ");
  assert.equal(strategyBody({ ...COND, rule: "none" }, "QLD", 120).switch_ref, "QQQ");
});

/** backtestBody를 따라오는지 볼 조건들. 기본값이 아닌 칸을 골고루 바꾼다. */
const FOLLOW_CASES = [
  { id: "9-8 조건 (레버리지 전환·양도세)", cond: COND },
  {
    id: "정수 주·수수료 0.25%·달러·매주 금요일·기본 규칙",
    cond: { ...COND, fractional: false, fee: 0.25, currency: "USD", freq: "weekly", weekDay: 4 },
  },
  {
    id: "매일·과열 때 절반·양도세 끔",
    cond: { ...COND, freq: "daily", rule: "ma_hot", tax: false, amount: 50_000 },
  },
];

for (const { id, cond } of FOLLOW_CASES) {
  test(`strategyBody: backtestBody에서 백테스트 전용 키만 빼고 같은 값이 따라온다, ${id}`, () => {
    const full = backtestBody(cond);
    const body = strategyBody(cond, "QLD", 60);
    const shared = Object.keys(full).filter((k) => !BACKTEST_ONLY.includes(k));
    for (const key of shared) assert.deepEqual(body[key], full[key], key);
    assert.deepEqual(
      Object.keys(body).sort(),
      [...shared, "symbol", "ma_days", "switch_ref"].sort(),
    );
    assert.equal(body.symbol, "QLD");
    assert.equal(body.ma_days, 60);
  });
}

// ---------- 저장 키와 종목 고르기 ----------

test("strategyKey: 종목과 이평선 기간 (QLD|200)", () => {
  assert.equal(strategyKey("QLD", 200), "QLD|200");
  assert.notEqual(strategyKey("QLD", 20), strategyKey("QLD", 200));
  assert.notEqual(strategyKey("QQQ", 200), strategyKey("QLD", 200));
});

test("pickSymbol: 처음은 첫 종목, 다시 계산해도 그 종목이 있으면 그대로, 없으면 첫 종목", () => {
  assert.equal(pickSymbol(["QQQ", "QLD"], null), "QQQ");
  assert.equal(pickSymbol(["QQQ", "QLD"], "QLD"), "QLD");
  assert.equal(pickSymbol(["QQQ", "TQQQ"], "QLD"), "QQQ");
  assert.equal(pickSymbol(["005930.KS"], "QLD"), "005930.KS");
});

// ---------- 전략 카드: 9-8 (expected.json v2.strategies) ----------

/** 9-8 200일 카드 글 (이슈 #65 완료 기준). */
const CARDS_98 = {
  none: `2억 2,582만원 · +88.19% · +25.75% · $37.97 · ${MINUS}39.4% · 0원 · 60번 모두 200만원씩`,
  ma_dip:
    `2억 919만원 · +74.33% · +22.55% · $36.09 · ${MINUS}38.2% · 2,864만원 · ` +
    "200일선 아래였던 매수일 18번 / 60번",
  // 최저 수익률 −35.45는 화면 자리(소수 1자리)로 −35.5%다. 9-8 표·시안은 −35.4% (결정 d61)
  ma_hot:
    `2억 1,720만원 · +81.00% · +24.12% · $36.95 · ${MINUS}35.5% · 1,575만원 · ` +
    "과열이었던 매수일 16번 / 60번",
  switch:
    `2억 3,139만원 · +92.83% · +26.78% · $37.06 · ${MINUS}24.8% · 0원 · ` +
    "쉰 매수일 15번 / 60번, 다음 매수일에 모아서 삼",
  lump_sum:
    `2억 3,171만원 · +93.09% · +14.11% · $42.32 · ${MINUS}57.5% · 0원 · ` +
    "첫 매수일에 60번 몫을 한 번에",
};

/** 9-8 규칙 한 줄 (시안 글에 이평선 기간·금액·종목·주기를 넣은 것, 이슈 #65). */
const RULES_98 = {
  none: "매월 1일 200만원",
  ma_dip: "200일선 아래면 400만원, 위면 100만원 (같은 예산)",
  ma_hot: "200일선보다 20% 넘게 위면 100만원만",
  switch: "QQQ가 200일선 위일 때만 QLD 사기, 아래면 현금으로 모아 두기",
  lump_sum: "2021-12-01에 1억 2,000만원을 한 번에",
};

/** 9-8 굵은 칸 (시안과 같다). 평가금은 칸이 아니고, 남은 현금은 굵게 하지 않는다. */
const BEST_98 = {
  return_pct: ["lump_sum"],
  xirr_pct: ["switch"],
  avg_cost_asset: ["ma_dip"],
  worst_return_pct: ["switch"],
  leftover_cash_invest: [],
};

test("strategyCards: 9-8 카드 다섯 장, 순서는 STRATEGY_KEYS, 이름은 결정 d64", () => {
  const cards = strategyCards(R98, BUYS);
  assert.deepEqual(
    cards.map((c) => c.key),
    ["none", "ma_dip", "ma_hot", "switch", "lump_sum"],
  );
  assert.deepEqual(
    cards.map((c) => c.name),
    ["기본 적립", ruleName("ma_dip"), ruleName("ma_hot"), ruleName("switch"), "일시금"],
  );
});

for (const [key, line] of Object.entries(CARDS_98)) {
  test(`strategyCards: 9-8 ${key} 카드 글 (평가금 · 칸 다섯 · 바닥 한 줄)`, () => {
    assert.equal(cardLine(cardOf(strategyCards(R98, BUYS), key)), line);
  });
}

test("strategyCards: 과열 때 절반 최저 수익률은 화면 자리로 −35.5% (결정 d61)", () => {
  const worst = cardOf(strategyCards(R98, BUYS), "ma_hot").cells[3];
  assert.equal(worst.key, "worst_return_pct");
  assert.equal(worst.text, `${MINUS}35.5%`);
});

test("strategyCards: 9-8 규칙 한 줄에 이평선 기간·금액·종목·주기·첫 매수일·총액", () => {
  const cards = strategyCards(R98, BUYS);
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.key, c.rule])), RULES_98);
});

test("strategyCards: 칸은 수익률·XIRR·평단가·최저 수익률·남은 현금 순서", () => {
  for (const card of strategyCards(R98, BUYS)) {
    assert.deepEqual(
      card.cells.map((c) => c.key),
      CELL_KEYS,
      card.key,
    );
    assert.deepEqual(
      card.cells.map((c) => c.label),
      ["수익률", "XIRR", "평단가", "최저 수익률", "남은 현금"],
      card.key,
    );
  }
});

test("strategyCards: 9-8 굵은 칸은 수익률 일시금, XIRR·최저 수익률 레버리지 전환, 평단가 이평선 아래 2배·위 절반", () => {
  assert.deepEqual(bestKeys(strategyCards(R98, BUYS)), BEST_98);
});

test("strategyCards: 남은 현금은 굵게 하지 않고, 평가금은 칸이 아니라 value 글이다", () => {
  for (const card of strategyCards(R98, BUYS)) {
    assert.equal(cellOf(card, "leftover_cash_invest").best, false, card.key);
    assert.equal(typeof card.value, "string", card.key);
    assert.equal(
      card.cells.some((c) => c.key === "value"),
      false,
      card.key,
    );
  }
});

test("strategyCards: 테두리를 굵게 하는 base는 기본 적립만 true", () => {
  const cards = strategyCards(R98, BUYS);
  assert.deepEqual(
    cards.map((c) => c.base),
    [true, false, false, false, false],
  );
});

test("strategyCards: 계산한 카드는 error가 null", () => {
  for (const card of strategyCards(R98, BUYS)) assert.equal(card.error, null, card.key);
});

/** key 칸. */
function cellOf(card, key) {
  const cell = card.cells.find((c) => c.key === key);
  assert.ok(cell, `${card.key} 카드에 ${key} 칸이 없다`);
  return cell;
}

// ---------- 전략 카드: 이평선·주기는 그 응답의 params로 ----------

test("strategyCards: 20일선 응답은 규칙 세 줄이 20일선", () => {
  const cards = strategyCards(R20, BUYS);
  assert.equal(cardOf(cards, "ma_dip").rule, "20일선 아래면 400만원, 위면 100만원 (같은 예산)");
  assert.equal(cardOf(cards, "ma_hot").rule, "20일선보다 20% 넘게 위면 100만원만");
  assert.equal(
    cardOf(cards, "switch").rule,
    "QQQ가 20일선 위일 때만 QLD 사기, 아래면 현금으로 모아 두기",
  );
  assert.equal(cardOf(cards, "none").rule, RULES_98.none);
  assert.equal(cardOf(cards, "lump_sum").rule, RULES_98.lump_sum);
});

test("strategyCards: 20일선 응답은 이평선 아래 바닥 글도 20일선", () => {
  const cards = strategyCards(R20, BUYS);
  assert.equal(cardOf(cards, "ma_dip").foot, "20일선 아래였던 매수일 18번 / 60번");
  assert.equal(cardOf(cards, "ma_hot").foot, "과열이었던 매수일 16번 / 60번");
});

test("strategyCards: 기본 적립 규칙 글의 주기는 응답 params대로 (매주 월요일, 매일)", () => {
  const weekly = response({ params: { freq: "weekly", anchor: 0 } });
  const daily = response({ params: { freq: "daily", anchor: null } });
  assert.equal(cardOf(strategyCards(weekly, BUYS), "none").rule, "매주 월요일 200만원");
  assert.equal(cardOf(strategyCards(daily, BUYS), "none").rule, "매일 200만원");
});

test("basisText: 9-8 응답의 기준 종목 basis는 같은 날 종가로 판단 (이평선과 상관없다)", () => {
  for (const reply of [R98, R20]) {
    const ref = reply.result.switch_ref;
    const text = basisText(ref.basis, [reply.result.symbol], ref.symbol, reply.params.ma_days);
    assert.equal(text, "같은 날 종가로 판단");
  }
});

// ---------- 전략 카드: 다른 거래소 기준 종목 (005930.KS, v2.switch_cross_exchange) ----------

test("strategyCards: 005930.KS 레버리지 전환 카드는 원화 평단가 (v2.switch_cross_exchange)", () => {
  const card = cardOf(strategyCards(KS, BUYS), "switch");
  assert.equal(
    cardLine(card),
    `2억 9,811만원 · +148.42% · +37.64% · 76,241원 · ${MINUS}26.2% · 0원 · ` +
      "쉰 매수일 14번 / 60번, 다음 매수일에 모아서 삼",
  );
  assert.equal(card.rule, "QQQ가 200일선 위일 때만 005930.KS 사기, 아래면 현금으로 모아 두기");
});

test("basisText: 005930.KS 응답의 기준 종목 basis는 previous_day 글 (결정 d29)", () => {
  const ref = KS.result.switch_ref;
  assert.equal(
    basisText(ref.basis, [KS.result.symbol], ref.symbol, KS.params.ma_days),
    "005930.KS는 QQQ와 거래소가 달라 매수일보다 앞선 마지막 거래일의 " +
      "QQQ 종가·200일선으로 판단했습니다.",
  );
});

// ---------- 전략 카드: 기준 종목만 실패 (결정 d31) ----------

test("strategyCards: 기준 종목만 실패하면 다섯 장 중 레버리지 전환만 오류 글", () => {
  const cards = strategyCards(REF_FAILED, BUYS);
  assert.deepEqual(
    cards.map((c) => c.key),
    STRATEGY_KEYS,
  );
  const card = cardOf(cards, "switch");
  assert.equal(card.name, ruleName("switch"));
  assert.deepEqual(card.error, {
    title: "계산하지 못했습니다",
    detail:
      "기준 종목 QQQ를 받지 못해 레버리지 전환은 계산하지 못했습니다. " +
      "'QQQ' 종목을 찾을 수 없습니다.",
  });
  assert.equal(card.value, null);
  assert.deepEqual(card.cells, []);
});

test("strategyCards: 기준 종목만 실패해도 나머지 네 장은 9-8 글 그대로", () => {
  const cards = strategyCards(REF_FAILED, BUYS);
  for (const key of ["none", "ma_dip", "ma_hot", "lump_sum"]) {
    const card = cardOf(cards, key);
    assert.equal(cardLine(card), CARDS_98[key], key);
    assert.equal(card.rule, RULES_98[key], key);
    assert.equal(card.error, null, key);
  }
});

test("strategyCards: 기준 종목만 실패하면 굵은 칸을 네 장 안에서 다시 고른다", () => {
  assert.deepEqual(bestKeys(strategyCards(REF_FAILED, BUYS)), {
    return_pct: ["lump_sum"],
    xirr_pct: ["none"],
    avg_cost_asset: ["ma_dip"],
    worst_return_pct: ["ma_hot"],
    leftover_cash_invest: [],
  });
});

// ---------- 전략 카드: 계산 불가와 같은 값 ----------

test("strategyCards: XIRR이 null이면 계산 불가이고 굵지 않다 (다음으로 큰 값이 굵다)", () => {
  const reply = response({ strategies: { switch: { ...V2.strategies.switch, xirr_pct: null } } });
  const cards = strategyCards(reply, BUYS);
  const xirr = cellOf(cardOf(cards, "switch"), "xirr_pct");
  assert.equal(xirr.text, "계산 불가");
  assert.equal(xirr.best, false);
  assert.deepEqual(bestKeys(cards).xirr_pct, ["none"]);
});

test("strategyCards: 화면 자리로 같아 보이면 모두 굵게 (평단가 shownPrice, 최저 수익률 소수 1자리)", () => {
  // 과열 때 절반 평단가 36.0912는 $36.09(이평선 아래 2배·위 절반 36.0893과 같은 글),
  // 최저 수익률 −24.84는 −24.8%(레버리지 전환 −24.76과 같은 글)
  const hot = { ...V2.strategies.ma_hot, avg_cost_asset: 36.0912, worst_return_pct: -24.84 };
  const best = bestKeys(strategyCards(response({ strategies: { ma_hot: hot } }), BUYS));
  assert.deepEqual(best.avg_cost_asset, ["ma_dip", "ma_hot"]);
  assert.deepEqual(best.worst_return_pct, ["ma_hot", "switch"]);
});

// ---------- 계산 방법 세 칸 (시안) ----------

test("methodCells: 같은 예산 · 안 쓴 현금도 평가금 · 미래 데이터 금지 세 칸", () => {
  const cells = methodCells(R98);
  assert.deepEqual(
    cells.map((c) => c.title),
    ["같은 예산", "안 쓴 현금도 평가금", "미래 데이터 금지"],
  );
  assert.ok(cells[0].text.includes("200만원"), cells[0].text);
  assert.ok(cells[1].text.includes("달러 현금"), cells[1].text);
  assert.ok(cells[2].text.includes("매수일의 200일선"), cells[2].text);
});

test("methodCells: 현금은 종목 통화라 005930.KS는 원화 현금", () => {
  const cells = methodCells(KS);
  assert.ok(cells[1].text.includes("원화 현금"), cells[1].text);
  assert.equal(
    cells.some((c) => c.text.includes("달러")),
    false,
  );
});

test("methodCells: 20일선 응답은 매수일의 20일선", () => {
  const cells = methodCells(R20);
  assert.ok(cells[2].text.includes("매수일의 20일선"), cells[2].text);
  assert.equal(
    cells.some((c) => c.text.includes("200일선")),
    false,
  );
});

// ---------- 카드 위 안내: 소수점 매수, 따로 받은 기준 종목 ----------

test("fractionalNote: 정수 주만으로 요청했으면 소수점 매수 안내, 아니면 null (결정 d28)", () => {
  assert.equal(fractionalNote({ ...PARAMS, fractional: false }), "전략은 소수점 매수로 계산합니다");
  assert.equal(fractionalNote(PARAMS), null);
});

const REF_FETCHED =
  "레버리지 전환의 기준 종목 QQQ를 따로 받아 썼습니다. " +
  "기준 종목은 계산에만 쓰고 결과 카드에는 넣지 않습니다.";

test("refFetchedNote: 기준 종목이 결과 종목에 없으면 따로 받아 썼다는 글 (시안 늘어나는 상태 5)", () => {
  assert.equal(refFetchedNote(["QLD"], R98), REF_FETCHED);
  assert.equal(refFetchedNote(["005930.KS"], KS), REF_FETCHED);
});

test("refFetchedNote: 기준 종목이 결과 종목에 있으면 null", () => {
  assert.equal(refFetchedNote(["QQQ", "QLD"], R98), null);
});

test("refFetchedNote: 기준 종목을 받지 못했으면(switch_ref null) null", () => {
  assert.equal(refFetchedNote(["QLD"], REF_FAILED), null);
});

// ---------- 저장본 노랑 알림 (F-10) ----------

const STALE_REF = { ...SWITCH_REF, stale: true, data_through: "2026-11-20" };
const STOCK_STALE_TITLE = "QLD는 2026-11-20까지 저장된 데이터로 계산했습니다.";

test("strategyStale: 종목과 기준 종목을 새로 받았으면 []", () => {
  assert.deepEqual(strategyStale(R98), []);
  assert.deepEqual(strategyStale(REF_FAILED), []); // 기준 종목 실패는 저장본이 아니다
});

test("strategyStale: result.stale이면 종목 저장본 알림 (날짜는 종목 data_through)", () => {
  const alerts = strategyStale(response({ result: { stale: true, data_through: "2026-11-20" } }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, STOCK_STALE_TITLE);
  assert.equal(typeof alerts[0].detail, "string");
});

test("strategyStale: switch_ref.stale이면 refStaleAlert와 같은 글 (그 응답의 이평선 기간)", () => {
  for (const ma of [200, 20]) {
    const reply = response({ params: { ma_days: ma }, result: { switch_ref: STALE_REF } });
    const want = refStaleAlert([{ switch_ref: STALE_REF }], reply.params);
    assert.deepEqual(strategyStale(reply), [want]);
    assert.equal(want.title, "기준 종목 QQQ는 2026-11-20까지 저장된 데이터로 판단했습니다.");
    assert.ok(want.detail.includes(`${ma}일선`), want.detail);
  }
});

test("strategyStale: 종목과 기준 종목이 모두 저장본이면 종목 알림이 먼저", () => {
  const reply = response({
    result: { stale: true, data_through: "2026-11-20", switch_ref: STALE_REF },
  });
  const alerts = strategyStale(reply);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].title, STOCK_STALE_TITLE);
  assert.deepEqual(alerts[1], refStaleAlert([{ switch_ref: STALE_REF }], reply.params));
});

// ---------- 탭 안 빨강 상자 (F-10) ----------

const NOT_CONNECTED = {
  title: "계산하지 못했습니다",
  detail: "서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 시도해 주세요.",
};

test("failureOf: 연결 실패(reply null)는 app.js와 같은 연결 실패 글", () => {
  assert.deepEqual(failureOf(null, "QLD"), NOT_CONNECTED);
});

test("failureOf: HTTP 오류는 상태 번호를 적는다", () => {
  assert.deepEqual(failureOf({ status: 500, json: null }, "QLD"), {
    title: "계산하지 못했습니다",
    detail: "서버가 계산하지 못했습니다 (HTTP 500). 잠시 뒤 다시 시도해 주세요.",
  });
});

/** result null 응답의 종목 줄 (상세 설계 4절 오류: 메시지는 /api/backtest와 같다). */
const RESULT_NULL_CASES = [
  { id: "없는 종목", message: "'QLD' 종목을 찾을 수 없습니다." },
  { id: "기간 안 매수일 없음", message: "QLD: 기간 안에 매수일이 없습니다" },
  { id: "환율을 받지 못함", message: "USDKRW=X 환율을 받지 못해 계산하지 못했습니다." },
  { id: "환율 없는 날", message: "USDKRW=X 환율이 2021-12-01 이전에는 없습니다" },
];

for (const { id, message } of RESULT_NULL_CASES) {
  test(`failureOf: result null이면 종목과 이유 (F-10 빨강 상자), ${id}`, () => {
    const reply = { status: 200, json: failed([{ symbol: "QLD", message }]) };
    assert.deepEqual(failureOf(reply, "QLD"), {
      title: "QLD는 계산하지 못했습니다.",
      detail: message,
    });
  });
}

test("failureOf: result null에 종목 줄과 기준 종목 줄이 같이 있으면 종목 줄 이유", () => {
  const reply = { status: 200, json: failed([QLD_ERROR, REF_ERROR]) };
  assert.deepEqual(failureOf(reply, "QLD"), {
    title: "QLD는 계산하지 못했습니다.",
    detail: QLD_ERROR.message,
  });
});

test("failureOf: 성공과 기준 종목만 실패한 응답은 null (카드를 그린다)", () => {
  assert.equal(failureOf({ status: 200, json: R98 }, "QLD"), null);
  assert.equal(failureOf({ status: 200, json: REF_FAILED }, "QLD"), null);
});

// ---------- 저장해 둘 응답 (결정 보드 d63) ----------

const STORE_CASES = [
  { id: "성공", reply: { status: 200, json: R98 }, want: true },
  { id: "연결 실패", reply: null, want: false },
  { id: "HTTP 500", reply: { status: 500, json: null }, want: false },
  { id: "HTTP 422", reply: { status: 422, json: { detail: [] } }, want: false },
  { id: "result null", reply: { status: 200, json: failed([QLD_ERROR]) }, want: false },
  { id: "기준 종목만 실패", reply: { status: 200, json: REF_FAILED }, want: false },
];

for (const { id, reply, want } of STORE_CASES) {
  test(`canStore: 200·result 있음·errors 빔일 때만 저장, ${id}`, () => {
    assert.equal(canStore(reply), want);
  });
}

// ---------- 요청 묶음: 저장·같이 기다리기·늦게 온 응답 (결정 보드 d63) ----------

const K200 = "QLD|200";
const K20 = "QLD|20";
const BODY_200 = STRATEGY_REQUEST;
const BODY_20 = { ...STRATEGY_REQUEST, ma_days: 20 };
const OK_200 = { status: 200, json: R98 };
const OK_20 = { status: 200, json: R20 };

/** 가짜 send: 부를 때마다 { body, resolve }를 calls에 쌓고, 테스트가 손으로 응답을 푼다. */
function fakeSend() {
  const calls = [];
  const send = (body) => new Promise((resolve) => calls.push({ body, resolve }));
  return { send, calls };
}

/** pick 안의 await가 send까지 가도록 한 바퀴 돌린다. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("strategyRequests: 200 → 20 → 200은 send 두 번, 200으로 돌아가면 저장한 응답", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  const first = requests.pick(K200, BODY_200);
  await flush();
  calls[0].resolve(OK_200);
  const r1 = await first;
  assert.deepEqual(r1.reply, OK_200);
  assert.equal(r1.latest, true);

  const second = requests.pick(K20, BODY_20);
  await flush();
  calls[1].resolve(OK_20);
  const r2 = await second;
  assert.deepEqual(r2.reply, OK_20);
  assert.equal(r2.latest, true);

  const back = await requests.pick(K200, BODY_200);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.body),
    [BODY_200, BODY_20],
  );
  assert.deepEqual(back.reply, OK_200);
  assert.equal(back.latest, true);
  assert.deepEqual(requests.saved(K200), OK_200);
  assert.deepEqual(requests.saved(K20), OK_20);
});

test("strategyRequests: 200(느림) 뒤 20(빠름)이면 늦게 온 200은 latest false지만 저장한다", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  const slow = requests.pick(K200, BODY_200);
  const fast = requests.pick(K20, BODY_20);
  await flush();
  assert.equal(calls.length, 2);

  calls[1].resolve(OK_20);
  assert.equal((await fast).latest, true);
  calls[0].resolve(OK_200);
  const late = await slow;
  assert.deepEqual(late.reply, OK_200);
  assert.equal(late.latest, false);
  assert.deepEqual(requests.saved(K200), OK_200);

  const again = await requests.pick(K200, BODY_200);
  await flush();
  assert.equal(calls.length, 2); // 저장한 200을 다시 보내지 않는다
  assert.equal(again.latest, true);
});

test("strategyRequests: 20 가는 중에 저장한 200으로 돌아가면 200이 latest, 늦게 온 20은 저장만", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  const first = requests.pick(K200, BODY_200);
  await flush();
  calls[0].resolve(OK_200);
  await first;

  const pending = requests.pick(K20, BODY_20);
  await flush();
  const back = await requests.pick(K200, BODY_200);
  assert.equal(back.latest, true);
  assert.deepEqual(back.reply, OK_200);

  calls[1].resolve(OK_20);
  const late = await pending;
  assert.equal(late.latest, false);
  assert.deepEqual(requests.saved(K20), OK_20);
  assert.equal(calls.length, 2);
});

/** 저장하지 않는 응답: 다시 고르면 다시 보낸다. */
const RETRY_CASES = [
  { id: "연결 실패", reply: null },
  { id: "HTTP 500", reply: { status: 500, json: null } },
  { id: "result null", reply: { status: 200, json: failed([QLD_ERROR]) } },
  { id: "기준 종목만 실패", reply: { status: 200, json: REF_FAILED } },
];

for (const { id, reply } of RETRY_CASES) {
  test(`strategyRequests: 저장하지 않고 다시 고르면 다시 보낸다, ${id}`, async () => {
    const { send, calls } = fakeSend();
    const requests = strategyRequests(send);
    const first = requests.pick(K200, BODY_200);
    await flush();
    calls[0].resolve(reply);
    const r1 = await first;
    assert.deepEqual(r1.reply, reply);
    assert.equal(r1.latest, true);
    assert.equal(requests.saved(K200) ?? null, null);

    const again = requests.pick(K200, BODY_200);
    await flush();
    assert.equal(calls.length, 2);
    calls[1].resolve(OK_200);
    assert.deepEqual((await again).reply, OK_200);
    assert.deepEqual(requests.saved(K200), OK_200);
  });
}

test("strategyRequests: 가는 중인 같은 key를 두 번 고르면 send 한 번, 둘 다 그 응답", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  const first = requests.pick(K200, BODY_200);
  const second = requests.pick(K200, BODY_200);
  await flush();
  assert.equal(calls.length, 1);
  calls[0].resolve(OK_200);
  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual(r1.reply, OK_200);
  assert.deepEqual(r2.reply, OK_200);
  assert.equal(r2.latest, true);
});

test("strategyRequests: 200 가는 중에 20을 골랐다가 200으로 돌아오면 200은 다시 보내지 않는다", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  requests.pick(K200, BODY_200);
  const p20 = requests.pick(K20, BODY_20);
  const back = requests.pick(K200, BODY_200);
  await flush();
  assert.equal(calls.length, 2);

  calls[1].resolve(OK_20);
  assert.equal((await p20).latest, false); // 마지막으로 고른 것은 200
  calls[0].resolve(OK_200);
  const r = await back;
  assert.deepEqual(r.reply, OK_200);
  assert.equal(r.latest, true);
});

test("strategyRequests: 고른 적 없는 key는 saved가 비었다", () => {
  const { send } = fakeSend();
  assert.equal(strategyRequests(send).saved(K200) ?? null, null);
});

test("strategyRequests: 20이 가는 중에 이미 그린 200으로 돌아가면(select) 늦게 온 20은 latest가 아니다", async () => {
  // strategy.js showStrategy가 부르는 순서 그대로: 그린 key·저장한 key로 돌아갈 때는 pick 없이 select만 한다
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  const first = requests.pick(K200, BODY_200);
  await flush();
  calls[0].resolve(OK_200);
  await first;

  const pending = requests.pick(K20, BODY_20);
  await flush();
  requests.select(K200);
  calls[1].resolve(OK_20);
  const late = await pending;
  assert.equal(late.latest, false);
  assert.deepEqual(requests.saved(K20), OK_20); // 늦게 왔어도 저장한다
  assert.equal(calls.length, 2);
});

test("strategyRequests: select는 보내지 않는다", async () => {
  const { send, calls } = fakeSend();
  const requests = strategyRequests(send);
  requests.select(K200);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(requests.saved(K200) ?? null, null);
});
