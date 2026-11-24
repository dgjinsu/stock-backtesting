// 적립식 백테스트 화면: 조건 패널, 검색, 입력 검사, 주소 공유, 결과(카드·비교 표·알림·안내).
// 계산은 서버(/api/backtest)가 하고 여기서는 입력을 받고 결과를 그린다 (아키텍처 1절).

import {
  ALL_START,
  MAX_SYMBOLS,
  SYMBOL_PATTERN,
  anchorOf,
  estimateBuys,
  readQuery,
  shiftYears,
  toQuery,
  todayKst,
  validate as validateCond,
} from "./conditions.js";
import { h, icon, swatch } from "./dom.js";
import { fx, money, pct, period, price, qty, signedMoney } from "./format.js";

const WEEKDAYS = ["월요일", "화요일", "수요일", "목요일", "금요일"];
const DEFAULT_SYMBOLS = ["QQQ", "QLD"];

const $ = (id) => document.getElementById(id);

const state = {
  symbols: [], // { code, name, slot }
  start: "",
  end: "",
  freq: "monthly",
  monthDay: 1,
  weekDay: 0,
  amount: 2_000_000,
  currency: "KRW",
  fractional: true,
  fee: 0,
  loading: false,
  result: null,
  serverErrors: {},
  badSymbols: new Map(), // code → 이유
};

// ---------- 작은 도우미 ----------

/** 지금 조건 (conditions.js의 cond 모양). */
function cond() {
  return { ...state, codes: state.symbols.map((s) => s.code) };
}

function freqText() {
  if (state.freq === "daily") return "매일";
  if (state.freq === "weekly") return `매주 ${WEEKDAYS[state.weekDay]}`;
  return state.monthDay === 31 ? "매월 말일" : `매월 ${state.monthDay}일`;
}

function investLabel(currency) {
  return currency === "KRW" ? "원화" : currency === "USD" ? "달러" : currency;
}

// ---------- 입력 검사 (F-02, F-04, F-10) ----------

const FIELD_ERROR_IDS = { symbols: "sym-error", start: "start-error", end: "end-error", amount: "amount-error", fee: "fee-error" };
const FIELD_INPUT_IDS = { symbols: "sym-search", start: "start", end: "end", amount: "amount", fee: "fee" };

function validate() {
  return validateCond(cond(), todayKst());
}

function showErrors(clientErrors) {
  const errors = { ...state.serverErrors, ...clientErrors };
  for (const [field, id] of Object.entries(FIELD_ERROR_IDS)) {
    const box = $(id);
    let message = errors[field];
    if (field === "symbols" && !message && state.badSymbols.size) {
      message = [...state.badSymbols].map(([code, why]) => `${code}: ${why}`).join(" · ");
    }
    box.textContent = message ?? "";
    box.hidden = !message;
    const input = $(FIELD_INPUT_IDS[field]);
    if (errors[field]) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
  const others = Object.entries(errors).filter(([field]) => !(field in FIELD_ERROR_IDS));
  if (others.length) $("status").textContent = others.map(([, m]) => m).join(" · ");
  $("run").disabled = state.loading || Object.keys(clientErrors).length > 0;
}

// ---------- 조건 패널 그리기 ----------

function renderSymbols() {
  const list = $("sym-list");
  list.replaceChildren(
    ...state.symbols.map((s) =>
      h(
        "li",
        { class: state.badSymbols.has(s.code) ? "sym bad" : "sym" },
        swatch(s.slot),
        h("strong", { text: s.code }),
        h("span", { class: "nm", text: s.name || "" }),
        h(
          "button",
          { type: "button", class: "x", "aria-label": `${s.code} 빼기`, onclick: () => removeSymbol(s.code) },
          icon(["M6 6l12 12M18 6L6 18"], 14),
        ),
      ),
    ),
  );
  $("sym-count").textContent = `${state.symbols.length} / ${MAX_SYMBOLS}`;
}

function renderPreview() {
  const preview = $("amount-preview");
  if (!(state.amount > 0) || !state.start || !state.end || state.start >= state.end) {
    preview.textContent = "";
    return;
  }
  if (state.start === ALL_START) {
    preview.textContent = "상장일부터 끝날짜까지 · 매수 횟수는 종목마다 다릅니다";
    return;
  }
  const count = estimateBuys(cond());
  const each = money(count * state.amount, state.currency);
  const n = state.symbols.length;
  const total = n > 1 ? ` · ${n}종목 합계 ${money(count * state.amount * n, state.currency)}` : "";
  preview.textContent = `약 ${count.toLocaleString("ko-KR")}회 · 종목당 ${each}${total}`;
}

function setOn(groupId, matches) {
  for (const button of $(groupId).querySelectorAll("button")) {
    const on = matches(button);
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

function renderForm() {
  $("start").value = state.start;
  $("end").value = state.end;
  $("end").max = todayKst();
  $("start").max = todayKst();
  setOn("period", (b) => {
    const key = b.dataset.years;
    return key === "all" ? state.start === ALL_START : state.start === shiftYears(state.end, Number(key));
  });
  setOn("freq", (b) => b.dataset.freq === state.freq);
  $("monthly-row").hidden = state.freq !== "monthly";
  $("weekly-row").hidden = state.freq !== "weekly";
  $("daily-row").hidden = state.freq !== "daily";
  $("month-day").value = String(state.monthDay);
  $("week-day").value = String(state.weekDay);
  if (document.activeElement !== $("amount")) $("amount").value = state.amount ? state.amount.toLocaleString("ko-KR") : "";
  $("amount-unit").textContent = state.currency === "KRW" ? "원" : "$";
  $("currency").value = state.currency;
  setOn("mode", (b) => (b.dataset.fractional === "true") === state.fractional);
  if (document.activeElement !== $("fee")) $("fee").value = String(state.fee);
  $("advanced-summary").textContent = `· ${state.fractional ? "소수점" : "정수 주"} · 수수료 ${state.fee}%`;
  renderSymbols();
  renderPreview();
}

function changed() {
  state.serverErrors = {};
  renderForm();
  showErrors(validate());
}

// ---------- 종목 넣고 빼기와 검색 (F-01) ----------

function addSymbol(code, name = "") {
  const upper = code.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(upper)) {
    state.serverErrors = { symbols: `종목 코드 형식이 올바르지 않습니다: '${code}'` };
    showErrors(validate());
    return;
  }
  if (state.symbols.some((s) => s.code === upper)) return;
  if (state.symbols.length >= MAX_SYMBOLS) {
    state.serverErrors = { symbols: `종목은 ${MAX_SYMBOLS}개까지 넣을 수 있습니다` };
    showErrors(validate());
    return;
  }
  const used = new Set(state.symbols.map((s) => s.slot));
  const slot = [...Array(MAX_SYMBOLS).keys()].find((i) => !used.has(i));
  state.symbols.push({ code: upper, name, slot });
  $("sym-search").value = "";
  closeList();
  changed();
}

function removeSymbol(code) {
  state.symbols = state.symbols.filter((s) => s.code !== code);
  state.badSymbols.delete(code);
  changed();
}

const search = { timer: 0, abort: null, options: [], active: -1 };

function closeList() {
  const list = $("sym-results");
  list.hidden = true;
  list.replaceChildren();
  $("sym-search").setAttribute("aria-expanded", "false");
  $("sym-search").removeAttribute("aria-activedescendant");
  search.options = [];
  search.active = -1;
}

function showNote(text) {
  const list = $("sym-results");
  list.replaceChildren(h("li", { class: "note", role: "presentation", text }));
  list.hidden = false;
  $("sym-search").setAttribute("aria-expanded", "true");
  search.options = [];
  search.active = -1;
}

function renderHits(query, hits) {
  const list = $("sym-results");
  const typed = query.trim().toUpperCase();
  const added = new Set(state.symbols.map((s) => s.code));
  search.options = hits.map((hit) => ({ code: hit.symbol, name: hit.name, disabled: added.has(hit.symbol), meta: `${hit.exchange} · ${hit.type}` }));
  if (SYMBOL_PATTERN.test(typed) && !search.options.some((o) => o.code === typed)) {
    search.options.push({ code: typed, name: "입력한 코드 그대로 넣기", disabled: added.has(typed), meta: "검색 결과에 없어도 넣을 수 있습니다" });
  }
  if (!search.options.length) {
    showNote("결과가 없습니다. 코드나 영문 이름으로 찾아 주세요");
    return;
  }
  list.replaceChildren(
    ...search.options.map((o, i) =>
      h(
        "li",
        {
          id: `sym-opt-${i}`,
          role: "option",
          "aria-selected": "false",
          "aria-disabled": o.disabled ? "true" : null,
          onmousedown: (event) => {
            event.preventDefault();
            if (!o.disabled) addSymbol(o.code, o.name === "입력한 코드 그대로 넣기" ? "" : o.name);
          },
        },
        h("strong", { text: o.code }),
        h("span", { class: "nm", text: o.disabled ? `${o.name} · 추가됨` : o.name }),
        h("span", { class: "meta", text: o.meta }),
      ),
    ),
  );
  list.hidden = false;
  $("sym-search").setAttribute("aria-expanded", "true");
  search.active = -1;
}

async function runSearch(query) {
  search.abort?.abort();
  search.abort = new AbortController();
  showNote("찾는 중…");
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: search.abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderHits(query, await response.json());
  } catch (error) {
    if (error.name === "AbortError") return;
    showNote("검색하지 못했습니다. 코드를 그대로 쓰고 Enter를 누르면 넣을 수 있습니다");
  }
}

function moveActive(step) {
  const enabled = search.options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return;
  const at = enabled.indexOf(search.active);
  search.active = enabled[(at + step + enabled.length) % enabled.length];
  for (const [i, li] of [...$("sym-results").querySelectorAll('[role="option"]')].entries()) {
    li.setAttribute("aria-selected", String(i === search.active));
  }
  $("sym-search").setAttribute("aria-activedescendant", `sym-opt-${search.active}`);
}

function wireSearch() {
  const input = $("sym-search");
  input.addEventListener("input", () => {
    clearTimeout(search.timer);
    const query = input.value.trim();
    if (!query) {
      closeList();
      return;
    }
    search.timer = setTimeout(() => runSearch(query), 300);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = search.options[search.active];
      if (option && !option.disabled) addSymbol(option.code, option.name === "입력한 코드 그대로 넣기" ? "" : option.name);
      else if (input.value.trim()) addSymbol(input.value);
    } else if (event.key === "Escape") {
      closeList();
    }
  });
  input.addEventListener("blur", () => setTimeout(closeList, 150));
}

// ---------- 계산하기 ----------

function setLoading(on) {
  state.loading = on;
  $("run").disabled = on || Object.keys(validate()).length > 0;
  $("run").querySelector(".spinner").hidden = !on;
  $("run-label").textContent = on ? "계산 중…" : "계산하기";
  $("status").textContent = on ? `${state.symbols.length}개 종목 주가를 받고 계산하는 중입니다` : "";
  $("output").classList.toggle("dim", on);
  if (on && $("output").hidden) {
    $("empty").replaceChildren(h("p", { class: "empty-title", text: "계산하는 중입니다…" }), h("p", { class: "muted", text: "처음 보는 종목은 Yahoo Finance에서 주가를 받느라 몇 초 걸립니다." }));
  }
}

async function run() {
  const errors = validate();
  showErrors(errors);
  if (Object.keys(errors).length || state.loading) return;
  setLoading(true);
  const body = {
    symbols: state.symbols.map((s) => s.code),
    start: state.start,
    end: state.end,
    freq: state.freq,
    anchor: anchorOf(state),
    amount: state.amount,
    currency: state.currency,
    fractional: state.fractional,
    fee_pct: state.fee,
  };
  try {
    const response = await fetch("/api/backtest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 422) {
      const detail = (await response.json()).detail ?? [];
      state.serverErrors = Object.fromEntries(detail.map((d) => [d.field, d.message]));
      setLoading(false);
      showErrors(validate());
      if (!$("status").textContent) $("status").textContent = "입력을 확인해 주세요";
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.result = data;
    state.badSymbols = new Map(data.errors.map((e) => [e.symbol, e.message]));
    for (const result of data.results) {
      const entry = state.symbols.find((s) => s.code === result.symbol);
      if (entry) entry.name = result.name;
    }
    history.replaceState(null, "", `?${toQuery(cond())}`);
    setLoading(false);
    renderForm();
    showErrors(validate());
    renderResult(data);
  } catch {
    setLoading(false);
    renderFailure("서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 시도해 주세요.");
  }
}

// ---------- 결과 (F-06, F-10) ----------

function slotOf(code) {
  return state.symbols.find((s) => s.code === code)?.slot ?? 0;
}

function signClass(value) {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "";
}

function renderFailure(message, retry = true) {
  $("empty").hidden = true;
  const output = $("output");
  output.hidden = false;
  output.classList.remove("dim");
  output.replaceChildren(
    h(
      "div",
      { class: "alert bad alert-all", role: "alert" },
      h("strong", { text: "계산하지 못했습니다" }),
      h("div", { text: message }),
      retry ? h("button", { type: "button", onclick: run, text: "다시 시도" }) : null,
    ),
  );
}

function header(data) {
  const results = data.results;
  const params = data.params;
  const buys = new Set(results.map((r) => `${r.summary.buys}|${r.summary.first_buy}|${r.summary.last_buy}`));
  const first = results[0].summary;
  const buyText =
    buys.size === 1
      ? `종목마다 ${first.buys.toLocaleString("ko-KR")}회 매수 (${first.first_buy} ~ ${first.last_buy})`
      : `매수 ${Math.min(...results.map((r) => r.summary.buys))}~${Math.max(...results.map((r) => r.summary.buys))}회 (종목마다 다름)`;
  const latest = results.map((r) => r.data_through).sort().at(-1);
  const foreign = results.find((r) => r.currency !== params.currency);
  const fxText = foreign ? `, 환율 ${fx(foreign.summary.eval_fx)}${params.currency === "KRW" ? "원" : ""}` : "";
  const span = params.start <= ALL_START ? "상장 이후 전체" : period(params.start, params.end);
  const title = `${results.length}개 종목 · ${freqText()} ${money(params.amount, params.currency)} · ${span}`;
  const copy = h("button", { type: "button", class: "btn2" }, icon(["M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1", "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"]), "링크 복사");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copy.lastChild.textContent = "복사했습니다";
    } catch {
      copy.lastChild.textContent = "주소창의 주소를 복사해 주세요";
    }
    setTimeout(() => (copy.lastChild.textContent = "링크 복사"), 2000);
  });
  return h(
    "div",
    { class: "res-head" },
    h("div", {}, h("h2", { text: title }), h("p", { text: `${params.start <= ALL_START ? "상장일" : params.start} ~ ${params.end} · ${buyText} · 평가 ${latest} 종가${fxText}` })),
    h("div", { class: "actions", id: "result-actions" }, copy),
  );
}

function alerts(data) {
  const boxes = [];
  const rest = data.results.length;
  const alertIcon = () => icon(["M12 8v5", "M12 16.5v.5", "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"], 18);
  for (const error of data.errors) {
    boxes.push(h("div", { class: "alert bad", role: "alert" }, alertIcon(), h("div", {}, h("strong", { text: `${error.symbol}는 계산하지 못했습니다.` }), ` ${error.message} 나머지 ${rest}개 종목 결과를 보여 줍니다.`)));
  }
  for (const r of data.results.filter((x) => x.stale)) {
    boxes.push(h("div", { class: "alert warn" }, alertIcon(), h("div", {}, h("strong", { text: `${r.symbol}는 ${r.data_through}까지 저장된 데이터로 계산했습니다.` }), ` Yahoo Finance에서 새로 받지 못했습니다. 평가 기준일도 ${r.data_through}입니다.`)));
  }
  if (data.params.start > ALL_START) {
    for (const r of data.results.filter((x) => x.listed_from)) {
      const more = data.results.length > 1 ? " 다른 종목보다 매수 횟수가 적습니다." : "";
      boxes.push(h("div", { class: "alert info" }, icon(["M12 11v6", "M12 7.5v.5", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"], 18), h("div", {}, h("strong", { text: `${r.symbol}는 ${r.listed_from} 상장이라 그때부터 계산했습니다.` }), more)));
    }
  }
  return boxes;
}

function infoButton(text) {
  return h(
    "button",
    { type: "button", class: "info-btn", "aria-label": text },
    icon(["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v6", "M12 7.5v.5"], 13),
    h("span", { class: "tip", role: "tooltip", text }),
  );
}

function card(result, invest) {
  const s = result.summary;
  const cur = result.currency;
  const foreign = cur !== invest;
  const notes = result.notes.join(" · ");
  const avgSub = foreign
    ? h("div", { class: "sub" }, `${investLabel(invest)} ${money(s.avg_cost_invest, invest, { short: false })}`, infoButton(`매수할 때마다 그날 환율로 계산한 ${investLabel(invest)} 평단가입니다. 달러 평단가 × 지금 환율(${fx(s.eval_fx)})과 다릅니다.`))
    : h("div", { class: "sub" }, "종목 통화 그대로");
  const leftover = s.leftover_cash > 0 ? ` · 남은 현금 ${price(s.leftover_cash, cur)}` : "";
  return h(
    "article",
    { class: "card" },
    h("header", { class: "card-head" }, swatch(slotOf(result.symbol), 24), h("h3", { text: result.symbol }), h("span", { class: "muted small", text: result.name }), notes ? h("span", { class: "note", text: notes }) : null),
    h(
      "div",
      { class: "stats" },
      h("div", {}, h("div", { class: "lbl", text: "평단가" }), h("div", { class: "big", text: price(s.avg_cost_asset, cur) }), avgSub),
      h("div", {}, h("div", { class: "lbl", text: "수익률" }), h("div", { class: `big ${signClass(s.return_pct)}`, text: pct(s.return_pct) }), h("div", { class: "sub", text: `손익 ${signedMoney(s.profit, invest)}` })),
      h("div", {}, h("div", { class: "lbl", text: "연환산 (XIRR)" }), h("div", { class: "big", text: pct(s.xirr_pct) }), h("div", { class: "sub", text: "돈 넣은 시점을 반영" })),
    ),
    h(
      "div",
      { class: "strip" },
      h("div", {}, h("div", { class: "lbl", text: "투자금" }), h("div", { class: "v", text: money(s.invested, invest) })),
      h("div", {}, h("div", { class: "lbl", text: "평가금" }), h("div", { class: "v", text: money(s.value, invest) })),
      h("div", {}, h("div", { class: "lbl", text: "손익" }), h("div", { class: `v ${signClass(s.profit)}`, text: signedMoney(s.profit, invest) })),
    ),
    h(
      "dl",
      { class: "facts" },
      h("dt", { text: "보유 수량" }), h("dd", { text: `${qty(s.shares)}주${leftover}` }),
      h("dt", { text: "현재가" }), h("dd", {}, price(s.eval_price, cur), " ", h("span", { class: "muted", text: `${s.eval_date} 종가` })),
      h("dt", { text: "매수" }), h("dd", {}, `${s.buys.toLocaleString("ko-KR")}회 `, h("span", { class: "muted", text: `${s.first_buy} ~ ${s.last_buy}` })),
      h("dt", { text: "최고 · 최저 수익률" }),
      h("dd", {}, h("span", { class: signClass(s.best.return_pct), text: pct(s.best.return_pct, 1) }), " ", h("span", { class: "muted", text: s.best.date }), " · ", h("span", { class: signClass(s.worst.return_pct), text: pct(s.worst.return_pct, 1) }), " ", h("span", { class: "muted", text: s.worst.date })),
      h("dt", { text: "평가금 최고점 대비" }),
      h("dd", {}, h("span", { class: signClass(s.from_peak_pct), text: pct(s.from_peak_pct, 1) }), " ", h("span", { class: "muted", text: `최고 ${money(s.peak_value.value, invest)}, ${s.peak_value.date}` })),
    ),
  );
}

function compareTable(data) {
  const invest = data.params.currency;
  const head = ["평단가", `${investLabel(invest)} 평단가`, "보유 수량", "평가금", "손익", "수익률", "XIRR", "최저 수익률", "고점 대비"];
  return h(
    "section",
    { class: "box", "aria-labelledby": "cmp-h" },
    h("h3", { id: "cmp-h", text: "비교 표" }),
    h(
      "div",
      { class: "scroll" },
      h(
        "table",
        { class: "tbl", "aria-labelledby": "cmp-h" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "left", text: "종목" }), ...head.map((t) => h("th", { scope: "col", text: t })))),
        h(
          "tbody",
          {},
          ...data.results.map((r) => {
            const s = r.summary;
            return h(
              "tr",
              {},
              h("th", { scope: "row", class: "sym-cell" }, h("span", {}, swatch(slotOf(r.symbol), 18), r.symbol)),
              h("td", { text: price(s.avg_cost_asset, r.currency) }),
              h("td", { text: money(s.avg_cost_invest, invest, { short: false }) }),
              h("td", { text: qty(s.shares) }),
              h("td", { text: money(s.value, invest) }),
              h("td", { class: signClass(s.profit), text: signedMoney(s.profit, invest) }),
              h("td", { class: signClass(s.return_pct), text: pct(s.return_pct) }),
              h("td", { text: pct(s.xirr_pct) }),
              h("td", { class: signClass(s.worst.return_pct), text: pct(s.worst.return_pct, 1) }),
              h("td", { class: signClass(s.from_peak_pct), text: pct(s.from_peak_pct, 1) }),
            );
          }),
        ),
      ),
    ),
  );
}

function notice(data) {
  const latest = data.results.map((r) => r.data_through).sort().at(-1);
  const pairs = [...new Set(data.results.filter((r) => r.currency !== data.params.currency).map((r) => `${r.currency}${data.params.currency}=X`))];
  const splits = data.results.flatMap((r) => (r.notes.length ? [`${r.symbol} ${r.notes.map((n) => n.replace(" 분할 반영", "")).join("·")}`] : []));
  return h(
    "aside",
    { class: "notice", "aria-label": "안내" },
    h(
      "ul",
      {},
      h("li", { text: `데이터: Yahoo Finance 일별 종가(비공식), ${latest} 종가 기준.${pairs.length ? ` 환율은 ${pairs.join(", ")}.` : ""}` }),
      h("li", { text: `${splits.length ? `주식 분할은 반영했습니다 (${splits.join(", ")}). ` : ""}배당은 반영하지 않았습니다.` }),
      h("li", { text: "세금과 환전 비용은 반영하지 않았습니다. 환전 비용은 고급 설정의 수수료에 합쳐 넣으세요." }),
      h("li", { text: "과거 데이터로 계산한 결과이며 투자 권유가 아닙니다." }),
    ),
  );
}

function renderResult(data) {
  const status = $("data-status");
  status.classList.remove("ok", "warn");
  if (!data.results.length) {
    status.classList.add("warn");
    const reasons = data.errors.map((e) => `${e.symbol}: ${e.message}`).join(" ");
    renderFailure(reasons || "계산할 수 있는 종목이 없습니다.");
    return;
  }
  const latest = data.results.map((r) => r.data_through).sort().at(-1);
  status.classList.add(data.results.some((r) => r.stale) ? "warn" : "ok");
  $("data-status-text").textContent = `Yahoo Finance · ${latest} 종가`;
  $("empty").hidden = true;
  const output = $("output");
  output.hidden = false;
  output.replaceChildren(
    header(data),
    ...alerts(data),
    h("div", { class: "cards" }, ...data.results.map((r) => card(r, data.params.currency))),
    compareTable(data),
    notice(data),
  );
}

// ---------- 시작 ----------

function wireForm() {
  $("form").addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });
  $("start").addEventListener("change", (e) => {
    state.start = e.target.value;
    changed();
  });
  $("end").addEventListener("change", (e) => {
    state.end = e.target.value;
    changed();
  });
  for (const button of $("period").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      const key = button.dataset.years;
      if (!state.end || state.end > todayKst()) state.end = todayKst();
      state.start = key === "all" ? ALL_START : shiftYears(state.end, Number(key));
      changed();
    });
  }
  for (const button of $("freq").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      state.freq = button.dataset.freq;
      changed();
    });
  }
  $("month-day").replaceChildren(...Array.from({ length: 31 }, (_, i) => h("option", { value: String(i + 1), text: i === 30 ? "말일" : `${i + 1}일` })));
  $("month-day").addEventListener("change", (e) => {
    state.monthDay = Number(e.target.value);
    changed();
  });
  $("week-day").addEventListener("change", (e) => {
    state.weekDay = Number(e.target.value);
    changed();
  });
  $("amount").addEventListener("input", (e) => {
    state.amount = Number(e.target.value.replace(/[^\d.]/g, "")) || 0;
    state.serverErrors = {};
    renderPreview();
    showErrors(validate());
  });
  $("amount").addEventListener("blur", changed);
  $("currency").addEventListener("change", (e) => {
    const before = state.currency;
    state.currency = e.target.value;
    if (before !== state.currency && state.amount === (before === "KRW" ? 2_000_000 : 1_500)) {
      state.amount = state.currency === "KRW" ? 2_000_000 : 1_500; // 기본 금액이면 통화에 맞춰 바꾼다
    }
    changed();
  });
  for (const button of $("mode").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      state.fractional = button.dataset.fractional === "true";
      changed();
    });
  }
  $("fee").addEventListener("input", (e) => {
    state.fee = e.target.value.trim() === "" ? 0 : Number(e.target.value);
    state.serverErrors = {};
    $("advanced-summary").textContent = `· ${state.fractional ? "소수점" : "정수 주"} · 수수료 ${state.fee}%`;
    showErrors(validate());
  });
  $("fee").addEventListener("blur", changed);
}

function wireTheme() {
  const button = $("theme-toggle");
  const sync = () => {
    const dark = document.documentElement.classList.contains("dark");
    button.setAttribute("aria-label", dark ? "라이트 모드로 바꾸기" : "다크 모드로 바꾸기");
  };
  button.addEventListener("click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {
      // 저장하지 못해도 이번 화면에서는 바뀐다
    }
    sync();
    document.dispatchEvent(new CustomEvent("themechange"));
  });
  sync();
}

function init() {
  const fromUrl = readQuery(location.search);
  state.end = fromUrl.end ?? todayKst();
  state.start = fromUrl.start ?? shiftYears(state.end, 5);
  for (const key of ["freq", "monthDay", "weekDay", "amount", "currency", "fractional", "fee"]) {
    if (key in fromUrl) state[key] = fromUrl[key];
  }
  const codes = fromUrl.codes.length ? fromUrl.codes : DEFAULT_SYMBOLS;
  for (const code of codes) addSymbol(code);
  wireForm();
  wireSearch();
  wireTheme();
  changed();
  if (fromUrl.codes.length) run();
}

init();
