// 전략 비교 탭(F-15)을 그린다: 탭 맨 위 → 고르기 줄 → 상태 줄 → 본문(알림·카드·계산 방법) → 탭 끝 안내.
// 글·카드 모델·요청 묶음은 strategydata.js(DOM 없음)가 만들고, 여기서는 요소를 만들고 /api/strategy를
// 부른다. app.js는 import하지 않는다 (색 자리는 slotOf로 받는다).
// 새 결과마다 strategyPanel이 저장이 빈 view를 만들고, 탭이 보일 때 showStrategy가 부른다 (결정 보드 d63).

import { RULE_MA_DAYS } from "./conditions.js";
import { alertBox, h, keepFocus, segButtons } from "./dom.js";
import { basisText } from "./results.js";
import {
  MA_CHOICES,
  REF_LINE,
  STRATEGY_LOADING,
  STRATEGY_NOTES,
  STRATEGY_TITLE,
  failureOf,
  fractionalNote,
  methodCells,
  pickSymbol,
  refFetchedNote,
  strategyBody,
  strategyCards,
  strategyIntro,
  strategyKey,
  strategyRequests,
  strategyStale,
} from "./strategydata.js";

/** 고른 종목·이평선. 다시 계산해도 남기고(그 종목이 있으면), 주소에는 담지 않는다 (F-11은 탭만). */
const picks = { symbol: null, maDays: RULE_MA_DAYS };
/** 지금 결과의 view. 새 결과(strategyPanel)나 실패 상자(clearStrategy)면 버린다. */
let active = null;

/** null·false를 빼고 자식을 바꾼다 (replaceChildren은 null을 글자 "null"로 넣는다). */
function fill(parent, ...children) {
  parent.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
}

/** POST /api/strategy. 연결 실패면 null, 아니면 { status, json } (본문이 JSON이 아니면 json null). */
async function send(body) {
  let response;
  try {
    response = await fetch("/api/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** 전략 비교 탭 패널의 자식들. 새 결과마다 부른다. 앞 view를 버리고 저장이 빈 view를 만든다. */
export function strategyPanel(data, slotOf, shown) {
  if (active) active.disposed = true;
  const symbols = data.results.map((r) => r.symbol);
  picks.symbol = pickSymbol(symbols, picks.symbol);
  const view = {
    data,
    slotOf,
    shown,
    symbols,
    requests: strategyRequests(send),
    drawnKey: null,
    disposed: false,
    picksRow: h("div", { class: "st-picks" }),
    refLine: h("p", { class: "st-ref", text: REF_LINE }),
    refNote: h("p", { class: "hint st-ref-note", hidden: true }),
    status: h("p", { class: "st-status", role: "status" }),
    body: h("div", { class: "st-body", tabindex: "-1" }),
  };
  active = view;
  renderPicks(view);
  return [
    h(
      "div",
      { class: "st-head" },
      h("h3", { text: STRATEGY_TITLE }),
      h("p", { class: "an-intro", text: strategyIntro(data.params) }),
    ),
    h(
      "div",
      { class: "st-tools" },
      view.picksRow,
      h("div", { class: "st-refs" }, view.refLine, view.refNote),
    ),
    view.status,
    view.body,
    h("ul", { class: "an-notes" }, ...STRATEGY_NOTES.map((text) => h("li", { text }))),
  ];
}

/** 탭이 보일 때. 고른 (종목, 이평선)을 그렸으면 그대로, 저장돼 있으면 그리고, 없으면 부른다. */
export function showStrategy() {
  const view = active;
  if (!view || view.disposed || !picks.symbol || !view.shown) return;
  const key = strategyKey(picks.symbol, picks.maDays);
  // 이미 그렸거나 저장한 key로 돌아가도 고른 key를 알린다. 가는 중인 앞 요청이 늦게 와도 그리지 않는다
  view.requests.select(key);
  if (view.drawnKey === key) {
    setBusy(view, false);
    return;
  }
  const saved = view.requests.saved(key);
  if (saved) {
    setBusy(view, false);
    draw(view, saved);
    view.drawnKey = key;
    return;
  }
  setBusy(view, true);
  const symbol = picks.symbol;
  view.requests
    .pick(key, strategyBody(view.shown, symbol, picks.maDays))
    .then(({ reply, latest }) => {
      if (view.disposed || !latest) return; // 늦게 온 앞 요청은 저장만 하고 그리지 않는다
      setBusy(view, false);
      const ok = draw(view, reply, symbol);
      view.drawnKey = ok ? key : null; // 실패는 저장하지 않으니 다시 시도하면 다시 부른다
    });
}

/** 결과 자리가 실패 상자로 바뀔 때. 지금 view를 버린다. */
export function clearStrategy() {
  if (active) active.disposed = true;
  active = null;
}

function setBusy(view, on) {
  view.status.textContent = on ? STRATEGY_LOADING : "";
  view.body.classList.toggle("dim", on);
  if (on) view.body.setAttribute("aria-busy", "true");
  else view.body.removeAttribute("aria-busy");
}

function pick(change) {
  const view = active;
  if (!view) return;
  Object.assign(picks, change);
  keepFocus(view.picksRow, () => renderPicks(view));
  showStrategy();
}

/** 고르기 줄: 종목(결과 종목이 하나면 두지 않는다)과 이평선. */
function renderPicks(view) {
  const symbolItems = view.symbols.map((code) => ({
    key: code,
    label: code,
    slot: view.slotOf(code),
  }));
  const maItems = MA_CHOICES.map((days) => ({ key: days, label: `${days}일` }));
  fill(
    view.picksRow,
    view.symbols.length > 1
      ? h(
          "div",
          { class: "st-pick" },
          h("span", { class: "lbl", "aria-hidden": "true", text: "종목" }),
          segButtons(
            symbolItems,
            (i) => i.key === picks.symbol,
            (i) => pick({ symbol: i.key }),
            "전략을 계산할 종목",
          ),
        )
      : null,
    h(
      "div",
      { class: "st-pick" },
      h("span", { class: "lbl", "aria-hidden": "true", text: "이평선" }),
      segButtons(
        maItems,
        (i) => i.key === picks.maDays,
        (i) => pick({ maDays: i.key }),
        "이평선 기간",
      ),
    ),
  );
}

/** 응답을 그린다. 실패면 빨강 상자와 다시 시도를 두고 false. */
function draw(view, reply, symbol = picks.symbol) {
  // 다시 시도를 키보드로 눌렀으면 버튼이 사라져도 포커스가 body로 빠지지 않게 새 본문으로 옮긴다
  const hadFocus = view.body.contains(document.activeElement);
  const ok = drawBody(view, reply, symbol);
  if (hadFocus) (view.body.querySelector(".st-retry") ?? view.body).focus();
  return ok;
}

function drawBody(view, reply, symbol) {
  const failure = failureOf(reply, symbol);
  if (failure) {
    view.refLine.textContent = REF_LINE;
    view.refNote.hidden = true;
    fill(
      view.body,
      alertBox(
        "bad",
        failure,
        h("button", {
          type: "button",
          class: "st-retry",
          onclick: showStrategy,
          text: "다시 시도",
        }),
      ),
    );
    return false;
  }
  const response = reply.json;
  const result = response.result;
  const ma = response.params.ma_days ?? RULE_MA_DAYS;
  const ref = result.switch_ref;
  const basis = ref ? basisText(ref.basis, [result.symbol], ref.symbol, ma) : null;
  view.refLine.textContent = basis ? `${REF_LINE} · ${basis}` : REF_LINE;
  const fetched = refFetchedNote(view.symbols, response);
  view.refNote.textContent = fetched ?? "";
  view.refNote.hidden = !fetched;
  const buys = view.data.results.find((r) => r.symbol === result.symbol)?.summary.buys;
  const note = fractionalNote(response.params);
  fill(
    view.body,
    note ? h("p", { class: "hint st-frac", text: note }) : null,
    ...strategyStale(response).map((alert) => alertBox("warn", alert)),
    h(
      "ul",
      { class: "st-cards", "aria-label": `${result.symbol} 전략 5개` },
      ...strategyCards(response, buys).map(cardItem),
    ),
    methodsBox(response),
  );
  return true;
}

/** 전략 카드 하나: 이름·규칙 한 줄 → 평가금 → 칸 → 바닥 한 줄. 기준 종목만 실패하면 오류 글. */
function cardItem(card) {
  const head = h(
    "div",
    { class: "st-card-head" },
    h("h4", { text: card.name }),
    h("p", { class: "st-rule", text: card.rule }),
  );
  if (card.error) {
    return h(
      "li",
      { class: "st-card st-card-error" },
      head,
      h("p", { class: "st-error-title", text: card.error.title }),
      h("p", { class: "st-error-detail", text: card.error.detail }),
    );
  }
  return h(
    "li",
    { class: card.base ? "st-card base" : "st-card" },
    head,
    h("p", { class: "st-value", text: card.value }),
    h(
      "dl",
      { class: "st-cells" },
      ...card.cells.map((cell) =>
        h(
          "div",
          {},
          h("dt", { text: cell.label }),
          h(
            "dd",
            { class: cell.tone || null },
            cell.best ? h("strong", { text: cell.text }) : cell.text,
            cell.best ? h("span", { class: "sr", text: " (가장 좋은 값)" }) : null,
          ),
        ),
      ),
    ),
    card.foot ? h("p", { class: "st-fact", text: card.foot }) : null,
  );
}

/** 계산 방법 세 칸 (시안): 같은 예산 / 안 쓴 현금도 평가금 / 미래 데이터 금지. */
function methodsBox(response) {
  return h(
    "section",
    { class: "box", "aria-labelledby": "st-method-h" },
    h("div", { class: "box-head" }, h("h3", { id: "st-method-h", text: "계산 방법" })),
    h(
      "ol",
      { class: "st-methods" },
      ...methodCells(response).map((cell) =>
        h("li", {}, h("strong", { text: cell.title }), h("p", { text: cell.text })),
      ),
    ),
  );
}
