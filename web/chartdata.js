// 그래프 데이터, 매수 내역 미리보기, CSV를 만드는 순수 함수 (F-07, F-08, F-13). DOM 없음.

import { money } from "./format.js";

/** 종목 선 모양. 색(--c1~--c8)과 함께 종목에 붙는다 (상세 설계 5절). */
export const DASHES = ["", "7 4", "2 3", "10 3 2 3", "12 4", "4 4", "1 4", "8 3 1 3"];

const HEAD_ROWS = 6;
const TAIL_ROWS = 2;
const DAY_MS = 86_400_000;
const BOM = "\uFEFF"; // 엑셀이 UTF-8로 읽게 하는 표시

/** 시안의 선 모양("7 4")을 Chart.js borderDash([7, 4])로. 0번은 실선. */
export function dashOf(slot) {
  const text = DASHES[slot] ?? "";
  return text ? text.split(" ").map(Number) : [];
}

/**
 * x축 눈금 글자. 기간이 1년 안쪽이면 날짜 전부(같은 달이 여러 번 찍히지 않게), 길면 연-월.
 * dates는 그래프 날짜축 (오름차순).
 */
export function dateTick(dates) {
  const span = dates.length ? (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / DAY_MS : 0;
  return span > 370 ? (iso) => iso.slice(0, 7) : (iso) => iso;
}

/** 마지막 null 아닌 값. 범례에 마지막 값을 적을 때 쓴다. */
export function lastValue(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null && values[i] !== undefined) return values[i];
  }
  return null;
}

/** 로그 축은 0 이하를 그리지 못하므로 비운다. */
export function logSafe(values) {
  return values.map((v) => (v !== null && v > 0 ? v : null));
}

/**
 * 평가금 그래프의 회색 투자금 계단선. 종목마다 투자금이 같으면(대부분) 선 하나,
 * 상장일이 달라 다르면 종목마다 하나씩 (symbol로 선 모양을 맞춘다).
 */
export function investedLines(chart, symbols) {
  const lines = symbols.map((symbol) => ({ symbol, values: chart.series[symbol].invested }));
  const same = lines.every((line) => line.values.every((v, i) => v === lines[0].values[i]));
  return same && lines.length ? [{ symbol: null, values: lines[0].values }] : lines;
}

/** 매수 내역 처음 화면: 앞 6회와 마지막 2회. no는 1부터 센 회차. */
export function previewRows(rows) {
  const numbered = rows.map((row, i) => ({ no: i + 1, row }));
  if (rows.length <= HEAD_ROWS + TAIL_ROWS) return { head: numbered, tail: [], hidden: 0 };
  return {
    head: numbered.slice(0, HEAD_ROWS),
    tail: numbered.slice(-TAIL_ROWS),
    hidden: rows.length - HEAD_ROWS - TAIL_ROWS,
  };
}

function investName(currency) {
  return currency === "KRW" ? "원화" : currency === "USD" ? "달러" : currency;
}

/** 매수 내역 열. 화면 표와 CSV가 같이 쓴다. key는 API buys의 필드. */
export const BUY_COLUMNS = [
  { key: "date", title: () => "날짜", csv: () => "날짜" },
  { key: "price", title: () => "종가", csv: () => "종가" },
  { key: "fx", title: () => "환율", csv: () => "환율" },
  { key: "qty", title: () => "산 수량", csv: () => "산 수량" },
  { key: "cum_qty", title: () => "누적 수량", csv: () => "누적 수량" },
  { key: "avg_cost_asset", title: () => "누적 평단가", csv: () => "누적 평단가" },
  {
    key: "avg_cost_invest",
    title: (cur) => `${investName(cur)} 평단가`,
    csv: (cur) => `${investName(cur)} 평단가`,
  },
  { key: "invested", title: () => "누적 투자금", csv: (cur) => `누적 투자금(${cur})` },
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * 모든 종목의 매수 내역 CSV. 엑셀에서 한글이 깨지지 않게 UTF-8 BOM을 붙이고 줄 끝은 CRLF.
 * 숫자는 API가 보낸 값 그대로 (반올림은 서버가 계산 규칙 자리수로 이미 했다).
 */
export function buysCsv(results, investCurrency) {
  // "통화"(종목 통화: 종가·평단가의 단위)와 "회차"는 BUY_COLUMNS에 없다 (화면은 줄 번호로 보인다)
  const head = ["종목", "통화", "회차", ...BUY_COLUMNS.map((c) => c.csv(investCurrency))];
  const lines = [head.join(",")];
  for (const result of results) {
    result.buys.forEach((row, i) => {
      const cells = [result.symbol, result.currency, i + 1, ...BUY_COLUMNS.map((c) => row[c.key])];
      lines.push(cells.map(csvCell).join(","));
    });
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** CSV 파일 이름: 적립식_QQQ-QLD_2021-11-25_2026-11-24.csv */
export function csvFileName(params) {
  return `적립식_${params.symbols.join("-")}_${params.start}_${params.end}.csv`;
}

/** 그래프 점을 줄였으면 그래프 아래에 적을 문장 (F-07). */
export function sampledNote(chart) {
  if (!(chart.total_days > chart.dates.length)) return null;
  const n = (v) => v.toLocaleString("ko-KR");
  return (
    `기간이 길어 그래프는 ${n(chart.total_days)}일 중 ${n(chart.dates.length)}점만 골라 그렸습니다. ` +
    "첫날·마지막 날·최고·최저 수익률 날은 빠지지 않았고, 계산은 모든 날로 했습니다."
  );
}

// ---------- 그래프 더하기 (F-13) ----------

/** 보는 기간. years가 null이면 전체. 계산은 그대로고 그리는 구간만 바뀐다. */
export const RANGES = [
  { key: "1y", label: "최근 1년", years: 1 },
  { key: "3y", label: "3년", years: 3 },
  { key: "all", label: "전체", years: null },
];

/** iso의 years년 전 날. 그해에 2월 29일이 없으면 2월 28일. */
function yearsBefore(iso, years) {
  const [y, m, d] = iso.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  return new Date(Date.UTC(y - years, m - 1, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/**
 * 보는 기간의 첫 위치: 마지막 날짜의 years년 전 날(그날 포함) 이후 첫 날짜.
 * 전체(null)이거나 날짜축이 years년보다 짧으면 0.
 */
export function rangeStart(dates, years) {
  if (!years || !dates.length) return 0;
  const from = yearsBefore(dates.at(-1), years);
  const i = dates.findIndex((d) => d >= from);
  return Math.max(i, 0);
}

/** 가장 큰 최고 평가금이 가장 작은 것의 이 배수를 넘으면 로그 축으로 먼저 연다. */
const LOG_FIRST_RATIO = 5;

/**
 * 로그 축 먼저: peaks([{symbol, value}], value는 종목의 최고 평가금)에서 가장 큰 값이
 * 가장 작은 값의 5배를 넘으면 가장 큰 종목 {symbol, value}, 아니면 null.
 * 값이 없거나(null) 0 이하인 종목은 건너뛴다 (로그 축에 못 그린다). 종목이 하나면 null.
 */
export function logFirst(peaks) {
  const valid = peaks.filter((p) => p.value !== null && p.value !== undefined && p.value > 0);
  if (valid.length < 2) return null;
  const top = valid.reduce((a, b) => (b.value > a.value ? b : a));
  const low = Math.min(...valid.map((p) => p.value));
  return top.value > low * LOG_FIRST_RATIO ? { symbol: top.symbol, value: top.value } : null;
}

/** 로그 축으로 먼저 연 이유 한 줄 (시안 v2). currency는 투자 통화. */
export function logFirstNote(pick, currency) {
  return (
    "로그 축: 같은 간격이 같은 배수입니다. " +
    `${pick.symbol} 평가금(최고 ${money(pick.value, currency)})이 다른 종목보다 훨씬 커서 ` +
    "로그 축으로 먼저 보여 줍니다."
  );
}

const SPLIT_NOTE = /^(\d{4}-\d{2}-\d{2}) (\S+) 분할 반영$/;

/** results[].notes("2025-11-20 2:1 분할 반영", 상세 설계 4절)에서 분할만 읽는다. */
export function splitsOf(notes) {
  return (notes ?? []).flatMap((note) => {
    const match = SPLIT_NOTE.exec(note);
    return match ? [{ date: match[1], ratio: match[2] }] : [];
  });
}

/**
 * 분할일 세로선: dates(지금 그리는 날짜축)에서 그날, 점을 줄여 그날이 없으면 그 뒤 첫 날짜의
 * 위치. 날짜축 앞(보는 기간 밖)이나 뒤(끝날짜 뒤 분할)는 뺀다.
 */
export function splitMarks(notes, dates) {
  if (!dates.length) return [];
  return splitsOf(notes).flatMap((split) => {
    if (split.date < dates[0] || split.date > dates.at(-1)) return [];
    const index = dates.findIndex((d) => d >= split.date);
    return [{ index, ...split, label: `${split.ratio} 분할` }];
  });
}
