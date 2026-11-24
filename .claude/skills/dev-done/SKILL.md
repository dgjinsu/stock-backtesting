---
name: dev-done
description: 사용자가 PR을 머지한 뒤 정리한다. 머지를 확인하고, 로컬 main을 당기고, 브랜치를 지우고, 이슈가 닫혔는지 보고, 현황판에 머지·완료를 기록하고, 다음 할 일을 제안한다.
argument-hint: <PR 번호>
---

# 머지 뒤 정리

PR: #$ARGUMENTS

1. **머지 확인**: `gh pr view $ARGUMENTS --json state,mergedAt,headRefName,closingIssuesReferences,url`. `state`가 `MERGED`가 아니면 멈추고 알린다. 머지는 사용자가 한다.
2. **로컬 정리**:
   ```bash
   git switch main && git pull --ff-only
   git branch -D <headRefName>    # squash 머지라 -d로는 지워지지 않는다. 1에서 머지를 확인했을 때만
   ```
   원격 브랜치는 GitHub의 "Automatically delete head branches"가 지운다. 남아 있으면 `git push origin --delete <headRefName>`.
3. **이슈**: `closingIssuesReferences`의 이슈가 닫혔는지 본다. 안 닫혔으면 `gh issue close <번호> --comment "#$ARGUMENTS 머지로 끝남"`.
4. **현황판**: `.claude/skills/dev-board/SKILL.md`의 "머지했을 때"대로 기록한다. 그 단계의 이슈가 모두 닫혔으면 단계를 "완료"로 바꾼다.
5. **다음**: `docs/5_개발계획.md`에서 다음 단계나 남은 이슈를 찾아 제안한다 (`/dev-issue <단계>` 또는 `/dev-start <이슈>`).
