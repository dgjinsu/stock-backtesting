// web/keys.js 키보드 단축키 판정 (F-01 검색 Ctrl K, 결정 d49·d52)과 검색 목록 자리 스크롤 양
// (이슈 #59). node --test로 돈다.
// 가짜 이벤트 객체 {ctrlKey, metaKey, shiftKey, altKey, code, key}로 시험한다.
// 빠진 필드는 브라우저 이벤트에서 false/undefined인 것과 같게 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSearchShortcut,
  searchScrollDelta,
  shortcutAria,
  shortcutLabel,
} from "../../web/keys.js";

// ---------- isSearchShortcut: 맥이 아닐 때 (Ctrl+K) ----------

const NOT_MAC = [
  { label: 'Ctrl+K (key "k")', event: { ctrlKey: true, code: "KeyK", key: "k" }, want: true },
  {
    label: 'Ctrl+K (key "K", Caps Lock)',
    event: { ctrlKey: true, code: "KeyK", key: "K" },
    want: true,
  },
  {
    label: 'Ctrl+K 한글 입력 (key "ㅏ", code "KeyK")',
    event: { ctrlKey: true, code: "KeyK", key: "ㅏ" },
    want: true,
  },
  {
    label: "Ctrl+K 모든 필드를 채운 이벤트",
    event: {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      code: "KeyK",
      key: "k",
    },
    want: true,
  },
  { label: "Meta+K만 (맥 키)", event: { metaKey: true, code: "KeyK", key: "k" }, want: false },
  {
    label: "Ctrl+Shift+K",
    event: { ctrlKey: true, shiftKey: true, code: "KeyK", key: "K" },
    want: false,
  },
  {
    label: "Ctrl+Alt+K",
    event: { ctrlKey: true, altKey: true, code: "KeyK", key: "k" },
    want: false,
  },
  { label: 'Ctrl+J (code "KeyJ")', event: { ctrlKey: true, code: "KeyJ", key: "j" }, want: false },
  { label: "수식키 없이 K만", event: { code: "KeyK", key: "k" }, want: false },
  {
    label: 'Ctrl+K 한글 조합 중 (key "Process")',
    event: { ctrlKey: true, code: "KeyK", key: "Process" },
    want: true,
  },
  {
    label: "Ctrl+Meta+K",
    event: { ctrlKey: true, metaKey: true, code: "KeyK", key: "k" },
    want: false,
  },
];

for (const { label, event, want } of NOT_MAC) {
  test(`isSearchShortcut: 맥 아님, ${label} → ${want ? "참" : "거짓"}`, () => {
    assert.equal(isSearchShortcut(event, false), want);
  });
}

// ---------- isSearchShortcut: 맥일 때 (⌘K) ----------

const MAC = [
  { label: "⌘K", event: { metaKey: true, code: "KeyK", key: "k" }, want: true },
  { label: "⌘K (code만)", event: { metaKey: true, code: "KeyK" }, want: true },
  { label: "Ctrl+K만", event: { ctrlKey: true, code: "KeyK" }, want: false },
  {
    label: "⌘+Shift+K",
    event: { metaKey: true, shiftKey: true, code: "KeyK", key: "K" },
    want: false,
  },
  { label: "⌘+Alt+K", event: { metaKey: true, altKey: true, code: "KeyK", key: "k" }, want: false },
  { label: "수식키 없이 K만", event: { code: "KeyK", key: "k" }, want: false },
  {
    label: "⌘+Ctrl+K",
    event: { metaKey: true, ctrlKey: true, code: "KeyK", key: "k" },
    want: false,
  },
];

for (const { label, event, want } of MAC) {
  test(`isSearchShortcut: 맥, ${label} → ${want ? "참" : "거짓"}`, () => {
    assert.equal(isSearchShortcut(event, true), want);
  });
}

// ---------- shortcutLabel: 검색칸 키 표시 글 (결정 d52 ②) ----------

test('shortcutLabel: 맥이 아니면 "Ctrl K"', () => {
  assert.equal(shortcutLabel(false), "Ctrl K");
});

test('shortcutLabel: 맥이면 "⌘K"', () => {
  assert.equal(shortcutLabel(true), "⌘K");
});

// ---------- shortcutAria: 검색칸 aria-keyshortcuts 값 (화면 글과 표기가 다르다) ----------

test('shortcutAria: 맥이 아니면 "Control+K"', () => {
  assert.equal(shortcutAria(false), "Control+K");
});

test('shortcutAria: 맥이면 "Meta+K"', () => {
  assert.equal(shortcutAria(true), "Meta+K");
});

// ---------- searchScrollDelta: 검색칸과 목록 자리가 조건 패널 안에 보이게 할 스크롤 양 (이슈 #59) ----------
// 목록 자리: 칸 위끝 − gap부터 gap + listTop + listMax + gap까지. 위로 숨으면 음수(되올림),
// 바닥을 넘으면 넘친 만큼 양수(내림)이되 칸 위끝까지 거리로 막힌다. 다 보이면 0.
// gap 16, listTop 44, listMax 360은 이슈 #59 완료 기준의 값이다 (px).

const LIST = { listTop: 44, listMax: 360, gap: 16 };

const SCROLL = [
  { label: "칸이 패널 위로 숨으면 되올린다", panel: [60, 740], fieldTop: 40, want: -36 },
  { label: "목록 자리가 패널 바닥을 넘으면 넘친 만큼 내린다", panel: [60, 740], fieldTop: 500, want: 180 },
  {
    label: "낮은 패널에서는 칸 위끝까지 거리로 막힌다",
    panel: [60, 400],
    fieldTop: 200,
    want: 124,
  },
  { label: "칸과 목록 자리가 이미 보이면 스크롤하지 않는다", panel: [60, 740], fieldTop: 100, want: 0 },
];

for (const { label, panel, fieldTop, want } of SCROLL) {
  const [panelTop, panelBottom] = panel;
  const name = `패널 ${panelTop}~${panelBottom}, 칸 위끝 ${fieldTop} → ${want}`;
  test(`searchScrollDelta: ${label} (${name})`, () => {
    assert.equal(searchScrollDelta({ panelTop, panelBottom, fieldTop, ...LIST }), want);
  });
}
