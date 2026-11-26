// web/index.html 머리의 테마 인라인 스크립트 (F-07, 결정 d47). node --test로 돈다.
// 모듈로 빼면 그리기 전에 테마를 정하지 못해 깜빡이므로, index.html의 글을 그대로 꺼내 돌린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const HTML = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

/** 테마 스크립트를 알아보는 글: localStorage.getItem("theme") (따옴표 종류·공백은 가리지 않는다). */
const READS_THEME = /localStorage\s*\.\s*getItem\s*\(\s*["'`]theme["'`]\s*\)/;

/** index.html의 <script> 블록 전부: 여는 태그 속성, 글, 파일에서의 위치. */
function scripts() {
  return [...HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((m) => ({
    attrs: m[1],
    body: m[2],
    index: m.index,
  }));
}

/** 테마를 읽는 <script> 블록 하나. 없거나 여럿이면 실패. */
function themeScript() {
  const found = scripts().filter((s) => READS_THEME.test(s.body));
  assert.equal(found.length, 1, 'localStorage.getItem("theme")를 담은 <script>는 하나여야 한다');
  return found[0];
}

/** <html> 여는 태그의 처음 클래스 (index.html에 적힌 그대로). */
function initialClasses() {
  const tag = HTML.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const cls = tag.match(/\bclass\s*=\s*"([^"]*)"/i)?.[1] ?? "";
  return cls.split(/\s+/).filter(Boolean);
}

const THROWS = Symbol("getItem이 예외를 던진다");

/**
 * 가짜 브라우저에서 테마 스크립트를 돌리고 <html>에 dark 클래스가 켜졌는지 돌려준다.
 * saved: localStorage "theme" 값 (null = 저장값 없음, THROWS = getItem 예외). osDark: 운영체제 다크.
 */
function runTheme({ saved, osDark }) {
  const classes = new Set(initialClasses());
  const classList = {
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : Boolean(force);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
    add(...names) {
      for (const name of names) classes.add(name);
    },
    remove(...names) {
      for (const name of names) classes.delete(name);
    },
    contains(name) {
      return classes.has(name);
    },
  };
  const localStorage = {
    getItem(key) {
      if (saved === THROWS) throw new Error("SecurityError: 저장소를 쓸 수 없음");
      return key === "theme" ? saved : null;
    },
    setItem() {},
    removeItem() {},
  };
  const matchMedia = (query) => {
    const asksDark = /prefers-color-scheme\s*:\s*dark/.test(query);
    const asksLight = /prefers-color-scheme\s*:\s*light/.test(query);
    return {
      media: query,
      matches: (asksDark && osDark) || (asksLight && !osDark),
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    };
  };
  const sandbox = {
    localStorage,
    matchMedia,
    document: { documentElement: { classList, dataset: {}, style: {} } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(themeScript().body, sandbox);
  return classes.has("dark");
}

// ---------- 자리: 그리기 전에 도는 인라인 스크립트 ----------

test("테마 스크립트: index.html <head> 안에 src 없는 인라인 스크립트로 하나 있다", () => {
  const script = themeScript();
  const headEnd = HTML.search(/<\/head\s*>/i);
  assert.ok(headEnd > 0, "index.html에 </head>가 있어야 한다");
  assert.ok(script.index < headEnd, "테마 스크립트는 <head> 안에 있어야 한다");
  // 모듈·defer·async·src면 첫 그리기 뒤에 돌아 라이트가 먼저 비친다
  assert.doesNotMatch(script.attrs, /\bsrc\s*=/i);
  assert.doesNotMatch(script.attrs, /\btype\s*=\s*["']?module/i);
  assert.doesNotMatch(script.attrs, /\b(defer|async)\b/i);
});

// ---------- 처음 테마: 저장값이 없으면 다크 (결정 d47) ----------

const SAVED = [
  { label: "저장값 없음", saved: null },
  { label: '저장값 "light"', saved: "light" },
  { label: '저장값 "dark"', saved: "dark" },
  { label: "localStorage.getItem 예외", saved: THROWS },
];
const OS = [
  { label: "운영체제 라이트", osDark: false },
  { label: "운영체제 다크", osDark: true },
];

for (const { label: savedLabel, saved } of SAVED) {
  for (const { label: osLabel, osDark } of OS) {
    // "light"만 라이트, 나머지(없음·"dark"·예외)는 운영체제와 상관없이 다크
    const expectDark = saved !== "light";
    const name = `테마 스크립트: ${savedLabel}, ${osLabel} → ${expectDark ? "다크" : "라이트"}`;
    test(name, () => {
      const want = `dark 클래스가 ${expectDark ? "켜져" : "꺼져"} 있어야 한다`;
      assert.equal(runTheme({ saved, osDark }), expectDark, want);
    });
  }
}

// ---------- 테마 버튼의 처음 이름 ----------

test("테마 버튼: 처음 aria-label은 '라이트 모드로 바꾸기' (처음 테마가 다크라서)", () => {
  const button = HTML.match(/<button\b[^>]*\bid\s*=\s*"theme-toggle"[^>]*>/i)?.[0];
  assert.ok(button, 'index.html에 id="theme-toggle" 버튼이 있어야 한다');
  const label = button.match(/\baria-label\s*=\s*"([^"]*)"/i)?.[1];
  assert.equal(label, "라이트 모드로 바꾸기");
});
