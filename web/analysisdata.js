// 분석 탭(F-14)의 글, 표 줄, 그래프 좌표를 만드는 순수 함수. DOM 없음 (node --test로 시험한다).
// 그리는 쪽은 analysis.js다. 묶음마다 아래에 구역이 하나씩 있다.

import { sparkline } from "./chartdata.js";
import {
  MINUS,
  fx,
  investLabel,
  money,
  pct,
  price,
  qty,
  rate,
  shortDate,
  shortMonth,
  shownMoney,
  signedMoney,
} from "./format.js";

const NONE = "없음";

/** 칸 하나: text(값), sub(옆의 작은 글, 없으면 null), tone(손익 색 pos·neg, 없으면 ""). */
function cell(text, sub = null, tone = "") {
  return { text, sub, tone };
}

/** 화면에 보이는 자리(digits)로 반올림한 값의 손익 색. "−0.0%"처럼 보이지 않게 0은 색이 없다. */
function toneOf(value, digits) {
  const shown = Number(value.toFixed(digits));
  if (shown > 0) return "pos";
  if (shown < 0) return "neg";
  return "";
}

/** 값이 있는지 (null, 그리고 v2 필드가 빠진 옛 응답의 undefined는 없다). */
function present(value) {
  return value !== null && value !== undefined;
}

// ---------- 탭 맨 위와 끝 ----------

/** 탭 맨 위 한 줄. 금액은 투자 통화로 보인다 (매수 가격은 종목 통화라 "숫자는 모두"가 아니다). */
export function analysisIntro(params) {
  return `결과를 여러 각도로 나눠 봅니다. 금액은 ${investLabel(params.currency)} 기준입니다.`;
}

/** 탭 끝 안내 (계산 규칙 9-1: 평가금 낙폭과 MDD가 다르다고 화면에 적는다). */
export function analysisNotes() {
  return [
    "평가금 낙폭은 넣은 돈이 계속 더해지는 상태의 값이라, " +
      "한 번에 넣은 투자의 낙폭(MDD)과 다릅니다.",
  ];
}

// ---------- 얼마나 흔들렸나 (F-14, 계산 규칙 9-1) ----------

/** 흔들림 표의 열. riskRow의 cells가 이 순서다. */
export const RISK_COLUMNS = [
  { key: "worst", title: "최저 수익률" },
  { key: "drawdown", title: "평가금 최대 낙폭" },
  { key: "underwater", title: "원금 아래였던 날" },
  { key: "longest", title: "가장 길게 원금 아래" },
  { key: "last", title: "마지막으로 원금 아래" },
];

/** 표 위 글. 거래일 수(첫 매수일 ~ 평가일)가 종목마다 다르면 하나로 적지 않는다. */
export function riskIntro(results) {
  const lead = "적립식은 넣은 돈이 계속 늘어서, 수익률과 평가금 기준 낙폭을 같이 봅니다.";
  const days = [...new Set(results.map((r) => r.summary.trading_days))];
  return days.length === 1
    ? `${lead} 전체 ${qty(days[0], 0)} 거래일 기준.`
    : `${lead} 거래일 수는 종목마다 다릅니다.`;
}

/**
 * 흔들림 표 한 줄: { symbol, cells }. cells는 RISK_COLUMNS 순서다.
 * 값이 없을 때(결정 d25): 낙폭이 없으면 "없음", 원금 아래였던 적이 없으면 "0일 (0.0%)"과 "없음",
 * 끝까지 원금 위로 못 올라왔으면 가장 긴 구간의 끝을 "회복 전"으로 쓴다.
 * 원금 아래 칸은 카드의 "331일 (26.5%)"(results.js underwaterText)와 같은 글이다.
 */
export function riskRow(result) {
  const s = result.summary;
  const worst = cell(
    pct(s.worst.return_pct, 1),
    shortDate(s.worst.date),
    toneOf(s.worst.return_pct, 1),
  );
  const dd = s.max_drawdown;
  const drawdown = present(dd)
    ? cell(pct(dd.pct, 1), shortDate(dd.date), toneOf(dd.pct, 1))
    : cell(NONE);
  const days = present(s.underwater_days) ? `${qty(s.underwater_days, 0)}일` : "—";
  const underwater = cell(days, `(${rate(s.underwater_pct, 1)})`);
  const lu = s.longest_underwater;
  const longest = present(lu)
    ? cell(
        `${qty(lu.days, 0)} 거래일`,
        `${shortMonth(lu.start)} ~ ${present(lu.recovered) ? shortMonth(lu.recovered) : "회복 전"}`,
      )
    : cell(NONE);
  const last = present(s.last_underwater) ? cell(s.last_underwater) : cell(NONE);
  return { symbol: result.symbol, cells: [worst, drawdown, underwater, longest, last] };
}

// ---------- 낙폭 그래프 ----------

const MAX_X_TICKS = 10;

/** 세로 눈금 간격: 가장 깊은 낙폭이 20% 이하면 5, 50% 이하면 10, 그보다 깊으면 25. */
function tickStep(depth) {
  if (depth <= 20) return 5;
  if (depth <= 50) return 10;
  return 25;
}

/** 눈금이 너무 많으면 고르게 솎는다 (첫 눈금은 남긴다). */
function thin(ticks) {
  if (ticks.length <= MAX_X_TICKS) return ticks;
  const every = Math.ceil(ticks.length / MAX_X_TICKS);
  return ticks.filter((_, i) => i % every === 0);
}

/**
 * 가로 눈금: 해가 바뀌는 첫 날짜마다 연도. 그런 날이 둘보다 적으면(1년 안쪽) 달이 바뀌는 날마다
 * "YY-MM". left는 날짜축 위치 비율(i / (n − 1))로 sparkline의 x와 같다. 10개가 넘으면 솎는다.
 */
function xTicksOf(dates) {
  const n = dates.length;
  const changes = (part, label) => {
    const ticks = [];
    for (let i = 1; i < n; i += 1) {
      if (part(dates[i]) !== part(dates[i - 1]))
        ticks.push({ label: label(dates[i]), left: i / (n - 1) });
    }
    return ticks;
  };
  const years = changes(
    (d) => d.slice(0, 4),
    (d) => d.slice(0, 4),
  );
  return thin(years.length >= 2 ? years : changes((d) => d.slice(0, 7), shortMonth));
}

/** 가장 낮은 값과 그 자리 (같은 값이면 앞의 것). 값이 없으면 null. */
function lowOf(values, dates) {
  let low = null;
  values.forEach((value, index) => {
    if (present(value) && (low === null || value < low.value)) {
      low = { index, date: dates[index], value };
    }
  });
  return low;
}

/**
 * 평가금 최고점 대비 낙폭 그래프 (F-14 "아래에 낙폭 그래프"). chart는 /api/backtest의 chart이고
 * symbols는 그릴 종목(결과 순서). 화면은 점을 더 줄이지 않는다: 서버가 1,000점 이하로 줄이면서
 * 종목마다 최대 낙폭 날을 남긴다 (상세 설계 3절). 그래서 가장 낮은 점이 표의 최대 낙폭과 같다.
 * - 세로축은 모든 선이 같이 쓴다. 바닥(floor)은 가장 깊은 낙폭을 눈금 간격으로 내린 값이고,
 *   낙폭이 모두 0이면 한 칸 아래다. yTicks의 top은 판 위에서의 비율(값 ÷ 바닥)이다.
 * - 선(lines)은 width×height 상자의 SVG path다. null(첫 매수 전)은 건너뛴다 (sparkline).
 * 날짜가 없으면 null.
 */
export function drawdownChart(chart, symbols, { width = 1000, height = 300 } = {}) {
  const { dates } = chart;
  if (!dates.length) return null;
  const all = symbols.map((symbol) => chart.series[symbol].drawdown);
  const deepest = Math.min(0, ...all.flat().filter(present));
  const depth = -deepest;
  const step = tickStep(depth);
  // 부동소수점 나눗셈(예: 30 / 10)이 3.0000001이 되어 한 칸 더 내려가지 않게 조금 깎는다
  const floor = depth === 0 ? -step : -Math.ceil(depth / step - 1e-9) * step;
  const yTicks = [];
  for (let v = 0; v >= floor; v -= step) {
    yTicks.push({ label: v === 0 ? "0%" : `${MINUS}${-v}%`, top: v === 0 ? 0 : v / floor });
  }
  const lines = symbols.map((symbol, i) => {
    const line = sparkline(all[i], { width, height, pad: 0, domain: [floor, 0] });
    return { symbol, path: line ? line.path : "", low: lowOf(all[i], dates) };
  });
  return { floor, yTicks, xTicks: xTicksOf(dates), lines };
}

/** 낙폭 그래프 범례의 값: 최대 낙폭(1자리), 낙폭이 없으면 "낙폭 없음" (결정 d25, 표·aria-label과 같다). */
export function drawdownLegend(result) {
  const dd = result.summary.max_drawdown;
  return present(dd) ? pct(dd.pct, 1) : "낙폭 없음";
}

/** 낙폭 그래프의 aria-label. 표의 짧은 날짜와 달리 낭독용이라 날짜를 다 쓴다. */
export function drawdownAria(results) {
  const parts = results.map((r) => {
    const dd = r.summary.max_drawdown;
    return present(dd)
      ? `${r.symbol} 최대 ${pct(dd.pct, 1)} (${dd.date})`
      : `${r.symbol} 낙폭 없음`;
  });
  return `평가금 최고점 대비 낙폭 그래프. ${parts.join(", ")}.`;
}

// ---------- 연도별 결과 (F-14, 계산 규칙 9-2) ----------

/** 결과 종목 통화 이름: 하나면 원화·달러, 여럿이면 "종목 통화". */
function assetLabel(results) {
  const currencies = [...new Set(results.map((r) => r.currency))];
  return currencies.length === 1 ? investLabel(currencies[0]) : "종목 통화";
}

/** 결과 한 줄의 analysis.years (v2 필드가 빠진 옛 응답이면 빈 것). */
function yearsOfResult(result) {
  return result.analysis?.years ?? {};
}

/** 모든 종목 연도를 합친 오름차순 목록. */
function allYears(results) {
  return [...new Set(results.flatMap((r) => Object.keys(yearsOfResult(r))))].sort();
}

/**
 * 해마다 그해까지(연도 ≤ 그해) 마지막 매수 줄의 invested. 그해에 매수가 없으면 앞 해 값이고,
 * 첫 매수 전 해는 null이다. buys는 날짜 오름차순이다 (상세 설계 4절).
 */
function investedByYear(buys, years) {
  const byYear = new Map();
  let next = 0;
  let last = null;
  for (const year of years) {
    while (next < buys.length && buys[next].date.slice(0, 4) <= year) {
      last = buys[next].invested;
      next += 1;
    }
    byYear.set(year, last);
  }
  return byYear;
}

/** 표 위 글. 아래 작은 글씨(주가 등락)는 종목 통화다. */
export function yearsIntro(results) {
  return (
    "그해 마지막 거래일 기준 누적 수익률. " +
    `아래 작은 글씨는 그해 주가 등락(${assetLabel(results)})`
  );
}

/** 연도별 표의 칸: 그해 누적 수익률, 주가 등락, (투자금이 종목마다 다를 때) 그해 투자금. */
function yearCell(value, invested, currency) {
  if (!present(value)) return { text: "—", sub: null, tone: "", invested: null };
  const change = value.price_change_pct;
  return {
    text: pct(value.return_pct, 1),
    sub: present(change) ? `주가 ${pct(change, 1)}` : "주가 —",
    tone: toneOf(value.return_pct, 1),
    invested: present(invested) ? `투자금 ${money(invested, currency)}` : null,
  };
}

/**
 * 연도별 결과 표 (F-14, 9-2). currency는 투자 통화(params.currency)다. 행은 모든 종목 연도를 합친
 * 오름차순, cells는 results 순서다. 누적 투자금(결정 d66)은 모든 줄·모든 종목이 같으면 열 하나
 * (sharedInvested, 줄의 invested)로, 하나라도 다르면 칸마다(칸의 invested) 쓴다. 표 모양이 줄마다
 * 바뀌지 않게 표 전체로 정한다.
 */
export function yearsTable(results, currency) {
  const years = allYears(results);
  const invested = results.map((r) => investedByYear(r.buys ?? [], years));
  const sharedInvested = years.every(
    (year) => new Set(invested.map((byYear) => byYear.get(year))).size === 1,
  );
  const rows = years.map((year) => ({
    year,
    invested: sharedInvested ? money(invested[0].get(year), currency) : null,
    cells: results.map((r, i) =>
      yearCell(yearsOfResult(r)[year], sharedInvested ? null : invested[i].get(year), currency),
    ),
  }));
  return { sharedInvested, rows };
}

/**
 * 표 아래 한 줄: 마지막 연도가 어디까지인지 ("2026년은 11-23까지."). 마지막 연도에 끝나는
 * data_through만 보고, 종목마다 다르면 "2026년은 QQQ 11-23, 005930.KS 11-24까지."다. 없으면 null.
 */
export function yearsFoot(results) {
  const last = allYears(results).at(-1);
  if (!last) return null;
  const ends = results
    .filter((r) => r.data_through?.slice(0, 4) === last)
    .map((r) => ({ symbol: r.symbol, day: r.data_through.slice(5) }));
  if (!ends.length) return null;
  const days = new Set(ends.map((e) => e.day));
  const until = days.size === 1 ? ends[0].day : ends.map((e) => `${e.symbol} ${e.day}`).join(", ");
  return `${last}년은 ${until}까지.`;
}

// ---------- 달마다 얼마나 움직였나 (F-14, 계산 규칙 9-3) ----------

/** 히트맵 바탕이 가장 진해지는 |월 수익률| (%). */
const HEAT_CAP = 25;

export const NO_MONTHS = "끝난 달이 없어 월별 수익률이 없습니다";

/**
 * 히트맵 위 글. 괄호는 투자 통화다. 고른 종목 통화가 투자 통화와 같으면 환율을 곱하지 않으므로
 * "× 환율"을 뺀다 (공식은 9-3 그대로).
 */
export function monthsIntro(result, params) {
  const fx = result.currency === params.currency ? "" : " × 환율";
  return `월말 종가${fx} 기준 월 수익률 (${investLabel(params.currency)})`;
}

/** 히트맵 칸: 글(1자리, 기호), 손익 색, 진하기(0~1, 25%에서 1). 화면에 0.0%면 색과 진하기가 없다. */
function heatCell(value) {
  const tone = toneOf(value, 1);
  const level = tone ? Number((Math.min(Math.abs(value), HEAT_CAP) / HEAT_CAP).toFixed(3)) : 0;
  return { text: pct(value, 1), tone, level };
}

/** months("YYYY-MM" → %)의 값이 있는 달을 달 순서로. */
function monthEntries(months) {
  return Object.entries(months ?? {})
    .filter(([, value]) => present(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 히트맵 행: months에 나오는 연도(오름차순)마다 1~12월 칸 열두 개. 데이터가 없는 달은 null.
 * months가 비면 빈 목록.
 */
export function monthsGrid(months) {
  const byMonth = new Map(monthEntries(months));
  const years = [...new Set([...byMonth.keys()].map((key) => key.slice(0, 4)))];
  return years.map((year) => ({
    year,
    cells: Array.from({ length: 12 }, (_, i) => {
      const value = byMonth.get(`${year}-${String(i + 1).padStart(2, "0")}`);
      return value === undefined ? null : heatCell(value);
    }),
  }));
}

/** "2026-04 +30.4%" 칸. 그런 달이 없으면 "없음". */
function monthCell(title, entry) {
  if (!entry) return { title, text: NONE, tone: "" };
  const [month, value] = entry;
  return { title, text: `${month} ${pct(value, 1)}`, tone: toneOf(value, 1) };
}

/**
 * 히트맵 아래 세 칸: 오른 달 / 내린 달(응답 값이 0보다 큰 / 작은 달, expected months.up과 같은
 * 기준), 가장 크게 오른 달, 가장 크게 내린 달. 같은 값이면 앞의 달이다. months가 비면 null.
 */
export function monthsStats(months) {
  const entries = monthEntries(months);
  if (!entries.length) return null;
  const up = entries.filter(([, v]) => v > 0);
  const down = entries.filter(([, v]) => v < 0);
  const best = up.reduce((a, b) => (b[1] > a[1] ? b : a), up[0]);
  const worst = down.reduce((a, b) => (b[1] < a[1] ? b : a), down[0]);
  return [
    {
      title: "오른 달 / 내린 달",
      text: `${qty(up.length, 0)}달 / ${qty(down.length, 0)}달`,
      tone: "",
    },
    monthCell("가장 크게 오른 달", best),
    monthCell("가장 크게 내린 달", worst),
  ];
}

// ---------- 수익은 어디서 왔나 (F-14, 계산 규칙 9-4) ----------

/** 수익 줄이 되는 결과: 종목 통화가 투자 통화와 다르고 주가 효과가 있는 결과 (results 순서, 9-4). */
function profitResults(results, currency) {
  return results.filter((r) => r.currency !== currency && present(r.summary?.price_effect));
}

/** 화면에 보이는 금액(shownMoney)의 손익 색. */
function moneyTone(value, currency) {
  const shown = shownMoney(value, currency);
  if (shown > 0) return "pos";
  if (shown < 0) return "neg";
  return "";
}

/**
 * 상자 위 글. 투자 통화 손익을 두 효과로 나누는 식이다. 달러 자리는 수익 줄의 종목 통화(여럿이면
 * "종목 통화")다. 환율 변동 제외(includeFx false, F-24 결정 d74)면 평가 환율이 평균 매수 환율이고
 * 환율 효과가 0이라 그렇게 쓴다.
 */
export function profitIntro(results, currency, { includeFx = true } = {}) {
  const invest = investLabel(currency);
  const asset = assetLabel(profitResults(results, currency));
  if (!includeFx) {
    return (
      `${invest} 손익 = 주가 효과(${asset}로 번 돈 × 평균 매수 환율) + ` +
      "환율 효과(환율 변동 제외라 0)"
    );
  }
  return (
    `${invest} 손익 = 주가 효과(${asset}로 번 돈 × 지금 환율) + ` +
    `환율 효과(산 ${asset}를 지금 환율로 바꾼 값 ${MINUS} 넣은 ${invest})`
  );
}

/**
 * 수익 줄: 주가 효과·환율 효과·손익 글과 손익 색, 막대 폭(|손익| ÷ 가장 큰 |손익|, 소수 4자리).
 * 손익은 summary.profit이라 두 효과의 합과 1원 다를 수 있다 (상세 설계 4절). 빈 목록이면 상자가 없다.
 */
export function profitRows(results, currency) {
  const rows = profitResults(results, currency);
  const most = Math.max(0, ...rows.map((r) => Math.abs(r.summary.profit)));
  return rows.map((r) => {
    const s = r.summary;
    return {
      symbol: r.symbol,
      price: signedMoney(s.price_effect, currency),
      priceTone: moneyTone(s.price_effect, currency),
      fx: signedMoney(s.fx_effect, currency),
      fxTone: moneyTone(s.fx_effect, currency),
      total: signedMoney(s.profit, currency),
      tone: moneyTone(s.profit, currency),
      width: most === 0 ? 0 : Number((Math.abs(s.profit) / most).toFixed(4)),
    };
  });
}

/** 응답이 환율 변동을 넣어 계산했는지 (F-24). include_fx가 false일 때만 끔이고, 없으면(#74 전) 켬이다. */
export function fxIncluded(params) {
  return params?.include_fx !== false;
}

/**
 * 평균 매수 환율 문장. 횟수는 매수일 수(summary.buys, 쉰 날도 그날 환전한다, 9-4)이고 가장 쌀 때·비쌀
 * 때는 buys[].fx에서 고른다 (같으면 앞 날짜). 환율 단위는 투자 통화가 원화일 때만 "원"이다.
 * compare가 false면(환율 변동 제외: 평가 환율이 곧 평균 매수 환율) 평가 환율 비교 없이 끝낸다.
 * 평균 매수 환율이 없거나 매수가 없으면 null.
 */
function avgFxSentence(result, currency, { compare = true } = {}) {
  const s = result.summary;
  const rows = (result.buys ?? []).filter((b) => present(b.fx));
  if (!present(s.avg_buy_fx) || !rows.length) return null;
  const unit = currency === "KRW" ? "원" : "";
  const text = (value) => `${fx(value)}${unit}`;
  const low = rows.reduce((a, b) => (b.fx < a.fx ? b : a));
  const high = rows.reduce((a, b) => (b.fx > a.fx ? b : a));
  const lead =
    `${qty(s.buys, 0)}번 평균 매수 환율은 ${text(s.avg_buy_fx)}` +
    `(가장 쌀 때 ${text(low.fx)} ${low.date}, 가장 비쌀 때 ${text(high.fx)} ${high.date})`;
  if (!compare) return `${lead}입니다.`;
  let versus = "그보다 높습니다";
  if (fx(s.eval_fx) === fx(s.avg_buy_fx)) versus = "그와 같습니다";
  else if (s.eval_fx < s.avg_buy_fx) versus = "그보다 낮습니다";
  return `${lead}이고, 평가 환율 ${text(s.eval_fx)}이 ${versus}.`;
}

/** 평균 매수 환율 문장들: 모든 줄에서 같으면 하나, 다르면 줄마다 종목 코드를 앞에 붙인다. */
function avgFxNotes(rows, currency, options) {
  const sentences = rows
    .map((r) => ({ symbol: r.symbol, text: avgFxSentence(r, currency, options) }))
    .filter((e) => e.text !== null);
  if (new Set(sentences.map((e) => e.text)).size === 1) {
    return [{ text: sentences[0].text, strong: false }];
  }
  return sentences.map((e) => ({ text: `${e.symbol} ${e.text}`, strong: false }));
}

/**
 * 상자 아래 글 조각 [{text, strong}] (틀에 숫자를 넣은 사실 문장, 결정 d62). 한 문단에 띄어 잇는다.
 * 1) 수익 줄이 둘 이상이고 환율 효과 글·종목 통화·매수일(횟수·첫날·끝날)이 모두 같으면 굵은
 *    "환율 효과는 4개 종목 모두 −75만원으로 같습니다."와 그 이유 (같은 날 같은 돈을 바꿨을 때만 맞다).
 * 2) 평균 매수 환율 문장. 종목마다 다르면 줄마다 종목 코드를 앞에 붙인다.
 * 환율 변동 제외(includeFx false, 결정 d75)면 1)의 이유와 2)의 평가 환율 비교가 틀린 말이라, 안내 두
 * 조각 뒤에 비교 없는 평균 매수 환율 문장만 둔다 (평균 매수 환율은 끔에서도 그대로이고 평가에 쓴 값).
 * 수익 줄이 없으면 [].
 */
export function profitNotes(results, currency, { includeFx = true } = {}) {
  const rows = profitResults(results, currency);
  if (!rows.length) return [];
  if (!includeFx) {
    return [
      { text: "환율 변동 제외로 계산했습니다.", strong: true },
      {
        text:
          "통화가 다른 종목은 지금 환율 대신 그날까지의 평균 매수 환율로 평가해 " +
          "환율 효과가 0입니다.",
        strong: false,
      },
      ...avgFxNotes(rows, currency, { compare: false }),
    ];
  }
  const notes = [];
  const same = (key) => new Set(rows.map(key)).size === 1;
  const fxEffect = (r) => signedMoney(r.summary.fx_effect, currency);
  const buyDays = (r) => `${r.summary.buys}|${r.summary.first_buy}|${r.summary.last_buy}`;
  if (rows.length > 1 && same(fxEffect) && same((r) => r.currency) && same(buyDays)) {
    notes.push({
      text: `환율 효과는 ${qty(rows.length, 0)}개 종목 모두 ${fxEffect(rows[0])}으로 같습니다.`,
      strong: true,
    });
    notes.push({
      text: `같은 날 같은 ${investLabel(currency)}를 ${assetLabel(rows)}로 바꿨기 때문입니다.`,
      strong: false,
    });
  }
  return [...notes, ...avgFxNotes(rows, currency)];
}

// ---------- 얼마에 샀나 (F-14, 계산 규칙 9-1) ----------

export const NO_BUYS = "산 날이 없어 매수 가격 분포가 없습니다";

/**
 * 산 회차: buys 가운데 lot_return_pct가 null이 아닌 줄 (상세 설계 4절, 결정 d58). 레버리지 전환에서
 * 쉰 날은 빠진다. qty는 4자리로 반올림해 아주 적게 산 회차가 0으로 보일 수 있어 qty로 가리지 않는다.
 */
function boughtRows(result) {
  return (result.buys ?? []).filter((b) => present(b.lot_return_pct));
}

/** 상자 위 글: "60번 매수 가격의 분포 (달러, 분할 반영)". 산 회차가 없으면 횟수 없이. */
export function buyPriceIntro(result) {
  const count = boughtRows(result).length;
  const lead = count ? `${qty(count, 0)}번 ` : "";
  return `${lead}매수 가격의 분포 (${investLabel(result.currency)}, 분할 반영)`;
}

/** 막대 경계 글. 원화는 원 단위 정수, 그 밖은 칸 너비가 1 이상이면 정수, 아니면 소수 2자리. */
function edgeLabel(value, currency, step) {
  if (currency === "KRW") return money(value, "KRW", { short: false });
  const digits = step >= 1 ? 0 : 2;
  const text = value.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
}

/**
 * 매수 가격 분포 (F-14 얼마에 샀나). 산 회차의 buys[].price(종목 통화, 분할 반영)를 bins칸 막대로 센다.
 * - 칸 경계: lo = min(가장 낮은 가격, 평가 가격, 평단가) 내림, hi = max(가장 높은 가격, 평가 가격,
 *   평단가) × 1.02 올림. 시안 식(lo는 매수 가격만, hi는 평가 가격까지)에 지금 가격이 가장 낮은 매수
 *   가격보다 낮을 때와 평단가가 가장 높은 가격보다 높을 때(큰 수수료)를 더해 세로선이 늘 판 안에 있다.
 *   칸은 [from, to)라 경계에 걸린 가격은 위 칸이다. filled는 칸 위 끝이 평가 가격 이하인 칸(색칠).
 * - height는 가장 많은 칸 기준(소수 3자리), 세로선 left는 lo~hi 비율(소수 4자리). 선이 오른쪽 끝
 *   (0.8 넘음)에 가까우면 flip(글을 선 왼쪽에)이다. 평단가가 없으면 avg는 null.
 * 산 회차가 없으면 null.
 */
export function buyPriceDist(result, { bins = 12 } = {}) {
  const rows = boughtRows(result);
  if (!rows.length) return null;
  const s = result.summary;
  const currency = result.currency;
  const prices = rows.map((b) => b.price);
  const lines = present(s.avg_cost_asset) ? [s.eval_price, s.avg_cost_asset] : [s.eval_price];
  const lo = Math.floor(Math.min(...prices, ...lines));
  const hi = Math.ceil(Math.max(...prices, ...lines) * 1.02);
  const span = hi - lo;
  const step = span / bins;
  const edge = (k) => lo + (span * k) / bins;
  const counts = Array(bins).fill(0);
  for (const p of prices) counts[Math.min(bins - 1, Math.floor(((p - lo) * bins) / span))] += 1;
  const most = Math.max(...counts);
  const label = (value) => edgeLabel(value, currency, step);
  const list = counts.map((count, k) => {
    const from = edge(k);
    const to = edge(k + 1);
    return {
      count,
      from,
      to,
      filled: to <= s.eval_price,
      height: Number((count / most).toFixed(3)),
      title: `${label(from)} ~ ${label(to)}: ${qty(count, 0)}번`,
    };
  });
  const line = (value, name) => {
    const left = Number(((value - lo) / span).toFixed(4));
    return { left, label: `${name} ${price(value, currency)}`, flip: left > 0.8 };
  };
  const avg = present(s.avg_cost_asset) ? line(s.avg_cost_asset, "평단가") : null;
  const now = line(s.eval_price, "지금");
  const marks = [avg?.label, now.label].filter(Boolean).join(", ");
  return {
    count: rows.length,
    lo,
    hi,
    loLabel: label(lo),
    hiLabel: label(hi),
    bins: list,
    avg,
    now,
    aria:
      `${result.symbol} 매수 가격 분포 그래프. ${label(lo)} ~ ${label(hi)}를 ${bins}칸으로 나눈 ` +
      `칸별 횟수 ${counts.join(", ")}. ${marks}.`,
  };
}

/**
 * 분포 아래 글: 싸게 산 횟수(analysis.buys_below_*, 산 회차만 센다, 결정 d58)와 가장 싸게·비싸게 산
 * 날(산 회차에서, 같은 가격이면 앞 날짜). 평단가가 없으면 "평단가보다" 부분을 뺀다. 끝의 색칠 안내는
 * 색칠한 막대가 있을 때만 붙인다 (하락장만 적립하면 없다). 산 회차가 없으면 null.
 */
export function buyPriceText(result) {
  const rows = boughtRows(result);
  if (!rows.length) return null;
  const s = result.summary;
  const a = result.analysis ?? {};
  const currency = result.currency;
  const low = rows.reduce((x, b) => (b.price < x.price ? b : x));
  const high = rows.reduce((x, b) => (b.price > x.price ? b : x));
  const belowAvg = present(s.avg_cost_asset)
    ? `, ${qty(a.buys_below_avg_cost, 0)}번은 평단가보다 싸게`
    : "";
  const filled = buyPriceDist(result).bins.some((b) => b.filled);
  return (
    `${qty(rows.length, 0)}번 중 ${qty(a.buys_below_eval_price, 0)}번은 ` +
    `지금 가격보다 싸게${belowAvg} 샀습니다. ` +
    `가장 싸게 산 날은 ${low.date} ${price(low.price, currency)}, ` +
    `가장 비싸게 산 날은 ${high.date} ${price(high.price, currency)}입니다.` +
    (filled ? " 색칠한 막대는 지금 가격보다 싸게 산 구간입니다." : "")
  );
}
