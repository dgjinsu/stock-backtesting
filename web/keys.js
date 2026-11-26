// 키보드 단축키 판정과 키 표시 글 (F-01 종목 검색 Ctrl K, 결정 d49·d52 ②).
// DOM도 navigator도 읽지 않는다. 맥인지는 부르는 쪽(app.js)이 한 번 정해 넘긴다.

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
