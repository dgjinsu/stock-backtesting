// web/format.js 표시 형식. node --test로 돈다 (scripts/check.py "웹 테스트").
import assert from "node:assert/strict";
import { test } from "node:test";

import { MINUS, fx, krwShort, money, pct, period, price, qty, signedMoney } from "../../web/format.js";

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
