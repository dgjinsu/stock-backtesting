// 분석 탭(F-14)을 그린다: 탭 맨 위 한 줄 → 묶음 상자들 → 탭 끝 안내.
// 글과 좌표는 analysisdata.js(DOM 없음)가 만들고, 여기서는 요소만 만든다. app.js와 charts.js는
// import하지 않는다 (색 자리는 slotOf로 받는다). 모듈 상태가 없어 다시 계산하면 통째로 새로 그린다.

import {
  RISK_COLUMNS,
  analysisIntro,
  analysisNotes,
  drawdownAria,
  drawdownChart,
  riskIntro,
  riskRow,
} from "./analysisdata.js";
import { DASHES } from "./chartdata.js";
import { h, svgEl, swatch } from "./dom.js";
import { pct } from "./format.js";

// 낙폭 그래프 SVG 좌표 상자. 화면에서는 preserveAspectRatio="none"으로 판 크기에 맞춰 늘린다
const DD_W = 1000;
const DD_H = 300;

/** 분석 탭 패널의 자식들. slotOf(종목 코드)는 색·선 모양 자리(0~7)다. */
export function analysisPanel(data, slotOf) {
  return [
    h("p", { class: "an-intro", text: analysisIntro(data.params) }),
    riskBox(data, slotOf),
    h("ul", { class: "an-notes" }, ...analysisNotes(data).map((text) => h("li", { text }))),
  ];
}

/** 묶음 상자: 제목, 그 아래 설명 한 줄, 내용. 네 탭이 한 문서에 있어 id에 an- 접두를 붙인다. */
function analysisBox({ id, title, intro }, ...body) {
  return h(
    "section",
    { class: "box", "aria-labelledby": id },
    h("div", { class: "box-head" }, h("h3", { id, text: title })),
    intro ? h("p", { class: "hint box-note", text: intro }) : null,
    ...body,
  );
}

// ---------- 얼마나 흔들렸나 (F-14, 계산 규칙 9-1) ----------

function riskBox(data, slotOf) {
  return analysisBox(
    { id: "an-risk-h", title: "얼마나 흔들렸나", intro: riskIntro(data.results) },
    h("div", { class: "scroll" }, riskTable(data.results, slotOf)),
    h("div", { class: "box-body dd-body" }, ...drawdownFigure(data, slotOf)),
  );
}

/** 칸: 값(손익 색), 공백, 작은 글(회색). 정렬과 굵게는 없다. */
function riskCell({ text, sub, tone }) {
  return h(
    "td",
    {},
    h("span", { class: tone || null, text }),
    sub === null ? null : [" ", h("span", { class: "muted", text: sub })],
  );
}

function riskTable(results, slotOf) {
  return h(
    "table",
    { class: "tbl risk-tbl", "aria-labelledby": "an-risk-h" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col", class: "left", text: "종목" }),
        ...RISK_COLUMNS.map((c) => h("th", { scope: "col", text: c.title })),
      ),
    ),
    h(
      "tbody",
      {},
      ...results.map((r) => {
        const row = riskRow(r);
        return h(
          "tr",
          {},
          h(
            "th",
            { scope: "row", class: "sym-cell" },
            h("span", {}, swatch(slotOf(r.symbol), 18), r.symbol),
          ),
          ...row.cells.map(riskCell),
        );
      }),
    ),
  );
}

/** 낙폭 그래프: 소제목과 범례, 세로 눈금·판(SVG), 가로 눈금. 그릴 날짜가 없으면 아무것도 없다. */
function drawdownFigure(data, slotOf) {
  const symbols = data.results.map((r) => r.symbol);
  const dd = drawdownChart(data.chart, symbols, { width: DD_W, height: DD_H });
  if (!dd) return [];
  const legend = h(
    "ul",
    { class: "legend", "aria-label": "범례와 최대 낙폭" },
    ...data.results.map((r) =>
      h(
        "li",
        {},
        swatch(slotOf(r.symbol), 22),
        h("span", { class: "lg-label", text: r.symbol }),
        h("strong", {
          text: r.summary.max_drawdown ? pct(r.summary.max_drawdown.pct, 1) : "낙폭 없음",
        }),
      ),
    ),
  );
  const svg = svgEl("svg", {
    class: "dd-svg",
    viewBox: `0 0 ${DD_W} ${DD_H}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": drawdownAria(data.results),
  });
  // 결과 순서를 거꾸로 그려 첫 종목이 맨 위에 보인다 (시안)
  for (const line of [...dd.lines].reverse()) {
    if (!line.path) continue;
    const slot = slotOf(line.symbol);
    const path = svgEl("path", {
      class: "dd-line",
      d: line.path,
      "vector-effect": "non-scaling-stroke",
    });
    path.style.stroke = `var(--c${slot + 1})`;
    if (DASHES[slot]) path.style.strokeDasharray = DASHES[slot];
    svg.append(path);
  }
  const at = (ratio) => `${(ratio * 100).toFixed(2)}%`;
  return [
    h("div", { class: "dd-head" }, h("h4", { text: "평가금 최고점 대비 낙폭" }), legend),
    h(
      "div",
      { class: "dd-chart" },
      // 눈금 글은 HTML로 둔다 (SVG 글자는 viewBox를 따라 늘어난다). 읽는 값은 svg의 aria-label에 있다
      h(
        "div",
        { class: "dd-y", "aria-hidden": "true" },
        ...dd.yTicks.map((t) => h("span", { style: `top: ${at(t.top)}`, text: t.label })),
      ),
      h(
        "div",
        { class: "dd-plot" },
        ...dd.yTicks.map((t) =>
          h("div", { class: t.top === 0 ? "dd-grid zero" : "dd-grid", style: `top: ${at(t.top)}` }),
        ),
        svg,
      ),
    ),
    h(
      "div",
      { class: "dd-x", "aria-hidden": "true" },
      ...dd.xTicks.map((t) => h("span", { style: `left: ${at(t.left)}`, text: t.label })),
    ),
  ];
}
