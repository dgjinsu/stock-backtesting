// web/keys.js 키보드 단축키 판정 (F-01 검색 Ctrl K, 결정 d49·d52). node --test로 돈다.
// 가짜 이벤트 객체 {ctrlKey, metaKey, shiftKey, altKey, code, key}로 시험한다.
// 빠진 필드는 브라우저 이벤트에서 false/undefined인 것과 같게 본다.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSearchShortcut, shortcutLabel } from "../../web/keys.js";

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
