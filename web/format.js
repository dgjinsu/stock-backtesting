// 숫자·날짜·조건 표시. 손익은 부호(+/−)를 꼭 붙인다 (기능 명세 "정해 둔 것").

import { ALL_START } from "./conditions.js";

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
 * 접힌 조건 줄의 글 (F-11, 시안 v2): "기간 · 주기 · 종목마다 금액 · 통화".
 * params는 API 응답의 params(요청 그대로)다. "전체"는 상장일부터이고,
 * 정수 주와 수수료는 기본값이 아닐 때만 붙인다.
 */
export function condLine(params) {
  const from = params.start <= ALL_START ? "상장일" : params.start;
  return [
    `${from} ~ ${params.end}`,
    freqText(params.freq, params.anchor),
    `종목마다 ${money(params.amount, params.currency)}`,
    investLabel(params.currency),
    params.fractional === false ? "정수 주만" : null,
    params.fee_pct > 0 ? `수수료 ${params.fee_pct}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
