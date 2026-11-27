// web/style.css 색 토큰 (리디자인 B 바탕, 결정 d47·d48, B-3 채운 컨트롤 결정 d53). node --test로 돈다.
// 값은 이슈 #49·#50과 docs/4_상세설계.md 5절에서, 대비는 WCAG 2 상대 휘도로 잰다.
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

/**
 * tokens()와 같은 블록의 `--이름: N%;` 퍼센트 토큰 (숫자로, 히트맵 진하기 #61). 블록이 없으면 null.
 */
function percentTokens(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = CSS.match(new RegExp(`(?:^|[;}])\\s*${escaped}\\s*\\{([^{}]*)\\}`));
  if (!rule) return null;
  const found = {};
  for (const [, name, value] of rule[1].matchAll(/(--[\w-]+)\s*:\s*(\d+(?:\.\d+)?)%\s*(?:;|$)/g)) {
    found[name] = Number(value);
  }
  return found;
}

const LIGHT = tokens(":root") ?? {};
const DARK = tokens(":root.dark") ?? {};
const LIGHT_PCT = percentTokens(":root") ?? {};
const DARK_PCT = percentTokens(":root.dark") ?? {};

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

/**
 * fg를 bg 위에 p(0~1)만큼 섞은 색: 채널마다 fg × p + bg × (1 − p)를 0~255로 반올림 (srgb 선형 보간).
 * color-mix(in srgb, fg p, transparent)를 bg 위에 겹친 색과 같다.
 */
function mix(fg, bg, p) {
  const channel = (hex, i) => Number.parseInt(hex.slice(i, i + 2), 16);
  const mixed = [1, 3, 5].map((i) => Math.round(channel(fg, i) * p + channel(bg, i) * (1 - p)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
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

// ---------- 다크: 리디자인 B-3 값 (결정 d53) ----------

test("다크 토큰: 바탕·글자·강조·손익·버튼·채운 컨트롤이 B-3 값과 같다 (결정 d53)", () => {
  // panel → --surface, panel2 → --sunken, 버튼 글자 → --btnfg (이슈 #49 "할 일")
  // 이슈 #50: 바탕 다섯과 --sel을 올리고, 입력칸 면 --field·--fieldh와 밑줄 --ctl을 새로 둔다
  const want = lower({
    "--bg": "#121614",
    "--surface": "#181D1B",
    "--sunken": "#1F2522",
    "--line": "#2D3632",
    "--line2": "#34403B",
    "--text": "#E4EAE6",
    "--muted": "#A3ADA8",
    "--acc": "#C5F04A",
    "--accfg": "#0A0C0B",
    "--pos": "#6BE39A",
    "--neg": "#FF7D6E",
    "--btn": "#E4EAE6",
    "--btnfg": "#0A0C0B",
    "--sel": "#3A4641",
    "--field": "#252C29",
    "--fieldh": "#2D3531",
    "--ctl": "#8A9690",
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

test("다크 종목색: --c8은 #E64E84다 (새 패널 #181D1B 위 4.5:1, 결정 d53)", () => {
  // 옛 값 #E0457B는 새 --surface 위에서 4.31:1이라 바꿨다 (이슈 #50)
  assert.equal(DARK["--c8"], "#e64e84");
});

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

// ---------- 입력칸 경계: 채운 컨트롤 (결정 d53, WCAG 1.4.11) ----------

const FIELD_TOKENS = ["--field", "--fieldh", "--ctl"];

test("다크 --ctl: 입력칸 밑줄은 다크 --field·--surface 대비 3:1 이상 (WCAG 1.4.11)", () => {
  for (const bg of ["--field", "--surface"]) {
    assertContrast(DARK["--ctl"], DARK[bg], 3, `다크 --ctl on ${bg}`);
  }
});

test("라이트 토큰: 다크와 같은 이름의 --field·--fieldh·--ctl이 있다", () => {
  const missing = FIELD_TOKENS.filter((name) => !LIGHT[name]);
  assert.deepEqual(missing, [], ":root에 없는 채운 컨트롤 토큰");
});

test("라이트 --ctl: 입력칸 밑줄은 라이트 --field·--surface 대비 3:1 이상 (WCAG 1.4.11)", () => {
  for (const bg of ["--field", "--surface"]) {
    assertContrast(LIGHT["--ctl"], LIGHT[bg], 3, `라이트 --ctl on ${bg}`);
  }
});

// 양도세 스위치 꺼짐 (docs/4 5절): 손잡이는 트랙 대비 3:1 이상. 라이트는 트랙이 패널 대비
// 3:1 이상이고, 다크는 트랙이 패널과 가까워(1.58:1) 손잡이가 패널 대비 3:1 이상으로 경계를 알린다
test("스위치 꺼짐: 두 테마 모두 --knob은 --swoff 대비 3:1 이상", () => {
  for (const [theme, t] of [["라이트", LIGHT], ["다크", DARK]]) {
    assertContrast(t["--knob"], t["--swoff"], 3, `${theme} --knob on --swoff`);
  }
});

test("스위치 꺼짐: 라이트 --swoff는 --surface, 다크 --knob은 --surface 대비 3:1 이상", () => {
  assertContrast(LIGHT["--swoff"], LIGHT["--surface"], 3, "라이트 --swoff on --surface");
  assertContrast(DARK["--knob"], DARK["--surface"], 3, "다크 --knob on --surface");
});

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

// ---------- 그래프 툴팁 강조색 (이슈 #53) ----------

test("툴팁 강조색: --tipacc는 두 테마 모두 라임 #C5F04A이고 툴팁 바탕 대비 4.5:1 이상", () => {
  // 라이트 툴팁도 어두운 바탕(#15181D)이라 라이트 --acc(#4D6B00)로는 날짜 글자가 모자란다
  assert.equal(LIGHT["--tipacc"], "#c5f04a");
  assert.equal(DARK["--tipacc"], "#c5f04a");
  assertContrast(LIGHT["--tipacc"], LIGHT["--tip"], 4.5, "라이트 툴팁 날짜");
  // 다크 --tip은 rgba(10, 12, 11, 0.92)라 바탕 #121614 위에 겹친 색(#0B0D0C)으로 잰다
  assertContrast(DARK["--tipacc"], "#0b0d0c", 4.5, "다크 툴팁 날짜");
  assert.ok(contrast(LIGHT["--acc"], LIGHT["--tip"]) < 4.5, "라이트 --acc를 쓰지 않는 이유");
});

// ---------- 히트맵 칸 진하기 (분석 탭 달마다 얼마나 움직였나, 이슈 #61) ----------
// 칸 바탕은 color-mix(in srgb, var(--pos|--neg) calc(var(--hm-lo) + var(--hm) * var(--hm-span)),
// transparent)이고 상자(--surface) 위에 놓인다. --hm은 0~1 (|월 수익률| 25%에서 1)이라
// 가장 진한 칸은 --hm-lo + --hm-span만큼 섞인다. 글자는 --text다 (설계 메모).

test("mix: 알려진 값 (검정·흰색 절반은 #808080, 0이면 바탕, 1이면 글자 색)", () => {
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#0b7a47", "#ffffff", 0), "#ffffff");
  assert.equal(mix("#0b7a47", "#ffffff", 1), "#0b7a47");
});

const HM_THEMES = [
  { label: "라이트", theme: LIGHT, pct: LIGHT_PCT },
  { label: "다크", theme: DARK, pct: DARK_PCT },
];

for (const { label, pct } of HM_THEMES) {
  test(`${label} 히트맵 토큰: --hm-lo·--hm-span 퍼센트가 있고 합이 100% 이하`, () => {
    for (const name of ["--hm-lo", "--hm-span"]) {
      assert.ok(Number.isFinite(pct[name]), `${label}에 ${name}: N%; 토큰이 없다`);
    }
    assert.ok(pct["--hm-lo"] + pct["--hm-span"] <= 100, `${label} 합이 100%를 넘는다`);
  });
}

test("라이트 히트맵 토큰: 시안과 같은 --hm-lo 8%, --hm-span 55% (가장 진한 칸 63%)", () => {
  assert.deepEqual({ lo: LIGHT_PCT["--hm-lo"], span: LIGHT_PCT["--hm-span"] }, { lo: 8, span: 55 });
});

for (const { label, theme, pct } of HM_THEMES) {
  for (const [tone, name] of [
    ["--pos", "이익"],
    ["--neg", "손실"],
  ]) {
    test(`${label} 히트맵 가장 진한 ${name} 칸: --text 대비 4.5:1 이상`, () => {
      const p = (pct["--hm-lo"] + pct["--hm-span"]) / 100;
      assert.ok(Number.isFinite(p), `${label}에 --hm-lo·--hm-span 토큰이 없다`);
      assert.ok(theme[tone] && theme["--surface"], `${label}에 ${tone}·--surface가 있어야 한다`);
      const cell = mix(theme[tone], theme["--surface"], p);
      assertContrast(theme["--text"], cell, 4.5, `${label} --text on ${name} 칸 ${cell}`);
    });
  }
}

test("다크 히트맵: 시안 공식(최대 63%)을 그대로 쓰면 이익 칸 --text 대비가 4.5:1에 못 미친다", () => {
  // 다크 진하기를 시안과 다르게 두는 이유 (설계 메모 4: 이익 칸 2.81:1)
  const cell = mix(DARK["--pos"], DARK["--surface"], 0.63);
  assert.ok(contrast(DARK["--text"], cell) < 4.5, `${cell} 대비 ${contrast(DARK["--text"], cell)}`);
});
