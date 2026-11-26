# CLAUDE.md

적립식 백테스트 웹앱이다. 종목·기간·주기·금액을 넣으면 그동안 꾸준히 샀을 때의 평단가, 수익률, XIRR, 그래프를 보여 준다.
PC 웹 브라우저만 대상으로 하고, 지금은 v1(F-01~F-10)을 만든다.

## 먼저 볼 것

| 무엇 | 어디 |
|---|---|
| 만들 기능 (F-xx) | [docs/1_기능명세서.md](docs/1_기능명세서.md) |
| 계산 공식과 기준값 | [docs/2_계산규칙.md](docs/2_계산규칙.md), `tests/fixtures/expected.json` |
| 모듈 경계 | [docs/3_아키텍처.md](docs/3_아키텍처.md) |
| API·캐시·화면 규격 | [docs/4_상세설계.md](docs/4_상세설계.md) |
| 단계와 완료 기준 | [docs/5_개발계획.md](docs/5_개발계획.md) |
| 일하는 순서 | [docs/7_개발워크플로우.md](docs/7_개발워크플로우.md) |
| 코드 규칙 | [docs/8_코드컨벤션.md](docs/8_코드컨벤션.md) |
| 화면 시안 | 겉모습(색·글꼴·틀·부품 모양): https://claude.ai/artifact/Ro5VPSsc1bAFiXgU8A4drM 의 "B" 보드. 기능·문구·항목: https://claude.ai/artifact/Nvxz1FH9bYPKwinAibsZmr 의 "v1"·"v2" 페이지 (둘 다 Artifact 도구 `read`로 연다. 결정 d46) |
| 개발 현황판 | https://claude.ai/artifact/4qzSDxqhz7o8zoeF2CvucF (기록 방법은 `.claude/skills/dev-board/SKILL.md`) |
| 결정 보드 | https://claude.ai/artifact/JaxQyqXbXZLdmN4houmWh5 (Claude가 혼자 정한 것과 사용자가 할 일. 사용자 답은 `data/dev/answers`) |

## 명령 (Windows, 저장소 루트에서)

```powershell
python -m venv .venv                                         # 처음 한 번
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python scripts\check.py                      # 린트·포맷·타입·테스트·웹 한 번에. PR 전에 반드시
.\.venv\Scripts\python scripts\check.py --fix                # 린트 자동 수정과 포맷 적용 뒤 확인
.\.venv\Scripts\python -m pytest tests\test_engine.py -q     # 일부 테스트만
```

```powershell
.\.venv\Scripts\python -m src.main --open                     # 서버 켜고 브라우저 열기 (실행.bat과 같음)
```

Git Bash에서는 `.venv/Scripts/python`으로 쓴다. 환경변수 `HOST`, `PORT`, `DATA_DIR`로 주소와 캐시 위치를 바꾼다.

## 일하는 순서

모든 변경은 이슈 → 브랜치 → 테스트 → PR → 리뷰 → 머지로 간다. 자세한 것은 docs/7.

1. `/dev-issue <단계 또는 할 일>`: planner 에이전트로 초안을 받아 GitHub 이슈를 만들고 현황판에 적는다.
2. `/dev-start <이슈 번호>`: 최신 main에서 `<type>/<이슈번호>-<설명>` 브랜치를 딴다. 모듈이 둘 이상 걸치면 architect 설계 메모를 이슈에 단다.
3. test-writer로 실패하는 테스트를 먼저 쓰고, 그다음 구현한다.
4. `/dev-pr`: `scripts/check.py`가 통과해야 PR을 연다. 엔진이나 기준값을 바꿨으면 calc-verifier를 먼저 돌린다.
5. PR이 열리면 훅이 `/dev-review <번호>`를 부르라고 알려 준다. code-reviewer 결과를 PR 댓글과 현황판에 남긴다. GitHub Actions의 Claude 리뷰도 따로 돈다.
6. 머지는 사용자가 한다 (Squash and merge). 머지 뒤 `/dev-done <PR 번호>`.

일이 한 칸 나아갈 때마다 현황판에 기록한다. 빠뜨렸으면 `/dev-board sync`로 GitHub 상태와 맞춘다.

## 꼭 지킬 것

- `src/engine.py`는 표준 라이브러리만 쓰고, 네트워크·파일·현재 시각을 읽지 않는다.
- Yahoo 호출과 캐시 파일은 `src/market.py`에서만 다룬다. 테스트는 네트워크를 쓰지 않는다 (fixture, `httpx.MockTransport`). 실제 Yahoo 확인은 `@pytest.mark.live`로 표시해 기본 실행에서 뺀다.
- 계산 결과가 기준값과 다르면 기준값이 아니라 엔진을 고친다. 기준값은 계산 규칙 문서를 바꿀 때만 `python tests/reference_calc.py --write`로 다시 만들고, 이유를 PR에 적는다.
- v1 이슈에 v2 기능(F-11~F-23)을 넣지 않는다. 시안 "v1" 페이지에 없는 것은 v2다.
- main에 직접 커밋하거나 푸시하지 않는다. force push는 자기 PR 브랜치에 `--force-with-lease`로만 한다.
- API 키 같은 비밀값은 커밋하지 않는다. 설정은 환경변수(`HOST`, `PORT`, `DATA_DIR`)로 받는다.
- 문서와 코드가 다르면 멈추고 사용자에게 묻는다. 동작이 바뀌면 같은 PR에서 문서도 고친다.
- 커밋 메시지와 PR 제목은 Conventional Commits 형식, 설명은 한국어로 쓴다 (docs/7 5절).
