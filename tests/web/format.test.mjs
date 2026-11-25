// web/format.js 표시 형식. node --test로 돈다 (scripts/check.py "웹 테스트").
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINUS,
  condLine,
  freqText,
  fx,
  investLabel,
  krwShort,
  money,
  pct,
  period,
  price,
  qty,
  rate,
  signedMoney,
  times,
} from "../../web/format.js";

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

test("price: 달러는 1보다 작으면 4자리, 원은 정수", () => {
  assert.equal(price(37.97, "USD"), "$37.97");
  assert.equal(price(0.5, "USD"), "$0.5000");
  assert.equal(price(76_325, "KRW"), "76,325원");
  assert.equal(price(null, "USD"), "—");
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
