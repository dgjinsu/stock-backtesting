---
name: dev-pr
description: 지금 브랜치의 작업으로 PR을 연다. 확인 스크립트와 계산 검증을 통과시키고, main 위로 rebase하고, 템플릿대로 PR을 만들고, 현황판에 기록한다. PR이 열리면 곧바로 /dev-review로 리뷰한다.
argument-hint: "[draft]"
---

# PR 열기

1. **브랜치 확인**: 지금 브랜치가 `main`이면 멈춘다. 브랜치 이름에서 이슈 번호를 읽고 `gh issue view <번호>`로 완료 기준을 다시 본다.
2. **확인**: `.venv/Scripts/python scripts/check.py`. 실패하면 고치고 다시 돌린다. 통과할 때까지 PR을 열지 않는다.
3. **계산 검증**: `src/engine.py`, `tests/reference_calc.py`, `tests/fixtures/expected.json` 중 하나라도 바뀌었으면 calc-verifier 에이전트를 돌린다. 결론이 "통과"가 아니면 고친다.
4. **최신화**: `git fetch origin && git rebase origin/main`. 충돌을 풀었으면 2부터 다시 한다.
5. **올리기**: `git push -u origin HEAD`. rebase로 이미 올린 커밋이 바뀌었으면 `git push --force-with-lease`.
6. **PR 본문**: `.github/pull_request_template.md`를 채워 스크래치 디렉터리의 임시 파일에 쓴다. 첫 칸에 `Closes #<번호>`, 테스트 결과 칸에 pytest 마지막 줄을 넣고, 화면 변경이면 스크린샷을 붙인다.
7. **PR 만들기**: 다른 명령과 묶지 말고 따로 실행한다. 훅이 이 명령의 출력을 보고 리뷰를 부른다.
   ```bash
   gh pr create --base main --title "<type>(<scope>): <요약>" --body-file <파일> --label "<이슈와 같은 라벨>" --milestone "<v1|v2>"
   ```
   인자에 `draft`가 있으면 `--draft`를 붙인다.
8. **현황판**: `.claude/skills/dev-board/SKILL.md`의 "PR을 열었을 때"대로 기록한다.
9. **리뷰**: 바로 `/dev-review <PR 번호>`를 실행한다.
