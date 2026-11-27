// web/format.js 표시 형식. node --test로 돈다 (scripts/check.py "웹 테스트").
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINUS,
  amountPreview,
  advancedText,
  condLine,
  freqText,
  fx,
  headTitle,
  investLabel,
  krwShort,
  money,
  pct,
  period,
  price,
  qty,
  rate,
  ruleTag,
  shortDate,
  shortMonth,
  shownMoney,
  signedMoney,
  times,
} from "../../web/format.js";
import * as formatModule from "../../web/format.js";
import { ALL_START } from "../../web/conditions.js";

// #65에서 더하는 함수. 아직 없을 때 이 파일의 다른 테스트까지 막지 않게 모듈 이름공간에서 꺼낸다
const { shownPrice } = formatModule;

// ---------- 주기·통화 글자와 접힌 조건 줄 (F-11) ----------

/** API 응답의 params (요청 그대로): 예시 조건. */
const PARAMS = {
  symbols: ["QQQ", "QLD"],
  start: "2021-11-25",
  end: "2026-11-24",
  freq: "monthly",
  anchor: 1,
  amount: 2_000_000,
  currency: "KRW",
  fractional: true,
  fee_pct: 0,
};
const LINE = "2021-11-25 ~ 2026-11-24 · 매월 1일 · 종목마다 200만원 · 원화";

test("freqText: 주기마다 글자", () => {
  assert.equal(freqText("daily", null), "매일");
  assert.equal(freqText("weekly", 0), "매주 월요일");
  assert.equal(freqText("weekly", 4), "매주 금요일");
  assert.equal(freqText("monthly", 1), "매월 1일");
  assert.equal(freqText("monthly", 31), "매월 말일");
});

test("investLabel: 투자 통화 이름", () => {
  assert.equal(investLabel("KRW"), "원화");
  assert.equal(investLabel("USD"), "달러");
  assert.equal(investLabel("JPY"), "JPY");
});

test("condLine: 예시 조건은 기간 · 주기 · 금액 · 통화", () => {
  assert.equal(condLine(PARAMS), LINE);
});

test("condLine: 정수 주는 기본값이 아닐 때만 붙인다", () => {
  assert.equal(condLine({ ...PARAMS, fractional: false }), `${LINE} · 정수 주만`);
});

test("condLine: 수수료는 0보다 클 때만 붙인다", () => {
  assert.equal(condLine({ ...PARAMS, fee_pct: 0.25 }), `${LINE} · 수수료 0.25%`);
  assert.equal(
    condLine({ ...PARAMS, fractional: false, fee_pct: 0.1 }),
    `${LINE} · 정수 주만 · 수수료 0.1%`,
  );
});

test("condLine: 전체 기간은 상장일부터", () => {
  assert.equal(
    condLine({ ...PARAMS, start: "1970-01-02" }),
    "상장일 ~ 2026-11-24 · 매월 1일 · 종목마다 200만원 · 원화",
  );
});

test("condLine: 양도세 어림(F-20)은 켰을 때만 붙인다", () => {
  assert.equal(condLine({ ...PARAMS, tax: true }), `${LINE} · 양도세 반영`);
  assert.equal(condLine({ ...PARAMS, tax: false }), LINE);
  assert.equal(
    condLine({ ...PARAMS, fee_pct: 0.1, tax: true }),
    `${LINE} · 수수료 0.1% · 양도세 반영`,
  );
});

// ---------- 매수 규칙 이름 (F-17): 결과 머리 줄과 접힌 조건 줄 ----------

/** API 응답 params의 매수 규칙 부분 (요청 그대로, 결정 d43). */
const RULE = { ma_days: 200, switch_ref: "QQQ" };
const MA_DIP_TAG = "이평선 아래 2배·위 절반 (200일선)";

test("ruleTag: 규칙 이름과 이평선 기간. 레버리지 전환은 기준 종목도", () => {
  assert.equal(ruleTag({ ...PARAMS, ...RULE, rule: "ma_dip" }), MA_DIP_TAG);
  assert.equal(ruleTag({ ...PARAMS, ...RULE, rule: "ma_hot" }), "과열 때 절반 (200일선)");
  assert.equal(ruleTag({ ...PARAMS, ...RULE, rule: "switch" }), "레버리지 전환 (QQQ 200일선)");
});

test("ruleTag: 기본 규칙이거나 rule이 없으면(v1 응답) null", () => {
  assert.equal(ruleTag({ ...PARAMS, ...RULE, rule: "none" }), null);
  assert.equal(ruleTag(PARAMS), null);
});

test("condLine: 기본이 아닌 규칙은 통화 뒤에 이름을 붙인다", () => {
  assert.equal(condLine({ ...PARAMS, ...RULE, rule: "ma_dip" }), `${LINE} · ${MA_DIP_TAG}`);
  assert.equal(
    condLine({ ...PARAMS, ...RULE, rule: "switch", fee_pct: 0.1, tax: true }),
    `${LINE} · 레버리지 전환 (QQQ 200일선) · 수수료 0.1% · 양도세 반영`,
  );
});

test("condLine: 기본 규칙이면 규칙 이름을 적지 않는다", () => {
  assert.equal(condLine({ ...PARAMS, ...RULE, rule: "none" }), LINE);
});

test("condLine: 매수 규칙은 소수점 매수로 계산하므로 정수 주만을 적지 않는다 (9-6)", () => {
  assert.equal(
    condLine({ ...PARAMS, ...RULE, rule: "ma_dip", fractional: false }),
    `${LINE} · ${MA_DIP_TAG}`,
  );
  assert.equal(
    condLine({ ...PARAMS, ...RULE, rule: "none", fractional: false }),
    `${LINE} · 정수 주만`,
  );
});

test("headTitle: 결과 머리 줄 제목은 종목 수 · 주기와 금액 · 기간", () => {
  assert.equal(headTitle(PARAMS, 2), "2개 종목 · 매월 1일 200만원 · 5년");
  assert.equal(
    headTitle({ ...PARAMS, start: "1970-01-02" }, 1),
    "1개 종목 · 매월 1일 200만원 · 상장 이후 전체",
  );
});

test("headTitle: 기본이 아닌 규칙이면 끝에 규칙 이름을 붙인다", () => {
  assert.equal(
    headTitle({ ...PARAMS, ...RULE, rule: "ma_dip" }, 1),
    `1개 종목 · 매월 1일 200만원 · 5년 · ${MA_DIP_TAG}`,
  );
  assert.equal(headTitle({ ...PARAMS, ...RULE, rule: "none" }, 2), headTitle(PARAMS, 2));
});

test("advancedText: 접힌 고급 설정 제목 옆 지금 값 (F-05, 시안 v2)", () => {
  assert.equal(advancedText({ fractional: true, fee: 0, tax: false }), "· 소수점 · 수수료 0%");
  assert.equal(
    advancedText({ fractional: false, fee: 0.25, tax: true }),
    "· 정수 주 · 수수료 0.25% · 양도세",
  );
});

test("advancedText: 수수료가 숫자가 아니면 확인 필요", () => {
  assert.equal(
    advancedText({ fractional: true, fee: Number.NaN, tax: false }),
    "· 소수점 · 수수료 확인 필요",
  );
});

test("condLine: 매주·매일과 달러", () => {
  assert.equal(
    condLine({ ...PARAMS, freq: "weekly", anchor: 0, amount: 1500, currency: "USD" }),
    "2021-11-25 ~ 2026-11-24 · 매주 월요일 · 종목마다 $1,500.00 · 달러",
  );
  assert.equal(
    condLine({ ...PARAMS, freq: "daily", anchor: null }),
    "2021-11-25 ~ 2026-11-24 · 매일 · 종목마다 200만원 · 원화",
  );
});

test("pct: 부호와 소수 자리를 붙인다", () => {
  assert.equal(pct(88.19), "+88.19%");
  assert.equal(pct(-39.39), `${MINUS}39.39%`);
  assert.equal(pct(107.94, 1), "+107.9%");
  assert.equal(pct(1234.5), "+1,234.50%");
});

test("pct: 0으로 반올림되면 부호를 붙이지 않는다", () => {
  assert.equal(pct(0), "0.00%");
  assert.equal(pct(-0.004), "0.00%");
});

test("pct: 값이 없으면 계산 불가", () => {
  assert.equal(pct(null), "계산 불가");
  assert.equal(pct(undefined), "계산 불가");
});

test("rate: +는 붙이지 않고 빼기만 붙인다 (한눈에 요약의 연환산·비율)", () => {
  assert.equal(rate(28.19), "28.19%");
  assert.equal(rate(-1.5), `${MINUS}1.50%`);
  assert.equal(rate(22.8, 1), "22.8%");
  assert.equal(rate(0), "0.00%");
  assert.equal(rate(null), "계산 불가");
});

test("times: 몇 배인지 소수 2자리", () => {
  assert.equal(times(49.1 / 24.4708), "2.01배");
  assert.equal(times(0.5), "0.50배");
  assert.equal(times(1234.5), "1,234.50배");
  assert.equal(times(null), "—");
});

test("krwShort: 억·만 단위로 줄인다", () => {
  assert.equal(krwShort(225_824_590), "2억 2,582만원");
  assert.equal(krwShort(200_000_000), "2억원");
  assert.equal(krwShort(123_000), "12만원");
  assert.equal(krwShort(9_999), "9,999원");
  assert.equal(krwShort(-61_270_000), `${MINUS}6,127만원`);
});

test("krwShort: 만 단위 반올림이 1억이 되면 억을 올린다", () => {
  assert.equal(krwShort(199_995_000), "2억원");
});

test("money: 원은 짧게 또는 전부, 달러는 소수 2자리", () => {
  assert.equal(money(2_000_000, "KRW"), "200만원");
  assert.equal(money(2_000_000, "KRW", { short: false }), "2,000,000원");
  assert.equal(money(1234.5, "USD"), "$1,234.50");
  assert.equal(money(12_345.6, "USD"), "$12,346");
  assert.equal(money(-5, "USD"), `${MINUS}$5.00`);
  assert.equal(money(null, "USD"), "—");
});

test("signedMoney: 이익과 손실 모두 부호를 붙인다", () => {
  assert.equal(signedMoney(61_270_000, "KRW"), "+6,127만원");
  assert.equal(signedMoney(-500, "USD"), `${MINUS}$500.00`);
  assert.equal(signedMoney(0, "USD"), "$0.00");
});

// ---------- 화면에 보이는 금액 (#53): 비교 표 손익 열의 가장 좋은 값을 견주는 자리 ----------

/** money(기본 짧은 꼴)가 보여 주는 자리. 원은 1만원 이상 만 단위, 달러는 $10,000 이상 정수. */
const SHOWN_CASES = [
  { id: "원화 105,824,590원 → 1억 582만원", value: 105_824_590, cur: "KRW", want: 105_820_000 },
  { id: "원화 105,821,000원 → 1억 582만원", value: 105_821_000, cur: "KRW", want: 105_820_000 },
  { id: "원화 105,814,000원 → 1억 581만원", value: 105_814_000, cur: "KRW", want: 105_810_000 },
  { id: "원화 1만원 아래는 원 단위 (5,000원)", value: 5_000, cur: "KRW", want: 5_000 },
  { id: "원화 1만원 아래는 원 단위 (5,001원)", value: 5_001, cur: "KRW", want: 5_001 },
  { id: "원화 원 단위 반올림이 1만원이면 만 단위", value: 9_999.6, cur: "KRW", want: 10_000 },
  { id: "원화 손실은 부호를 지킨다", value: -105_824_590, cur: "KRW", want: -105_820_000 },
  // money는 절댓값을 반올림하므로 손실의 .5도 0에서 먼 쪽이다: −1억 583만원, −$12,346
  { id: "원화 손실은 절댓값을 반올림", value: -105_825_000, cur: "KRW", want: -105_830_000 },
  { id: "달러 $10,000 이상은 정수 ($12,345.40)", value: 12_345.4, cur: "USD", want: 12_345 },
  { id: "달러 $10,000 이상은 정수 ($12,345.20)", value: 12_345.2, cur: "USD", want: 12_345 },
  { id: "달러 $10,000 아래는 소수 2자리 ($123.454)", value: 123.454, cur: "USD", want: 123.45 },
  { id: "달러 $10,000 아래는 소수 2자리 ($123.456)", value: 123.456, cur: "USD", want: 123.46 },
  { id: "달러 손실은 절댓값을 반올림", value: -12_345.5, cur: "USD", want: -12_346 },
];

for (const { id, value, cur, want } of SHOWN_CASES) {
  test(`shownMoney: ${id}`, () => {
    assert.equal(shownMoney(value, cur), want);
  });
}

test("shownMoney: 값이 없으면 null", () => {
  assert.equal(shownMoney(null, "KRW"), null);
  assert.equal(shownMoney(undefined, "USD"), null);
});

test("shownMoney: 그 값을 money로 쓰면 원래 값의 money 글과 같다", () => {
  for (const { value, cur } of SHOWN_CASES) {
    assert.equal(money(shownMoney(value, cur), cur), money(value, cur), `${value} ${cur}`);
  }
});

test("shownMoney: money 글이 같은 두 값만 같은 값이다", () => {
  const pairs = [
    [105_824_590, 105_821_000, "KRW"], // 둘 다 1억 582만원
    [105_824_590, 105_814_000, "KRW"], // 1억 582만원, 1억 581만원
    [5_000, 5_001, "KRW"],
    [-105_825_000, -105_830_000, "KRW"], // 둘 다 −1억 583만원
    [12_345.4, 12_345.2, "USD"], // 둘 다 $12,345
    [123.454, 123.456, "USD"], // $123.45, $123.46
    [-12_345.5, -12_346, "USD"], // 둘 다 −$12,346
  ];
  for (const [a, b, cur] of pairs) {
    const sameText = money(a, cur) === money(b, cur);
    assert.equal(
      shownMoney(a, cur) === shownMoney(b, cur),
      sameText,
      `${money(a, cur)} / ${money(b, cur)}`,
    );
  }
});

test("price: 달러는 1보다 작으면 4자리, 원은 정수", () => {
  assert.equal(price(37.97, "USD"), "$37.97");
  assert.equal(price(0.5, "USD"), "$0.5000");
  assert.equal(price(76_325, "KRW"), "76,325원");
  assert.equal(price(null, "USD"), "—");
});

// ---------- 화면에 보이는 가격 (#65): 전략 카드 평단가의 가장 좋은 값을 견주는 자리 ----------

/** price가 보여 주는 자리. 원은 정수, 그 밖은 소수 2자리(1보다 작으면 4자리). */
const SHOWN_PRICES = [
  { id: "달러 $37.9743 → $37.97 (9-8 기본 적립 평단가)", value: 37.9743, cur: "USD", want: 37.97 },
  { id: "달러 1보다 작으면 소수 4자리 ($0.12345)", value: 0.12345, cur: "USD", want: 0.1235 },
  { id: "원화는 원 단위 (76,241.62원)", value: 76_241.62, cur: "KRW", want: 76_242 },
  {
    id: "원화 76,241.1205원 (v2.switch_cross_exchange)",
    value: 76_241.1205,
    cur: "KRW",
    want: 76_241,
  },
  {
    id: "그 밖의 통화는 달러와 같은 자리 (1,234.567 JPY)",
    value: 1_234.567,
    cur: "JPY",
    want: 1_234.57,
  },
];

for (const { id, value, cur, want } of SHOWN_PRICES) {
  test(`shownPrice: ${id}`, () => {
    assert.equal(shownPrice(value, cur), want);
  });
}

test("shownPrice: 값이 없으면 null", () => {
  assert.equal(shownPrice(null, "USD"), null);
  assert.equal(shownPrice(undefined, "KRW"), null);
});

test("shownPrice: 그 값을 price로 쓰면 원래 값의 price 글과 같다", () => {
  for (const { value, cur } of SHOWN_PRICES) {
    assert.equal(price(shownPrice(value, cur), cur), price(value, cur), `${value} ${cur}`);
  }
});

test("shownPrice: price 글이 같은 두 값만 같은 값이다", () => {
  const pairs = [
    [36.0893, 36.0912, "USD"], // 둘 다 $36.09 (전략 카드 같은 값 굵게)
    [36.0893, 36.9473, "USD"], // $36.09, $36.95
    [0.12345, 0.12349, "USD"], // 둘 다 $0.1235
    [76_241.1205, 76_241.4, "KRW"], // 둘 다 76,241원
    [76_241.1205, 76_241.62, "KRW"], // 76,241원, 76,242원
  ];
  for (const [a, b, cur] of pairs) {
    const sameText = price(a, cur) === price(b, cur);
    assert.equal(
      shownPrice(a, cur) === shownPrice(b, cur),
      sameText,
      `${price(a, cur)} / ${price(b, cur)}`,
    );
  }
});

test("qty: 소수 2자리까지, 정수는 정수로", () => {
  assert.equal(qty(211.47), "211.47");
  assert.equal(qty(60), "60");
  assert.equal(qty(2336.3123), "2,336.31");
  assert.equal(qty(39.9531, 4), "39.9531");
  assert.equal(qty(13.1, 4, { fixed: true }), "13.1000");
  assert.equal(qty(13.1, 4), "13.1");
});

test("fx: 1 이상은 소수 2자리, 작으면 유효숫자 4자리", () => {
  assert.equal(fx(1341.68), "1,341.68");
  assert.equal(fx(0.000745), "0.000745");
  assert.equal(fx(null), "—");
});

test("period: 년·개월·일로 줄인다", () => {
  assert.equal(period("2021-11-25", "2026-11-24"), "5년");
  assert.equal(period("2023-05-25", "2026-11-24"), "3년 6개월");
  assert.equal(period("2026-03-25", "2026-11-24"), "8개월");
  assert.equal(period("2026-11-01", "2026-11-24"), "23일");
});

// ---------- 금액 미리보기 (F-04, 이슈 #50) ----------
// 금액 미리보기 시험의 기본 조건 (app.js cond()와 같은 모양)
const BASE = {
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
};

// app.js renderPreview의 글을 DOM 없이 만든다. 기댓값은 지금 화면에 나오는 글 그대로다.

/** 이슈 #50 완료 기준의 조건: 2021-11-25 ~ 2026-11-24 매월 1일 (어림 60회). */
const PREVIEW = { ...BASE, start: "2021-11-25", end: "2026-11-24", freq: "monthly", monthDay: 1 };

const PREVIEW_CASES = [
  {
    id: "200만원·원화·4종목은 종목당 금액 뒤에 합계",
    cond: { ...PREVIEW, codes: ["QQQ", "QLD", "SPY", "TQQQ"] },
    want: "약 60회 · 종목당 1억 2,000만원 · 4종목 합계 4억 8,000만원",
  },
  {
    id: "200만원·원화·1종목은 합계를 붙이지 않는다",
    cond: { ...PREVIEW, codes: ["QLD"] },
    want: "약 60회 · 종목당 1억 2,000만원",
  },
  {
    id: "1,500달러·달러·2종목은 달러로 쓴다",
    cond: { ...PREVIEW, codes: ["QQQ", "QLD"], amount: 1500, currency: "USD" },
    want: "약 60회 · 종목당 $90,000 · 2종목 합계 $180,000",
  },
  {
    id: "횟수가 천 번을 넘으면 천 단위 쉼표 (매일 5년)",
    cond: { ...PREVIEW, codes: ["QLD"], freq: "daily", amount: 10_000 },
    want: "약 1,260회 · 종목당 1,260만원",
  },
];

for (const { id, cond, want } of PREVIEW_CASES) {
  test(`amountPreview: ${id}`, () => {
    assert.equal(amountPreview(cond), want);
  });
}

test("amountPreview: 시작일이 전체면 횟수 대신 상장일 안내 (종목 수·통화와 상관없이)", () => {
  const want = "상장일부터 끝날짜까지 · 매수 횟수는 종목마다 다릅니다";
  for (const extra of [{}, { codes: ["QLD"] }, { amount: 1500, currency: "USD" }]) {
    assert.equal(amountPreview({ ...PREVIEW, ...extra, start: ALL_START }), want);
  }
});

const PREVIEW_EMPTY = [
  { id: "금액이 0", cond: { ...PREVIEW, amount: 0 } },
  { id: "금액이 음수", cond: { ...PREVIEW, amount: -1 } },
  { id: "금액이 숫자가 아님 (빈 칸)", cond: { ...PREVIEW, amount: Number.NaN } },
  { id: "시작일이 끝날짜와 같음", cond: { ...PREVIEW, start: "2026-11-24" } },
  { id: "시작일이 끝날짜 뒤", cond: { ...PREVIEW, start: "2026-11-25" } },
  { id: "시작일이 빔", cond: { ...PREVIEW, start: "" } },
  { id: "끝날짜가 빔", cond: { ...PREVIEW, end: "" } },
  { id: "시작일이 전체여도 금액이 0", cond: { ...PREVIEW, start: ALL_START, amount: 0 } },
];

for (const { id, cond } of PREVIEW_EMPTY) {
  test(`amountPreview: ${id} → 빈 글`, () => {
    assert.equal(amountPreview(cond), "");
  });
}

// ---------- 짧은 날짜 (F-14 분석 탭 표, #60) ----------

const SHORT_DATES = [
  { id: "최저 수익률 날 (시안 QQQ)", iso: "2022-12-28", date: "22-12-28", month: "22-12" },
  {
    id: "가장 길게 원금 아래 칸의 달 (이슈 #60 예)",
    iso: "2022-09-19",
    date: "22-09-19",
    month: "22-09",
  },
  { id: "최대 낙폭 날 (QLD)", iso: "2026-11-20", date: "26-11-20", month: "26-11" },
  { id: "2000년대 첫해도 두 자리", iso: "2005-01-03", date: "05-01-03", month: "05-01" },
];

for (const { id, iso, date, month } of SHORT_DATES) {
  test(`shortDate·shortMonth: ${id} ${iso} → ${date}, ${month}`, () => {
    assert.equal(shortDate(iso), date);
    assert.equal(shortMonth(iso), month);
  });
}
