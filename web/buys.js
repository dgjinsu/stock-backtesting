// 매수 내역 탭(F-16)을 그린다: 탭 머리 → 고르기 줄 → 요약 칸 → 표(15줄 쪽, 분할 줄) → 열 설명과 쪽 번호.
// 글과 거르기·쪽 계산은 buysdata.js(DOM 없음)가 하고, 여기서는 요소만 만든다. app.js와 charts.js는
// import하지 않는다 (색 자리는 slotOf로 받는다). CSV 내려받기 버튼도 여기 있다 (결과 머리와 탭 머리).

import {
  BUYS_INTRO,
  CHEAP_LABEL,
  NO_ROWS,
  RETURN_COLUMNS,
  buyCell,
  buyYears,
  buysPage,
  buysSummary,
  cheapLocked,
  columnsNote,
  nextView,
  pageItems,
  returnCell,
} from "./buysdata.js";
import { BUY_COLUMNS, REST_LABEL, buysCsv, csvFileName, isRest, restNote } from "./chartdata.js";
import { h, icon, keepFocus, segButtons } from "./dom.js";
import { avgInvestNote } from "./results.js";

// 보는 종목·연도·체크·쪽. 다시 계산하면 종목은 결과에 있으면 그대로, 나머지는 처음으로 (buysSection)
let view = { symbol: null, year: null, cheap: false, page: 1 };

const COLS = 1 + BUY_COLUMNS.length + RETURN_COLUMNS.length; // 회차 + 열들 (분할 줄 colspan)

// ---------- CSV (F-08) ----------

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

/** 결과 머리의 [CSV]와 매수 내역 탭 머리의 [CSV 내려받기]. 모든 종목의 매수 내역을 내려받는다. */
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

// ---------- 표 ----------

/**
 * 매수 내역 한 줄. 사지 않은 회차는 산 수량 칸에 "쉼"을 적어 알아보게 한다 (#41). 투자 통화 평단가가
 * 없으면(매수 규칙, 결정 d39) "—"에 이유를 툴팁으로 단다. 두 열은 손익 색과 기호, 이 회차 지금은 굵게.
 */
function buyRow(no, row, result, params) {
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
        text: buyCell(c.key, row, result, params),
      });
    }),
    ...RETURN_COLUMNS.map((c) => {
      const cell = returnCell(row[c.key]);
      const cls = [cell.tone, c.strong ? "bt-lot" : ""].filter(Boolean).join(" ");
      return h("td", { class: cls || null, text: cell.text });
    }),
  );
}

function splitRow(line) {
  return h(
    "tr",
    { class: "bt-split" },
    h("td", { colspan: String(COLS), class: "left", text: line.text }),
  );
}

function buysTable(data, result, out) {
  const invest = data.params.currency;
  // 매수 규칙(F-17) 결과라 투자 통화 평단가가 없는 행이 있으면 그 이유를 열 제목에 단다 (결정 d39)
  const avgWhy =
    result.buys.map((row) => avgInvestNote(data.params, row.avg_cost_invest)).find(Boolean) ?? null;
  const rows = out.total
    ? out.lines.map((line) =>
        line.kind === "split" ? splitRow(line) : buyRow(line.no, line.row, result, data.params),
      )
    : [h("tr", { class: "bt-empty" }, h("td", { colspan: String(COLS), text: NO_ROWS }))];
  return h(
    "table",
    { class: "tbl bt-tbl", "aria-label": `${result.symbol} 매수 내역` },
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
        ...RETURN_COLUMNS.map((c) => h("th", { scope: "col", text: c.title })),
      ),
    ),
    h("tbody", {}, ...rows),
  );
}

/** 쪽 번호 (nav, 지금 쪽은 aria-current). 한 쪽뿐이면 null. */
function pager(out, onPage) {
  if (out.pages <= 1) return null;
  return h(
    "nav",
    { class: "bt-pages", "aria-label": "쪽" },
    ...pageItems(out.page, out.pages).map((p) =>
      p === null
        ? h("span", { class: "bt-gap", "aria-hidden": "true", text: "…" })
        : h("button", {
            type: "button",
            class: p === out.page ? "bt-pg on" : "bt-pg",
            "aria-current": p === out.page ? "page" : null,
            "aria-label": `${p}쪽`,
            "data-focus": `buys-page:${p}`,
            text: String(p),
            onclick: () => onPage(p),
          }),
    ),
  );
}

// ---------- 요약 칸 ----------

function summaryList(result, params) {
  return h(
    "dl",
    { class: "bt-sum" },
    ...buysSummary(result, params).map((cell) =>
      h(
        "div",
        { class: "bt-sum-cell" },
        h("dt", { text: cell.label }),
        h(
          "dd",
          { class: "mono", title: cell.title },
          cell.text,
          cell.sub === null ? null : [" ", h("span", { class: "bt-sub", text: cell.sub })],
          cell.title ? h("span", { class: "sr", text: ` (${cell.title})` }) : null,
        ),
      ),
    ),
  );
}

// ---------- 탭 ----------

/** 매수 내역 탭 패널의 내용. slotOf(종목 코드)는 색·선 모양 자리(0~7)다. */
export function buysSection(data, slotOf) {
  const symbols = data.results.map((r) => r.symbol);
  view = {
    symbol: symbols.includes(view.symbol) ? view.symbol : symbols[0],
    year: null,
    cheap: false,
    page: 1,
  };
  const resultOf = () => data.results.find((r) => r.symbol === view.symbol);

  // 뼈대는 한 번만 만든다. 상태 글(aria-live)은 다시 만들지 않고 글만 바꿔야 읽어 준다
  const seg = h("div", { class: "bt-seg" });
  const year = h("select", { id: "buys-year", class: "field" });
  const cheap = h("input", { type: "checkbox", id: "buys-cheap" });
  const lockNote = h("span", { class: "hint", text: "(지금 평단가가 없어 고를 수 없습니다)" });
  const status = h("p", { id: "buys-status", class: "bt-status", "aria-live": "polite" });
  const top = h("div", { class: "bt-top" });
  const rests = h("p", { class: "hint bt-rest" });
  const tableWrap = h("div", { class: "scroll bt-scroll" });
  const foot = h("div", { class: "bt-foot" });
  const box = h("section", { class: "box bt-box", "aria-label": "매수 내역 표" }, tableWrap, foot);

  const renderTable = () => {
    const result = resultOf();
    const out = buysPage(result, view);
    view = { ...view, year: out.year, cheap: out.cheap, page: out.page };
    year.value = out.year ?? "all";
    cheap.checked = out.cheap;
    status.textContent = out.status;
    tableWrap.replaceChildren(buysTable(data, result, out));
    const pages = pager(out, (p) => {
      view = nextView(view, { page: p });
      keepFocus(foot, renderTable);
    });
    foot.replaceChildren(
      ...[h("p", { class: "hint", text: columnsNote(data.params, result) }), pages].filter(Boolean),
    );
  };

  const renderSymbol = () => {
    const result = resultOf();
    seg.hidden = data.results.length <= 1; // 종목이 하나면 빈 자리도 flex 틈을 만들어 숨긴다
    seg.replaceChildren(
      ...(data.results.length > 1
        ? [
            segButtons(
              symbols.map((s) => ({ key: s, label: s, slot: slotOf(s) })),
              (o) => o.key === view.symbol,
              (o) => {
                view = nextView(view, { symbol: o.key });
                keepFocus(seg, () => {
                  renderSymbol();
                  renderTable();
                });
              },
              "매수 내역 종목",
            ),
          ]
        : []),
    );
    year.replaceChildren(
      h("option", { value: "all", text: "전체" }),
      ...buyYears(result.buys).map((y) => h("option", { value: y, text: y })),
    );
    const locked = cheapLocked(result);
    cheap.disabled = locked;
    lockNote.hidden = !locked; // disabled 체크는 Tab이 가지 않아 잠근 이유를 글로 보인다
    top.replaceChildren(summaryList(result, data.params));
    const note = restNote(data.params, result.buys); // "쉼: … · 60회 중 15회" (#41)
    rests.textContent = note ?? "";
    rests.hidden = !note;
  };

  year.addEventListener("change", () => {
    view = nextView(view, { year: year.value === "all" ? null : year.value });
    renderTable();
  });
  cheap.addEventListener("change", () => {
    view = nextView(view, { cheap: cheap.checked });
    renderTable();
  });

  renderSymbol();
  renderTable();
  return h(
    "div",
    { class: "bt" },
    h(
      "div",
      { class: "bt-head" },
      h("div", {}, h("h3", { text: "매수 내역" }), h("p", { class: "bt-intro", text: BUYS_INTRO })),
      csvButton(data, "CSV 내려받기"),
    ),
    h(
      "div",
      { class: "bt-pick" },
      seg,
      h("label", { class: "bt-year", for: "buys-year" }, "연도", year),
      h("label", { class: "bt-check", for: "buys-cheap" }, cheap, CHEAP_LABEL, lockNote),
      status,
    ),
    top,
    rests,
    box,
  );
}
