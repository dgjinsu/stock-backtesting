// web/conditions.js 조건 다루기 (F-02, F-04, F-09, F-10). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SYMBOLS,
  anchorOf,
  estimateBuys,
  isDate,
  readQuery,
  shiftYears,
  toQuery,
  todayKst,
  validate,
} from "../../web/conditions.js";

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
const TODAY = "2026-11-24";

test("todayKst: 한국 시각 자정에 날짜가 바뀐다", () => {
  assert.equal(todayKst(Date.UTC(2026, 10, 23, 14, 59)), "2026-11-23");
  assert.equal(todayKst(Date.UTC(2026, 10, 23, 15, 0)), "2026-11-24");
});

test("shiftYears: N년 전의 다음 날", () => {
  assert.equal(shiftYears("2026-11-24", 5), "2021-11-25");
  assert.equal(shiftYears("2026-12-31", 1), "2026-01-01");
});

test("shiftYears: 날짜가 비었거나 잘못되면 null", () => {
  assert.equal(shiftYears("", 5), null);
  assert.equal(shiftYears("2026-13-01", 1), null);
  assert.equal(shiftYears("2026-02-31", 1), null);
  assert.equal(shiftYears(undefined, 1), null);
});

test("shiftYears: 2월 29일은 평년의 2월 28일로 본다", () => {
  assert.equal(shiftYears("2024-02-29", 1), "2023-03-01");
  assert.equal(shiftYears("2024-02-29", 4), "2020-03-01");
});

test("anchorOf: 주기마다 API의 anchor 값", () => {
  assert.equal(anchorOf({ ...BASE, freq: "monthly", monthDay: 31 }), 31);
  assert.equal(anchorOf({ ...BASE, freq: "weekly", weekDay: 0 }), 0);
  assert.equal(anchorOf({ ...BASE, freq: "daily" }), null);
});

test("toQuery: 예시 조건의 주소", () => {
  assert.equal(
    toQuery(BASE),
    "s=QQQ,QLD&from=2021-11-25&to=2026-11-24&freq=monthly&day=1&amt=2000000&cur=KRW",
  );
});

test("toQuery: 매일은 day를 빼고, 정수 주와 수수료는 있을 때만 넣는다", () => {
  const query = new URLSearchParams(
    toQuery({ ...BASE, freq: "daily", fractional: false, fee: 0.25 }),
  );
  assert.equal(query.get("day"), null);
  assert.equal(query.get("frac"), "0");
  assert.equal(query.get("fee"), "0.25");
});

test("readQuery: toQuery로 만든 주소를 그대로 되읽는다", () => {
  const cond = {
    ...BASE,
    freq: "weekly",
    weekDay: 0,
    currency: "USD",
    amount: 1500,
    fractional: false,
    fee: 0.1,
  };
  const found = readQuery(`?${toQuery(cond)}`);
  assert.deepEqual(found, {
    codes: ["QQQ", "QLD"],
    start: "2021-11-25",
    end: "2026-11-24",
    freq: "weekly",
    weekDay: 0,
    amount: 1500,
    currency: "USD",
    fractional: false,
    fee: 0.1,
  });
});

test("readQuery: 쉼표가 %2C로 바뀐 옛 주소도 읽는다", () => {
  assert.deepEqual(readQuery("?s=QQQ%2CQLD").codes, ["QQQ", "QLD"]);
});

test("toQuery: 특수 문자가 든 종목 코드는 인코딩한다", () => {
  assert.equal(
    new URLSearchParams(toQuery({ ...BASE, codes: ["^GSPC", "BRK-B"] })).get("s"),
    "^GSPC,BRK-B",
  );
});

test("readQuery: 잘못된 값은 버린다", () => {
  const found = readQuery(
    "?s=qqq,../etc,QQQ,SPY&from=2021-1-1&to=x&freq=yearly&day=40&amt=-5&cur=JPY&fee=20",
  );
  assert.deepEqual(found, { codes: ["QQQ", "SPY"] });
});

test("isDate: 달력에 있는 날짜만", () => {
  assert.equal(isDate("2024-02-29"), true);
  assert.equal(isDate("2026-02-29"), false);
  assert.equal(isDate("2020-13-45"), false);
  assert.equal(isDate("2026-1-1"), false);
  assert.equal(isDate(null), false);
});

test("readQuery: 달력에 없는 날짜는 버린다", () => {
  assert.deepEqual(readQuery("?s=QQQ&from=2026-02-31&to=2020-13-45"), { codes: ["QQQ"] });
});

test("readQuery: 범위를 벗어난 요일·날짜는 버린다", () => {
  assert.equal(readQuery("?freq=weekly&day=5").weekDay, undefined);
  assert.equal(readQuery("?freq=monthly&day=0").monthDay, undefined);
  assert.equal(readQuery("?freq=monthly").monthDay, undefined);
});

test("readQuery: 종목은 8개까지", () => {
  const codes = Array.from({ length: 10 }, (_, i) => `S${i}`);
  assert.equal(readQuery(`?s=${codes.join(",")}`).codes.length, MAX_SYMBOLS);
});

test("validate: 올바른 조건은 오류가 없다", () => {
  assert.deepEqual(validate(BASE, TODAY), {});
});

test("validate: 항목마다 한국어 메시지", () => {
  assert.deepEqual(validate({ ...BASE, codes: [] }, TODAY), {
    symbols: "종목을 하나 이상 넣어 주세요",
  });
  assert.deepEqual(validate({ ...BASE, start: "2026-11-24" }, TODAY), {
    start: "시작일은 끝날짜보다 앞이어야 합니다",
  });
  assert.deepEqual(validate({ ...BASE, end: "2026-11-25" }, TODAY), {
    end: "끝날짜는 오늘(2026-11-24)보다 늦을 수 없습니다",
  });
  assert.deepEqual(validate({ ...BASE, amount: 0 }, TODAY), { amount: "금액은 0보다 커야 합니다" });
  assert.deepEqual(validate({ ...BASE, fee: 11 }, TODAY), { fee: "수수료는 0~10%입니다" });
  assert.deepEqual(validate({ ...BASE, fee: Number.NaN }, TODAY), { fee: "수수료는 0~10%입니다" });
});

test("validate: 날짜가 비면 그 칸에 알린다", () => {
  assert.deepEqual(validate({ ...BASE, start: "", end: "" }, TODAY), {
    start: "시작일을 넣어 주세요",
    end: "끝날짜를 넣어 주세요",
  });
});

test("estimateBuys: 예시 조건(5년 매월 1일)은 60회", () => {
  assert.equal(estimateBuys(BASE), 60);
});

test("estimateBuys: 매월 31일은 짧은 달에 말일로 센다", () => {
  assert.equal(estimateBuys({ ...BASE, start: "2026-01-01", end: "2026-06-30", monthDay: 31 }), 6);
});

test("estimateBuys: 매주와 매일은 어림값", () => {
  assert.equal(
    estimateBuys({ ...BASE, freq: "weekly", start: "2025-11-25", end: "2026-11-24" }),
    52,
  );
  assert.equal(
    estimateBuys({ ...BASE, freq: "daily", start: "2025-11-24", end: "2026-11-24" }),
    252,
  );
});

test("estimateBuys: 기간이 없으면 0", () => {
  assert.equal(estimateBuys({ ...BASE, start: "2026-11-24", end: "2026-11-24" }), 0);
});
