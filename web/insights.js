// 한눈에 요약 (F-12): 계산 결과로 만든 문장과 하이라이트 4개. DOM 없음.
// AI가 아니라 정해진 문장 틀에 숫자를 넣는다. 문구 틀은 모두 이 파일에 둔다 (결정 d42).
// 같은 값이면 결과 순서가 앞인 종목을 고른다 (결정 d25 "같으면 앞의 것"과 같은 방식).

import { pct, qty, rate, times } from "./format.js";

/** 끝 글자를 읽으면 받침이 있는 것: 엘·엠·엔·알, 영·일·삼·육·칠·팔. */
const FINAL_SOUND = /[LMNR013678]$/i;

/**
 * 종목 코드 뒤 조사. pair는 "이/가"나 "은/는"이고, 코드 끝 글자를 읽는 소리로 고른다.
 * josa("SOXL", "이/가") → "이", josa("TQQQ", "이/가") → "가".
 */
export function josa(code, pair) {
  const [withFinal, withoutFinal] = pair.split("/");
  return FINAL_SOUND.test(code) ? withFinal : withoutFinal;
}

/** 손익 색 이름: 이익 pos, 손실 neg, 0은 없음. */
function toneOf(value) {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "";
}

/** key가 가장 큰(more) 또는 작은(!more) 결과. 같으면 앞의 것. key가 null이면 뺀다. */
function pick(results, key, more) {
  let best = null;
  let bestValue = null;
  for (const result of results) {
    const value = key(result.summary);
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    if (best === null || (more ? value > bestValue : value < bestValue)) {
      best = result;
      bestValue = value;
    }
  }
  return best;
}

const returnOf = (s) => s.return_pct;
const xirrOf = (s) => s.xirr_pct;
const worstOf = (s) => s.worst?.return_pct;

// ---------- 문장 ----------

const plain = (text) => ({ text, strong: false, tone: "" });
const strong = (text, tone = "") => ({ text, strong: true, tone });

/** 첫 문장: 이익·손실 개수. 수익률이 0 아래면 손실, 나머지는 이익으로 센다. */
function countSentence(results) {
  const n = results.length;
  const losses = results.filter((r) => r.summary.return_pct < 0).length;
  if (losses === 0) return `${n}개 종목 모두 이익입니다.`;
  if (losses === n) return `${n}개 종목 모두 손실입니다.`;
  return `${n}개 종목 중 ${n - losses}개는 이익, ${losses}개는 손실입니다.`;
}

/** 최저 수익률이 0 아래로 내려갔으면 그 날짜와 값. */
function fall(summary) {
  const worst = summary.worst;
  return worst && worst.return_pct < 0 ? worst : null;
}

/** 종목 하나: "QLD는 수익률 +88.19%, 연환산 25.75%입니다. 2022-06-16에는 −39.4%까지 빠졌습니다." */
function singleParts(result) {
  const s = result.summary;
  const parts = [
    strong(result.symbol),
    plain(`${josa(result.symbol, "은/는")} 수익률 `),
    strong(pct(s.return_pct), toneOf(s.return_pct)),
  ];
  if (s.xirr_pct !== null && s.xirr_pct !== undefined) {
    parts.push(plain(", 연환산 "), strong(rate(s.xirr_pct)));
  }
  parts.push(plain("입니다."));
  const worst = fall(s);
  if (worst) {
    parts.push(
      plain(` ${worst.date}에는 `),
      strong(pct(worst.return_pct, 1), "neg"),
      plain("까지 빠졌습니다."),
    );
  }
  return parts;
}

/**
 * 두 종목 이상 (시안 v2 예):
 * "4개 종목 모두 이익입니다. TQQQ가 수익률 +99.40%, 연환산 28.19%로 가장 높았지만
 *  2022-06-16에는 −55.9%까지 빠졌습니다. 가장 덜 흔들린 종목은 QQQ(최저 −19.0%)입니다."
 * - 둘째 문장은 수익률 1위로 쓴다. XIRR 1위가 다른 종목이면 "…로 가장 높았고, 연환산은 B가 x로
 *   가장 높았습니다."로 나누고, 수익률 1위가 빠졌던 것은 "A는 날짜에 −y%까지 빠졌습니다."로 잇는다.
 * - 수익률 1위의 최저 수익률이 0 이상이면 빠졌다는 말을 쓰지 않는다.
 * - 가장 덜 흔들린 종목은 최저 수익률이 가장 높은(덜 빠진) 종목이다.
 */
function manyParts(results) {
  const top = pick(results, returnOf, true);
  const xirrTop = pick(results, xirrOf, true);
  const s = top.summary;
  const worst = fall(s);
  const parts = [
    plain(`${countSentence(results)} `),
    strong(top.symbol),
    plain(`${josa(top.symbol, "이/가")} 수익률 `),
    strong(pct(s.return_pct), toneOf(s.return_pct)),
  ];
  if (xirrTop && xirrTop !== top) {
    parts.push(
      plain("로 가장 높았고, 연환산은 "),
      strong(xirrTop.symbol),
      plain(`${josa(xirrTop.symbol, "이/가")} `),
      strong(rate(xirrTop.summary.xirr_pct)),
      plain("로 가장 높았습니다."),
    );
    if (worst) {
      parts.push(
        plain(" "),
        strong(top.symbol),
        plain(`${josa(top.symbol, "은/는")} ${worst.date}에 `),
        strong(pct(worst.return_pct, 1), "neg"),
        plain("까지 빠졌습니다."),
      );
    }
  } else {
    if (xirrTop) parts.push(plain(", 연환산 "), strong(rate(s.xirr_pct)));
    if (worst) {
      parts.push(
        plain(`로 가장 높았지만 ${worst.date}에는 `),
        strong(pct(worst.return_pct, 1), "neg"),
        plain("까지 빠졌습니다."),
      );
    } else {
      parts.push(plain("로 가장 높았습니다."));
    }
  }
  const calm = pick(results, worstOf, true);
  if (calm) {
    parts.push(
      plain(" 가장 덜 흔들린 종목은 "),
      strong(calm.symbol),
      plain(`(최저 ${pct(calm.summary.worst.return_pct, 1)})입니다.`),
    );
  }
  return parts;
}

/**
 * 요약 탭 맨 위 문장의 조각 목록. results는 /api/backtest 응답의 results(결과 순서 그대로).
 * 조각은 { text, strong, tone }이고, 화면은 strong이면 굵게, tone(pos·neg)이면 손익 색으로 그린다.
 * 이어 붙이면 문장이 된다 (sentenceText).
 */
export function summaryParts(results) {
  if (!results.length) return [];
  return results.length === 1 ? singleParts(results[0]) : manyParts(results);
}

/** 조각을 이어 붙인 문장. */
export function sentenceText(parts) {
  return parts.map((part) => part.text).join("");
}

// ---------- 하이라이트 ----------

function item(key, label, result, value, { tone = "", note = null } = {}) {
  return { key, label, symbol: result.symbol, value, tone, note };
}

/** 현재가가 평단가의 몇 배인지. 평단가가 없으면 null. */
function ratioOf(s) {
  if (!(s.avg_cost_asset > 0) || !(s.eval_price >= 0)) return null;
  return s.eval_price / s.avg_cost_asset;
}

/**
 * 하이라이트 (시안 v2 순서): 가장 높은 XIRR, 현재가가 평단가의 몇 배(최고), 가장 깊은 손실(결정 d43:
 * 최저 수익률), 원금 아래였던 날이 가장 적음. 칸마다 { key, label, symbol, value, tone, note }이고,
 * note는 값 옆에 흐리게 쓰는 날짜나 비율이다. 고를 종목이 없는 칸(XIRR이 모두 null 등)은 뺀다.
 */
export function highlights(results) {
  const items = [];
  const xirrTop = pick(results, xirrOf, true);
  if (xirrTop) {
    items.push(item("xirr", "가장 높은 XIRR", xirrTop, rate(xirrTop.summary.xirr_pct)));
  }
  const ratioTop = pick(results, ratioOf, true);
  if (ratioTop) {
    items.push(
      item("ratio", "현재가가 평단가의 몇 배 (최고)", ratioTop, times(ratioOf(ratioTop.summary))),
    );
  }
  const deepest = pick(results, worstOf, false);
  if (deepest) {
    const worst = deepest.summary.worst;
    items.push(
      item("worst", "가장 깊은 손실", deepest, pct(worst.return_pct, 1), {
        tone: toneOf(worst.return_pct),
        note: worst.date,
      }),
    );
  }
  const steady = pick(results, (s) => s.underwater_days, false);
  if (steady) {
    const s = steady.summary;
    items.push(
      item("underwater", "원금 아래였던 날이 가장 적음", steady, `${qty(s.underwater_days, 0)}일`, {
        note: `(${rate(s.underwater_pct, 1)})`,
      }),
    );
  }
  return items;
}
