// 결과 아래쪽: 그래프 4개(F-07, F-13)와 매수 내역·CSV(F-08). Chart.js 4는 index.html에서 불러온다.

import {
  BUY_COLUMNS,
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
  restNote,
  sampledNote,
  splitMarks,
} from "./chartdata.js";
import { h, icon, keepFocus, segButtons, swatch } from "./dom.js";
import { fx, money, pct, price, qty } from "./format.js";
import { avgInvestNote } from "./results.js";

const TABS = [
  { key: "value", label: "평가금·투자금" },
  { key: "return", label: "수익률" },
  { key: "drawdown", label: "낙폭" },
  { key: "price", label: "주가·평단가" },
];

const DRAWDOWN_HINT =
  "낙폭: 그날 평가금이 그때까지의 최고 평가금보다 얼마나 낮은지. 적립 중이라 넣은 돈도 평가금에 들어갑니다.";
const SPLIT_HINT =
  "세로선은 주식 분할일입니다. 과거 가격은 분할을 반영해 지금 주식 수 기준으로 바뀌어 있습니다.";

/**
 * 다시 계산해도 유지하는 보기 상태. logPicked는 사용자가 마지막으로 고른 축이고, log는 지금 축이다
 * (새 결과가 로그 축 먼저에 걸리면 log만 켠다). hidden(범례로 숨긴 종목)은 새 결과마다 비운다.
 */
const view = {
  tab: "value",
  log: false,
  logPicked: false,
  range: "all",
  hidden: new Set(),
  priceSymbol: null,
  buySymbol: null,
  expanded: false,
};
let current = null; // { data, slotOf, chart, wrap, legend, hints, logFirst }

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, alpha) {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 그래프를 만들 때 한 번 읽는 테마 값 (리디자인 B). 테마를 바꾸면 그래프를 새로 만들어 다시 읽는다. */
function chartTheme() {
  return {
    dark: document.documentElement.classList.contains("dark"),
    mono: cssVar("--font-mono"),
    muted: cssVar("--muted"),
    axis: cssVar("--axis"),
    grid: cssVar("--grid"),
    line2: cssVar("--line2"),
    bg: cssVar("--bg"),
    acc: cssVar("--acc"),
    tip: cssVar("--tip"),
    tipfg: cssVar("--tipfg"),
    tipacc: cssVar("--tipacc"),
  };
}

/** 마우스를 올린 날의 세로 기준선: 강조색 실선, 투명도 0.6 (B). 색은 플러그인 옵션 color. */
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart, _args, options) {
    const active = chart.tooltip?.getActiveElements() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = Math.round(active[0].element.x) + 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = options.color;
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * 다크에서 종목 선에 그 색의 빛을 준다 (B, CSS drop-shadow 0 0 3px와 비슷하게). 데이터셋에 glow가
 * 있는 선만이다. 라이트에서는 이 플러그인을 넣지 않는다 (결정 d52 ③). 캔버스 그림자는 배율을 따르지
 * 않아 화면 배율을 곱한다.
 */
const glow = {
  id: "glow",
  beforeDatasetDraw(chart, { index }) {
    const dataset = chart.data.datasets[index];
    if (!dataset.glow) return;
    chart.ctx.save();
    chart.ctx.shadowColor = dataset.borderColor;
    chart.ctx.shadowBlur = 3 * chart.currentDevicePixelRatio;
  },
  afterDatasetDraw(chart, { index }) {
    if (chart.data.datasets[index].glow) chart.ctx.restore();
  },
};

/**
 * 그리는 판 자리(chartArea)를 그래프 상자의 CSS 변수 --plot으로 넘긴다. .chart-wrap::before가
 * 그 자리에 점 격자를 깐다 (B). 캔버스 안에 그리지 않아 마우스를 움직여도 다시 그리지 않는다.
 */
const plotBoard = {
  id: "plotBoard",
  afterLayout(chart) {
    const { top, right, bottom, left } = chart.chartArea;
    const inset = `${top}px ${chart.width - right}px ${chart.height - bottom}px ${left}px`;
    chart.canvas.parentNode?.style.setProperty("--plot", inset);
  },
};

/**
 * 주식 분할일 세로 점선과 "2:1 분할 2025-11-20" 글자 (F-13). marks는 splitMarks 결과, theme은
 * chartTheme() 값이다. 마우스를 움직일 때마다 다시 그리므로 색과 글꼴은 여기서 읽지 않는다.
 */
function splitLines(marks, theme) {
  const xOf = (chart, mark) => chart.scales.x.getPixelForValue(mark.index);
  return {
    id: "splitLines",
    // 선은 주가 선 아래에, 글자는 위에 그린다
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = theme.muted;
      for (const mark of marks) {
        const x = Math.round(xOf(chart, mark)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = `11px ${theme.mono}`;
      ctx.textBaseline = "middle";
      for (const mark of marks) {
        const x = xOf(chart, mark);
        const text = `${mark.label} ${mark.date}`;
        const width = ctx.measureText(text).width + 8;
        const left = x + 4 + width > chartArea.right ? x - 4 - width : x + 4;
        ctx.fillStyle = theme.bg; // 점 격자 판(--bg) 위에서 글자만 또렷하게
        ctx.fillRect(left, chartArea.top + 2, width, 16);
        ctx.fillStyle = theme.muted;
        ctx.fillText(text, left + 4, chartArea.top + 10);
      }
      ctx.restore();
    },
  };
}

// ---------- 그래프 데이터 ----------

/** 종목 선 (B): 1.8px, 다크에서 빛(glow 플러그인), 마우스를 올린 점은 바탕색 속에 종목색 2px 테두리. */
function symbolLine(label, values, slot, extra = {}) {
  const color = cssVar(`--c${slot + 1}`);
  return {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color,
    borderDash: dashOf(slot),
    borderWidth: 1.8,
    glow: true,
    pointRadius: 0,
    pointHoverRadius: 3.5,
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: color,
    pointHoverBackgroundColor: cssVar("--bg"),
    ...extra,
  };
}

/** 평단가·투자금 계단선. 하나로 합친 투자금은 회색(muted) 점선이다 (B). */
function refLine(label, values, { dash = [], color = cssVar("--ref"), width = 1.5 } = {}) {
  return {
    label,
    data: values,
    borderColor: color,
    backgroundColor: color,
    borderDash: dash,
    borderWidth: width,
    stepped: true,
    pointRadius: 0,
    pointHoverRadius: 2,
  };
}

/** 하나로 합친 투자금 선과 범례 견본의 점선 (B). */
const INVEST_DASH = [3, 3];

/**
 * 종목마다 선 하나인 그래프(수익률, 낙폭). 범례로 숨긴 종목은 datasets에서 빼서
 * 세로축이 남은 종목에 맞춰진다. 범례 값은 보는 기간과 상관없이 마지막 값이다.
 */
function perSymbolModel(data, slotOf, cut, key, format) {
  const series = data.chart.series;
  const symbols = data.results.map((r) => r.symbol);
  return {
    format,
    tick: (v) => `${v}%`,
    datasets: symbols
      .filter((s) => !view.hidden.has(s))
      .map((s) => symbolLine(s, cut(series[s][key]), slotOf(s))),
    legend: symbols.map((s) => ({
      slot: slotOf(s),
      label: s,
      value: format(lastValue(series[s][key])),
      toggle: s,
      hidden: view.hidden.has(s),
    })),
    zeroLine: true,
  };
}

/**
 * 지금 탭의 날짜축, datasets, 값 형식, 범례 항목, 그래프 아래 안내.
 * 보는 기간(F-13)은 날짜축과 선을 같은 위치에서 자른다 (범례 마지막 값과 툴팁 값은 그대로).
 */
function tabModel(data, slotOf) {
  const chart = data.chart;
  const invest = data.params.currency;
  const symbols = data.results.map((r) => r.symbol);
  const years = RANGES.find((r) => r.key === view.range)?.years ?? null;
  const from = rangeFrom(chart.dates, years); // 분할일은 잘린 축의 첫 점이 아니라 이 날짜로 거른다
  const start = rangeStart(chart.dates, years);
  const cut = (values) => values.slice(start);
  const labels = cut(chart.dates);
  if (view.tab === "return") {
    const model = perSymbolModel(data, slotOf, cut, "return_pct", (v) => pct(v));
    return { labels, ...model, hints: [] };
  }
  if (view.tab === "drawdown") {
    // 범례 마지막 값은 카드의 "평가금 최고점 대비"와 같은 자리수
    const model = perSymbolModel(data, slotOf, cut, "drawdown", (v) => pct(v, 1));
    return { labels, ...model, hints: [DRAWDOWN_HINT] };
  }
  if (view.tab === "price") {
    const symbol = symbols.includes(view.priceSymbol) ? view.priceSymbol : symbols[0];
    view.priceSymbol = symbol;
    const result = data.results.find((r) => r.symbol === symbol);
    const cur = result.currency;
    const series = chart.series[symbol];
    const pos = cssVar("--pos");
    const neg = cssVar("--neg");
    const marks = splitMarks(result.notes, labels, from);
    return {
      labels,
      format: (v) => price(v, cur),
      tick: (v) => (v === 0 ? "0" : price(v, cur)),
      datasets: [
        symbolLine(`${symbol} 주가`, cut(series.price), slotOf(symbol), {
          fill: { target: 1, above: withAlpha(pos, 0.12), below: withAlpha(neg, 0.12) },
        }),
        refLine("평단가", cut(series.avg_cost)),
      ],
      legend: [
        {
          slot: slotOf(symbol),
          label: `${symbol} 주가`,
          value: price(lastValue(series.price), cur),
        },
        { ref: true, slot: 0, label: "평단가", value: price(lastValue(series.avg_cost), cur) },
      ],
      marks,
      hints: [
        "주가가 평단가 위인 구간(초록)은 이익, 아래(빨강)는 손실입니다.",
        marks.length ? SPLIT_HINT : null,
      ],
    };
  }
  const invested = investedLines(chart, symbols);
  const prep = (values) => cut(view.log ? logSafe(values) : values);
  // 종목마다 나뉜 투자금 선은 그 종목과 같이 숨긴다. 하나로 합친 선(symbol null)은 늘 보인다
  const off = (symbol) => symbol !== null && view.hidden.has(symbol);
  return {
    labels,
    format: (v) => money(v, invest),
    tick: (v) => money(v, invest),
    datasets: [
      ...symbols
        .filter((s) => !off(s))
        .map((s) => symbolLine(s, prep(chart.series[s].value), slotOf(s))),
      ...invested
        .filter((line) => !off(line.symbol))
        .map((line) =>
          line.symbol
            ? refLine(`투자금 ${line.symbol}`, prep(line.values), {
                dash: dashOf(slotOf(line.symbol)),
              })
            : refLine("투자금", prep(line.values), {
                dash: INVEST_DASH,
                color: cssVar("--muted"),
                width: 1.4,
              }),
        ),
    ],
    legend: [
      ...symbols.map((s) => ({
        slot: slotOf(s),
        label: s,
        value: money(lastValue(chart.series[s].value), invest),
        toggle: s,
        hidden: off(s),
      })),
      ...invested.map((line) => ({
        ref: true,
        slot: line.symbol ? slotOf(line.symbol) : 0, // 종목마다 나뉘면 회색 선을 선 모양으로 가른다
        // 하나로 합친 선은 그래프와 같은 회색 점선 견본
        look: line.symbol
          ? null
          : { color: "var(--muted)", dash: INVEST_DASH.join(" "), cap: "butt" },
        label: line.symbol ? `투자금 ${line.symbol}` : "투자금",
        value: money(lastValue(line.values), invest),
        hidden: off(line.symbol),
      })),
    ],
    log: view.log,
    hints: [view.log && current.logFirst ? logFirstNote(current.logFirst, invest) : null],
  };
}

// ---------- 그리기 ----------

/**
 * 범례. 종목 항목(toggle)은 누르면 숨기고 다시 누르면 보이는 버튼이다 (aria-pressed: 보이면 true).
 * 숨김은 색만으로 알리지 않고 줄 긋기와 "숨김" 글자로 알린다. 투자금·평단가는 버튼이 아니다.
 */
function legendItems(items) {
  return items.map((item) => {
    const content = [
      swatch(item.slot, 22, item.look ?? (item.ref ? { color: "var(--ref)" } : {})),
      h("span", { class: "lg-label", text: item.label }),
      h("strong", { text: item.value }),
      // 버튼 안에서는 aria-pressed가 상태를 알리므로 이름이 바뀌지 않게 읽지 않는다 (APG 토글
      // 버튼). 버튼이 아닌 투자금 항목은 상태를 알릴 다른 수단이 없어 읽게 둔다
      item.hidden
        ? h("span", {
            class: "lg-off",
            text: "숨김",
            "aria-hidden": item.toggle ? "true" : null,
          })
        : null,
    ];
    const li = (...children) => h("li", { class: item.hidden ? "off" : null }, ...children);
    if (!item.toggle) return li(...content);
    return li(
      h(
        "button",
        {
          type: "button",
          class: "lg-btn",
          "aria-pressed": String(!item.hidden),
          "data-focus": `legend:${item.toggle}`,
          title: "누르면 그래프에서 숨기거나 다시 보입니다", // 상태와 상관없이 같은 글
          onclick: () => toggleSymbol(item.toggle),
        },
        ...content,
      ),
    );
  });
}

/** 범례로 종목을 숨기거나 다시 보인다. 그래프 종류를 바꿔도 유지하고, 새 결과에서 모두 보인다. */
function toggleSymbol(symbol) {
  if (view.hidden.has(symbol)) view.hidden.delete(symbol);
  else view.hidden.add(symbol);
  keepFocus(current.legend, draw);
}

const MISSING =
  "그래프 도구(Chart.js)를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요. 위의 숫자와 아래 매수 내역은 그대로 볼 수 있습니다.";

/** 결과를 지울 때(전체 실패 등) 그래프를 치운다. */
export function clearCharts() {
  current?.chart?.destroy();
  current = null;
}

/**
 * Chart.js가 아직 없으면 안내를 두고 기다린다. index.html의 script는 async라
 * cdnjs가 늦거나 막혀도 화면은 먼저 뜬다. 실패하면 onerror가, 받았는데 Chart가 없으면
 * onload(index.html)와 afterChartJs가 data-failed를 단다.
 */
function waitForChartJs(wrap) {
  const script = document.getElementById("chartjs");
  const failed = !script || script.dataset.failed;
  wrap.replaceChildren(
    h("p", { class: "chart-missing", text: failed ? MISSING : "그래프 도구를 불러오는 중입니다…" }),
  );
  if (!failed) {
    script.addEventListener("load", afterChartJs, { once: true });
    script.addEventListener("error", draw, { once: true });
  }
}

/** 받았는데도 Chart가 없으면(스크립트 실행 오류) 실패로 보고 안내한다. */
function afterChartJs() {
  const script = document.getElementById("chartjs");
  if (!globalThis.Chart && script) script.dataset.failed = "1";
  draw();
}

/** 지금 탭을 다시 그린다. 그리다 난 오류는 그래프 자리에 알린다 (microtask라 run()이 못 잡는다). */
function draw() {
  if (!current?.wrap.isConnected) return; // 결과가 바뀌었거나 지워졌다
  try {
    drawNow();
  } catch (error) {
    console.error(error);
    const text = "그래프를 그리지 못했습니다. 새로고침한 뒤 다시 계산해 주세요.";
    current.wrap.replaceChildren(h("p", { class: "chart-missing", text }));
  }
}

function drawNow() {
  current.chart?.destroy();
  current.chart = null;
  const { data, slotOf, wrap, legend, hints } = current;
  const model = tabModel(data, slotOf);
  legend.replaceChildren(...legendItems(model.legend));
  const lines = model.hints.filter(Boolean);
  hints.replaceChildren(...lines.map((text) => h("p", { class: "hint", text })));
  hints.hidden = !lines.length;
  const ChartJs = globalThis.Chart;
  if (!ChartJs) {
    waitForChartJs(wrap);
    return;
  }
  current.chart = newChart(ChartJs, wrap, model);
}

function newChart(ChartJs, wrap, model) {
  const values = model.legend
    .map((i) => `${i.label} 마지막 ${i.value}${i.hidden ? " (숨김)" : ""}`)
    .join(", ");
  const range = RANGES.find((r) => r.key === view.range);
  const span = range?.years ? `(${range.label})` : "";
  const marks = model.marks ?? [];
  const splits = marks.length
    ? ` 세로 점선: ${marks.map((m) => `${m.date} ${m.label}`).join(", ")}.`
    : "";
  const canvas = h("canvas", {
    role: "img",
    "aria-label": `${TABS.find((t) => t.key === view.tab).label} 그래프${span}. ${values}.${splits}`,
  });
  wrap.replaceChildren(canvas);
  const theme = chartTheme();
  ChartJs.defaults.font.family = theme.mono; // 축 글자·툴팁은 mono (B)
  const tickText = dateTick(model.labels);
  return new ChartJs(canvas, {
    type: "line",
    data: { labels: model.labels, datasets: model.datasets },
    plugins: [
      plotBoard,
      crosshair,
      ...(theme.dark ? [glow] : []),
      ...(marks.length ? [splitLines(marks, theme)] : []),
    ],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          border: { color: theme.line2 },
          ticks: {
            color: theme.muted,
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            callback(value) {
              return tickText(String(this.getLabelForValue(value)));
            },
          },
        },
        y: {
          type: model.log ? "logarithmic" : "linear",
          border: { display: false },
          grid: {
            color: (ctx) => (model.zeroLine && ctx.tick?.value === 0 ? theme.axis : theme.grid),
            lineWidth: (ctx) => (model.zeroLine && ctx.tick?.value === 0 ? 2 : 1),
            drawTicks: false,
          },
          ticks: {
            color: theme.muted,
            font: { size: 11 },
            padding: 8,
            maxTicksLimit: 7,
            callback: (value) => model.tick(Number(value)),
          },
        },
      },
      plugins: {
        legend: { display: false },
        crosshair: { color: theme.acc },
        // 툴팁 (B): mono 12px, 강조색 테두리, 날짜는 강조색 굵게. 라이트 툴팁도 어두워서 날짜와
        // 테두리는 두 테마 모두 라임(--tipacc)이다 (라이트 --acc는 어두운 바탕에서 대비가 모자란다)
        tooltip: {
          backgroundColor: theme.tip,
          borderColor: theme.tipacc,
          borderWidth: 1,
          cornerRadius: 8,
          caretSize: 0,
          padding: { x: 12, y: 10 },
          titleColor: theme.tipacc,
          titleFont: { size: 12, weight: 700 },
          titleMarginBottom: 6,
          bodyColor: theme.tipfg,
          bodyFont: { size: 12 },
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 6,
          usePointStyle: false,
          filter: (item) => item.raw !== null && item.raw !== undefined,
          callbacks: {
            label: (item) => `${item.dataset.label}  ${model.format(item.raw)}`,
          },
        },
      },
    },
  });
}

function chartTools(data, slotOf) {
  const tools = h("div", { class: "chart-tools" });
  const rebuild = () => {
    keepFocus(tools, () => tools.replaceChildren(...chartToolsChildren(data, slotOf, rebuild)));
    draw();
  };
  tools.replaceChildren(...chartToolsChildren(data, slotOf, rebuild));
  return tools;
}

function chartToolsChildren(data, slotOf, rebuild) {
  const children = [
    segButtons(
      TABS,
      (t) => t.key === view.tab,
      (t) => {
        view.tab = t.key;
        rebuild();
      },
      "그래프 종류",
    ),
  ];
  if (view.tab === "value") {
    children.push(
      segButtons(
        [
          { key: false, label: "일반" },
          { key: true, label: "로그" },
        ],
        (o) => o.key === view.log,
        (o) => {
          view.log = o.key;
          view.logPicked = o.key;
          rebuild();
        },
        "세로축",
      ),
    );
  }
  if (view.tab === "price" && data.results.length > 1) {
    const symbols = data.results.map((r) => r.symbol);
    if (!symbols.includes(view.priceSymbol)) view.priceSymbol = symbols[0];
    children.push(
      segButtons(
        symbols.map((s) => ({ key: s, label: s, slot: slotOf(s) })),
        (o) => o.key === view.priceSymbol,
        (o) => {
          view.priceSymbol = o.key;
          rebuild();
        },
        "종목",
      ),
    );
  }
  children.push(
    segButtons(
      RANGES,
      (r) => r.key === view.range,
      (r) => {
        view.range = r.key;
        rebuild();
      },
      "보는 기간",
    ),
  );
  return children;
}

/**
 * 그래프 상자. 요소를 문서에 붙인 뒤(같은 작업 안) 그린다. 새 결과마다 불리므로 여기서
 * 숨긴 종목을 비우고, 로그 축 먼저(F-13)에 걸리면 평가금 그래프를 로그 축으로 연다.
 * 걸리지 않으면 사용자가 마지막으로 고른 축을 둔다.
 */
export function chartSection(data, slotOf) {
  clearCharts();
  const wrap = h("div", { class: "chart-wrap" });
  const legend = h("ul", { class: "legend", "aria-label": "범례와 마지막 값" });
  const hints = h("div", { class: "chart-hints", hidden: true });
  const peaks = data.results.map((r) => ({
    symbol: r.symbol,
    value: r.summary.peak_value?.value ?? null,
  }));
  const pick = logFirst(peaks);
  view.hidden = new Set();
  view.log = pick ? true : view.logPicked;
  current = { data, slotOf, chart: null, wrap, legend, hints, logFirst: pick };
  const note = sampledNote(data.chart);
  queueMicrotask(draw);
  return h(
    "section",
    { class: "box", "aria-labelledby": "chart-h" },
    h(
      "div",
      { class: "box-head" },
      h("h3", { id: "chart-h", text: "그래프" }),
      chartTools(data, slotOf),
    ),
    h(
      "div",
      { class: "box-body" },
      legend,
      wrap,
      hints,
      note ? h("p", { class: "hint", text: note }) : null,
    ),
  );
}

document.addEventListener("themechange", () => draw());
// 캔버스 글자(축·툴팁·분할일)는 그릴 때의 글꼴로 남는다. JetBrains Mono가 늦게 오면 한 번 다시 그린다
document.fonts?.load(`11px "JetBrains Mono"`).then(
  () => draw(),
  () => {},
);

// ---------- 매수 내역과 CSV (F-08) ----------

function downloadCsv(data) {
  const text = buysCsv(data.results, data.params.currency);
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = h("a", {
    href: url,
    download: csvFileName({ ...data.params, symbols: data.results.map((r) => r.symbol) }),
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DOWNLOAD_ICON = ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"];

/** 결과 머리의 [CSV] 버튼. 모든 종목의 매수 내역을 내려받는다. */
export function csvButton(data, label = "CSV") {
  return h(
    "button",
    {
      type: "button",
      class: "ghost",
      title: "모든 종목의 매수 내역 (엑셀에서 열 수 있는 UTF-8 CSV)",
      onclick: () => downloadCsv(data),
    },
    icon(DOWNLOAD_ICON),
    label,
  );
}

function cell(column, row, result, invest, fractional) {
  const value = row[column.key];
  switch (column.key) {
    case "date":
      return value;
    case "price":
    case "avg_cost_asset":
      return price(value, result.currency);
    case "fx":
      return result.currency === invest ? "—" : fx(value);
    case "qty":
    case "cum_qty":
      return qty(value, 4, { fixed: fractional });
    case "avg_cost_invest":
      return money(value, invest, { short: false });
    default:
      return money(value, invest);
  }
}

/**
 * 매수 내역 한 줄. 사지 않은 회차(산 수량 0, 레버리지 전환에서 쉰 날 등)는 산 수량 칸에 "쉼"을 적어
 * 알아보게 한다 (#41). 투자 통화 평단가가 없으면(매수 규칙, 결정 d39) "—"에 이유를 툴팁으로 단다.
 */
function buyRow(no, row, result, params) {
  const fractional = boughtFractional(params); // 매수 규칙은 정수 주만을 골라도 소수점 (9-6)
  const rest = isRest(row);
  return h(
    "tr",
    {},
    h("td", { class: "left muted", text: String(no) }),
    ...BUY_COLUMNS.map((c) => {
      if (c.key === "qty" && rest) {
        return h("td", {}, h("span", { class: "rest-tag", text: REST_LABEL }));
      }
      const note = c.key === "avg_cost_invest" ? avgInvestNote(params, row.avg_cost_invest) : null;
      return h("td", {
        class: c.key === "date" ? "left" : null,
        title: note,
        text: cell(c, row, result, params.currency, fractional),
      });
    }),
  );
}

function buysTable(data, result) {
  const invest = data.params.currency;
  // 매수 규칙(F-17) 결과라 투자 통화 평단가가 없는 행이 있으면 그 이유를 열 제목에 단다 (결정 d39)
  const avgWhy =
    result.buys.map((row) => avgInvestNote(data.params, row.avg_cost_invest)).find(Boolean) ??
    null;
  const view8 = previewRows(result.buys);
  const all = view.expanded || view8.hidden === 0;
  const rows = all
    ? result.buys.map((row, i) => buyRow(i + 1, row, result, data.params))
    : [
        ...view8.head.map((r) => buyRow(r.no, r.row, result, data.params)),
        h(
          "tr",
          { class: "gap" },
          h("td", {
            colspan: String(BUY_COLUMNS.length + 1),
            text: `⋯ ${view8.hidden.toLocaleString("ko-KR")}회 더 있음`,
          }),
        ),
        ...view8.tail.map((r) => buyRow(r.no, r.row, result, data.params)),
      ];
  return h(
    "table",
    { class: "tbl", "aria-label": `${result.symbol} 매수 내역` },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col", class: "left", text: "회차" }),
        ...BUY_COLUMNS.map((c) => {
          const why = c.key === "avg_cost_invest" ? avgWhy : null;
          return h(
            "th",
            { scope: "col", class: c.key === "date" ? "left" : null, title: why },
            c.title(invest),
            why ? h("span", { class: "sr", text: ` (${why})` }) : null,
          );
        }),
      ),
    ),
    h("tbody", {}, ...rows),
  );
}

/** 매수 내역 상자. 종목 고르기, 앞 6회 + 끝 2회, 전체 보기, CSV 내려받기. */
export function buysSection(data, slotOf) {
  view.expanded = false;
  const section = h("section", { class: "box", "aria-labelledby": "buys-h" });
  const toggle = (result) =>
    h("button", {
      type: "button",
      class: "link-btn",
      "aria-expanded": String(view.expanded),
      "data-focus": "buys-toggle",
      text: view.expanded ? "접기" : `전체 보기 (${result.buys.length.toLocaleString("ko-KR")}회)`,
      onclick: () => {
        view.expanded = !view.expanded;
        keepFocus(section, render);
      },
    });
  const render = () => {
    const symbols = data.results.map((r) => r.symbol);
    if (!symbols.includes(view.buySymbol)) view.buySymbol = symbols[0];
    const result = data.results.find((r) => r.symbol === view.buySymbol);
    const more = previewRows(result.buys).hidden > 0;
    const rests = restNote(data.params, result.buys); // "쉼: … · 60회 중 15회" (#41)
    const picker =
      data.results.length > 1
        ? segButtons(
            symbols.map((s) => ({ key: s, label: s, slot: slotOf(s) })),
            (o) => o.key === view.buySymbol,
            (o) => {
              view.buySymbol = o.key;
              view.expanded = false;
              keepFocus(section, render);
            },
            "매수 내역 종목",
          )
        : null;
    // 펼치기·접기는 머리에 둬서 2,500줄을 펼쳐도 버튼과 포커스가 제자리에 있다.
    // replaceChildren은 null을 "null" 글자로 넣으므로 빈 자리는 거른다
    const parts = [
      h(
        "div",
        { class: "box-head" },
        h("h3", { id: "buys-h", text: "매수 내역" }),
        picker,
        more ? toggle(result) : null,
        csvButton(data, "CSV 내려받기"),
      ),
      rests ? h("p", { class: "hint box-note", text: rests }) : null,
      h("div", { class: "scroll" }, buysTable(data, result)),
      more && !view.expanded ? h("div", { class: "box-foot" }, toggle(result)) : null,
    ];
    section.replaceChildren(...parts.filter(Boolean));
  };
  render();
  return section;
}
