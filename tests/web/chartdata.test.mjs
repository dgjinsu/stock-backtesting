// web/chartdata.js 그래프 데이터·매수 내역·CSV (F-07, F-08). node --test로 돈다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUY_COLUMNS,
  DASHES,
  buysCsv,
  csvFileName,
  dashOf,
  dateTick,
  investedLines,
  lastValue,
  logSafe,
  previewRows,
  sampledNote,
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
  { symbol: "005930.KS", name: "Samsung, \"Electronics\"", currency: "KRW", buys: [buy(1, { fx: 1, price: 76_325 })] },
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
  assert.deepEqual(view.head.map((r) => r.no), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(view.tail.map((r) => r.no), [59, 60]);
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
  assert.equal(lines[0], "종목,통화,회차,날짜,종가,환율,산 수량,누적 수량,누적 평단가,원화 평단가,누적 투자금(KRW)");
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
