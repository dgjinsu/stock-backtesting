// 분석 탭(F-14)의 글, 표 줄, 그래프 좌표를 만드는 순수 함수. DOM 없음 (node --test로 시험한다).
// 그리는 쪽은 analysis.js다. 묶음마다 아래에 구역을 더한다 (#61 연도별·월별, #64 수익 분해·매수 가격).

import { sparkline } from "./chartdata.js";
import { MINUS, investLabel, pct, qty, rate, shortDate, shortMonth } from "./format.js";

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
