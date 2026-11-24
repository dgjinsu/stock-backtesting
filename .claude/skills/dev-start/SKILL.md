---
name: dev-start
description: 이슈 작업을 시작한다. 최신 main에서 규칙에 맞는 브랜치를 따고, 필요하면 architect 설계 메모를 이슈에 달고, 현황판에 "진행 중"으로 기록한 뒤 test-writer로 실패하는 테스트부터 쓴다.
argument-hint: <이슈 번호>
---

# 작업 시작

이슈: #$ARGUMENTS

1. **이슈 읽기**: `gh issue view $ARGUMENTS --json number,title,body,labels,milestone,state`. 닫혀 있거나 없으면 멈춘다.
2. **작업 트리 확인**: `git status --short`가 비어 있어야 한다. 아니면 무엇이 남았는지 알리고 멈춘다.
3. **브랜치**:
   ```bash
   git switch main && git pull --ff-only
   git switch -c <type>/$ARGUMENTS-<짧은-영어-설명>
   ```
   type은 이슈의 `type:` 라벨 값(feat, fix, docs, test, refactor, chore)이다.
4. **설계 메모**: 모듈이 둘 이상 걸치거나 새 공개 함수·API 모양이 생기면 architect 에이전트로 메모를 받아 `gh issue comment $ARGUMENTS --body-file <파일>`로 단다.
5. **현황판**: `.claude/skills/dev-board/SKILL.md`의 "작업을 시작했을 때"대로 기록한다.
6. **테스트 먼저**: test-writer 에이전트에게 이슈 번호를 주고 실패하는 테스트를 받는다. 실패 이유가 "아직 없음"인지 확인하고 커밋한다.
   커밋 메시지: `test(<scope>): <무엇> 테스트 추가`, 본문 끝에 `Refs #$ARGUMENTS`.
7. 그다음 구현한다. 커밋은 `docs/7_개발워크플로우.md` 5절대로 작게 나눈다. 다 되면 `/dev-pr`.
