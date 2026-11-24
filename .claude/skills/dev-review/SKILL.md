---
name: dev-review
description: PR을 code-reviewer 에이전트로 리뷰하고 결과를 PR 댓글과 개발 현황판에 남긴다. 필수 지적이 있으면 고치고 다시 리뷰한다. PR을 만든 직후(훅이 알려 준다)와 리뷰를 반영한 뒤에 쓴다.
argument-hint: <PR 번호>
---

# PR 리뷰

PR: #$ARGUMENTS

1. **리뷰**: code-reviewer 에이전트에게 "PR #$ARGUMENTS를 세션 리뷰로 리뷰한다"고 넘긴다. 이 세션에서 짠 코드라도 에이전트의 판단을 그대로 받는다.
2. **댓글**: 에이전트의 리뷰를 고치지 말고 스크래치 디렉터리의 임시 파일에 쓴 뒤 `gh pr comment $ARGUMENTS --body-file <파일>`. 출력된 댓글 주소를 현황판에 쓴다.
   지적에 동의하지 않으면 리뷰에서 빼지 말고, 그 지적 번호를 들어 근거를 단 답글을 따로 단다.
3. **현황판**: `.claude/skills/dev-board/SKILL.md`의 "리뷰를 마쳤을 때"대로 기록한다. CI 결과는 `gh pr checks $ARGUMENTS`로 본다.
4. **반영**:
   - 필수가 있으면 고친다. 커밋 `fix(<scope>): 리뷰 반영 - <무엇>`, 푸시, 지적마다 어떻게 고쳤는지 PR 댓글로 답한 뒤 이 스킬을 처음부터 다시 돈다.
   - 두 번 돌아도 필수가 남거나, 고치려면 명세를 바꿔야 하면 멈추고 사용자에게 묻는다.
   - 권장은 고치거나, 안 고치는 이유를 답한다. 참고 중 할 만한 것은 `/dev-issue`로 이슈를 만든다.
5. **끝**: 필수가 0이고 CI가 초록이면 사용자에게 머지를 부탁한다 (Squash and merge). 머지는 사용자가 한다. 머지 뒤에는 `/dev-done $ARGUMENTS`.
