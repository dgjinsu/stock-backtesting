// 결과 카드·비교 표·결과 아래 안내의 DOM 없는 부분 (F-12, F-20, F-10). node --test로 시험한다.
// 비교 표 열, 정렬, 열마다 가장 좋은 값, 원금 아래·세후 손익 글자, 환율·비용 안내.

import { RULE_MA_DAYS } from "./conditions.js";
import { investLabel, money, pct, price, qty, rate, signedMoney } from "./format.js";

/** 비교 표 위 안내 (시안 v2). */
export const SORT_HINT = "열 제목을 누르면 정렬 · 굵은 값은 그 열에서 가장 좋은 값";

/**
 * 비교 표 열 (F-12). 순서는 시안 v2(종목 평단가 현재가 평가금 손익 세후 손익 수익률 XIRR
 * 최저 수익률 고점 대비 원금 아래)에 v1의 원화 평단가·보유 수량(F-06)을 끼운 것이다.
 * 세후 손익은 양도세 어림(F-20)을 켰을 때만 둔다.
 * - value(result): 정렬하고 견주는 값 (없으면 null). text(result): 칸 글자 (카드와 같은 형식).
 * - better: "high"는 높을수록, "low"는 적을수록 좋은 열이고, null은 종목마다 단위나 투자금이 달라
 *   견줄 수 없는 열(굵게 하지 않는다). digits는 화면에 보이는 자리로, 가장 좋은 값을 견줄 때 쓴다.
 * - tone: 손익 색(이익 초록, 손실 빨강)을 칠하는 열.
 */
export function compareColumns(invest, { tax = false } = {}) {
  const pick = (read) => (result) => read(result.summary) ?? null;
  const columns = [
    {
      key: "avg_cost_asset",
      title: "평단가",
      better: null,
      value: pick((s) => s.avg_cost_asset),
      text: (r) => price(r.summary.avg_cost_asset, r.currency),
    },
    {
      key: "avg_cost_invest",
      title: `${investLabel(invest)} 평단가`,
      better: null,
      value: pick((s) => s.avg_cost_invest),
      text: (r) => money(r.summary.avg_cost_invest, invest, { short: false }),
    },
    {
      key: "eval_price",
      title: "현재가",
      better: null,
      value: pick((s) => s.eval_price),
      text: (r) => price(r.summary.eval_price, r.currency),
    },
    {
      key: "shares",
      title: "보유 수량",
      better: null,
      value: pick((s) => s.shares),
      text: (r) => qty(r.summary.shares),
    },
    {
      key: "value",
      title: "평가금",
      better: null,
      value: pick((s) => s.value),
      text: (r) => money(r.summary.value, invest),
    },
    {
      key: "profit",
      title: "손익",
      better: "high",
      digits: 2,
      tone: true,
      value: pick((s) => s.profit),
      text: (r) => signedMoney(r.summary.profit, invest),
    },
    tax
      ? {
          key: "profit_after_tax",
          title: "세후 손익",
          better: "high",
          digits: 2,
          tone: true,
          value: pick((s) => s.profit_after_tax),
          text: (r) => afterTaxText(r.summary.profit_after_tax, invest),
        }
      : null,
    {
      key: "return_pct",
      title: "수익률",
      better: "high",
      digits: 2,
      tone: true,
      value: pick((s) => s.return_pct),
      text: (r) => pct(r.summary.return_pct),
    },
    {
      key: "xirr_pct",
      title: "XIRR",
      better: "high",
      digits: 2,
      value: pick((s) => s.xirr_pct),
      text: (r) => pct(r.summary.xirr_pct),
    },
    {
      key: "worst",
      title: "최저 수익률",
      better: "high",
      digits: 1,
      tone: true,
      value: pick((s) => s.worst?.return_pct),
      text: (r) => pct(r.summary.worst?.return_pct, 1),
    },
    {
      key: "from_peak_pct",
      title: "고점 대비",
      better: "high",
      digits: 1,
      tone: true,
      value: pick((s) => s.from_peak_pct),
      text: (r) => pct(r.summary.from_peak_pct, 1),
    },
    {
      key: "underwater_days",
      title: "원금 아래",
      better: "low",
      digits: 0,
      value: pick((s) => s.underwater_days),
      text: (r) => days(r.summary.underwater_days),
    },
  ];
  return columns.filter(Boolean).map((c) => ({ digits: 2, tone: false, ...c }));
}

/**
 * 열 제목을 눌렀을 때의 정렬 상태 { key, dir }. sort는 지금 상태(없으면 null).
 * 처음 누르면 좋은 값이 위로(적을수록 좋은 열은 오름차순, 그 밖은 내림차순), 같은 열을 다시 누르면
 * 반대로. 견줄 수 없는 열도 처음에는 큰 값이 위다.
 */
export function nextSort(sort, column) {
  if (sort?.key === column.key)
    return { key: column.key, dir: sort.dir === "desc" ? "asc" : "desc" };
  return { key: column.key, dir: column.better === "low" ? "asc" : "desc" };
}

/** 값이 없는지 (null, undefined, NaN). */
function missing(value) {
  return value === null || value === undefined || Number.isNaN(value);
}

/**
 * rows를 valueOf 값으로 정렬한 새 배열. dir은 "asc"(오름) 또는 "desc"(내림).
 * 값이 없는 줄(XIRR 계산 불가 등)은 방향과 상관없이 맨 아래, 같은 값은 원래 순서를 지킨다.
 */
export function sortRows(rows, valueOf, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => {
      const aMissing = missing(a.value);
      const bMissing = missing(b.value);
      if (aMissing || bMissing) return aMissing - bMissing || a.index - b.index;
      return (a.value - b.value) * sign || a.index - b.index;
    })
    .map((item) => item.row);
}

/**
 * 열에서 가장 좋은 값의 위치들(Set). better가 "high"면 가장 큰 값, "low"면 가장 작은 값이고,
 * 같은 값이 여럿이면 모두다. 견주는 값은 화면에 보이는 자리(digits)로 반올림한다.
 * 값이 없는 칸은 건너뛴다. 견줄 수 없는 열(better가 null)이거나 줄이 둘보다 적으면 빈 Set.
 */
export function bestIndexes(values, better, digits = 2) {
  if (!better || values.length < 2) return new Set();
  const shown = values.map((v) => (missing(v) ? null : Number(v.toFixed(digits))));
  const present = shown.filter((v) => v !== null);
  if (!present.length) return new Set();
  const best = better === "high" ? Math.max(...present) : Math.min(...present);
  return new Set(shown.flatMap((v, i) => (v === best ? [i] : [])));
}

/** 일수: 1234 → "1,234일". */
function days(value) {
  return value === null || value === undefined ? "—" : `${qty(value, 0)}일`;
}

/** 원금 아래였던 날 (9-1): "331일 (26.5%)". 비율은 소수 1자리. */
export function underwaterText(summary) {
  return `${days(summary.underwater_days)} (${rate(summary.underwater_pct, 1)})`;
}

function afterTaxText(value, invest) {
  return value === null || value === undefined ? "—" : signedMoney(value, invest);
}

/** 손익 색 이름: 이익 pos, 손실 neg, 0은 없음. */
function toneOf(value) {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "";
}

/**
 * 카드의 세후 손익 칸 (F-20). 양도세 어림을 끄면(profit_after_tax가 null) null.
 * { label, text, tone, note }이고 note는 값 아래 작은 글이다. 한국 종목(종목 통화 원화)은
 * 양도세가 0이라 그렇다고 적고(계산 규칙 9-5), 해외 종목은 뺀 양도세를 적는다. 금액은 투자 통화.
 */
export function afterTax(result, invest) {
  const s = result.summary;
  if (s.profit_after_tax === null || s.profit_after_tax === undefined) return null;
  return {
    label: "세후 손익 · 어림값",
    text: afterTaxText(s.profit_after_tax, invest),
    tone: toneOf(s.profit_after_tax),
    note:
      result.currency === "KRW"
        ? "한국 종목은 양도세 0으로 둡니다"
        : `양도세 ${money(s.tax, invest)}`,
  };
}

/**
 * 매수 규칙(F-17) 결과에 투자 통화 평단가가 없는(null) 이유 (결정 d39). 카드·비교 표·매수 내역에서
 * "—" 옆 툴팁으로 단다. 같은 예산 규칙은 넣은 돈 일부를 현금으로 남겼다가 나중에 쓰므로 정하지 않는다.
 */
export function avgInvestReason(invest) {
  return (
    "매수 규칙은 넣은 돈 일부를 현금으로 두었다가 나중에 사서 넣은 돈과 산 돈이 달라, " +
    `${investLabel(invest)} 평단가는 정하지 않습니다. 평단가(종목 통화)는 그대로입니다.`
  );
}

/**
 * 투자 통화 평단가 칸에 달 이유. 매수 규칙(rule이 none이 아님) 결과라서 값이 없을 때만 이유를 돌려주고,
 * 그 밖에는 null이다. 기본 규칙에서 정수 주만 살 때 아직 한 주도 못 사 값이 없는 것은 규칙 때문이 아니다.
 * params는 API 응답의 params다.
 */
export function avgInvestNote(params, value) {
  if (value !== null && value !== undefined) return null;
  if (!params.rule || params.rule === "none") return null;
  return avgInvestReason(params.currency);
}

/**
 * 레버리지 전환(F-17)의 기준 종목을 저장본으로 판단했으면 F-10 노랑 알림 { title, detail }, 아니면
 * null. 기준 종목은 요청 하나에 하나라 종목이 여럿이어도 알림은 하나다. switch_ref에는 날짜가 없어
 * 기준일은 적지 않는다. params는 API 응답의 params다.
 */
export function refStaleAlert(results, params) {
  const ref = results.map((r) => r.switch_ref).find((s) => s?.stale);
  if (!ref) return null;
  return {
    title: `기준 종목 ${ref.symbol}는 저장된 데이터로 판단했습니다.`,
    detail: `Yahoo Finance에서 새로 받지 못해 저장해 둔 주가로 ${params.ma_days ?? RULE_MA_DAYS}일선 위아래를 봤습니다.`,
  };
}

/**
 * 결과 아래 안내(F-10)의 환율 글. 종목 통화와 투자 통화가 다른 쌍, 그리고 양도세 어림을 켠
 * 달러 투자면 손익을 원화로 바꿔 공제하는 데 쓴 USDKRW=X(계산 규칙 9-5, 상세 설계 4절)를 적는다.
 * 양도세 환율은 원화가 아닌 종목이 있을 때만 쓴다 (한국 종목은 0). 적을 것이 없으면 null.
 * params는 API 응답의 params(요청 그대로)다.
 */
export function fxNote(results, params) {
  const invest = params.currency;
  const pairs = [
    ...new Set(results.filter((r) => r.currency !== invest).map((r) => `${r.currency}${invest}=X`)),
  ];
  if (params.tax && invest !== "KRW" && results.some((r) => r.currency !== "KRW")) {
    pairs.push(`${invest}KRW=X(양도세 원화 환산)`);
  }
  return pairs.length ? `환율은 ${pairs.join(", ")}.` : null;
}

/**
 * 결과 아래 고정 안내의 세금·환전 비용 줄 (F-10, F-20). 양도세 어림을 켜면 시안 v2 문구로 바꾸고,
 * 환전 비용 안내는 그대로 둔다.
 */
export function costNotice(tax) {
  const fee = "환전 비용은 고급 설정의 수수료에 합쳐 넣으세요.";
  return tax
    ? `양도세는 끝날짜에 한 번에 판다고 보고 어림한 값입니다. 환전 비용은 반영하지 않았습니다. ${fee}`
    : `세금과 환전 비용은 반영하지 않았습니다. ${fee}`;
}
