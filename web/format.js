// 숫자·날짜·조건 표시. 손익은 부호(+/−)를 꼭 붙인다 (기능 명세 "정해 둔 것").

import {
  ALL_START,
  BUY_RULES,
  DEFAULT_RULE,
  RULE_MA_DAYS,
  RULE_SWITCH_REF,
  estimateBuys,
} from "./conditions.js";

export const MINUS = "−"; // U+2212
const WEEKDAYS = ["월요일", "화요일", "수요일", "목요일", "금요일"];

const int = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const two = new Intl.NumberFormat("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function withSign(value, text) {
  if (value > 0) return `+${text}`;
  if (value < 0) return `${MINUS}${text}`;
  return text;
}

/** 88.19 → "+88.19%", -39.39 → "−39.39%". digits는 소수 자리. */
export function pct(value, digits = 2) {
  if (value === null || value === undefined) return "계산 불가";
  const options = { minimumFractionDigits: digits, maximumFractionDigits: digits };
  const text = `${Math.abs(value).toLocaleString("ko-KR", options)}%`;
  return withSign(Number(value.toFixed(digits)), text);
}

/** +는 붙이지 않고 빼기만 붙이는 비율: 28.19 → "28.19%", -1.5 → "−1.50%" (한눈에 요약의 연환산). */
export function rate(value, digits = 2) {
  const text = pct(value, digits);
  return text.startsWith("+") ? text.slice(1) : text;
}

/** 몇 배인지: 2.0065 → "2.01배". */
export function times(value) {
  if (value === null || value === undefined) return "—";
  return `${two.format(value)}배`;
}

/** 원을 만 단위로 줄인다. 225824590 → "2억 2,582만원", 123000 → "12만원", 9999 → "9,999원". */
export function krwShort(value) {
  const n = Math.round(Math.abs(value));
  let eok = Math.floor(n / 1e8);
  let man = Math.round((n % 1e8) / 1e4);
  if (man === 10000) {
    eok += 1;
    man = 0;
  }
  let text;
  if (eok > 0) text = `${int.format(eok)}억${man ? ` ${int.format(man)}만` : ""}원`;
  else if (n >= 1e4) text = `${int.format(Math.round(n / 1e4))}만원`;
  else text = `${int.format(n)}원`;
  return value < 0 ? `${MINUS}${text}` : text;
}

/** 금액. 원은 짧게(억·만) 또는 전부, 그 밖은 통화 기호와 소수 2자리(큰 값은 정수). */
export function money(value, currency, { short = true } = {}) {
  if (value === null || value === undefined) return "—";
  if (currency === "KRW")
    return short ? krwShort(value) : `${value < 0 ? MINUS : ""}${int.format(Math.abs(value))}원`;
  const abs = Math.abs(value);
  const text = abs >= 10000 ? int.format(abs) : two.format(abs);
  const sign = value < 0 ? MINUS : "";
  return currency === "USD" ? `${sign}$${text}` : `${sign}${text} ${currency}`;
}

/**
 * money(value, currency)가 화면에 보여 주는 자리로 반올림한 값 (비교 표의 가장 좋은 값 견주기, PR #47).
 * 원은 1만 이상이면 만원 단위, 아래면 원 단위. 달러 등은 1만 이상이면 정수, 아래면 소수 2자리.
 * 절댓값을 반올림하고 부호를 다시 붙인다 (money와 같다). 값이 없으면 null.
 */
export function shownMoney(value, currency) {
  if (value === null || value === undefined) return null;
  const abs = Math.abs(value);
  let shown;
  if (currency === "KRW") {
    const n = Math.round(abs);
    shown = n >= 1e4 ? Math.round(n / 1e4) * 1e4 : n;
  } else {
    shown = abs >= 10000 ? Math.round(abs) : Number(abs.toFixed(2));
  }
  return value < 0 && shown !== 0 ? -shown : shown;
}

/** 손익처럼 부호를 늘 붙이는 금액. */
export function signedMoney(value, currency, options) {
  const text = money(Math.abs(value), currency, options);
  return withSign(value, text);
}

/** 종목 통화 가격·평단가. 달러는 $37.97 (1보다 작으면 4자리), 원은 76,325원. */
export function price(value, currency) {
  if (value === null || value === undefined) return "—";
  if (currency === "KRW") return `${int.format(value)}원`;
  const digits = Math.abs(value) < 1 ? 4 : 2;
  const text = value.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency === "USD" ? `$${text}` : `${text} ${currency}`;
}

/** 수량: 소수 digits자리까지 (정수면 정수로). fixed면 자리를 채워 표에서 줄이 맞는다. */
export function qty(value, digits = 2, { fixed = false } = {}) {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("ko-KR", {
    minimumFractionDigits: fixed ? digits : 0,
    maximumFractionDigits: digits,
  });
}

/** 환율: 1 이상이면 소수 2자리, 작으면 유효숫자 4자리. */
export function fx(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1) return two.format(value);
  return Number(value.toPrecision(4)).toString();
}

/** 날짜 차이를 "5년", "3년 6개월", "8개월"로. */
export function period(startIso, endIso) {
  const start = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() + 1 < start.getUTCDate()) months -= 1;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years && rest) return `${years}년 ${rest}개월`;
  if (years) return `${years}년`;
  if (months) return `${months}개월`;
  const days = Math.round((end - start) / 86400000);
  return `${days}일`;
}

/** 주기 글자. anchor는 API 값: 매주는 요일(0=월), 매월은 날짜(31=말일), 매일은 null. */
export function freqText(freq, anchor) {
  if (freq === "daily") return "매일";
  if (freq === "weekly") return `매주 ${WEEKDAYS[anchor]}`;
  return anchor === 31 ? "매월 말일" : `매월 ${anchor}일`;
}

/** 투자 통화 이름: 원화, 달러. */
export function investLabel(currency) {
  return currency === "KRW" ? "원화" : currency === "USD" ? "달러" : currency;
}

/**
 * 결과 머리 줄과 접힌 조건 줄에 붙이는 매수 규칙 이름 (F-17): "이평선 아래 2배·위 절반 (200일선)",
 * 레버리지 전환은 "레버리지 전환 (QQQ 200일선)". params는 API 응답의 params(요청 그대로)다.
 * 기본 규칙이거나 rule이 없으면(v1 응답) null.
 */
export function ruleTag(params) {
  const rule = BUY_RULES.find((r) => r.key === params.rule);
  if (!rule || rule.key === DEFAULT_RULE) return null;
  const ma = `${params.ma_days ?? RULE_MA_DAYS}일선`;
  const basis = rule.key === "switch" ? `${params.switch_ref ?? RULE_SWITCH_REF} ${ma}` : ma;
  return `${rule.name} (${basis})`;
}

/**
 * 접힌 조건 줄의 글 (F-11, 시안 v2): "기간 · 주기 · 종목마다 금액 · 통화".
 * params는 API 응답의 params(요청 그대로)다. "전체"는 상장일부터이고, 매수 규칙(F-17),
 * 정수 주, 수수료, 양도세 어림(F-20)은 기본값이 아닐 때만 조건 패널 순서로 붙인다.
 * 매수 규칙은 정수 주만을 골라도 소수점 매수로 계산하므로(9-6) 그때는 "정수 주만"을 적지 않는다.
 */
export function condLine(params) {
  const from = params.start <= ALL_START ? "상장일" : params.start;
  const rule = ruleTag(params);
  return [
    `${from} ~ ${params.end}`,
    freqText(params.freq, params.anchor),
    `종목마다 ${money(params.amount, params.currency)}`,
    investLabel(params.currency),
    rule,
    params.fractional === false && !rule ? "정수 주만" : null,
    params.fee_pct > 0 ? `수수료 ${params.fee_pct}%` : null,
    params.tax ? "양도세 반영" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 결과 머리 줄 제목: "2개 종목 · 매월 1일 200만원 · 5년". 기본이 아닌 매수 규칙(F-17)이면 끝에
 * " · 이평선 아래 2배·위 절반 (200일선)"을 붙인다. count는 결과가 나온 종목 수다.
 */
export function headTitle(params, count) {
  const span = params.start <= ALL_START ? "상장 이후 전체" : period(params.start, params.end);
  const each = `${freqText(params.freq, params.anchor)} ${money(params.amount, params.currency)}`;
  return [`${count}개 종목`, each, span, ruleTag(params)].filter(Boolean).join(" · ");
}

/**
 * 접힌 고급 설정 제목 옆에 쓰는 지금 값 (F-05, 시안 v2): "· 소수점 · 수수료 0% · 양도세".
 * cond는 conditions.js의 조건 모양이다. 양도세 어림(F-20)은 켰을 때만 붙인다.
 */
export function advancedText({ fractional, fee, tax }) {
  const feeText = Number.isFinite(fee) ? `${fee}%` : "확인 필요";
  return `· ${fractional ? "소수점" : "정수 주"} · 수수료 ${feeText}${tax ? " · 양도세" : ""}`;
}

/**
 * 금액 아래 미리보기 (F-04): "약 60회 · 종목당 1억 2,000만원 · 4종목 합계 4억 8,000만원".
 * `cond`는 app.js의 cond() 모양(start, end, freq, monthDay, amount, currency, codes)이다.
 * 금액이 없거나 기간이 맞지 않으면 빈 글, 시작일이 "전체"면 횟수 대신 상장일 안내다.
 */
export function amountPreview(cond) {
  if (!(cond.amount > 0) || !cond.start || !cond.end || cond.start >= cond.end) return "";
  if (cond.start === ALL_START) return "상장일부터 끝날짜까지 · 매수 횟수는 종목마다 다릅니다";
  const count = estimateBuys(cond);
  const each = money(count * cond.amount, cond.currency);
  const n = cond.codes.length;
  const total = n > 1 ? ` · ${n}종목 합계 ${money(count * cond.amount * n, cond.currency)}` : "";
  return `약 ${count.toLocaleString("ko-KR")}회 · 종목당 ${each}${total}`;
}

/** 짧은 날짜 (분석 탭 표, F-14): "2022-12-28" → "22-12-28". */
export function shortDate(iso) {
  return iso.slice(2, 10);
}

/** 짧은 연-월 (분석 탭 표, F-14): "2022-09-19" → "22-09". */
export function shortMonth(iso) {
  return iso.slice(2, 7);
}
