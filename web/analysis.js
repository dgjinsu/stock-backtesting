// 분석 탭(F-14)을 그린다: 탭 맨 위 한 줄 → 묶음 상자들 → 탭 끝 안내.
// 글과 좌표는 analysisdata.js(DOM 없음)가 만들고, 여기서는 요소만 만든다. app.js와 charts.js는
// import하지 않는다 (색 자리는 slotOf로 받는다). 모듈 상태가 없어 다시 계산하면 통째로 새로 그린다
// (달마다·얼마에 샀나 상자의 고른 종목은 그 상자 안에만 있다).

import {
  NO_BUYS,
  NO_MONTHS,
  RISK_COLUMNS,
  analysisIntro,
  analysisNotes,
  buyPriceDist,
  buyPriceIntro,
  buyPriceText,
  drawdownAria,
  drawdownChart,
  drawdownLegend,
  fxIncluded,
  monthsGrid,
  monthsIntro,
  monthsStats,
  profitIntro,
  profitNotes,
  profitRows,
  riskIntro,
  riskRow,
  yearsFoot,
  yearsIntro,
  yearsTable,
} from "./analysisdata.js";
import { DASHES } from "./chartdata.js";
import { h, keepFocus, segButtons, svgEl, swatch } from "./dom.js";

// 낙폭 그래프 SVG 좌표 상자. 화면에서는 preserveAspectRatio="none"으로 판 크기에 맞춰 늘린다
const DD_W = 1000;
const DD_H = 300;

/** 분석 탭 패널의 자식들. slotOf(종목 코드)는 색·선 모양 자리(0~7)다. */
export function analysisPanel(data, slotOf) {
  return [
    h("p", { class: "an-intro", text: analysisIntro(data.params) }),
    riskBox(data, slotOf),
    // 두 줄 격자: 연도별 → 수익 분해 → 달마다 → 얼마에 샀나 순서 (시안). 수익 상자가 없으면 당긴다
    h(
      "div",
      { class: "an-grid" },
      yearsBox(data, slotOf),
      profitBox(data, slotOf),
      monthsBox(data, slotOf),
      buyPriceBox(data, slotOf),
    ),
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
        h("strong", { text: drawdownLegend(r) }),
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

// ---------- 연도별 결과 (F-14, 계산 규칙 9-2) ----------

/** 종목 열 머리: 견본과 코드. */
function symbolHead(result, slotOf) {
  return h(
    "th",
    { scope: "col" },
    h("span", { class: "th-sym" }, swatch(slotOf(result.symbol), 14), result.symbol),
  );
}

/** 칸: 그해 누적 수익률(굵게, 손익 색), 아래 작은 글 주가 등락, (칸마다면) 투자금. */
function yearCell({ text, sub, tone, invested }) {
  return h(
    "td",
    {},
    h("span", { class: tone ? `yr-ret ${tone}` : "yr-ret", text }),
    sub === null ? null : h("span", { class: "yr-sub", text: sub }),
    invested === null ? null : h("span", { class: "yr-sub", text: invested }),
  );
}

function yearsBox(data, slotOf) {
  const { results } = data;
  const { sharedInvested, rows } = yearsTable(results, data.params.currency);
  const foot = yearsFoot(results);
  const table = h(
    "table",
    { class: "tbl years-tbl", "aria-labelledby": "an-years-h" },
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col", class: "left", text: "연도" }),
        sharedInvested ? h("th", { scope: "col", text: "누적 투자금" }) : null,
        ...results.map((r) => symbolHead(r, slotOf)),
      ),
    ),
    h(
      "tbody",
      {},
      ...rows.map((row) =>
        h(
          "tr",
          {},
          h("th", { scope: "row", class: "left", text: row.year }),
          sharedInvested ? h("td", { class: "muted", text: row.invested }) : null,
          ...row.cells.map(yearCell),
        ),
      ),
    ),
  );
  return analysisBox(
    { id: "an-years-h", title: "연도별 결과", intro: yearsIntro(results) },
    h("div", { class: "scroll" }, table),
    foot ? h("p", { class: "hint an-foot", text: foot }) : null,
  );
}

// ---------- 달마다 얼마나 움직였나 (F-14, 계산 규칙 9-3) ----------

const MONTH_HEADS = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);

/** 히트맵 표: 행 머리 연도, 열 머리 1~12월. 칸 바탕 진하기는 --hm(0~1)로 CSS가 정한다. */
function heatTable(result, months) {
  return h(
    "div",
    { class: "scroll hm-scroll" },
    h(
      "table",
      { class: "tbl hm-tbl", "aria-label": `${result.symbol} 월별 수익률` },
      h(
        "thead",
        {},
        h("tr", {}, h("td", {}), ...MONTH_HEADS.map((m) => h("th", { scope: "col", text: m }))),
      ),
      h(
        "tbody",
        {},
        ...monthsGrid(months).map((row) =>
          h(
            "tr",
            {},
            h("th", { scope: "row", text: row.year }),
            ...row.cells.map((c) =>
              c === null
                ? h("td", {})
                : h("td", {
                    class: c.tone || null,
                    style: c.level ? `--hm: ${c.level}` : null,
                    text: c.text,
                  }),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 아래 세 칸 (오른 달 / 내린 달, 가장 크게 오른 달, 가장 크게 내린 달). */
function statsList(stats) {
  return h(
    "dl",
    { class: "an-stats" },
    ...stats.map((s) =>
      h("div", {}, h("dt", { text: s.title }), h("dd", { class: s.tone || null, text: s.text })),
    ),
  );
}

/**
 * 달마다 상자: 고른 종목 하나의 월별 히트맵. 처음은 첫 종목이고, 고르면 이 상자만 다시 그린다
 * (다른 상자와 app.js 상태는 그대로). 종목이 하나면 고르기 버튼이 없다 (매수 내역과 같다).
 */
function monthsBox(data, slotOf) {
  const { results } = data;
  const section = h("section", { class: "box", "aria-labelledby": "an-months-h" });
  let symbol = results[0]?.symbol;
  const render = () => {
    const result = results.find((r) => r.symbol === symbol);
    if (!result) return;
    const months = result.analysis?.months ?? {};
    const stats = monthsStats(months);
    const picker =
      results.length > 1
        ? segButtons(
            results.map((r) => ({ key: r.symbol, label: r.symbol, slot: slotOf(r.symbol) })),
            (item) => item.key === symbol,
            (item) => {
              symbol = item.key;
              keepFocus(section, render);
            },
            "월별 종목",
          )
        : null;
    section.replaceChildren(
      h(
        "div",
        { class: "box-head" },
        h("h3", { id: "an-months-h", text: "달마다 얼마나 움직였나" }),
        picker,
      ),
      h("p", { class: "hint box-note", text: monthsIntro(result, data.params) }),
      ...(stats
        ? [heatTable(result, months), statsList(stats)]
        : [h("p", { class: "an-empty", text: NO_MONTHS })]),
    );
  };
  render();
  return section;
}

// ---------- 수익은 어디서 왔나 (F-14, 계산 규칙 9-4) ----------

/** 금액 글. 손익 색은 보이는 값의 부호다. */
function toned(text, tone) {
  return h("span", { class: tone || null, text });
}

/**
 * 수익 상자. 종목 통화가 투자 통화와 다른 종목이 없으면 null (상자 없음, 9-4).
 * 응답 params.include_fx가 false면 환율 변동 제외 글로 쓴다 (F-24, 결정 d75). 없으면 켬이다.
 */
function profitBox(data, slotOf) {
  const { results, params } = data;
  const rows = profitRows(results, params.currency);
  if (!rows.length) return null;
  const options = { includeFx: fxIncluded(params) };
  const notes = profitNotes(results, params.currency, options);
  return analysisBox(
    {
      id: "an-profit-h",
      title: "수익은 어디서 왔나",
      intro: profitIntro(results, params.currency, options),
    },
    h(
      "ul",
      { class: "pf-list" },
      ...rows.map((row) => {
        const slot = slotOf(row.symbol);
        const bar = h("div", { class: "pf-bar" });
        bar.style.width = `${(row.width * 100).toFixed(2)}%`;
        bar.style.background = `var(--c${slot + 1})`;
        return h(
          "li",
          { class: "pf-row" },
          h(
            "span",
            { class: "pf-sym" },
            swatch(slot, 18),
            h("span", { class: "pf-code", text: row.symbol }),
          ),
          h(
            "div",
            { class: "pf-mid" },
            h("div", { class: "pf-track", "aria-hidden": "true" }, bar),
            h(
              "p",
              { class: "pf-sub" },
              "주가 효과 ",
              toned(row.price, row.priceTone),
              " · 환율 효과 ",
              toned(row.fx, row.fxTone),
            ),
          ),
          h(
            "strong",
            { class: row.tone ? `pf-total ${row.tone}` : "pf-total" },
            h("span", { class: "sr", text: "손익 " }),
            row.total,
          ),
        );
      }),
    ),
    notes.length
      ? h(
          "p",
          { class: "an-callout" },
          ...notes.flatMap((note, i) => [
            i ? " " : null,
            note.strong ? h("strong", { text: note.text }) : note.text,
          ]),
        )
      : null,
  );
}

// ---------- 얼마에 샀나 (F-14, 계산 규칙 9-1) ----------

/** 평단가·지금 가격 세로선. 글이 오른쪽 끝에 가까우면(flip) 선 왼쪽에 둔다. */
function priceLine(line, kind) {
  const el = h(
    "div",
    { class: `bp-line ${kind}`, "aria-hidden": "true" },
    h("span", { class: line.flip ? "bp-tag flip" : "bp-tag", text: line.label }),
  );
  el.style.left = `${(line.left * 100).toFixed(2)}%`;
  return el;
}

function buyPriceChart(result, dist, slot) {
  const bars = dist.bins.map((bin) => {
    const bar = h(
      "div",
      { class: "bp-bar", title: bin.title },
      h("span", { class: "bp-n", text: bin.count ? bin.count.toLocaleString("ko-KR") : "" }),
    );
    bar.style.setProperty("--h", String(bin.height));
    if (bin.filled) bar.style.background = `var(--c${slot + 1})`;
    return bar;
  });
  return [
    h(
      "div",
      { class: "bp-chart", role: "img", "aria-label": dist.aria },
      h("div", { class: "bp-bars" }, ...bars),
      dist.avg ? priceLine(dist.avg, "avg") : null,
      priceLine(dist.now, "now"),
    ),
    h(
      "div",
      { class: "bp-ends", "aria-hidden": "true" },
      h("span", { text: dist.loLabel }),
      h("span", { text: dist.hiLabel }),
    ),
    h("p", { class: "bp-text", text: buyPriceText(result) }),
  ];
}

/** 얼마에 샀나 상자: 고른 종목 하나의 매수 가격 분포. 고르기는 달마다 상자와 따로다. */
function buyPriceBox(data, slotOf) {
  const { results } = data;
  const section = h("section", { class: "box", "aria-labelledby": "an-buys-h" });
  let symbol = results[0]?.symbol;
  const render = () => {
    const result = results.find((r) => r.symbol === symbol);
    if (!result) return;
    const dist = buyPriceDist(result);
    const picker =
      results.length > 1
        ? segButtons(
            results.map((r) => ({ key: r.symbol, label: r.symbol, slot: slotOf(r.symbol) })),
            (item) => item.key === symbol,
            (item) => {
              symbol = item.key;
              keepFocus(section, render);
            },
            "매수 가격 종목",
          )
        : null;
    section.replaceChildren(
      h("div", { class: "box-head" }, h("h3", { id: "an-buys-h", text: "얼마에 샀나" }), picker),
      h("p", { class: "hint box-note", text: buyPriceIntro(result) }),
      dist
        ? h("div", { class: "box-body bp-body" }, ...buyPriceChart(result, dist, slotOf(symbol)))
        : h("p", { class: "an-empty", text: NO_BUYS }),
    );
  };
  render();
  return section;
}
