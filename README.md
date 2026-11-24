# 적립식 백테스트

"지난 5년간 QLD를 매달 200만원씩 샀다면 지금 평단가는?" 같은 질문에 답하는 웹 화면.
종목, 기간, 주기(매일·매주·매월), 금액을 고르면 평단가, 수익률, 평가금과 그래프를 보여 준다.

지금은 **개발 준비(0단계)** 중이다 (2026-11-24). 설계는 끝났고 앱 코드는 1단계부터 쓴다. 데스크톱 웹 브라우저용으로만 만든다.

- 화면 시안: [Design 캔버스](https://claude.ai/artifact/Nvxz1FH9bYPKwinAibsZmr) (비공개). "v1" 페이지가 먼저 만들 화면, "v2" 페이지가 그다음 화면이다.
- 개발 현황판: [적립식 백테스트 개발 현황](https://claude.ai/artifact/4qzSDxqhz7o8zoeF2CvucF) (비공개). 단계·이슈·PR·리뷰를 이어서 기록한다.

## 문서

| 문서 | 내용 |
|---|---|
| [기능 명세서](docs/1_기능명세서.md) | 무엇을 만드나, v1 기능 F-01~F-10, v2 기능 F-11~F-23, 화면 구성과 흐름, 비기능 요구 |
| [계산 규칙](docs/2_계산규칙.md) | 매수일, 환율, 평단가, 수익률·XIRR 공식과 기준값. 9절은 v2 지표와 전략 |
| [아키텍처](docs/3_아키텍처.md) | 언어·기술 선택과 이유, 모듈 나누기, 데이터 저장·갱신 방식, 실행 환경 |
| [상세 설계](docs/4_상세설계.md) | Yahoo 주소, 캐시 파일 형식, 계산 엔진 함수, API, 화면, 테스트 |
| [개발 계획](docs/5_개발계획.md) | 시작 전에 정할 것, 0단계(개발 준비)·v1 단계 1~8·v2 단계 9~14의 할 일과 완료 기준, 위험 |
| [확장 아이디어](docs/6_확장아이디어.md) | 아이디어를 고를 때의 고민 (이평선 적립·AI 해설은 v2로 옮김), MCP 서버, 쓸 만한 오픈소스 |
| [개발 워크플로우](docs/7_개발워크플로우.md) | 이슈 → 브랜치 → 테스트 → PR → Claude 리뷰 → 머지, 에이전트와 슬래시 명령, 현황판 기록, 처음 한 번 할 설정 |
| [코드 컨벤션](docs/8_코드컨벤션.md) | 모듈 경계, Python·테스트·API·웹 규칙, 의존성, 문서 |

Claude Code로 작업할 때 지키는 규칙은 [CLAUDE.md](CLAUDE.md)에 있다.

## 개발 환경

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python scripts\check.py
```

`scripts/check.py`는 린트(ruff), 포맷, 타입(mypy, `src/`가 생긴 뒤부터), 테스트(pytest)를 차례로 돌린다. GitHub Actions도 PR마다 같은 스크립트를 돌린다.

## 개발을 시작할 때

1. [개발 워크플로우](docs/7_개발워크플로우.md)를 읽는다. 모든 변경은 이슈에서 시작해 PR로 들어간다.
2. 문서를 1 → 5 순서로 읽는다. 결과가 맞는지는 계산 규칙이 기준이다.
3. 단계 1(뼈대)부터 한다. 계산 엔진(단계 3)은 네트워크 없이 먼저 만들어도 된다.

## 테스트용 데이터

- `tests/fixtures/yahoo/`: Yahoo Finance 응답을 그대로 저장한 것 (QQQ, QLD, TQQQ, SOXL, USDKRW=X, 005930.KS, 2021-01-01 ~ 2026-11-24).
- `tests/fixtures/expected.json`: 위 데이터로 계산한 기준값. 계산 엔진은 이 값과 같아야 한다.
- `tests/reference_calc.py`: 기준값을 만든 참고 스크립트. `python tests/reference_calc.py --write`로 다시 만든다.
- `tests/test_reference_calc.py`: 참고 스크립트의 출력이 `expected.json`과 같은지 확인한다.
