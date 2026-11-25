// web/conditions.js 조건 다루기 (F-02, F-04, F-09, F-10). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TAB,
  MAX_SYMBOLS,
  RESULT_TABS,
  anchorOf,
  estimateBuys,
  isDate,
  nextTab,
  panelFold,
  readQuery,
  shiftYears,
  symbolStatus,
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

// ---------- 결과 탭 (F-11) ----------

const V1_QUERY =
  "s=QQQ,QLD&from=2021-11-25&to=2026-11-24&freq=monthly&day=1&amt=2000000&cur=KRW";

test("RESULT_TABS: 요약·분석·전략 비교·매수 내역 순서이고 요약이 기본", () => {
  assert.deepEqual(RESULT_TABS, ["summary", "analysis", "strategy", "buys"]);
  assert.equal(DEFAULT_TAB, "summary");
});

test("toQuery: 요약 탭은 기본값이라 tab을 넣지 않는다", () => {
  assert.equal(toQuery({ ...BASE, tab: "summary" }), V1_QUERY);
  assert.equal(new URLSearchParams(toQuery({ ...BASE, tab: "summary" })).get("tab"), null);
});

test("toQuery: 탭은 조건 뒤에 붙는다", () => {
  assert.equal(toQuery({ ...BASE, tab: "buys" }), `${V1_QUERY}&tab=buys`);
});

test("toQuery·readQuery: 분석·전략 비교·매수 내역 탭은 주소로 왕복한다", () => {
  for (const tab of ["analysis", "strategy", "buys"]) {
    const query = toQuery({ ...BASE, tab });
    assert.equal(new URLSearchParams(query).get("tab"), tab, tab);
    assert.equal(readQuery(`?${query}`).tab, tab, tab);
  }
});

test("toQuery: 모르는 탭 값은 넣지 않는다", () => {
  assert.equal(toQuery({ ...BASE, tab: "foo" }), V1_QUERY);
});

test("readQuery: 모르는 탭 값은 버린다", () => {
  for (const bad of ["foo", "", "BUYS", "Buys", "buys "]) {
    const found = readQuery(`?s=QQQ&tab=${encodeURIComponent(bad)}`);
    assert.equal("tab" in found, false, JSON.stringify(bad));
  }
});

test("readQuery: tab=summary는 요약으로 읽는다", () => {
  assert.equal(readQuery("?s=QQQ&tab=summary").tab, "summary");
});

test("readQuery: tab이 없는 v1 주소는 그대로 읽는다", () => {
  assert.deepEqual(readQuery(`?${V1_QUERY}`), {
    codes: ["QQQ", "QLD"],
    start: "2021-11-25",
    end: "2026-11-24",
    freq: "monthly",
    monthDay: 1,
    amount: 2_000_000,
    currency: "KRW",
  });
});

test("readQuery: 탭이 있어도 나머지 조건은 v1과 같게 읽는다", () => {
  const { tab, ...rest } = readQuery(`?${V1_QUERY}&tab=buys`);
  assert.equal(tab, "buys");
  assert.deepEqual(rest, readQuery(`?${V1_QUERY}`));
});

// ---------- 양도세 어림 (F-20) ----------

test("toQuery: 양도세를 켜면 tax=1, 끄면(기본) 뺀다", () => {
  assert.equal(toQuery({ ...BASE, tax: true }), `${V1_QUERY}&tax=1`);
  assert.equal(toQuery({ ...BASE, tax: false }), V1_QUERY);
  assert.equal(toQuery(BASE), V1_QUERY);
});

test("toQuery: tax는 조건이라 탭보다 앞에 둔다", () => {
  assert.equal(toQuery({ ...BASE, tax: true, tab: "buys" }), `${V1_QUERY}&tax=1&tab=buys`);
});

test("toQuery·readQuery: tax=1은 주소로 왕복한다", () => {
  const cond = { ...BASE, currency: "USD", amount: 1500, tax: true, tab: "analysis" };
  assert.deepEqual(readQuery(`?${toQuery(cond)}`), {
    codes: ["QQQ", "QLD"],
    start: "2021-11-25",
    end: "2026-11-24",
    freq: "monthly",
    monthDay: 1,
    amount: 1500,
    currency: "USD",
    tax: true,
    tab: "analysis",
  });
});

test("readQuery: tax가 1이 아니면 버린다 (꺼짐이 기본)", () => {
  for (const bad of ["0", "", "true", "2", "yes", " 1"]) {
    const found = readQuery(`?s=QQQ&tax=${encodeURIComponent(bad)}`);
    assert.equal("tax" in found, false, JSON.stringify(bad));
  }
  assert.equal("tax" in readQuery(`?${V1_QUERY}`), false);
});

test("nextTab: →는 다음 탭, 마지막에서는 처음으로", () => {
  assert.equal(nextTab("summary", "ArrowRight"), "analysis");
  assert.equal(nextTab("strategy", "ArrowRight"), "buys");
  assert.equal(nextTab("buys", "ArrowRight"), "summary");
});

test("nextTab: ←는 앞 탭, 처음에서는 마지막으로", () => {
  assert.equal(nextTab("strategy", "ArrowLeft"), "analysis");
  assert.equal(nextTab("summary", "ArrowLeft"), "buys");
});

test("nextTab: Home은 처음, End는 마지막 탭", () => {
  assert.equal(nextTab("analysis", "Home"), "summary");
  assert.equal(nextTab("analysis", "End"), "buys");
  assert.equal(nextTab("summary", "Home"), "summary");
});

test("nextTab: 다른 키나 모르는 탭이면 null", () => {
  for (const key of ["Enter", " ", "Tab", "ArrowDown", "ArrowUp"]) {
    assert.equal(nextTab("summary", key), null, key);
  }
  assert.equal(nextTab("foo", "ArrowRight"), null);
});

test("panelFold: 결과가 없으면 접힌 줄도 없고 패널은 편다", () => {
  for (const tab of RESULT_TABS) {
    assert.deepEqual(panelFold({ hasResult: false, tab, expanded: false }), {
      bar: false,
      collapsed: false,
    });
  }
});

test("panelFold: 요약 탭은 늘 패널을 편다", () => {
  for (const expanded of [false, true]) {
    assert.deepEqual(panelFold({ hasResult: true, tab: "summary", expanded }), {
      bar: false,
      collapsed: false,
    });
  }
});

test("panelFold: 요약이 아닌 탭은 접고, 조건 펼치기를 누르면 줄을 둔 채 편다", () => {
  for (const tab of ["analysis", "strategy", "buys"]) {
    assert.deepEqual(panelFold({ hasResult: true, tab, expanded: false }), {
      bar: true,
      collapsed: true,
    });
    assert.deepEqual(panelFold({ hasResult: true, tab, expanded: true }), {
      bar: true,
      collapsed: false,
    });
  }
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

const IDLE = { loading: false, sending: new Set(), bad: new Map(), stale: new Map() };

test("symbolStatus: 아무 일 없으면 기본", () => {
  assert.equal(symbolStatus("QQQ", IDLE), null);
});

test("symbolStatus: 계산 중이고 보낸 종목만 받는 중", () => {
  const busy = { ...IDLE, loading: true, sending: new Set(["QQQ"]) };
  assert.deepEqual(symbolStatus("QQQ", busy), { cls: "busy", text: "받는 중" });
  assert.equal(symbolStatus("QLD", busy), null); // 계산 중에 넣은 종목
  assert.equal(symbolStatus("QQQ", { ...busy, loading: false }), null);
});

test("symbolStatus: 다시 계산하면 앞에서 실패한 종목도 받는 중", () => {
  const state = {
    ...IDLE,
    loading: true,
    sending: new Set(["XXXX"]),
    bad: new Map([["XXXX", "'XXXX' 종목을 찾을 수 없습니다."]]),
  };
  assert.equal(symbolStatus("XXXX", state).cls, "busy");
});

test("symbolStatus: 실패 이유에 따라 찾을 수 없음 / 계산 못 함", () => {
  const bad = new Map([
    ["XXXX", "'XXXX' 종목을 찾을 수 없습니다."],
    ["QLD", "주가를 받지 못했습니다. 잠시 뒤 다시 시도해 주세요."],
  ]);
  assert.equal(symbolStatus("XXXX", { ...IDLE, bad }).text, "찾을 수 없음");
  assert.equal(symbolStatus("QLD", { ...IDLE, bad }).text, "계산 못 함");
});

test("symbolStatus: 저장본은 짧게, 전체 날짜는 title", () => {
  const stale = new Map([["QLD", "2026-11-20"]]);
  assert.deepEqual(symbolStatus("QLD", { ...IDLE, stale }), {
    cls: "stale",
    text: "저장본 11-20",
    title: "2026-11-20까지 저장된 데이터로 계산",
  });
});
