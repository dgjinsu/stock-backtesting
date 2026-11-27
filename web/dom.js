// DOM을 만드는 작은 도우미. 화면 모듈(app.js, charts.js, analysis.js, strategy.js)이 같이 쓴다.

import { DASHES } from "./chartdata.js";

const SVG = "http://www.w3.org/2000/svg";

/** 요소를 만든다. 글자는 textContent로만 넣는다 (서버 값을 innerHTML에 넣지 않는다). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** SVG 요소를 만든다. attrs는 속성 이름 → 값 (null·undefined는 건너뛴다). */
export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  return el;
}

/**
 * 다시 그려도 누르던 버튼에 포커스를 둔다. container 안에서 포커스가 있던 요소의
 * data-focus 이름으로 다시 찾는다 (그래프 도구, 범례, 매수 내역, 비교 표 정렬).
 */
export function keepFocus(container, render) {
  const active = document.activeElement;
  const key = container.contains(active) ? active.dataset.focus : undefined;
  render();
  if (key) container.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus();
}

/**
 * 종목 선 모양 견본 (색 + 점선). slot은 0~7. color를 주면 그 색(투자금·평단가는 var(--ref)),
 * dash를 주면 그 점선(하나로 합친 투자금은 "3 3"), cap은 선 끝 모양이다.
 */
export function swatch(
  slot,
  width = 20,
  { color = `var(--c${slot + 1})`, dash = DASHES[slot], cap = "round" } = {},
) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", "6");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("swatch");
  const line = document.createElementNS(SVG, "line");
  for (const [k, v] of Object.entries({
    x1: 1,
    y1: 3,
    x2: width - 1,
    y2: 3,
    "stroke-width": 3,
    "stroke-linecap": cap, // 짧은 점선은 끝이 둥글면 틈이 메워져 "butt"로 준다
  })) {
    line.setAttribute(k, String(v));
  }
  line.style.stroke = color;
  if (dash) line.style.strokeDasharray = dash;
  svg.append(line);
  return svg;
}

/**
 * 고르는 버튼 묶음 (.seg, aria-pressed). items는 {key, label, slot?}이고 slot이 있으면 견본을 앞에 붙인다.
 * data-focus는 "label:key"라 keepFocus로 다시 그려도 누르던 버튼에 포커스가 남는다
 * (그래프 도구, 매수 내역, 분석 탭 달마다).
 */
export function segButtons(items, isOn, onPick, label) {
  const group = h("div", { class: "seg inline-seg", role: "group", "aria-label": label });
  for (const item of items) {
    const on = isOn(item);
    group.append(
      h(
        "button",
        {
          type: "button",
          class: on ? "on" : null,
          "aria-pressed": String(on),
          "data-focus": `${label}:${String(item.key)}`,
          onclick: () => onPick(item),
        },
        item.slot === undefined ? null : swatch(item.slot, 16),
        item.label,
      ),
    );
  }
  return group;
}

/** 선으로 그린 아이콘. paths는 24×24 기준 SVG path 목록. */
export function icon(paths, size = 16) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, String(v));
  }
  for (const d of paths) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    svg.append(path);
  }
  return svg;
}

const ALERT_ICONS = {
  bad: [
    "M12 8v5",
    "M12 16.5v.5",
    "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  ],
  info: ["M12 11v6", "M12 7.5v.5", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"],
};

/**
 * F-10 알림 상자 (app.js alerts와 같은 마크업). kind는 bad(빨강)·warn(노랑)·info(파랑), title은 굵게,
 * detail은 그 뒤 글, extra는 상자 안 끝에 더할 요소(다시 시도 버튼 등)다. 빨강은 role="alert".
 */
export function alertBox(kind, { title, detail }, ...extra) {
  return h(
    "div",
    { class: `alert ${kind}`, role: kind === "bad" ? "alert" : null },
    icon(ALERT_ICONS[kind] ?? ALERT_ICONS.bad, 18),
    h("div", {}, h("strong", { text: title }), detail ? ` ${detail}` : null, ...extra),
  );
}
