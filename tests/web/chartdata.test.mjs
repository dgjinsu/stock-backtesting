// web/chartdata.js 그래프 데이터·매수 내역·CSV (F-07, F-08, F-13). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUY_COLUMNS,
  DASHES,
  RANGES,
  REST_LABEL,
  boughtFractional,
  buysCsv,
  csvFileName,
  dashOf,
  dateTick,
  investedLines,
  isRest,
  lastValue,
  logFirst,
  logFirstNote,
  logSafe,
  previewRows,
  rangeFrom,
  rangeStart,
  restCount,
  restNote,
  sampledNote,
  sparkline,
  splitMarks,
  splitsOf,
} from "../../web/chartdata.js";

function buy(n, extra = {}) {
  return {
    date: `2026-01-${String(n).padStart(2, "0")}`,
    price: 10 + n,
    fx: 1300.5,
    qty: 1.5,
    cum_qty: 1.5 * n,
    avg_cost_asset: 10.25,
    avg_cost_invest: 13_330,
    invested: 20_000 * n,
    ...extra,
  };
}

const RESULTS = [
  { symbol: "QQQ", name: "Invesco QQQ Trust", currency: "USD", buys: [buy(1), buy(2)] },
  {
    symbol: "005930.KS",
    name: 'Samsung, "Electronics"',
    currency: "KRW",
    buys: [buy(1, { fx: 1, price: 76_325 })],
  },
];

test("DASHES: 종목 8개의 선 모양, 첫째는 실선", () => {
  assert.equal(DASHES.length, 8);
  assert.equal(DASHES[0], "");
});

test("dateTick: 1년 안쪽이면 날짜 전부, 길면 연-월", () => {
  assert.equal(dateTick(["2026-03-02", "2026-11-24"])("2026-05-04"), "2026-05-04");
  assert.equal(dateTick(["2021-11-26", "2026-11-24"])("2024-05-17"), "2024-05");
  assert.equal(dateTick([])("2024-05-17"), "2024-05-17");
});

test("dashOf: 시안의 선 모양 문자열을 Chart.js borderDash로", () => {
  assert.deepEqual(dashOf(0), []);
  assert.deepEqual(dashOf(1), [7, 4]);
  assert.deepEqual(dashOf(3), [10, 3, 2, 3]);
});

test("lastValue: 마지막 null 아닌 값", () => {
  assert.equal(lastValue([null, 1, 2, null]), 2);
  assert.equal(lastValue([null, null]), null);
  assert.equal(lastValue([]), null);
});

test("logSafe: 로그 축에 못 그리는 0 이하 값을 비운다", () => {
  assert.deepEqual(logSafe([null, 0, -5, 3, 1_000_000]), [null, null, null, 3, 1_000_000]);
});

test("investedLines: 종목들의 투자금이 같으면 회색 선 하나", () => {
  const chart = {
    dates: ["2026-01-02", "2026-01-03"],
    series: { QQQ: { invested: [100, 200] }, QLD: { invested: [100, 200] } },
  };
  assert.deepEqual(investedLines(chart, ["QQQ", "QLD"]), [{ symbol: null, values: [100, 200] }]);
});

test("investedLines: 상장일이 달라 투자금이 다르면 종목마다", () => {
  const chart = {
    dates: ["2026-01-02", "2026-01-03"],
    series: { QQQ: { invested: [100, 200] }, QQQM: { invested: [null, 100] } },
  };
  assert.deepEqual(investedLines(chart, ["QQQ", "QQQM"]), [
    { symbol: "QQQ", values: [100, 200] },
    { symbol: "QQQM", values: [null, 100] },
  ]);
});

test("previewRows: 9회 이상이면 앞 6회와 마지막 2회, 가운데 숨긴 수", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i + 1);
  const view = previewRows(rows);
  assert.deepEqual(
    view.head.map((r) => r.no),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    view.tail.map((r) => r.no),
    [59, 60],
  );
  assert.equal(view.hidden, 52);
  assert.equal(view.head[0].row, 1);
});

test("previewRows: 8회 이하는 모두 보인다", () => {
  const view = previewRows([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(view.head.length, 8);
  assert.deepEqual(view.tail, []);
  assert.equal(view.hidden, 0);
});

test("buysCsv: UTF-8로 바꾸면 BOM(EF BB BF)으로 시작한다", () => {
  const bytes = new TextEncoder().encode(buysCsv(RESULTS, "KRW"));
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("buysCsv: 모든 종목의 매수를 한 줄씩, 종목 통화를 같이", () => {
  const lines = buysCsv(RESULTS, "KRW").slice(1).trimEnd().split("\r\n");
  assert.equal(lines.length, 1 + 3);
  assert.equal(
    lines[0],
    "종목,통화,회차,날짜,종가,환율,산 수량,누적 수량,누적 평단가,원화 평단가,누적 투자금(KRW)",
  );
  assert.equal(BUY_COLUMNS.length, 8);
  assert.equal(lines[1], "QQQ,USD,1,2026-01-01,11,1300.5,1.5,1.5,10.25,13330,20000");
  assert.equal(lines[3], "005930.KS,KRW,1,2026-01-01,76325,1,1.5,1.5,10.25,13330,20000");
});

test("buysCsv: 투자 통화에 맞춘 열 이름", () => {
  const head = buysCsv(RESULTS, "USD").slice(1).split("\r\n")[0];
  assert.ok(head.includes("달러 평단가"));
  assert.ok(head.includes("누적 투자금(USD)"));
});

test("buysCsv: 쉼표·따옴표·줄바꿈이 든 값은 따옴표로 감싼다", () => {
  const tricky = [{ symbol: 'A,"B"', currency: "USD", buys: [buy(1, { date: "2026\n01" })] }];
  const line = buysCsv(tricky, "KRW").slice(1).split("\r\n").slice(1).join("\r\n");
  assert.ok(line.startsWith('"A,""B""",USD,1,"2026\n01",'));
});

test("buysCsv: 값이 없으면 빈 칸", () => {
  const rows = [{ symbol: "X", currency: "USD", buys: [buy(1, { avg_cost_asset: null })] }];
  const line = buysCsv(rows, "KRW").slice(1).split("\r\n")[1];
  assert.equal(line.split(",")[8], "");
});

// ---------- 쉰 매수일 (F-17, #41 댓글: 레버리지 전환에서 qty 0인 줄) ----------

/** 레버리지 전환 결과처럼 60회 중 15회는 사지 않은 매수 내역 (9-8: 쉰 매수일 15번). */
const SWITCH_BUYS = Array.from({ length: 60 }, (_, i) => buy(1, { qty: i % 4 === 1 ? 0 : 1.25 }));
const RULE_PARAMS = { fractional: true, rule: "switch", ma_days: 200, switch_ref: "QQQ" };

test("REST_LABEL·isRest: 산 수량이 0인 회차는 '쉼'", () => {
  assert.equal(REST_LABEL, "쉼");
  assert.equal(isRest(buy(1, { qty: 0 })), true);
  assert.equal(isRest(buy(1, { qty: 0.0001 })), false);
  assert.equal(isRest(buy(1)), false);
});

test("restCount: 쉰 회차 수", () => {
  assert.equal(restCount(SWITCH_BUYS), 15);
  assert.equal(restCount([buy(1), buy(2)]), 0);
  assert.equal(restCount([]), 0);
});

test("restNote: 레버리지 전환은 기준 종목이 이평선 아래라 현금으로 모은 날", () => {
  assert.equal(
    restNote(RULE_PARAMS, SWITCH_BUYS),
    "쉼: 기준 종목 QQQ가 200일선 아래라 사지 않고 현금으로 모은 매수일 · 60회 중 15회",
  );
});

test("restNote: 정수 주만 살 때 한 주 값이 모자라 못 산 날도 쉼으로 알린다", () => {
  const buys = [buy(1), buy(2, { qty: 0 }), buy(3)];
  assert.equal(
    restNote({ fractional: false, rule: "none" }, buys),
    "쉼: 모은 돈이 한 주 값보다 적어 사지 않고 다음 매수에 보탠 매수일 · 3회 중 1회",
  );
});

test("restNote: 쉰 회차가 없으면 null", () => {
  assert.equal(restNote(RULE_PARAMS, [buy(1), buy(2)]), null);
  assert.equal(restNote({ fractional: true }, [buy(1)]), null);
});

test("boughtFractional: 매수 규칙은 정수 주만을 골라도 소수점으로 샀다 (9-6)", () => {
  assert.equal(boughtFractional({ fractional: true, rule: "none" }), true);
  assert.equal(boughtFractional({ fractional: false, rule: "none" }), false);
  assert.equal(boughtFractional({ fractional: false, rule: "ma_dip" }), true);
  assert.equal(boughtFractional({ fractional: false }), false); // rule이 없는 v1 응답
});

test("csvFileName: 종목과 기간을 넣는다", () => {
  const params = { symbols: ["QQQ", "QLD"], start: "2021-11-25", end: "2026-11-24" };
  assert.equal(csvFileName(params), "적립식_QQQ-QLD_2021-11-25_2026-11-24.csv");
});

test("sampledNote: 줄였으면 안내 문장, 아니면 null", () => {
  assert.equal(
    sampledNote({ dates: new Array(1000), total_days: 2512 }),
    "기간이 길어 그래프는 2,512일 중 1,000점만 골라 그렸습니다. 첫날·마지막 날·최고·최저 수익률 날은 빠지지 않았고, 계산은 모든 날로 했습니다.",
  );
  assert.equal(sampledNote({ dates: new Array(10), total_days: 10 }), null);
});

// ---------- 그래프 더하기 (F-13) ----------

test("RANGES: 최근 1년, 3년, 전체 순서이고 전체는 years가 null", () => {
  assert.deepEqual(
    RANGES.map((r) => [r.label, r.years]),
    [
      ["최근 1년", 1],
      ["3년", 3],
      ["전체", null],
    ],
  );
});

const LONG = [
  "2021-12-01",
  "2023-11-22",
  "2023-11-23",
  "2023-11-24",
  "2025-11-21",
  "2025-11-24",
  "2026-06-22",
  "2026-11-23",
];

test("rangeStart: 마지막 날짜의 1년 전 날 이후 첫 위치", () => {
  // 2026-11-23의 1년 전은 2025-11-23(일), 그 뒤 첫 날짜는 2025-11-24
  assert.equal(rangeStart(LONG, 1), 5);
});

test("rangeStart: 3년 전 날 그날이 날짜축에 있으면 그날부터", () => {
  assert.equal(rangeStart(LONG, 3), 2);
});

test("rangeStart: 전체(null)이거나 기간이 N년보다 짧으면 0", () => {
  assert.equal(rangeStart(LONG, null), 0);
  assert.equal(rangeStart(["2026-03-02", "2026-06-01", "2026-11-23"], 1), 0);
  assert.equal(rangeStart(["2024-01-02", "2026-11-23"], 3), 0);
  assert.equal(rangeStart([], 1), 0);
});

test("rangeStart: 2월 29일의 1년 전은 2월 28일로 본다", () => {
  assert.equal(rangeStart(["2027-02-26", "2027-02-28", "2027-03-01", "2028-02-29"], 1), 1);
});

test("rangeFrom: 보는 기간 시작 날짜는 마지막 날짜의 N년 전 날 (날짜축에 없어도)", () => {
  assert.equal(rangeFrom(LONG, 1), "2025-11-23");
  assert.equal(rangeFrom(LONG, 3), "2023-11-23");
  assert.equal(rangeFrom(["2027-02-26", "2028-02-29"], 1), "2027-02-28");
});

test("rangeFrom: 전체(null)이거나 기간이 N년보다 짧으면 첫 날짜, 날짜가 없으면 null", () => {
  assert.equal(rangeFrom(LONG, null), "2021-12-01");
  assert.equal(rangeFrom(["2026-03-02", "2026-11-23"], 1), "2026-03-02");
  assert.equal(rangeFrom([], 1), null);
});

test("logFirst: 가장 큰 최고 평가금이 가장 작은 것의 5배를 넘으면 그 종목", () => {
  const peaks = [
    { symbol: "QQQ", value: 228_690_000 },
    { symbol: "QLD", value: 342_707_723 },
    { symbol: "SOXL", value: 1_577_680_000 },
  ];
  assert.deepEqual(logFirst(peaks), { symbol: "SOXL", value: 1_577_680_000 });
});

test("logFirst: 정확히 5배면 null, 조금이라도 넘으면 종목", () => {
  const at = (value) => [
    { symbol: "A", value: 100 },
    { symbol: "B", value },
  ];
  assert.equal(logFirst(at(500)), null);
  assert.equal(logFirst(at(500.01))?.symbol, "B");
});

test("logFirst: 종목이 1개면 null", () => {
  assert.equal(logFirst([{ symbol: "SOXL", value: 1_577_680_000 }]), null);
  assert.equal(logFirst([]), null);
});

test("logFirst: 값이 null인 종목은 건너뛴다", () => {
  const peaks = [
    { symbol: "X", value: null },
    { symbol: "QQQ", value: 100 },
    { symbol: "SOXL", value: 600 },
  ];
  assert.equal(logFirst(peaks)?.symbol, "SOXL");
  assert.equal(logFirst([peaks[0], peaks[2]]), null);
});

test("logFirst: 최고 평가금이 0이거나 음수인 종목도 null처럼 건너뛴다", () => {
  const zero = { symbol: "Z", value: 0 };
  const negative = { symbol: "N", value: -50 };
  // 0 이하를 빼면 600 / 100 = 6배라 걸린다
  const over = [zero, negative, { symbol: "QQQ", value: 100 }, { symbol: "SOXL", value: 600 }];
  assert.deepEqual(logFirst(over), { symbol: "SOXL", value: 600 });
  // 0을 가장 작은 값으로 쓰면 무엇이든 5배를 넘지만, 빼고 보면 400 / 100 = 4배라 걸리지 않는다
  const under = [zero, negative, { symbol: "QQQ", value: 100 }, { symbol: "QLD", value: 400 }];
  assert.equal(logFirst(under), null);
  // 0 이하를 빼고 종목이 하나만 남으면 null
  assert.equal(logFirst([zero, negative, { symbol: "SOXL", value: 600 }]), null);
});

test("logFirstNote: 이유 한 줄에 종목과 최고 평가금을 적는다 (시안 v2)", () => {
  assert.equal(
    logFirstNote({ symbol: "SOXL", value: 1_577_680_000 }, "KRW"),
    "로그 축: 같은 간격이 같은 배수입니다. SOXL 평가금(최고 15억 7,768만원)이 다른 종목보다 훨씬 커서 로그 축으로 먼저 보여 줍니다.",
  );
  assert.ok(
    logFirstNote({ symbol: "SOXL", value: 1_200_000 }, "USD").includes("(최고 $1,200,000)"),
  );
});

test("splitsOf: notes에서 분할 날짜와 비율을 읽고 다른 글은 건너뛴다", () => {
  const notes = ["2025-11-20 2:1 분할 반영", "다른 안내", "2022-01-13 1:10 분할 반영"];
  assert.deepEqual(splitsOf(notes), [
    { date: "2025-11-20", ratio: "2:1" },
    { date: "2022-01-13", ratio: "1:10" },
  ]);
  assert.deepEqual(splitsOf([]), []);
  assert.deepEqual(splitsOf(undefined), []);
});

test("splitMarks: 날짜축에 그날이 있으면 그 위치에 '2:1 분할'", () => {
  const dates = ["2021-12-01", "2022-01-12", "2022-01-13", "2022-01-14", "2026-11-23"];
  assert.deepEqual(splitMarks(["2022-01-13 2:1 분할 반영"], dates), [
    { index: 2, date: "2022-01-13", ratio: "2:1", label: "2:1 분할" },
  ]);
});

test("splitMarks: 줄인 날짜축에서 그날이 없으면 그 뒤 첫 날짜에 그린다", () => {
  const dates = ["2021-12-01", "2025-11-18", "2025-11-24", "2026-11-23"];
  const marks = splitMarks(["2025-11-20 2:1 분할 반영"], dates);
  assert.deepEqual(
    marks.map((m) => [m.date, m.index]),
    [["2025-11-20", 2]],
  );
});

test("splitMarks: 끝날짜 뒤와 보는 기간 앞의 분할은 빠진다", () => {
  const dates = ["2025-11-24", "2026-06-22", "2026-11-23"];
  const notes = [
    "2022-01-13 2:1 분할 반영",
    "2026-06-22 3:1 분할 반영",
    "2026-12-01 2:1 분할 반영",
  ];
  assert.deepEqual(
    splitMarks(notes, dates).map((m) => [m.date, m.index]),
    [["2026-06-22", 1]],
  );
  assert.deepEqual(splitMarks(notes, []), []);
});

test("splitMarks: 줄인 축의 최근 1년에서 첫 점보다 앞이어도 보는 기간 안이면 첫 점에 그린다", () => {
  // 리뷰 재현 사례: 1년 전 날은 2025-11-23, 잘린 축의 첫 점은 2025-11-26
  const dates = ["2021-12-01", "2025-11-19", "2025-11-26", "2026-06-22", "2026-11-23"];
  const labels = dates.slice(rangeStart(dates, 1));
  const from = rangeFrom(dates, 1);
  assert.deepEqual(labels, ["2025-11-26", "2026-06-22", "2026-11-23"]);
  assert.deepEqual(splitMarks(["2025-11-24 2:1 분할 반영"], labels, from), [
    { index: 0, date: "2025-11-24", ratio: "2:1", label: "2:1 분할" },
  ]);
  // 보는 기간(1년 전 날) 앞의 분할은 여전히 빠진다
  assert.deepEqual(splitMarks(["2025-11-20 2:1 분할 반영"], labels, from), []);
});

// ---------- 카드의 작은 수익률 그래프 (F-12) ----------

const BOX = { width: 40, height: 22, pad: 1 };

test("sparkline: x는 날짜축 위치, y는 값이 클수록 위. 0%가 범위에 들어간다", () => {
  // 값 0~20: y = 1 + (20 − v) / 20 × 20. x = 위치 × 40 / 4
  assert.deepEqual(sparkline([0, 5, 10, 15, 20], BOX), {
    path: "M0 21L10 16L20 11L30 6L40 1",
    area: "M0 22L0 21L10 16L20 11L30 6L40 1L40 22Z",
    zeroY: 21,
    last: 20,
    min: 0,
    max: 20,
  });
});

test("sparkline: null은 건너뛰고, 빈 자리 뒤에서 선을 새로 시작한다", () => {
  const line = sparkline([null, 0, 10, null, 20], BOX);
  assert.equal(line.path, "M10 21L20 11M40 1");
  assert.equal(line.last, 20);
});

test("sparkline: 첫 매수 전 null은 그리지 않고 x 자리는 날짜축 그대로", () => {
  assert.equal(sparkline([null, null, 10, 20, 20], BOX).path, "M20 11L30 1L40 1");
});

test("sparkline: 손실과 이익이 섞이면 0% 선이 가운데쯤", () => {
  const line = sparkline([-10, 10], BOX);
  assert.equal(line.path, "M0 21L40 1");
  assert.equal(line.zeroY, 11);
  assert.deepEqual([line.min, line.max], [-10, 10]);
});

test("sparkline: 모두 0보다 크면 0% 선은 맨 아래, 모두 작으면 맨 위", () => {
  assert.equal(sparkline([10, 20], BOX).zeroY, 21);
  assert.equal(sparkline([-10, -20], BOX).zeroY, 1);
});

test("sparkline: 값이 모두 같으면(모두 0) 가운데 가로선", () => {
  const line = sparkline([0, 0, 0], BOX);
  assert.equal(line.path, "M0 11L20 11L40 11");
  assert.equal(line.zeroY, 11);
});

test("sparkline: 날짜가 하나면 가운데에 둔다", () => {
  assert.equal(sparkline([5], BOX).path, "M20 1");
  assert.equal(sparkline([null, 5], BOX).path, "M40 1"); // 날짜가 둘이면 그 자리
});

test("sparkline: 좌표는 소수 1자리로 줄인다", () => {
  const line = sparkline([0, 1, 3], { width: 10, height: 10, pad: 0 });
  // y(1) = (3 − 1) / 3 × 10 = 6.666… → 6.7
  assert.equal(line.path, "M0 10L5 6.7L10 0");
});

test("sparkline: 그릴 값이 없으면 null", () => {
  assert.equal(sparkline([], BOX), null);
  assert.equal(sparkline([null, null], BOX), null);
  assert.equal(sparkline(undefined, BOX), null);
});

test("sparkline: 기본 상자는 300×48 (카드 SVG viewBox)", () => {
  const line = sparkline([0, 100]);
  assert.equal(line.path, "M0 46L300 2");
  assert.equal(line.zeroY, 46);
});

// ---------- 작은 수익률 그래프의 선 아래 면 (#52) ----------

/** path를 선 조각(M으로 시작하는 연속 구간)마다 점 좌표 글자로: "M0 1L2 3M5 6" → [["0 1", "2 3"], ["5 6"]]. */
function runsOf(path) {
  return path
    .split("M")
    .slice(1)
    .map((run) => run.split("L"));
}

/** area를 닫힌 조각마다 점 좌표 글자로. 조각은 모두 M으로 시작해 Z로 닫혀야 한다. */
function piecesOf(area) {
  assert.match(area, /^(M[^MZ]+Z)+$/);
  return area
    .slice(0, -1)
    .split("Z")
    .map((piece) => piece.slice(1).split("L"));
}

/**
 * area가 선 조각마다 `M{첫 x} {bottom}`에서 올라가 선의 점(path와 같은 좌표 글자)을 같은 순서로
 * 지나고 `L{끝 x} {bottom}Z`로 바닥까지 내려와 닫히는지 본다.
 */
function assertAreaUnder(line, bottom) {
  const runs = runsOf(line.path);
  const pieces = piecesOf(line.area);
  const x = (point) => point.split(" ")[0];
  assert.equal(pieces.length, runs.length, line.area);
  runs.forEach((run, k) => {
    assert.deepEqual(pieces[k], [`${x(run[0])} ${bottom}`, ...run, `${x(run.at(-1))} ${bottom}`]);
  });
}

test("sparkline: area는 첫 점 x의 바닥에서 올라가 선을 지나 끝 점 x의 바닥으로 내려와 닫힌다", () => {
  // x = 위치 × 40 / 3, y = 1 + (10 − v) / 15 × 20. 바닥은 height 22
  const line = sparkline([null, 0, 10, -5], BOX);
  assert.equal(line.path, "M13.3 14.3L26.7 1L40 21");
  assert.equal(line.area, "M13.3 22L13.3 14.3L26.7 1L40 21L40 22Z");
  assertAreaUnder(line, 22);
});

test("sparkline: 빈 자리로 나뉜 선은 area도 조각마다 따로 바닥까지 닫힌다", () => {
  const line = sparkline([0, 5, null, 3, 4], BOX);
  assert.equal(line.path, "M0 21L10 1M30 9L40 5");
  assertAreaUnder(line, 22);
  assert.equal(line.area.match(/M/g).length, 2);
  assert.equal(line.area.match(/Z/g).length, 2);
});

test("sparkline: area 바닥은 height다. 기본 48, 카드 그래프 높이 54", () => {
  const values = [null, 0, 10, -5];
  assertAreaUnder(sparkline(values), 48);
  assertAreaUnder(sparkline(values, { height: 54 }), 54);
});
