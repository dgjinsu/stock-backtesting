// DOM을 만드는 작은 도우미. 화면 모듈(app.js, charts.js)이 같이 쓴다.

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

/** 종목 선 모양 견본 (색 + 점선). slot은 0~7. color를 주면 그 색(투자금·평단가는 var(--ref)). */
export function swatch(slot, width = 20, { color = `var(--c${slot + 1})` } = {}) {
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
    "stroke-linecap": "round",
  })) {
    line.setAttribute(k, String(v));
  }
  line.style.stroke = color;
  if (DASHES[slot]) line.style.strokeDasharray = DASHES[slot];
  svg.append(line);
  return svg;
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
