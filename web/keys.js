// 키보드 단축키 판정과 키 표시 글 (F-01 종목 검색 Ctrl K, 결정 d49·d52 ②), 검색 목록 자리 스크롤 양.
// DOM도 navigator도 읽지 않는다. 맥인지와 화면 위치는 부르는 쪽(app.js)이 재서 넘긴다.

/**
 * 종목 검색칸으로 가는 단축키인지 본다. 맥이 아니면 Ctrl+K, 맥이면 ⌘K다.
 * 글자(key)가 아니라 키 자리(code "KeyK")로 본다. 그래서 한글 입력 상태("ㅏ"),
 * Caps Lock("K"), 조합 중("Process")에도 같은 자리면 된다.
 * Shift나 Alt를 같이 누르거나 Ctrl과 ⌘를 같이 누르면 반응하지 않는다.
 * @param {{code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean,
 *   altKey?: boolean}} event KeyboardEvent 또는 그 일부. 빠진 수식키는 안 눌린 것이다.
 * @param {boolean} mac
 * @returns {boolean}
 */
export function isSearchShortcut(event, mac) {
  if (event.code !== "KeyK") return false;
  if (event.shiftKey || event.altKey) return false;
  const ctrl = Boolean(event.ctrlKey);
  const meta = Boolean(event.metaKey);
  return mac ? meta && !ctrl : ctrl && !meta;
}

/** 검색칸 안 키 표시 글. */
export function shortcutLabel(mac) {
  return mac ? "⌘K" : "Ctrl K";
}

/** 검색칸의 aria-keyshortcuts 값. 표기("Control", "Meta")가 화면 글과 다르다. */
export function shortcutAria(mac) {
  return mac ? "Meta+K" : "Control+K";
}

/**
 * 검색칸과 그 아래 목록 자리(최대 높이)가 조건 패널 안에 보이게 할 패널 스크롤 양(px, 아래로 +).
 * 0이면 스크롤하지 않는다. 위치는 화면 좌표(getBoundingClientRect), 길이는 CSS px다.
 * 패널 끝에 붙으면 포커스 테두리가 잘리므로 위아래로 gap을 둔다.
 * 칸이 패널 위로 숨어 있으면 되올리고(음수), 목록 자리가 패널 바닥을 넘으면 넘친 만큼 내리되
 * 칸 위끝이 패널 위로 올라가지는 않게 한다.
 * @param {{panelTop: number, panelBottom: number, fieldTop: number, listTop: number,
 *   listMax: number, gap: number}} box fieldTop은 검색칸 감싸개의 위끝, listTop은 칸 위끝에서
 *   목록 위끝까지, listMax는 목록 최대 높이다.
 * @returns {number}
 */
export function searchScrollDelta({ panelTop, panelBottom, fieldTop, listTop, listMax, gap }) {
  const top = fieldTop - gap;
  const bottom = top + gap + listTop + listMax + gap;
  if (top < panelTop) return top - panelTop;
  if (bottom > panelBottom) return Math.min(bottom - panelBottom, top - panelTop);
  return 0;
}
