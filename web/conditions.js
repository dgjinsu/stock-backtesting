// 조건(종목·기간·주기·금액)을 다루는 순수 함수. DOM을 쓰지 않아 node --test로 시험한다.
// cond 모양: { codes, start, end, freq, monthDay, weekDay, amount, currency, fractional, fee, tax,
// rule }. tax는 해외주식 양도세 어림(F-20) 스위치, rule은 매수 규칙(F-17)이다.
// 주소에는 보고 있는 결과 탭(tab)도 같이 담는다 (F-11). 조건이 아니라 계산에는 쓰지 않는다.

export const MAX_SYMBOLS = 8;
export const ALL_START = "1970-01-02"; // "전체": 상장 이후 전부
export const SYMBOL_PATTERN = /^[A-Za-z0-9.\-=^]{1,20}$/;
export const FREQS = ["daily", "weekly", "monthly"];
export const CURRENCIES = ["KRW", "USD"];
/** 결과 탭 (F-11): 요약, 분석, 전략 비교, 매수 내역. 화면의 탭 순서와 같다. */
export const RESULT_TABS = ["summary", "analysis", "strategy", "buys"];
export const DEFAULT_TAB = "summary";
const DAY_MS = 86_400_000;

/** 매수 규칙의 이평선 기간과 레버리지 전환의 기준 종목. 화면에서 고르지 않고 늘 이 값이다 (결정 d43). */
export const RULE_MA_DAYS = 200;
export const RULE_SWITCH_REF = "QQQ";
/**
 * 매수 규칙 (F-17). key는 API의 rule, name은 F-17 규칙 이름(결과 머리 줄·접힌 줄에도 쓴다),
 * desc는 시안 v2 조건 패널의 설명. 순서는 F-17과 같다. 계산은 계산 규칙 9-6(같은 예산)이다.
 */
export const BUY_RULES = [
  { key: "none", name: "기본", desc: "매번 같은 금액" },
  {
    key: "ma_dip",
    name: "이평선 아래 2배·위 절반",
    desc: `${RULE_MA_DAYS}일선 아래면 2배, 위면 절반`,
  },
  { key: "ma_hot", name: "과열 때 절반", desc: `${RULE_MA_DAYS}일선보다 20% 넘게 위면 절반` },
  {
    key: "switch",
    name: "레버리지 전환",
    desc: `${RULE_SWITCH_REF}가 ${RULE_MA_DAYS}일선 위일 때만 사기`,
  },
];
export const DEFAULT_RULE = "none";
const RULE_KEYS = BUY_RULES.map((r) => r.key);
/** 기본이 아닌 규칙에서 정수 주만을 골랐을 때의 안내 (계산 규칙 9-6: 규칙은 소수점 매수로 계산). */
export const RULE_FRACTIONAL_NOTE = "매수 규칙은 소수점 매수로 계산합니다";

/** 알려진 규칙이면 그 값, 아니면 기본 규칙. */
function ruleKey(rule) {
  return RULE_KEYS.includes(rule) ? rule : DEFAULT_RULE;
}

/** 정수 주만을 골랐는데 기본이 아닌 규칙이면 안내 문구, 아니면 null. */
export function ruleFractionalNote({ rule, fractional }) {
  return ruleKey(rule) !== DEFAULT_RULE && fractional === false ? RULE_FRACTIONAL_NOTE : null;
}

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

/** 조건을 주소 쿼리로 (F-09). 기본값인 항목(기본 규칙, 정수 주가 아님, 수수료 0, 양도세 꺼짐,
 * 요약 탭)은 뺀다. 순서는 조건 패널 순서(…통화, 매수 규칙, 고급 설정)이고 tab은 맨 뒤다 (F-11).
 * 모르는 규칙·탭 값은 넣지 않는다. 이평선 기간·기준 종목은 늘 같아 키가 없다 (결정 d43).
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
  if (ruleKey(cond.rule) !== DEFAULT_RULE) params.set("rule", cond.rule);
  if (!cond.fractional) params.set("frac", "0");
  if (cond.fee) params.set("fee", String(cond.fee));
  if (cond.tax) params.set("tax", "1");
  if (RESULT_TABS.includes(cond.tab) && cond.tab !== DEFAULT_TAB) params.set("tab", cond.tab);
  return params.toString().replaceAll("%2C", ",");
}

/** 주소 쿼리에서 조건과 탭을 읽는다. 잘못된 값은 버리고 읽은 항목만 돌려준다. */
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
  if (RULE_KEYS.includes(params.get("rule"))) found.rule = params.get("rule"); // 그 밖은 기본 규칙
  if (params.get("frac") === "0") found.fractional = false;
  const feeText = params.get("fee");
  const fee = Number(feeText);
  if (feeText !== null && feeText !== "" && fee >= 0 && fee <= 10) found.fee = fee;
  if (params.get("tax") === "1") found.tax = true; // 그 밖의 값은 버리고 꺼짐(기본)으로 둔다
  if (RESULT_TABS.includes(params.get("tab"))) found.tab = params.get("tab");
  return found;
}

/**
 * /api/backtest 요청 본문 (상세 설계 4절). 매수 규칙(F-17)은 이평선 기간과 기준 종목을 고르지 않고
 * 200일·QQQ로 보낸다 (결정 d43). 모르는 규칙 값이면 기본 규칙. 탭은 계산에 쓰지 않아 싣지 않는다.
 */
export function backtestBody(cond) {
  return {
    symbols: cond.codes,
    start: cond.start,
    end: cond.end,
    freq: cond.freq,
    anchor: anchorOf(cond),
    amount: cond.amount,
    currency: cond.currency,
    fractional: cond.fractional,
    fee_pct: cond.fee,
    tax: cond.tax === true,
    rule: ruleKey(cond.rule),
    ma_days: RULE_MA_DAYS,
    switch_ref: RULE_SWITCH_REF,
  };
}

/**
 * 탭 목록에서 키를 눌렀을 때 옮겨 갈 탭 (WAI-ARIA 탭 패턴, F-11).
 * →는 다음, ←는 앞 탭이고 끝에서는 반대쪽 끝으로 넘어간다. Home은 처음, End는 마지막.
 * 다른 키이거나 모르는 탭이면 null (그 키는 브라우저 기본 동작에 맡긴다).
 */
export function nextTab(tab, key) {
  const from = RESULT_TABS.indexOf(tab);
  if (from < 0) return null;
  const last = RESULT_TABS.length - 1;
  const to = {
    ArrowRight: from === last ? 0 : from + 1,
    ArrowLeft: from === 0 ? last : from - 1,
    Home: 0,
    End: last,
  }[key];
  return to === undefined ? null : RESULT_TABS[to];
}

/**
 * 조건 패널 접기 규칙 (F-11). 결과(탭)가 보일 때 요약이 아닌 탭이면 결과 위에 접힌 줄(bar)을 두고,
 * "조건 펼치기"를 누르지 않았으면(expanded가 아니면) 패널을 접는다(collapsed).
 * 결과가 없거나 실패를 보이는 중이면 탭이 없으니 줄 없이 패널을 편다.
 */
export function panelFold({ hasResult, tab, expanded }) {
  const bar = hasResult && tab !== DEFAULT_TAB;
  return { bar, collapsed: bar && !expanded };
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

/**
 * 종목 줄 저장본 맵 (F-01). 그 종목의 주가(price)가 저장본인 결과만 code → 그 price의 data_through다.
 * 환율만 저장본이면 넣지 않는다 (알림은 따로 뜬다). listed는 지금 패널에 있는 코드 Set이고, 계산 중에
 * 뺀 종목은 버린다.
 * @returns {Map<string, string>}
 */
export function staleSymbols(results, listed) {
  const map = new Map();
  for (const r of results) {
    if (!listed.has(r.symbol)) continue;
    const price = (r.stale_sources ?? []).find((s) => s.kind === "price");
    if (price) map.set(r.symbol, price.data_through);
  }
  return map;
}

/**
 * 종목 줄 상태 (F-01). 기본이면 null.
 * 계산 중이고 보낸 종목이면 "받는 중"이 앞선다 (앞 계산에서 실패했어도 다시 받는 중이다).
 * 그다음 실패("찾을 수 없음"/"계산 못 함"), 저장본("저장본 MM-DD", 전체 날짜는 title).
 */
export function symbolStatus(code, { loading, sending, bad, stale }) {
  if (loading && sending.has(code)) return { cls: "busy", text: "받는 중" };
  const why = bad.get(code);
  if (why) return { cls: "bad", text: why.includes("찾을 수 없") ? "찾을 수 없음" : "계산 못 함" };
  const day = stale.get(code);
  if (day)
    return {
      cls: "stale",
      text: `저장본 ${day.slice(5)}`,
      title: `${day}까지 저장된 데이터로 계산`,
    };
  return null;
}
