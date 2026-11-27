// 전략 비교 탭(F-15)의 DOM 없는 부분. node --test로 시험한다. 그리는 쪽은 strategy.js다.
// 요청 본문·저장 키·요청 묶음(결정 보드 d63), 탭 글, 카드 모델과 가장 좋은 값, 기준 종목·오류·저장본 글,
// 계산 방법 세 칸. #66(평가금 추이)·#67(며칠에·언제 시작)의 모델도 이 파일에 더한다.
// 글의 이평선 기간·금액·주기는 늘 그 응답의 params로 만든다 (계산 중 흐린 앞 응답 옆에 새 값이 붙지 않게).

import { BUY_RULES, RULE_MA_DAYS, RULE_SWITCH_REF, backtestBody } from "./conditions.js";
import { freqText, investLabel, money, pct, price, shownPrice } from "./format.js";
import { josa } from "./insights.js";
import { bestIndexes, refStaleAlert } from "./results.js";

/** 전략 다섯 개. engine.RULES와 같은 순서다 (상세 설계 4절 strategies). */
export const STRATEGY_KEYS = ["none", "ma_dip", "ma_hot", "switch", "lump_sum"];
/** 이평선 기간 (F-15, 상세 설계 4절 ma_days 검사). 처음은 RULE_MA_DAYS(200). */
export const MA_CHOICES = [20, 60, 120, 200];
export const STRATEGY_TITLE = "같은 돈, 다른 규칙";
export const STRATEGY_LOADING = "전략 5개를 계산하는 중…";
/** 기준 종목은 화면에서 고르지 않고 늘 QQQ다 (결정 d43, 시안 "레버리지 전환의 기준 종목: QQQ"). */
export const REF_LINE = `레버리지 전환의 기준 종목: ${RULE_SWITCH_REF}`;
/** 탭 끝 안내 (F-15). */
export const STRATEGY_NOTES = [
  "전략은 사기만 합니다. 이평선 아래로 내려갈 때 파는 전략은 다루지 않습니다.",
  "과거에 잘 맞은 규칙이 앞으로도 맞는다는 뜻이 아닙니다. 기간을 바꿔 보면 순위가 바뀔 수 있습니다.",
];
/** /api/backtest에만 있는 칸. 전략 요청 본문에서 뺀다 (그 밖의 조건 칸은 따라온다). */
const BACKTEST_ONLY = ["symbols", "rule", "tax", "ma_days", "switch_ref", "include_daily"];

/** 카드 이름 (결정 보드 d64): 조건 패널 매수 규칙(F-17) 이름에 "기본 적립"·"일시금"을 더한다. */
export function strategyName(key) {
  if (key === "none") return "기본 적립";
  if (key === "lump_sum") return "일시금";
  return BUY_RULES.find((r) => r.key === key)?.name ?? key;
}

/**
 * /api/strategy 요청 본문 (상세 설계 4절). cond는 보이는 결과를 계산한 조건(resultView.shown)이다.
 * backtestBody(cond)에서 백테스트 전용 칸을 빼고 종목·이평선·기준 종목을 넣는다. 그래서 backtestBody에
 * 새로 생기는 조건 칸(예: F-24 include_fx, 결정 d74)은 손대지 않아도 같은 값으로 따라온다.
 * 매수 규칙·양도세는 싣지 않는다 (기능 명세 "v2 화면 흐름" 3). 기준 종목은 늘 QQQ다 (결정 d43).
 */
export function strategyBody(cond, symbol, maDays) {
  const body = backtestBody(cond);
  for (const key of BACKTEST_ONLY) delete body[key];
  return { symbol, ...body, ma_days: maDays, switch_ref: RULE_SWITCH_REF };
}

/** 응답을 저장해 두는 키: (종목, 이평선) (결정 보드 d63). */
export function strategyKey(symbol, maDays) {
  return `${symbol}|${maDays}`;
}

/** 고른 종목: 다시 계산해도 그 종목이 있으면 그대로, 없으면 첫 종목. */
export function pickSymbol(symbols, previous) {
  return symbols.includes(previous) ? previous : (symbols[0] ?? null);
}

/** 금액 글 뒤 목적격 조사: "200만원을", "$1,500.00를". */
function withObject(text) {
  return `${text}${text.endsWith("원") ? "을" : "를"}`;
}

/** 탭 맨 위 소개 글. 시안의 "매달"은 어느 주기에도 맞게 "매번"으로 쓴다. */
export function strategyIntro(params) {
  const amount = withObject(money(params.amount, params.currency));
  return `매번 ${amount} 넣는 건 같고, 언제 얼마나 살지만 바꿔 봅니다. 전략은 종목 하나씩 계산합니다.`;
}

/** 수익률 손익 색: 화면에 보이는 자리로 0이면 색이 없다. */
function toneOf(value, digits) {
  if (value === null || value === undefined) return "";
  const shown = Number(value.toFixed(digits));
  if (shown > 0) return "pos";
  if (shown < 0) return "neg";
  return "";
}

/**
 * 카드 칸 (F-15). better·digits는 bestIndexes 인자: 높을수록 좋은 칸(수익률·XIRR·최저 수익률), 낮을수록
 * 좋은 칸(평단가). 평가금은 칸이 아니라 크게 쓰는 값이고(투자금이 같아 수익률과 순서가 같다), 남은 현금은
 * 굵게 하지 않는다. 견주는 값은 화면에 보이는 자리다 (results.js 비교 표와 같은 규칙).
 */
function cellColumns(assetCurrency, investCurrency) {
  return [
    { key: "return_pct", label: "수익률", text: (v) => pct(v), tone: 2, better: "high", digits: 2 },
    { key: "xirr_pct", label: "XIRR", text: (v) => pct(v), tone: null, better: "high", digits: 2 },
    {
      key: "avg_cost_asset",
      label: "평단가",
      text: (v) => price(v, assetCurrency),
      tone: null,
      better: "low",
      digits: (v) => shownPrice(v, assetCurrency),
    },
    {
      key: "worst_return_pct",
      label: "최저 수익률",
      text: (v) => pct(v, 1),
      tone: 1,
      better: "high",
      digits: 1,
    },
    {
      key: "leftover_cash_invest",
      label: "남은 현금",
      text: (v) => money(v, investCurrency),
      tone: null,
      better: null,
      digits: 2,
    },
  ];
}

/**
 * 카드 5장 모델 (F-15, STRATEGY_KEYS 순서). response는 result가 null이 아닌 /api/strategy 응답,
 * buys는 같은 종목 /api/backtest 결과의 summary.buys다 (같은 조건이라 매수일 수가 같다, 결정 보드 d57).
 * 카드: { key, name, rule, base, value, cells: [{ key, label, text, tone, best }], foot, error }.
 * 계산하지 못한 전략(기준 종목만 실패한 레버리지 전환, 결정 d31)은 error { title, detail }, value null,
 * cells []이고, 가장 좋은 값은 남은 카드끼리 고른다.
 */
export function strategyCards(response, buys) {
  const { params, result, errors = [] } = response;
  const invest = params.currency;
  const amount = params.amount;
  const ma = params.ma_days ?? RULE_MA_DAYS;
  const ref = params.switch_ref ?? RULE_SWITCH_REF;
  const n = (value) => (value ?? 0).toLocaleString("ko-KR");
  const columns = cellColumns(result.currency, invest);
  const strategies = STRATEGY_KEYS.map((key) => result.strategies[key] ?? null);
  const best = columns.map((c) =>
    bestIndexes(
      strategies.map((s) => s?.[c.key] ?? null),
      c.better,
      c.digits,
    ),
  );
  const lumpTotal = result.strategies.lump_sum?.invested ?? amount * (buys ?? 0);
  const rules = {
    none: `${freqText(params.freq, params.anchor)} ${money(amount, invest)}`,
    ma_dip: `${ma}일선 아래면 ${money(amount * 2, invest)}, 위면 ${money(amount / 2, invest)} (같은 예산)`,
    ma_hot: `${ma}일선보다 20% 넘게 위면 ${money(amount / 2, invest)}만`,
    switch: `${ref}${josa(ref, "이/가")} ${ma}일선 위일 때만 ${result.symbol} 사기, 아래면 현금으로 모아 두기`,
    lump_sum: `${result.chart.dates[0]}에 ${withObject(money(lumpTotal, invest))} 한 번에`,
  };
  const foot = (key, s) =>
    ({
      none: `${n(buys)}번 모두 ${money(amount, invest)}씩`,
      ma_dip: `${ma}일선 아래였던 매수일 ${n(s.rule_days)}번 / ${n(buys)}번`,
      ma_hot: `과열이었던 매수일 ${n(s.rule_days)}번 / ${n(buys)}번`,
      switch: `쉰 매수일 ${n(s.rule_days)}번 / ${n(buys)}번, 다음 매수일에 모아서 삼`,
      lump_sum: `첫 매수일에 ${n(buys)}번 몫을 한 번에`,
    })[key];
  return STRATEGY_KEYS.map((key, i) => {
    const s = strategies[i];
    const card = { key, name: strategyName(key), rule: rules[key], base: key === "none" };
    if (s === null) {
      const reason = errors.find((e) => e.symbol === ref)?.message ?? "";
      return {
        ...card,
        value: null,
        cells: [],
        foot: null,
        error: {
          title: "계산하지 못했습니다",
          detail:
            `기준 종목 ${ref}를 받지 못해 레버리지 전환은 계산하지 못했습니다. ${reason}`.trim(),
        },
      };
    }
    return {
      ...card,
      value: money(s.value, invest),
      cells: columns.map((c, j) => ({
        key: c.key,
        label: c.label,
        text: c.text(s[c.key]),
        tone: c.tone === null ? "" : toneOf(s[c.key], c.tone),
        best: best[j].has(i),
      })),
      foot: foot(key, s),
      error: null,
    };
  });
}

/** 계산 방법 세 칸 (시안). 금액은 투자 통화, 현금은 종목 통화, 이평선 기간은 그 응답의 값이다. */
export function methodCells(response) {
  const { params, result } = response;
  const amount = money(params.amount, params.currency);
  const ma = params.ma_days ?? RULE_MA_DAYS;
  return [
    {
      title: "같은 예산",
      text:
        `매번 ${withObject(amount)} 현금에 넣고, 규칙이 정한 만큼(${amount} × 배수)만 꺼내 삽니다. ` +
        "현금이 모자라면 있는 만큼만. 투자금은 기본 적립과 똑같이 늘어납니다.",
    },
    {
      title: "안 쓴 현금도 평가금",
      text:
        `규칙 때문에 덜 산 돈은 ${investLabel(result.currency)} 현금으로 들고 있고, 평가금에 넣어 ` +
        "비교합니다. 그래서 덜 사는 규칙은 오를 때 손해를 봅니다.",
    },
    {
      title: "미래 데이터 금지",
      text: `매수일의 ${ma}일선은 그날 종가까지로만 계산합니다. 상장 후 ${ma}거래일 전에는 배수 1로 삽니다.`,
    },
  ];
}

/** 정수 주만으로 요청했으면 카드 위 안내 (계산 규칙 9-6, 결정 d28). 아니면 null. */
export function fractionalNote(params) {
  return params.fractional === false ? "전략은 소수점 매수로 계산합니다" : null;
}

/** 기준 종목이 결과 종목에 없어 따로 받아 썼으면 안내 (시안 v2 늘어나는 상태 5, 결정 보드 d65). */
export function refFetchedNote(resultSymbols, response) {
  const ref = response.result?.switch_ref;
  if (!ref || resultSymbols.includes(ref.symbol)) return null;
  return `레버리지 전환의 기준 종목 ${ref.symbol}를 따로 받아 썼습니다. 기준 종목은 계산에만 쓰고 결과 카드에는 넣지 않습니다.`;
}

/**
 * 저장본으로 계산했다는 F-10 노랑 알림들 [{ title, detail }]: 종목(종목이나 환율이 저장본, result.stale)
 * 다음 기준 종목(switch_ref.stale, results.js refStaleAlert와 같은 글). /api/strategy에는 stale_sources가
 * 없어 날짜는 종목의 data_through다.
 */
export function strategyStale(response) {
  const { result, params } = response;
  const alerts = [];
  if (result.stale) {
    alerts.push({
      title:
        `${result.symbol}${josa(result.symbol, "은/는")} ` +
        `${result.data_through}까지 저장된 데이터로 계산했습니다.`,
      detail: "Yahoo Finance에서 새로 받지 못했습니다.",
    });
  }
  const ref = refStaleAlert([result], params);
  if (ref) alerts.push(ref);
  return alerts;
}

/**
 * 탭 안 F-10 빨강 상자 { title, detail }. reply는 연결 실패면 null, 아니면 { status, json }이다.
 * 기준 종목만 실패한 응답은 카드를 그리므로 null이다. 글은 app.js의 연결·HTTP 오류와 종목 알림과 같다.
 */
export function failureOf(reply, symbol) {
  if (reply === null || reply === undefined) {
    return {
      title: "계산하지 못했습니다",
      detail: "서버에 연결하지 못했습니다. 서버가 켜져 있는지 확인하고 다시 시도해 주세요.",
    };
  }
  if (reply.status !== 200 || !reply.json) {
    return {
      title: "계산하지 못했습니다",
      detail: `서버가 계산하지 못했습니다 (HTTP ${reply.status}). 잠시 뒤 다시 시도해 주세요.`,
    };
  }
  if (reply.json.result) return null;
  const errors = reply.json.errors ?? [];
  const line = errors.find((e) => e.symbol === symbol) ?? errors[0];
  return {
    title: `${symbol}${josa(symbol, "은/는")} 계산하지 못했습니다.`,
    detail: line?.message ?? "",
  };
}

/** 저장해 둘 응답: 200이고 결과가 있고 오류가 없을 때만 (실패와 기준 종목만 실패는 다시 부른다). */
export function canStore(reply) {
  return Boolean(
    reply && reply.status === 200 && reply.json?.result && (reply.json.errors ?? []).length === 0,
  );
}

/**
 * 요청 묶음 (결정 보드 d63). send(body)는 /api/strategy를 부르고 연결 실패면 null, 아니면
 * { status, json }을 준다. pick(key, body)는 { reply, latest }를 준다. select(key)는 보내지 않고 고른 key만
 * 알린다 (이미 그렸거나 저장한 key로 돌아갈 때. 그러면 가는 중인 앞 요청은 latest가 아니다).
 * - 저장한 key면 보내지 않는다. 가는 중인 같은 key면 그 요청을 같이 기다린다.
 * - 응답은 canStore일 때만 저장한다. 늦게 온 앞 요청도 저장한다 (다시 고르면 바로 그린다).
 * - latest는 응답이 왔을 때 그 key가 마지막으로 고른 key인지다. 그리는 쪽은 latest일 때만 그린다.
 */
export function strategyRequests(send) {
  const saved = new Map();
  const pending = new Map();
  let lastKey = null;
  return {
    saved: (key) => saved.get(key),
    select(key) {
      lastKey = key;
    },
    async pick(key, body) {
      lastKey = key;
      if (saved.has(key)) return { reply: saved.get(key), latest: lastKey === key };
      let request = pending.get(key);
      if (!request) {
        request = Promise.resolve()
          .then(() => send(body))
          .catch(() => null)
          .then((reply) => {
            if (canStore(reply)) saved.set(key, reply);
            return reply;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }
      const reply = await request;
      return { reply, latest: lastKey === key };
    },
  };
}
