// web/style.css 색 토큰 (리디자인 B 바탕, 결정 d47·d48). node --test로 돈다.
// 값은 이슈 #49와 docs/4_상세설계.md 5절에서, 대비는 WCAG 2 상대 휘도로 잰다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CSS = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * 맨 바깥 규칙 중 선택자가 정확히 selector인 블록의 `--이름: #rrggbb;` (6자리 hex만, 소문자).
 * 블록이 없으면 null.
 */
function tokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = CSS.match(new RegExp(`(?:^|[;}])\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  if (!rule) return null;
  const found = {};
  for (const [, name, hex] of rule[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*(?:;|$)/g)) {
    found[name] = hex.toLowerCase();
  }
  return found;
}

const LIGHT = tokens(":root") ?? {};
const DARK = tokens(":root.dark") ?? {};

/** 이름들의 값만 뽑는다 (없는 이름은 undefined로 남겨 견줄 때 드러나게). */
function pick(theme, names) {
  return Object.fromEntries(names.map((name) => [name, theme[name]]));
}

/** 대소문자를 무시하려고 값을 소문자로. */
function lower(table) {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.toLowerCase()]));
}

// ---------- WCAG 2 대비 (테스트 도구) ----------

/** #rrggbb의 상대 휘도. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 두 색의 대비 (1~21). */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** fg가 bg 대비 min:1 이상인지. 값이 없으면 그것부터 알린다. */
function assertContrast(fg, bg, min, label) {
  assert.ok(fg, `${label}: 글자 색 토큰이 없다`);
  assert.ok(bg, `${label}: 바탕 색 토큰이 없다`);
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= min, `${label}: ${fg} / ${bg} 대비 ${ratio.toFixed(2)}:1 < ${min}:1`);
}

const SERIES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];

test("contrast: 알려진 대비와 같다 (검정/흰 21:1, 이슈 #49의 #4D6B00 값)", () => {
  assert.ok(Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01);
  assert.ok(Math.abs(contrast("#ffffff", "#ffffff") - 1) < 0.01);
  assert.ok(Math.abs(contrast("#4d6b00", "#ffffff") - 6.14) < 0.01);
  assert.ok(Math.abs(contrast("#4d6b00", "#f5f6f8") - 5.68) < 0.01);
  assert.ok(Math.abs(contrast("#4d6b00", "#eff1f4") - 5.43) < 0.01);
});

test("style.css: :root와 :root.dark 블록이 있다", () => {
  assert.ok(tokens(":root"), ":root { … } 블록이 있어야 한다");
  assert.ok(tokens(":root.dark"), ":root.dark { … } 블록이 있어야 한다");
});

// ---------- 다크: 리디자인 B 값 ----------

test("다크 토큰: 바탕·글자·강조·손익·버튼이 B 값과 같다", () => {
  // panel → --surface, panel2 → --sunken, 버튼 글자 → --btnfg (이슈 #49 "할 일")
  const want = lower({
    "--bg": "#0A0C0B",
    "--surface": "#101412",
    "--sunken": "#171C1A",
    "--line": "#232A27",
    "--line2": "#34403B",
    "--text": "#E4EAE6",
    "--muted": "#909A95",
    "--acc": "#C5F04A",
    "--accfg": "#0A0C0B",
    "--pos": "#6BE39A",
    "--neg": "#FF7D6E",
    "--btn": "#E4EAE6",
    "--btnfg": "#0A0C0B",
    "--sel": "#27302C",
  });
  assert.deepEqual(pick(DARK, Object.keys(want)), want);
});

test("다크 토큰: 툴팁 바탕은 B 값 rgba(10, 12, 11, 0.92)다", () => {
  // hex가 아니라 tokens()가 읽지 않으므로 :root.dark 블록 글에서 직접 찾는다
  const block = CSS.match(/:root\.dark\s*\{([^}]*)\}/)[1];
  assert.match(block, /--tip:\s*rgba\(\s*10,\s*12,\s*11,\s*0?\.92\s*\)\s*;/);
});

test("다크 토큰: --c1~--c4가 B 값과 같다", () => {
  const want = lower({
    "--c1": "#7DA2FF",
    "--c2": "#FF9356",
    "--c3": "#3FDCC4",
    "--c4": "#F5D25A",
  });
  assert.deepEqual(pick(DARK, Object.keys(want)), want);
});

// ---------- 다크 종목 8색 (결정 d48) ----------

test("다크 종목색: --c1~--c8이 모두 있고 8개가 서로 다르다", () => {
  const missing = SERIES.filter((name) => !DARK[name]);
  assert.deepEqual(missing, [], ":root.dark에 없는 종목색");
  const values = SERIES.map((name) => DARK[name]);
  assert.equal(new Set(values).size, 8, `겹치는 색이 있다: ${values.join(", ")}`);
});

test("다크 종목색: --c1~--c8은 다크 --pos·--neg·--acc와 같지 않다", () => {
  for (const other of ["--pos", "--neg", "--acc"]) {
    assert.ok(DARK[other], `:root.dark에 ${other}가 있어야 한다`);
  }
  for (const name of SERIES) {
    for (const other of ["--pos", "--neg", "--acc"]) {
      assert.notEqual(DARK[name], DARK[other], `다크 ${name}이 ${other}와 같다`);
    }
  }
});

for (const name of SERIES) {
  // 이슈 #49는 3:1이지만 docs/4 5절은 "8색 모두 4.5:1 이상"이라 더 엄한 쪽을 지킨다
  test(`다크 종목색: ${name}은 다크 --bg·--surface 대비 4.5:1 이상`, () => {
    for (const bg of ["--bg", "--surface"]) {
      assertContrast(DARK[name], DARK[bg], 4.5, `다크 ${name} on ${bg}`);
    }
  });
}

// ---------- 글자 대비: 두 테마 모두 ----------

const THEMES = [
  { label: "라이트", theme: LIGHT },
  { label: "다크", theme: DARK },
];

for (const { label, theme } of THEMES) {
  for (const fg of ["--text", "--muted"]) {
    test(`${label} ${fg}: --bg·--surface·--sunken 대비 4.5:1 이상`, () => {
      for (const bg of ["--bg", "--surface", "--sunken"]) {
        assertContrast(theme[fg], theme[bg], 4.5, `${label} ${fg} on ${bg}`);
      }
    });
  }
}

for (const fg of ["--pos", "--neg"]) {
  test(`다크 ${fg}: 다크 --bg·--surface 대비 4.5:1 이상`, () => {
    for (const bg of ["--bg", "--surface"]) {
      assertContrast(DARK[fg], DARK[bg], 4.5, `다크 ${fg} on ${bg}`);
    }
  });
}

// ---------- 라이트 ----------

test("라이트 --acc: 있고, #FFFFFF와 라이트 --bg 대비 4.5:1 이상", () => {
  assert.ok(LIGHT["--acc"], ":root에 --acc가 있어야 한다");
  assertContrast(LIGHT["--acc"], "#ffffff", 4.5, "라이트 --acc on #FFFFFF");
  assertContrast(LIGHT["--acc"], LIGHT["--bg"], 4.5, "라이트 --acc on --bg");
});

test("라이트 종목색·손익색: docs/4 5절 값 그대로", () => {
  // docs/4_상세설계.md 5절 색 표 라이트 열과 손익 색 줄 (이익 #0B7A47, 손실 #C42B2B)
  const want = lower({
    "--c1": "#2a78d6",
    "--c2": "#eb6834",
    "--c3": "#1baf7a",
    "--c4": "#eda100",
    "--c5": "#e87ba4",
    "--c6": "#008300",
    "--c7": "#6250d6",
    "--c8": "#e34948",
    "--pos": "#0b7a47",
    "--neg": "#c42b2b",
  });
  assert.deepEqual(pick(LIGHT, Object.keys(want)), want);
});
