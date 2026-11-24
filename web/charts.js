// 결과 아래쪽: 그래프 3개(F-07)와 매수 내역·CSV(F-08). Chart.js 4는 index.html에서 불러온다.

import {
  BUY_COLUMNS,
  buysCsv,
  csvFileName,
  dashOf,
  investedLines,
  lastValue,
  logSafe,
  previewRows,
  sampledNote,
} from "./chartdata.js";
import { h, icon, swatch } from "./dom.js";
import { fx, money, pct, price, qty } from "./format.js";

const TABS = [
  { key: "value", label: "평가금·투자금" },
  { key: "return", label: "수익률" },
  { key: "price", label: "주가·평단가" },
];

/** 다시 계산해도 유지하는 보기 상태. */
const view = { tab: "value", log: false, priceSymbol: null, buySymbol: null, expanded: false };
let current = null; // { data, slotOf, chart, wrap, legend }

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, alpha) {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 마우스를 올린 날의 세로 기준선. */
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = cssVar("--axis");
    ctx.stroke();
    ctx.restore();
  },
};

// ---------- 그래프 데이터 ----------

function symbolLine(label, values, slot, extra = {}) {
  return {
    label,
    data: values,
    borderColor: cssVar(`--c${slot + 1}`),
    backgroundColor: cssVar(`--c${slot + 1}`),
    borderDash: dashOf(slot),
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 3,
    ...extra,
  };
}

function refLine(label, values, dash = []) {
  return {
    label,
    data: values,
    borderColor: cssVar("--ref"),
    backgroundColor: cssVar("--ref"),
    borderDash: dash,
    borderWidth: 1.5,
    stepped: true,
    pointRadius: 0,
    pointHoverRadius: 2,
  };
}

/** 지금 탭의 datasets, 값 형식, 범례 항목. */
function tabModel(data, slotOf) {
  const chart = data.chart;
  const invest = data.params.currency;
  const symbols = data.results.map((r) => r.symbol);
  if (view.tab === "return") {
    return {
      format: (v) => pct(v),
      tick: (v) => `${v}%`,
      datasets: symbols.map((s) => symbolLine(s, chart.series[s].return_pct, slotOf(s))),
      legend: symbols.map((s) => ({ slot: slotOf(s), label: s, value: pct(lastValue(chart.series[s].return_pct)) })),
      zeroLine: true,
    };
  }
  if (view.tab === "price") {
    const symbol = symbols.includes(view.priceSymbol) ? view.priceSymbol : symbols[0];
    view.priceSymbol = symbol;
    const cur = data.results.find((r) => r.symbol === symbol).currency;
    const series = chart.series[symbol];
    const pos = cssVar("--pos");
    const neg = cssVar("--neg");
    return {
      format: (v) => price(v, cur),
      tick: (v) => (v === 0 ? "0" : price(v, cur)),
      datasets: [
        symbolLine(`${symbol} 주가`, series.price, slotOf(symbol), {
          fill: { target: 1, above: withAlpha(pos, 0.12), below: withAlpha(neg, 0.12) },
        }),
        refLine("평단가", series.avg_cost),
      ],
      legend: [
        { slot: slotOf(symbol), label: `${symbol} 주가`, value: price(lastValue(series.price), cur) },
        { ref: true, label: "평단가", value: price(lastValue(series.avg_cost), cur) },
      ],
      hint: "주가가 평단가 위인 구간(초록)은 이익, 아래(빨강)는 손실입니다.",
    };
  }
  const invested = investedLines(chart, symbols);
  const prep = (values) => (view.log ? logSafe(values) : values);
  return {
    format: (v) => money(v, invest),
    tick: (v) => money(v, invest),
    datasets: [
      ...symbols.map((s) => symbolLine(s, prep(chart.series[s].value), slotOf(s))),
      ...invested.map((line) =>
        refLine(line.symbol ? `투자금 ${line.symbol}` : "투자금", prep(line.values), line.symbol ? dashOf(slotOf(line.symbol)) : []),
      ),
    ],
    legend: [
      ...symbols.map((s) => ({ slot: slotOf(s), label: s, value: money(lastValue(chart.series[s].value), invest) })),
      ...invested.map((line) => ({ ref: true, label: line.symbol ? `투자금 ${line.symbol}` : "투자금", value: money(lastValue(line.values), invest) })),
    ],
    log: view.log,
  };
}

// ---------- 그리기 ----------

function legendItems(items) {
  return items.map((item) =>
    h(
      "li",
      {},
      item.ref ? h("span", { class: "ref-swatch", "aria-hidden": "true" }) : swatch(item.slot, 22),
      h("span", { class: "lg-label", text: item.label }),
      h("strong", { text: item.value }),
    ),
  );
}

function draw() {
  if (!current) return;
  current.chart?.destroy();
  current.chart = null;
  const { data, slotOf, wrap, legend, hint } = current;
  const model = tabModel(data, slotOf);
  legend.replaceChildren(...legendItems(model.legend));
  hint.textContent = model.hint ?? "";
  hint.hidden = !model.hint;
  const ChartJs = globalThis.Chart;
  if (!ChartJs) {
    wrap.replaceChildren(
      h("p", { class: "chart-missing", text: "그래프 도구(Chart.js)를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요. 위의 숫자와 아래 매수 내역은 그대로 볼 수 있습니다." }),
    );
    return;
  }
  const canvas = h("canvas", {
    role: "img",
    "aria-label": `${TABS.find((t) => t.key === view.tab).label} 그래프. ${model.legend.map((i) => `${i.label} 마지막 ${i.value}`).join(", ")}`,
  });
  wrap.replaceChildren(canvas);
  const axis = cssVar("--axis");
  const grid = cssVar("--grid");
  ChartJs.defaults.font.family = getComputedStyle(document.body).fontFamily;
  current.chart = new ChartJs(canvas, {
    type: "line",
    data: { labels: data.chart.dates, datasets: model.datasets },
    plugins: [crosshair],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          border: { color: cssVar("--line2") },
          ticks: {
            color: axis,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            callback(value) {
              return String(this.getLabelForValue(value)).slice(0, 7);
            },
          },
        },
        y: {
          type: model.log ? "logarithmic" : "linear",
          border: { display: false },
          grid: {
            color: (ctx) => (model.zeroLine && ctx.tick?.value === 0 ? axis : grid),
            lineWidth: (ctx) => (model.zeroLine && ctx.tick?.value === 0 ? 2 : 1),
          },
          ticks: { color: axis, maxTicksLimit: 7, callback: (value) => model.tick(Number(value)) },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar("--tip"),
          titleColor: cssVar("--tipfg"),
          bodyColor: cssVar("--tipfg"),
          padding: 10,
          boxPadding: 4,
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

function segButtons(items, isOn, onPick, label) {
  const group = h("div", { class: "seg inline-seg", role: "group", "aria-label": label });
  for (const item of items) {
    const on = isOn(item);
    group.append(
      h(
        "button",
        { type: "button", class: on ? "on" : null, "aria-pressed": String(on), onclick: () => onPick(item) },
        item.slot === undefined ? null : swatch(item.slot, 16),
        item.label,
      ),
    );
  }
  return group;
}

function chartTools(data, slotOf) {
  const tools = h("div", { class: "chart-tools" });
  const rebuild = () => {
    tools.replaceChildren(...chartToolsChildren(data, slotOf, rebuild));
    draw();
  };
  tools.replaceChildren(...chartToolsChildren(data, slotOf, rebuild));
  return tools;
}

function chartToolsChildren(data, slotOf, rebuild) {
  const children = [
    segButtons(TABS, (t) => t.key === view.tab, (t) => {
      view.tab = t.key;
      rebuild();
    }, "그래프 종류"),
  ];
  if (view.tab === "value") {
    children.push(
      segButtons(
        [{ key: false, label: "일반" }, { key: true, label: "로그" }],
        (o) => o.key === view.log,
        (o) => {
          view.log = o.key;
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
  return children;
}

/** 그래프 상자. 요소를 문서에 붙인 뒤(같은 작업 안) 그린다. */
export function chartSection(data, slotOf) {
  current?.chart?.destroy();
  const wrap = h("div", { class: "chart-wrap" });
  const legend = h("ul", { class: "legend", "aria-label": "범례와 마지막 값" });
  const hint = h("p", { class: "hint", hidden: true });
  current = { data, slotOf, chart: null, wrap, legend, hint };
  const note = sampledNote(data.chart);
  queueMicrotask(draw);
  return h(
    "section",
    { class: "box", "aria-labelledby": "chart-h" },
    h("div", { class: "box-head" }, h("h3", { id: "chart-h", text: "그래프" }), chartTools(data, slotOf)),
    h("div", { class: "box-body" }, legend, wrap, hint, note ? h("p", { class: "hint", text: note }) : null),
  );
}

document.addEventListener("themechange", () => draw());

// ---------- 매수 내역과 CSV (F-08) ----------

function downloadCsv(data) {
  const text = buysCsv(data.results, data.params.currency);
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = h("a", { href: url, download: csvFileName({ ...data.params, symbols: data.results.map((r) => r.symbol) }) });
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
    { type: "button", class: "btn2", title: "모든 종목의 매수 내역 (엑셀에서 열 수 있는 UTF-8 CSV)", onclick: () => downloadCsv(data) },
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

function buyRow(no, row, result, params) {
  return h(
    "tr",
    {},
    h("td", { class: "left muted", text: String(no) }),
    ...BUY_COLUMNS.map((c) => h("td", { class: c.key === "date" ? "left" : null, text: cell(c, row, result, params.currency, params.fractional) })),
  );
}

function buysTable(data, result) {
  const invest = data.params.currency;
  const view8 = previewRows(result.buys);
  const all = view.expanded || view8.hidden === 0;
  const rows = all
    ? result.buys.map((row, i) => buyRow(i + 1, row, result, data.params))
    : [
        ...view8.head.map((r) => buyRow(r.no, r.row, result, data.params)),
        h("tr", { class: "gap" }, h("td", { colspan: String(BUY_COLUMNS.length + 1), text: `⋯ ${view8.hidden.toLocaleString("ko-KR")}회 더 있음` })),
        ...view8.tail.map((r) => buyRow(r.no, r.row, result, data.params)),
      ];
  return h(
    "table",
    { class: "tbl", "aria-label": `${result.symbol} 매수 내역` },
    h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "left", text: "회차" }), ...BUY_COLUMNS.map((c) => h("th", { scope: "col", class: c.key === "date" ? "left" : null, text: c.title(invest) })))),
    h("tbody", {}, ...rows),
  );
}

/** 매수 내역 상자. 종목 고르기, 앞 6회 + 끝 2회, 전체 보기, CSV 내려받기. */
export function buysSection(data, slotOf) {
  view.expanded = false;
  const section = h("section", { class: "box", "aria-labelledby": "buys-h" });
  const render = () => {
    const symbols = data.results.map((r) => r.symbol);
    if (!symbols.includes(view.buySymbol)) view.buySymbol = symbols[0];
    const result = data.results.find((r) => r.symbol === view.buySymbol);
    const more = result.buys.length > 8;
    section.replaceChildren(
      h(
        "div",
        { class: "box-head" },
        h("h3", { id: "buys-h", text: "매수 내역" }),
        data.results.length > 1
          ? segButtons(
              symbols.map((s) => ({ key: s, label: s, slot: slotOf(s) })),
              (o) => o.key === view.buySymbol,
              (o) => {
                view.buySymbol = o.key;
                view.expanded = false;
                render();
              },
              "매수 내역 종목",
            )
          : null,
        csvButton(data, "CSV 내려받기"),
      ),
      h("div", { class: "scroll" }, buysTable(data, result)),
      more
        ? h(
            "div",
            { class: "box-foot" },
            h("button", {
              type: "button",
              class: "link-btn",
              "aria-expanded": String(view.expanded),
              text: view.expanded ? "접기" : `전체 보기 (${result.buys.length.toLocaleString("ko-KR")}회)`,
              onclick: () => {
                view.expanded = !view.expanded;
                render();
              },
            }),
          )
        : null,
    );
  };
  render();
  return section;
}
