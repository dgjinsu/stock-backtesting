// 조건(종목·기간·주기·금액)을 다루는 순수 함수. DOM을 쓰지 않아 node --test로 시험한다.
// cond 모양: { codes, start, end, freq, monthDay, weekDay, amount, currency, fractional, fee }

export const MAX_SYMBOLS = 8;
export const ALL_START = "1970-01-02"; // "전체": 상장 이후 전부
export const SYMBOL_PATTERN = /^[A-Za-z0-9.\-=^]{1,20}$/;
export const FREQS = ["daily", "weekly", "monthly"];
export const CURRENCIES = ["KRW", "USD"];
const DAY_MS = 86_400_000;

/** 한국 시각 기준 오늘 (YYYY-MM-DD). 서버의 "오늘"과 같은 기준이다. */
export function todayKst(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 달력에 있는 날짜인지 (YYYY-MM-DD). 2026-02-31, 2020-13-45는 아니다. */
export function isDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? "")) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** 끝날짜에서 years년 전의 다음 날. 5년이면 2026-11-24 → 2021-11-25. 2월 29일은 28일로 본다.
 * 날짜가 비었거나 잘못되면 null. */
export function shiftYears(iso, years) {
  if (!isDate(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  return new Date(Date.UTC(y - years, m - 1, Math.min(d, lastDay) + 1)).toISOString().slice(0, 10);
}

/** API의 anchor: 매주는 요일(0=월), 매월은 날짜(31=말일), 매일은 null. */
export function anchorOf(cond) {
  if (cond.freq === "weekly") return cond.weekDay;
  if (cond.freq === "monthly") return cond.monthDay;
  return null;
}

/** 조건을 주소 쿼리로 (F-09). 기본값인 항목(정수 주가 아님, 수수료 0)은 뺀다.
 * 종목 사이 쉼표는 읽기 쉽게 그대로 둔다 (s=QQQ,QLD). 쿼리 키는 상세 설계 5절 표. */
export function toQuery(cond) {
  const params = new URLSearchParams();
  params.set("s", cond.codes.join(","));
  params.set("from", cond.start);
  params.set("to", cond.end);
  params.set("freq", cond.freq);
  if (cond.freq !== "daily") params.set("day", String(anchorOf(cond)));
  params.set("amt", String(cond.amount));
  params.set("cur", cond.currency);
  if (!cond.fractional) params.set("frac", "0");
  if (cond.fee) params.set("fee", String(cond.fee));
  return params.toString().replaceAll("%2C", ",");
}

/** 주소 쿼리에서 조건을 읽는다. 잘못된 값은 버리고 읽은 항목만 돌려준다. */
export function readQuery(search) {
  const params = new URLSearchParams(search);
  const codes = (params.get("s") ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => SYMBOL_PATTERN.test(c));
  const found = { codes: [...new Set(codes)].slice(0, MAX_SYMBOLS) };
  if (isDate(params.get("from"))) found.start = params.get("from");
  if (isDate(params.get("to"))) found.end = params.get("to");
  const freq = params.get("freq");
  if (FREQS.includes(freq)) found.freq = freq;
  const dayText = params.get("day");
  const day = Number(dayText);
  if (dayText !== null && Number.isInteger(day)) {
    if (found.freq === "weekly" && day >= 0 && day <= 4) found.weekDay = day;
    if (found.freq === "monthly" && day >= 1 && day <= 31) found.monthDay = day;
  }
  const amount = Number(params.get("amt"));
  if (Number.isFinite(amount) && amount > 0) found.amount = amount;
  if (CURRENCIES.includes(params.get("cur"))) found.currency = params.get("cur");
  if (params.get("frac") === "0") found.fractional = false;
  const feeText = params.get("fee");
  const fee = Number(feeText);
  if (feeText !== null && feeText !== "" && fee >= 0 && fee <= 10) found.fee = fee;
  return found;
}

/** 서버에 보내기 전 입력 검사 (F-10). 항목 이름 → 한국어 메시지. 서버도 같은 검사를 한다. */
export function validate(cond, today) {
  const errors = {};
  if (cond.codes.length === 0) errors.symbols = "종목을 하나 이상 넣어 주세요";
  if (!cond.start) errors.start = "시작일을 넣어 주세요";
  if (!cond.end) errors.end = "끝날짜를 넣어 주세요";
  if (cond.start && cond.end && cond.start >= cond.end)
    errors.start = "시작일은 끝날짜보다 앞이어야 합니다";
  if (cond.end && cond.end > today) errors.end = `끝날짜는 오늘(${today})보다 늦을 수 없습니다`;
  if (!(cond.amount > 0)) errors.amount = "금액은 0보다 커야 합니다";
  if (!(cond.fee >= 0 && cond.fee <= 10)) errors.fee = "수수료는 0~10%입니다";
  return errors;
}

/**
 * 금액 칸 아래 미리보기에 쓰는 매수 횟수 어림값. 휴장일을 모르므로 정확하지 않다.
 * 매월은 달마다 그 날짜(없으면 말일)가 기간 안이면 한 번, 매주는 7일에 한 번, 매일은 1년에 252일로 어림한다.
 */
export function estimateBuys(cond) {
  const start = new Date(`${cond.start}T00:00:00Z`);
  const end = new Date(`${cond.end}T00:00:00Z`);
  const days = (end - start) / DAY_MS;
  if (!(days > 0)) return 0;
  if (cond.freq === "daily") return Math.round((days * 252) / 365);
  if (cond.freq === "weekly") return Math.round(days / 7);
  let count = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const last = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const day = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), Math.min(cond.monthDay, last)),
    );
    if (day >= start && day <= end) count += 1;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return count;
}
