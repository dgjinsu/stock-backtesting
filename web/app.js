// 적립식 백테스트 화면: 조건 패널, 검색, 입력 검사, 주소 공유, 결과(카드·비교 표·알림·안내),
// 결과 탭과 조건 패널 접기(F-11), 매수 규칙(F-17), 양도세 어림 스위치(F-20).
// 계산은 서버(/api/backtest)가 하고 여기서는 입력을 받고 결과를 그린다 (아키텍처 1절).

import {
  ALL_START,
  BUY_RULES,
  DEFAULT_RULE,
  DEFAULT_TAB,
  MAX_SYMBOLS,
  RESULT_TABS,
  SYMBOL_PATTERN,
  backtestBody,
  nextTab,
  panelFold,
  readQuery,
  ruleFractionalNote,
  shiftYears,
  staleSymbols,
  symbolStatus,
  toQuery,
  todayKst,
  validate as validateCond,
} from "./conditions.js";
import { restCount, sparkline } from "./chartdata.js";
import { buysSection, chartSection, clearCharts, csvButton } from "./charts.js";
import { h, icon, keepFocus, svgEl, swatch } from "./dom.js";
import {
  advancedText,
  amountPreview,
  condLine,
  fx,
  headTitle,
  investLabel,
  money,
  pct,
  price,
  qty,
  signedMoney,
} from "./format.js";
import { highlights, summaryParts } from "./insights.js";
import { isSearchShortcut, searchScrollDelta, shortcutAria, shortcutLabel } from "./keys.js";
import {
  SORT_HINT,
  afterTax,
  avgInvestNote,
  avgInvestTip,
  bestIndexes,
  compareColumns,
  costNotice,
  fxNote,
  nextSort,
  sortRows,
  staleAlerts,
  underwaterText,
} from "./results.js";

const DEFAULT_SYMBOLS = ["QQQ", "QLD"];

const $ = (id) => document.getElementById(id);

/** 맥이면 검색 단축키가 ⌘K, 아니면 Ctrl+K다 (결정 d52 ②). userAgentData는 크로미움의 보안 문맥에만 있다. */
const MAC = /^mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");

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
  tax: false, // 해외주식 양도세 어림 (F-20)
  rule: DEFAULT_RULE, // 매수 규칙 (F-17). 이평선 기간·기준 종목은 늘 200일·QQQ (결정 d43)
  loading: false,
  serverErrors: {},
  badSymbols: new Map(), // code → 이유
  staleSymbols: new Map(), // code → 저장본 기준일 (data_through)
  sending: new Set(), // 계산 중인 요청에 담은 종목
};

/**
 * 결과 탭과 조건 패널 접기 (F-11).
 * - tab: 보는 탭. 처음 계산은 요약(주소에 s와 tab이 있으면 그 탭)이고, 다시 계산해도 그대로 둔다.
 * - expanded: 요약이 아닌 탭에서 "조건 펼치기"를 눌렀는지. 탭을 바꾸면 접는다. 주소에 담지 않는다.
 * - shown: 보이는 결과를 계산한 조건(보낸 때의 cond). 탭만 바꿀 때 이 조건으로 주소를 쓴다.
 *   결과가 없거나 실패를 보이는 중이면 null이고, 그때는 탭도 접힌 줄도 없다.
 */
const resultView = { tab: DEFAULT_TAB, expanded: false, shown: null };

// ---------- 작은 도우미 ----------

/** 지금 조건 (conditions.js의 cond 모양). */
function cond() {
  return { ...state, codes: state.symbols.map((s) => s.code) };
}

// ---------- 입력 검사 (F-02, F-04, F-10) ----------

/** 오류 칸마다 받는 항목 이름(화면 검사와 서버 422)과 표시할 입력 칸. */
const ERROR_BOXES = [
  { box: "sym-error", fields: ["symbols"], input: () => "sym-search" },
  { box: "start-error", fields: ["start"], input: () => "start" },
  { box: "end-error", fields: ["end"], input: () => "end" },
  {
    box: "anchor-error",
    fields: ["anchor", "freq"],
    input: () => (state.freq === "weekly" ? "week-day" : "month-day"),
  },
  { box: "amount-error", fields: ["amount", "currency"], input: () => "amount" },
  { box: "fee-error", fields: ["fee", "fee_pct", "fractional"], input: () => "fee" },
];
const BOXED_FIELDS = new Set(ERROR_BOXES.flatMap((b) => b.fields));

function validate() {
  return validateCond(cond(), todayKst());
}

function showErrors(clientErrors) {
  const errors = { ...state.serverErrors, ...clientErrors };
  for (const id of ["month-day", "week-day", ...ERROR_BOXES.map((b) => b.input())]) {
    $(id).removeAttribute("aria-invalid");
  }
  for (const { box, fields, input } of ERROR_BOXES) {
    const error = fields.map((f) => errors[f]).find(Boolean);
    let message = error;
    if (box === "sym-error" && !message && state.badSymbols.size) {
      message = [...state.badSymbols].map(([code, why]) => `${code}: ${why}`).join(" · ");
    }
    $(box).textContent = message ?? "";
    $(box).hidden = !message;
    if (error) $(input()).setAttribute("aria-invalid", "true");
  }
  // 칸이 없는 항목의 오류는 버튼 아래 한 줄로. 고치면 지운다.
  const others = Object.entries(errors).filter(([field]) => !BOXED_FIELDS.has(field));
  const status = $("status");
  if (others.length) {
    setStatus(others.map(([, m]) => m).join(" · "));
    status.dataset.kind = "errors";
  } else if (status.dataset.kind === "errors") {
    setStatus("");
    delete status.dataset.kind;
  }
  $("run").disabled = state.loading || Object.keys(clientErrors).length > 0;
}

/**
 * 계산하기 아래 상태 줄. 보이는 글은 패널 안 #status에, 읽어 주는 글은 패널 밖
 * #status-live(role=status)에 같이 쓴다. 요약이 아닌 탭에서 패널을 접은 뒤 써도 읽힌다.
 */
function setStatus(text) {
  $("status").textContent = text;
  $("status-live").textContent = text;
}

// ---------- 조건 패널 그리기 ----------

function renderSymbols() {
  const list = $("sym-list");
  list.replaceChildren(
    ...state.symbols.map((s) => {
      const status = symbolStatus(s.code, {
        loading: state.loading,
        sending: state.sending,
        bad: state.badSymbols,
        stale: state.staleSymbols,
      });
      return h(
        "li",
        { class: status ? `sym ${status.cls}` : "sym" },
        swatch(s.slot),
        h("strong", { text: s.code }),
        h("span", { class: "nm", text: s.name || "" }),
        status ? h("span", { class: "st", text: status.text, title: status.title }) : null,
        h(
          "button",
          {
            type: "button",
            class: "x",
            "aria-label": `${s.code} 빼기`,
            onclick: () => removeSymbol(s.code),
          },
          icon(["M6 6l12 12M18 6L6 18"], 14),
        ),
      );
    }),
  );
  $("sym-count").textContent = `${state.symbols.length} / ${MAX_SYMBOLS}`;
}

function renderPreview() {
  $("amount-preview").textContent = amountPreview(cond());
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
    if (key === "all") return state.start === ALL_START;
    const start = shiftYears(state.end, Number(key));
    return start !== null && state.start === start;
  });
  setOn("freq", (b) => b.dataset.freq === state.freq);
  $("monthly-row").hidden = state.freq !== "monthly";
  $("weekly-row").hidden = state.freq !== "weekly";
  $("daily-row").hidden = state.freq !== "daily";
  $("month-day").value = String(state.monthDay);
  $("week-day").value = String(state.weekDay);
  if (document.activeElement !== $("amount"))
    $("amount").value = state.amount ? state.amount.toLocaleString("ko-KR") : "";
  $("amount-unit").textContent = state.currency === "KRW" ? "원" : "$";
  setOn("currency", (b) => b.dataset.cur === state.currency);
  setOn("mode", (b) => (b.dataset.fractional === "true") === state.fractional);
  if (document.activeElement !== $("fee") && Number.isFinite(state.fee)) {
    $("fee").value = String(state.fee);
  }
  $("tax").setAttribute("aria-checked", String(state.tax));
  renderRule();
  renderAdvancedSummary();
  renderSymbols();
  renderPreview();
}

/**
 * 매수 규칙 칸 (F-17): 고른 규칙의 설명(시안 v2)과, 기본이 아닌 규칙에서 정수 주만을 골랐으면
 * "매수 규칙은 소수점 매수로 계산합니다" (계산 규칙 9-6). 둘 다 select의 aria-describedby다.
 */
function renderRule() {
  $("rule").value = state.rule;
  $("rule-desc").textContent = BUY_RULES.find((r) => r.key === state.rule)?.desc ?? "";
  const note = ruleFractionalNote(state);
  $("rule-frac").textContent = note ?? "";
  $("rule-frac").hidden = !note;
}

function renderAdvancedSummary() {
  $("advanced-summary").textContent = advancedText(state);
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
  state.staleSymbols.delete(code);
  changed();
}

const search = { timer: 0, blurTimer: 0, abort: null, options: [], active: -1 };

/** 목록을 닫고, 기다리는 검색(0.3초 타이머)과 진행 중인 요청도 취소한다. */
function closeList() {
  clearTimeout(search.timer);
  search.abort?.abort();
  search.abort = null;
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
  $("sym-live").textContent = text; // 목록 안 안내는 읽히지 않아 따로 알린다
  list.hidden = false;
  $("sym-search").setAttribute("aria-expanded", "true");
  search.options = [];
  search.active = -1;
  revealSearch(); // Tab·마우스로 들어와 쳐도 목록이 패널 바닥에서 잘리지 않게
}

function renderHits(query, hits) {
  const list = $("sym-results");
  $("sym-search").removeAttribute("aria-activedescendant");
  const typed = query.trim().toUpperCase();
  const added = new Set(state.symbols.map((s) => s.code));
  search.options = hits.map((hit) => ({
    code: hit.symbol,
    name: hit.name,
    disabled: added.has(hit.symbol),
    meta: `${hit.exchange} · ${hit.type}`,
  }));
  if (SYMBOL_PATTERN.test(typed) && !search.options.some((o) => o.code === typed)) {
    search.options.push({
      code: typed,
      name: "입력한 코드 그대로 넣기",
      raw: true,
      disabled: added.has(typed),
      meta: "검색 결과에 없어도 넣을 수 있습니다",
    });
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
            if (!o.disabled) addSymbol(o.code, o.raw ? "" : o.name);
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
  $("sym-live").textContent =
    `검색 결과 ${search.options.length}개. 위아래 화살표로 고르고 Enter로 넣습니다`;
  search.active = -1;
  revealSearch();
}

async function runSearch(query) {
  search.abort?.abort();
  search.abort = new AbortController();
  showNote("찾는 중…");
  const stillTyped = () => $("sym-search").value.trim() === query;
  try {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal: search.abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hits = await response.json();
    if (stillTyped()) renderHits(query, hits); // 그사이 칸이 바뀌었으면 버린다
  } catch (error) {
    if (error.name === "AbortError" || !stillTyped()) return;
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
      if (option && !option.disabled) addSymbol(option.code, option.raw ? "" : option.name);
      else if (input.value.trim()) addSymbol(input.value);
    } else if (event.key === "Escape") {
      closeList();
    }
  });
  // 목록을 누르는 동안(mousedown) 닫히지 않게 조금 늦게 닫는다. 그사이 돌아오면 닫지 않는다.
  input.addEventListener("blur", () => {
    search.blurTimer = setTimeout(closeList, 150);
  });
  input.addEventListener("focus", () => clearTimeout(search.blurTimer));
}

/**
 * 검색칸과 그 아래 목록 자리(최대 높이)가 조건 패널 안에 보이게 패널만 스크롤한다.
 * 패널은 스크롤 영역이라 목록이 패널 바닥을 넘으면 잘린다. 창은 스크롤하지 않는다.
 * Ctrl K로 왔을 때와 목록을 열 때(찾는 중·결과·안내) 부른다. 스크롤 양은 searchScrollDelta가 정한다.
 * 목록의 top·max-height는 CSS에서 읽는다 (값을 여기 다시 적지 않는다).
 */
function revealSearch() {
  const panel = $("panel");
  const box = panel.getBoundingClientRect();
  const list = getComputedStyle($("sym-results"));
  const delta = searchScrollDelta({
    panelTop: box.top,
    panelBottom: box.bottom,
    fieldTop: $("sym-search").closest(".search").getBoundingClientRect().top,
    listTop: parseFloat(list.top),
    listMax: parseFloat(list.maxHeight),
    gap: 16,
  });
  if (delta) panel.scrollTop += delta;
}

/**
 * 어디서나 Ctrl+K(맥 ⌘K)로 종목 검색칸에 간다 (F-01, 결정 d49). 브라우저 주소창 검색을 막는다.
 * 패널이 접혀 있으면 먼저 편다. 이미 검색칸에 있어도 글·커서·목록은 그대로 두고,
 * 칸이나 그 아래 목록 자리가 패널 밖으로 가려져 있으면 스크롤해 보이게 한다.
 */
function onSearchShortcut(event) {
  if (!isSearchShortcut(event, MAC)) return;
  event.preventDefault();
  expandPanel();
  const input = $("sym-search");
  // focus()가 스크롤하지 않게 하고, 목록 자리까지 보이게 아래에서 직접 스크롤한다
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  revealSearch();
}

function wireShortcut() {
  $("sym-kbd").textContent = shortcutLabel(MAC);
  $("sym-search").setAttribute("aria-keyshortcuts", shortcutAria(MAC));
  // capture로 단다. 다른 처리기가 전파를 막아도 단축키가 살아 있다
  document.addEventListener("keydown", onSearchShortcut, true);
}

// ---------- 계산하기 ----------

/** 계산 전에 포커스가 있던 요소. 계산 중 잠근 "계산하기"에서 body로 빠진 포커스를 되돌린다. */
let focusBeforeLoading = null;

function setLoading(on) {
  state.loading = on;
  if (on) focusBeforeLoading = document.activeElement;
  renderSymbols(); // 줄마다 "받는 중"을 켜고 끈다
  $("run").disabled = on || Object.keys(validate()).length > 0;
  if (!on) {
    // 잠긴 버튼에 있던 포커스는 브라우저가 body로 옮긴다. 다른 곳으로 옮겨 가지 않았으면 되돌린다
    const lost = !document.activeElement || document.activeElement === document.body;
    const back = focusBeforeLoading;
    if (lost && back && back !== document.body && back.isConnected && !back.disabled) {
      back.focus({ preventScroll: true });
    }
    focusBeforeLoading = null;
  }
  $("run").querySelector(".spinner").hidden = !on;
  $("run-label").textContent = on ? "계산 중…" : "계산하기";
  setStatus(on ? `${state.symbols.length}개 종목 주가를 받고 계산하는 중입니다` : "");
  $("output").classList.toggle("dim", on);
  if ($("output").hidden) {
    const busy = [
      h("p", { class: "empty-title", text: "계산하는 중입니다…" }),
      h("p", {
        class: "muted",
        text: "처음 보는 종목은 Yahoo Finance에서 주가를 받느라 몇 초 걸립니다.",
      }),
    ];
    $("empty").replaceChildren(...(on ? busy : EMPTY_IDLE.map((node) => node.cloneNode(true))));
  }
}

async function post(body) {
  const response = await fetch("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => null) };
}

async function run() {
  const errors = validate();
  showErrors(errors);
  if (Object.keys(errors).length || state.loading) return;
  // 계산 중에도 조건을 바꿀 수 있으니, 주소와 색은 보낸 때의 조건으로 만든다
  const sent = cond();
  const slots = new Map(state.symbols.map((s) => [s.code, s.slot]));
  state.sending = new Set(sent.codes);
  setLoading(true);
  let reply;
  try {
    reply = await post(backtestBody(sent)); // 매수 규칙은 rule·ma_days·switch_ref (F-17, 결정 d43)
  } catch {
    setLoading(false);
    renderFailure("서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 시도해 주세요.");
    return;
  }
  const { response, json } = reply;
  setLoading(false);
  if (response.status === 422) {
    state.serverErrors = Object.fromEntries((json?.detail ?? []).map((d) => [d.field, d.message]));
    showErrors(validate());
    if (!$("status").textContent) {
      setStatus("입력을 확인해 주세요");
      $("status").dataset.kind = "errors";
    }
    return;
  }
  if (!response.ok || !json) {
    renderFailure(
      `서버가 계산하지 못했습니다 (HTTP ${response.status}). 잠시 뒤 다시 시도해 주세요.`,
    );
    return;
  }
  // 계산 중에 뺀 종목의 오류는 남기지 않는다 (지울 줄이 없다)
  const listed = new Set(state.symbols.map((s) => s.code));
  state.badSymbols = new Map(
    json.errors.filter((e) => listed.has(e.symbol)).map((e) => [e.symbol, e.message]),
  );
  state.staleSymbols = staleSymbols(json.results, listed);
  for (const result of json.results) {
    const entry = state.symbols.find((s) => s.code === result.symbol);
    if (entry) entry.name = result.name;
  }
  // 다시 계산하면 보던 탭을 그대로 두므로 주소에도 그 탭을 남긴다
  history.replaceState(null, "", `?${toQuery({ ...sent, tab: resultView.tab })}`);
  shownSlots = slots;
  resultView.shown = sent;
  renderForm();
  showErrors(validate());
  try {
    renderResult(json);
  } catch (error) {
    console.error(error);
    renderFailure("결과를 화면에 그리지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.", false);
    return;
  }
  const failed = json.errors.length ? `, ${json.errors.length}개 실패` : "";
  setStatus(
    json.results.length
      ? `계산했습니다: ${json.results.length}개 종목${failed}`
      : `계산하지 못했습니다: ${json.errors.length}개 종목 모두 실패`,
  );
}

// ---------- 결과 (F-06, F-10) ----------

/** 보이는 결과의 종목 → 색 자리. 요청을 보낸 때 떠 둔다 (색은 종목에 붙는다, 상세 설계 5절). */
let shownSlots = new Map();

function slotOf(code) {
  return shownSlots.get(code) ?? state.symbols.find((s) => s.code === code)?.slot ?? 0;
}

function signClass(value) {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "";
}

function renderFailure(message, retry = true) {
  clearCharts();
  resultView.shown = null; // 탭이 없으니 조건 패널을 편다 (보던 탭은 다음 결과에 쓴다)
  layoutPanel();
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
  const buys = new Set(
    results.map((r) => `${r.summary.buys}|${r.summary.first_buy}|${r.summary.last_buy}`),
  );
  const first = results[0].summary;
  const counts = results.map((r) => r.summary.buys);
  const buyText =
    buys.size === 1
      ? `종목마다 ${first.buys.toLocaleString("ko-KR")}회 매수 (${first.first_buy} ~ ${first.last_buy})`
      : `매수 ${Math.min(...counts)}~${Math.max(...counts)}회 (종목마다 다름)`;
  const latest = results
    .map((r) => r.data_through)
    .sort()
    .at(-1);
  const foreign = results.find((r) => r.currency !== params.currency);
  const fxText = foreign
    ? `, 환율 ${fx(foreign.summary.eval_fx)}${params.currency === "KRW" ? "원" : ""}`
    : "";
  const from = params.start <= ALL_START ? "상장일" : params.start;
  const title = headTitle(params, results.length); // 기본이 아닌 매수 규칙은 끝에 이름 (F-17)
  const copy = h(
    "button",
    { type: "button", class: "ghost" },
    icon([
      "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1",
      "M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
    ]),
    "링크 복사",
  );
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
    h(
      "div",
      {},
      h("h2", { text: title }),
      h("p", {
        text: `${from} ~ ${params.end} · ${buyText} · 평가 ${latest} 종가${fxText}`,
      }),
    ),
    h("div", { class: "actions" }, copy, csvButton(data)),
  );
}

function alerts(data) {
  const boxes = [];
  const rest = data.results.length;
  const alertIcon = () =>
    icon(
      [
        "M12 8v5",
        "M12 16.5v.5",
        "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
      ],
      18,
    );
  for (const error of data.errors) {
    boxes.push(
      h(
        "div",
        { class: "alert bad", role: "alert" },
        alertIcon(),
        h(
          "div",
          {},
          h("strong", { text: `${error.symbol}는 계산하지 못했습니다.` }),
          ` ${error.message} 나머지 ${rest}개 종목 결과를 보여 줍니다.`,
        ),
      ),
    );
  }
  // 저장본 노랑 알림: 종목 주가, 환율·양도세 환율, 레버리지 전환의 기준 종목 순 (F-10, F-17)
  for (const alert of staleAlerts(data.results, data.params)) {
    boxes.push(
      h(
        "div",
        { class: "alert warn" },
        alertIcon(),
        h("div", {}, h("strong", { text: alert.title }), ` ${alert.detail}`),
      ),
    );
  }
  if (data.params.start > ALL_START) {
    for (const r of data.results.filter((x) => x.listed_from)) {
      const more = data.results.length > 1 ? " 다른 종목보다 매수 횟수가 적습니다." : "";
      boxes.push(
        h(
          "div",
          { class: "alert info" },
          icon(["M12 11v6", "M12 7.5v.5", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"], 18),
          h(
            "div",
            {},
            h("strong", { text: `${r.symbol}는 ${r.listed_from} 상장이라 그때부터 계산했습니다.` }),
            more,
          ),
        ),
      );
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

/** 카드 바닥 작은 그래프의 높이 (B 카드). SVG viewBox 높이와 sparkline의 바닥이 같다. */
const SPARK_H = 54;

/**
 * 카드의 작은 수익률 그래프 (F-12, 리디자인 B): chart.series[종목].return_pct 선, 선 아래 면(종목색
 * 12%), 0% 점선. 카드 바닥 좌우 끝까지 채운다. 글("수익률 추이", 최고·최저)은 그래프 바로 위 줄이다.
 * 카드가 여러 개라 Chart.js 인스턴스를 늘리지 않게 SVG로 그린다 (Chart.js를 못 불러와도 보인다).
 * 좌표는 chartdata.js의 sparkline이 만들고, aria-label에 그래프의 마지막 수익률을 적는다.
 */
function sparkBox(result, chart) {
  const line = sparkline(chart.series[result.symbol]?.return_pct, { height: SPARK_H });
  if (!line) return null;
  const s = result.summary;
  const color = `var(--c${slotOf(result.symbol) + 1})`;
  const graph = svgEl("svg", {
    class: "spark-svg",
    viewBox: `0 0 300 ${SPARK_H}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `${result.symbol} 수익률 추이 그래프. 마지막 수익률 ${pct(line.last)}`,
  });
  const area = svgEl("path", { class: "spark-area", d: line.area });
  area.style.fill = color;
  const zero = svgEl("line", {
    class: "spark-zero",
    x1: 0,
    x2: 300,
    y1: line.zeroY,
    y2: line.zeroY,
    "vector-effect": "non-scaling-stroke",
  });
  const path = svgEl("path", {
    class: "spark-line",
    d: line.path,
    "vector-effect": "non-scaling-stroke",
  });
  path.style.stroke = color;
  graph.append(area, zero, path); // 점선이 면 위에, 선이 맨 위에 보이게
  return h(
    "div",
    { class: "spark" },
    h(
      "div",
      { class: "spark-meta" },
      h("span", { class: "spark-title", "aria-hidden": "true", text: "수익률 추이" }),
      h("span", {
        class: "spark-range mono",
        text: `최고 ${pct(s.best.return_pct, 1)} · 최저 ${pct(s.worst.return_pct, 1)}`,
      }),
    ),
    h("div", { class: "spark-plot" }, graph),
  );
}

/** 카드 2열 칸 하나: 이름, 값(mono), 둘째 줄(있으면). */
function kvCell(label, value, { tone = "", light = false, sub = null } = {}) {
  const cls = ["v", tone, light ? "light" : ""].filter(Boolean).join(" ");
  return h(
    "div",
    {},
    h("div", { class: "lbl", text: label }),
    h("div", { class: cls }, ...[value].flat()),
    sub ? h("div", { class: "sub", text: sub }) : null,
  );
}

/**
 * 종목 카드 (F-06, 리디자인 B 배치, 결정 d51). 위에서부터
 * ① 머리(선 견본·코드·이름·분할 반영) ② 수익률 ③ XIRR·손익 한 줄 ④ 2열 칸 ⑤ 목록 ⑥ 작은 그래프.
 * v1·v2 카드의 항목과 글은 하나도 빼지 않는다 (손익은 ③ 한 곳에 둔다).
 */
function card(result, params, chart) {
  const invest = params.currency;
  const s = result.summary;
  const cur = result.currency;
  const taxCell = afterTax(result, invest); // 양도세 어림(F-20)을 켰을 때만
  const foreign = cur !== invest;
  const notes = result.notes.join(" · ");
  // 투자 통화 평단가: 값이 없으면 "—"와 이유(매수 규칙 d39, 정수 주만 d52 ⑥), 있으면 환율 설명
  const avgCell = foreign
    ? kvCell(
        `${investLabel(invest)} 평단가`,
        [
          money(s.avg_cost_invest, invest, { short: false }),
          infoButton(avgInvestTip(params, s, cur)),
        ],
        { light: true },
      )
    : kvCell(`${investLabel(invest)} 평단가`, "종목 통화 그대로", { light: true });
  const leftover = s.leftover_cash > 0 ? ` · 남은 현금 ${price(s.leftover_cash, cur)}` : "";
  const rests = restCount(result.buys); // 사지 않은 회차: 레버리지 전환에서 쉰 날 등 (#41)
  return h(
    "article",
    { class: "card" },
    h(
      "header",
      { class: "card-head" },
      swatch(slotOf(result.symbol), 18),
      h("h3", { class: "mono", text: result.symbol }),
      h("span", { class: "nm", title: result.name, text: result.name }),
      notes ? h("span", { class: "note mono", text: notes }) : null,
    ),
    h(
      "div",
      { class: "card-ret" },
      h("div", { class: "lbl", text: "수익률" }),
      h("div", { class: `ret mono ${signClass(s.return_pct)}`, text: pct(s.return_pct) }),
      h(
        "div",
        { class: "ret-sub mono" },
        h(
          "span",
          { title: "연환산 (XIRR): 돈 넣은 시점을 반영" },
          "XIRR ",
          h("span", { class: "strong", text: pct(s.xirr_pct) }),
          h("span", { class: "sr", text: " (연환산, 돈 넣은 시점을 반영)" }),
        ),
        " · 손익 ",
        h("span", { class: signClass(s.profit), text: signedMoney(s.profit, invest) }),
      ),
    ),
    h(
      "div",
      { class: "kv" },
      kvCell("평단가", price(s.avg_cost_asset, cur)),
      kvCell("평가금", money(s.value, invest)),
      avgCell,
      kvCell("평가금 최고점 대비", pct(s.from_peak_pct, 1), {
        tone: signClass(s.from_peak_pct),
        light: true,
        sub: `최고 ${money(s.peak_value.value, invest)}, ${s.peak_value.date}`,
      }),
      kvCell("투자금", money(s.invested, invest)),
      taxCell
        ? kvCell(taxCell.label, taxCell.text, { tone: taxCell.tone, sub: taxCell.note })
        : null,
    ),
    h(
      "dl",
      { class: "facts" },
      h("dt", { text: "보유 수량" }),
      h("dd", { text: `${qty(s.shares)}주${leftover}` }),
      h("dt", { text: "현재가" }),
      h(
        "dd",
        {},
        price(s.eval_price, cur),
        " ",
        h("span", { class: "muted", text: `${s.eval_date} 종가` }),
      ),
      h("dt", { text: "매수" }),
      h(
        "dd",
        {},
        `${s.buys.toLocaleString("ko-KR")}회 `,
        rests ? `(${rests.toLocaleString("ko-KR")}회 쉼) ` : null,
        h("span", { class: "muted", text: `${s.first_buy} ~ ${s.last_buy}` }),
      ),
      h("dt", { text: "최고 · 최저 수익률" }),
      h(
        "dd",
        {},
        h("span", { class: signClass(s.best.return_pct), text: pct(s.best.return_pct, 1) }),
        " ",
        h("span", { class: "muted", text: s.best.date }),
        " · ",
        h("span", { class: signClass(s.worst.return_pct), text: pct(s.worst.return_pct, 1) }),
        " ",
        h("span", { class: "muted", text: s.worst.date }),
      ),
      h("dt", { text: "원금 아래" }),
      h(
        "dd",
        { title: "평가금이 그날까지 넣은 돈보다 적었던 거래일 (전체 거래일 중 비율)" },
        underwaterText(s),
      ),
    ),
    sparkBox(result, chart),
  );
}

/** 비교 표 정렬 상태 { key, dir } (F-12). 다시 계산하면(새 결과) 풀린다. */
let tableSort = null;

const ARIA_SORT = { asc: "ascending", desc: "descending" };

/**
 * 비교 표 (F-06, F-12). 열 제목 안의 버튼을 누르면 정렬하고(처음은 좋은 값이 위, 다시 누르면 반대,
 * 값이 없는 종목은 맨 아래) 제목 칸의 aria-sort로 알린다. 열마다 가장 좋은 값은 굵게 하고
 * 읽어 주는 글을 붙인다. 열·정렬·가장 좋은 값 규칙은 results.js.
 */
function compareTable(data) {
  tableSort = null;
  const invest = data.params.currency;
  const columns = compareColumns(invest, { tax: data.params.tax === true });
  // 가장 좋은 값은 정렬과 상관없이 결과 순서로 한 번 고른다 (열 key → 굵게 할 종목)
  const best = new Map(
    columns.map((c) => {
      const found = bestIndexes(data.results.map(c.value), c.better, c.digits);
      return [c.key, new Set([...found].map((i) => data.results[i].symbol))];
    }),
  );
  const table = h("table", { class: "tbl cmp", "aria-labelledby": "cmp-h" });
  const sortBy = (column) => {
    tableSort = nextSort(tableSort, column);
    keepFocus(table, render);
  };
  const headCell = (column) => {
    const dir = tableSort?.key === column.key ? tableSort.dir : null;
    return h(
      "th",
      { scope: "col", "aria-sort": dir ? ARIA_SORT[dir] : null },
      h(
        "button",
        {
          type: "button",
          class: "sort-btn",
          "data-focus": `sort:${column.key}`,
          onclick: () => sortBy(column),
        },
        column.title,
        dir
          ? h("span", {
              class: "sort-mark",
              "aria-hidden": "true",
              text: dir === "asc" ? "▲" : "▼",
            })
          : null,
      ),
    );
  };
  const row = (r) =>
    h(
      "tr",
      {},
      h(
        "th",
        { scope: "row", class: "sym-cell" },
        h("span", {}, swatch(slotOf(r.symbol), 18), r.symbol),
      ),
      ...columns.map((c) => {
        const top = best.get(c.key).has(r.symbol);
        const tone = c.tone ? signClass(c.value(r)) : "";
        // 매수 규칙(F-17) 결과의 투자 통화 평단가는 null이라 "—"이고, 이유는 title로 (결정 d39)
        const why =
          c.key === "avg_cost_invest"
            ? avgInvestNote(data.params, r.summary.avg_cost_invest)
            : null;
        return h(
          "td",
          { class: [tone, top ? "best" : ""].filter(Boolean).join(" ") || null, title: why },
          c.text(r),
          top ? h("span", { class: "sr", text: " (가장 좋은 값)" }) : null,
          why ? h("span", { class: "sr", text: ` (${why})` }) : null,
        );
      }),
    );
  const render = () => {
    const column = tableSort && columns.find((c) => c.key === tableSort.key);
    const rows = column ? sortRows(data.results, column.value, tableSort.dir) : data.results;
    table.replaceChildren(
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "col", class: "left", text: "종목" }),
          ...columns.map(headCell),
        ),
      ),
      h("tbody", {}, ...rows.map(row)),
    );
  };
  render();
  return h(
    "section",
    { class: "box", "aria-labelledby": "cmp-h" },
    h(
      "div",
      { class: "box-head" },
      h("h3", { id: "cmp-h", text: "비교 표" }),
      h("span", { class: "hint", text: SORT_HINT }),
    ),
    h("div", { class: "scroll" }, table),
  );
}

function notice(data) {
  const latest = data.results
    .map((r) => r.data_through)
    .sort()
    .at(-1);
  // 종목 통화가 다른 쌍과, 양도세를 켠 달러 투자면 양도세용 USDKRW=X (#39)
  const fxText = fxNote(data.results, data.params);
  const splits = data.results.flatMap((r) =>
    r.notes.length
      ? [`${r.symbol} ${r.notes.map((n) => n.replace(" 분할 반영", "")).join("·")}`]
      : [],
  );
  return h(
    "aside",
    { class: "notice", "aria-label": "안내" },
    // 띠 모양이라 list-style을 지우면 일부 낭독기가 목록 뜻을 버려서 role을 적는다
    h(
      "ul",
      { role: "list" },
      h("li", {
        text: `데이터: Yahoo Finance 일별 종가(비공식), ${latest} 종가 기준.${fxText ? ` ${fxText}` : ""}`,
      }),
      h("li", {
        text: `${splits.length ? `주식 분할은 반영했습니다 (${splits.join(", ")}). ` : ""}배당은 반영하지 않았습니다.`,
      }),
      h("li", { text: costNotice(data.params.tax === true) }),
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
  const latest = data.results
    .map((r) => r.data_through)
    .sort()
    .at(-1);
  const stale = data.results.some((r) => r.stale || r.switch_ref?.stale); // 기준 종목도 (F-17)
  status.classList.add(stale ? "warn" : "ok");
  $("data-status-text").textContent = `Yahoo Finance · ${latest} 종가`;
  $("empty").hidden = true;
  const output = $("output");
  output.hidden = false;
  // 머리 줄과 알림은 탭 위, 고정 안내는 탭 아래라 어느 탭에서나 보인다. 탭 내용은 한 번에 다 그린다
  output.replaceChildren(
    header(data),
    ...alerts(data),
    tabList(),
    tabPanel(
      "summary",
      insightsSection(data),
      h(
        "div",
        { class: "cards" },
        ...data.results.map((r) => card(r, data.params, data.chart)),
      ),
      compareTable(data),
      chartSection(data, slotOf),
    ),
    tabPanel("analysis", comingSoon("analysis")),
    tabPanel("strategy", comingSoon("strategy")),
    tabPanel("buys", buysSection(data, slotOf)),
    notice(data),
  );
  renderCondBar(data);
  showTab();
}

// ---------- 한눈에 요약 (F-12) ----------

/**
 * 요약 탭 맨 위(카드 위): 정해진 틀로 만든 문장과 하이라이트 4칸. 문구와 고르는 규칙은 insights.js.
 * 문장 조각은 굵게(strong)와 손익 색(tone)만 입히고, 값은 모두 textContent로 넣는다.
 */
function insightsSection(data) {
  return h(
    "section",
    { class: "insights", "aria-label": "한눈에 요약" },
    h(
      "p",
      { class: "insights-text" },
      ...summaryParts(data.results).map((part) =>
        part.strong ? h("strong", { class: part.tone || null, text: part.text }) : part.text,
      ),
    ),
    h(
      "ul",
      { class: "highlights" },
      ...highlights(data.results).map((item) =>
        h(
          "li",
          {},
          h("div", { class: "lbl", text: item.label }),
          h(
            "div",
            { class: "hl-value" },
            swatch(slotOf(item.symbol), 18),
            `${item.symbol} `,
            h("span", { class: item.tone || null, text: item.value }),
            item.note ? [" ", h("span", { class: "muted", text: item.note })] : null,
          ),
        ),
      ),
    ),
  );
}

// ---------- 결과 탭과 조건 패널 접기 (F-11) ----------

const TAB_LABELS = { summary: "요약", analysis: "분석", strategy: "전략 비교", buys: "매수 내역" };

/** 아직 만들지 않은 탭의 안내 (결정 d41). 분석은 F-14, 전략 비교는 F-15에서 채운다. */
const COMING = {
  analysis:
    "분석 탭에는 얼마나 흔들렸나, 연도별 결과, 달마다 수익률, 수익의 출처, 매수 가격 분포가 들어갑니다.",
  strategy: "전략 비교 탭에서는 같은 돈을 넣되 사는 규칙만 다른 전략 5가지를 나란히 비교합니다.",
};

function comingSoon(key) {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty-title", text: "다음 단계에서 채웁니다" }),
    h("p", { class: "muted", text: COMING[key] }),
  );
}

/** WAI-ARIA 탭 목록. 고른 탭만 Tab 키로 가고, ←/→(Home/End)로 옮기면 바로 그 탭을 연다. */
function tabList() {
  return h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "결과 보기", onkeydown: onTabKey },
    ...RESULT_TABS.map((key) =>
      h("button", {
        type: "button",
        role: "tab",
        id: `tab-${key}`,
        "aria-controls": `tabpanel-${key}`,
        "data-tab": key,
        text: TAB_LABELS[key],
        onclick: () => selectTab(key),
      }),
    ),
  );
}

function tabPanel(key, ...children) {
  return h(
    "div",
    {
      class: "tabpanel",
      role: "tabpanel",
      id: `tabpanel-${key}`,
      "aria-labelledby": `tab-${key}`,
      tabindex: "0",
    },
    ...children,
  );
}

function onTabKey(event) {
  const to = nextTab(event.target.dataset?.tab, event.key);
  if (to === null) return;
  event.preventDefault();
  selectTab(to);
  $(`tab-${to}`).focus();
}

/** 탭을 바꾼다. 다시 계산하지 않고, 주소는 보이는 결과의 조건에서 tab만 바꾼다. */
function selectTab(key) {
  if (key === resultView.tab) return;
  resultView.tab = key;
  resultView.expanded = false; // 탭을 바꾸면 다시 규칙대로: 요약은 펼침, 그 밖은 접힘
  showTab();
  if (resultView.shown) {
    history.replaceState(null, "", `?${toQuery({ ...resultView.shown, tab: key })}`);
  }
}

/** 고른 탭과 그 패널만 보이게 하고, 조건 패널을 접거나 편다. */
function showTab() {
  for (const key of RESULT_TABS) {
    const tab = $(`tab-${key}`);
    if (!tab) continue;
    const on = key === resultView.tab;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`tabpanel-${key}`).hidden = !on;
  }
  layoutPanel();
}

/**
 * 요약이 아닌 탭에서는 왼쪽 조건 패널을 결과 위 한 줄로 접고 결과가 전체 폭을 쓴다.
 * "조건 펼치기"를 누르면 그 탭에 머문 채 패널을 열고, 같은 버튼("조건 접기")으로 다시 접는다.
 * 포커스가 패널 안에 있을 때 접으면(계산을 마치고 보던 탭으로 돌아갈 때) 포커스를
 * "조건 펼치기"로 옮긴다. 그대로 두면 숨은 요소와 함께 body로 사라진다.
 */
function layoutPanel() {
  const { bar, collapsed } = panelFold({
    hasResult: resultView.shown !== null,
    tab: resultView.tab,
    expanded: resultView.expanded,
  });
  const focusInPanel = $("panel").contains(document.activeElement);
  $("cond-bar").hidden = !bar;
  $("cond-bar").setAttribute("aria-label", collapsed ? "조건 (접힘)" : "조건 (펼침)");
  $("cond-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("cond-toggle-label").textContent = collapsed ? "조건 펼치기" : "조건 접기";
  $("panel").hidden = collapsed;
  // "전략 비교" 안내 버튼(F-17)은 탭이 있을 때(결과가 보일 때)만 누를 수 있다
  $("rule-compare").disabled = resultView.shown === null;
  if (collapsed && focusInPanel) $("cond-toggle").focus(); // 줄을 먼저 보이게 한 뒤에 옮긴다
}

/**
 * 접혀 있으면 "조건 펼치기"를 누른 것처럼 편다 (Ctrl+K). 탭과 주소는 그대로다.
 * 버튼의 click()은 토글이라 이미 펼쳐져 있으면 접히므로 쓰지 않는다.
 */
function expandPanel() {
  if (!$("panel").hidden) return;
  resultView.expanded = true;
  layoutPanel();
}

/** 접힌 줄의 종목과 조건 한 줄. 폼이 아니라 보이는 결과를 계산한 조건(params)으로 만든다. */
function renderCondBar(data) {
  $("cond-syms").replaceChildren(
    ...data.results.map((r) =>
      h("span", { class: "cond-sym" }, swatch(slotOf(r.symbol), 14), r.symbol),
    ),
  );
  $("cond-text").textContent = condLine(data.params);
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
  $("month-day").replaceChildren(
    ...Array.from({ length: 31 }, (_, i) =>
      h("option", { value: String(i + 1), text: i === 30 ? "말일" : `${i + 1}일` }),
    ),
  );
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
  // 투자 통화 [KRW|USD] (결정 d50). 기본 금액이면 통화에 맞춰 바꾼다
  for (const button of $("currency").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      const before = state.currency;
      state.currency = button.dataset.cur;
      if (before !== state.currency && state.amount === (before === "KRW" ? 2_000_000 : 1_500)) {
        state.amount = state.currency === "KRW" ? 2_000_000 : 1_500;
      }
      changed();
    });
  }
  for (const button of $("mode").querySelectorAll("button")) {
    button.addEventListener("click", () => {
      state.fractional = button.dataset.fractional === "true";
      changed();
    });
  }
  $("fee").addEventListener("input", (e) => {
    state.fee = e.target.value.trim() === "" ? 0 : Number(e.target.value);
    state.serverErrors = {};
    renderAdvancedSummary();
    showErrors(validate());
  });
  $("fee").addEventListener("blur", changed);
  $("tax").addEventListener("click", () => {
    state.tax = !state.tax;
    changed();
  });
  $("rule").replaceChildren(...BUY_RULES.map((r) => h("option", { value: r.key, text: r.name })));
  $("rule").addEventListener("change", (e) => {
    state.rule = e.target.value;
    changed();
  });
  // 규칙끼리 나란히 보려면 전략 비교 탭으로 (F-17). 탭으로 가면 패널이 접히므로 포커스를 탭에 둔다
  $("rule-compare").addEventListener("click", () => {
    if (resultView.shown === null) return;
    selectTab("strategy");
    $("tab-strategy")?.focus();
  });
}

function wireCondBar() {
  $("cond-toggle").addEventListener("click", () => {
    resultView.expanded = !resultView.expanded;
    layoutPanel(); // 포커스는 이 버튼에 그대로 둔다 (펼침 버튼 패턴)
  });
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

/** 처음 빈 자리 문구 (첫 계산이 실패로 끝나면 되돌린다). */
let EMPTY_IDLE = [];

function init() {
  EMPTY_IDLE = [...$("empty").childNodes].map((node) => node.cloneNode(true));
  const fromUrl = readQuery(location.search);
  state.end = fromUrl.end ?? todayKst();
  state.start = fromUrl.start ?? shiftYears(state.end, 5);
  const keys = [
    "freq",
    "monthDay",
    "weekDay",
    "amount",
    "currency",
    "rule",
    "fractional",
    "fee",
    "tax",
  ];
  for (const key of keys) {
    if (key in fromUrl) state[key] = fromUrl[key];
  }
  const codes = fromUrl.codes.length ? fromUrl.codes : DEFAULT_SYMBOLS;
  for (const code of codes) addSymbol(code);
  // 주소에 종목과 탭이 있으면 계산이 끝난 뒤 그 탭을 연다 (없으면 처음 계산은 요약)
  if (fromUrl.codes.length && fromUrl.tab) resultView.tab = fromUrl.tab;
  wireForm();
  wireSearch();
  wireShortcut();
  wireCondBar();
  wireTheme();
  changed();
  if (fromUrl.codes.length) run();
}

init();
