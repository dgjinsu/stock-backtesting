---
name: dev-board
description: 개발 현황판(claude.ai Artifact)에 단계·이슈·PR·리뷰 기록을 쓰는 규칙이다. 다른 dev-* 스킬이 기록할 때 이 파일을 따른다. "현황판 갱신", "현황판 맞춰" 같은 요청이나 `/dev-board sync`로 GitHub 상태와 현황판을 맞출 때도 쓴다.
argument-hint: "[sync]"
---

# 개발 현황판

- 주소: https://claude.ai/artifact/4qzSDxqhz7o8zoeF2CvucF
- 도구: `ArtifactData`. 목록에 없으면 ToolSearch에 `select:ArtifactData`로 불러온다. 모든 호출에 `url`을 넘긴다.
- 이미 있는 문서를 고칠 때는 먼저 `get`으로 읽어 `version`을 얻고 `if_version`을 붙인다. 문서가 둘 이상이면 `batch` 한 번으로 쓴다.
- 날짜는 `YYYY-MM-DD`, 시각은 한국 시각 `YYYY-MM-DDTHH:MM:SS+09:00`.
- GitHub에 있는 사실만 쓴다. 추측이나 앞으로의 계획은 쓰지 않는다.
- 페이지(`files/index.html`)와 데이터셋 정의(`datasets/*`)는 화면을 바꿀 때만 고친다. 기록은 아래 컬렉션에만 쓴다.

## 컬렉션과 필드

### `data/dev/steps` — 문서 id `s00` ~ `s14`

| 필드 | 값 |
|---|---|
| `no` | 0~14 (숫자) |
| `version` | `v1` 또는 `v2` |
| `title` | 단계 이름 (개발 계획 표) |
| `goal` | 끝났다고 보는 기준 |
| `scope` | 할 일 |
| `status` | `todo` 대기 · `doing` 진행 중 · `review` 리뷰 중 · `done` 완료 |
| `startedAt`, `doneAt` | 날짜 또는 빈 문자열 |

### `data/dev/issues` — 문서 id = 이슈 번호 (`"7"`)

| 필드 | 값 |
|---|---|
| `number` | 이슈 번호 (숫자) |
| `title`, `url` | GitHub 그대로 |
| `step` | 단계 문서 id (`s03`) |
| `type`, `area` | 라벨에서 `type:`·`area:`를 뺀 값 (`feat`, `engine`) |
| `status` | `open` 열림 · `doing` 진행 중 · `review` 리뷰 중 · `closed` 닫힘 |
| `branch` | 브랜치 이름 또는 빈 문자열 |
| `prs` | 연결된 PR 번호들을 쉼표로 (`"8"`, `"8,10"`) 또는 빈 문자열 |
| `openedAt`, `closedAt` | 날짜 또는 빈 문자열 |

### `data/dev/prs` — 문서 id = PR 번호

| 필드 | 값 |
|---|---|
| `number`, `title`, `url` | GitHub 그대로 (`number`는 숫자) |
| `issues` | 닫는 이슈 번호들을 쉼표로 (`"7"`) |
| `branch` | head 브랜치 |
| `status` | `open` 리뷰 대기 · `changes` 고칠 것 있음 · `approved` 머지 가능 · `merged` 머지됨 · `closed` 닫힘 |
| `review` | 마지막 리뷰 요약 (`필수 0 · 권장 2 · 참고 1`) 또는 빈 문자열 |
| `reviewUrl` | 마지막 리뷰 댓글 주소 또는 빈 문자열 |
| `ci` | `pass` · `fail` · `pending` · `none` |
| `tests` | pytest 마지막 줄 (`12 passed in 0.8s`) 또는 빈 문자열 |
| `additions`, `deletions` | 숫자 |
| `openedAt`, `mergedAt` | 날짜 또는 빈 문자열 |

### `data/dev/events` — 문서 id `YYYYMMDD-HHMMSS-<kind>-<번호>`

| 필드 | 값 |
|---|---|
| `at` | 시각 |
| `kind` | `issue` · `branch` · `commit` · `pr` · `review` · `fix` · `merge` · `close` · `step` · `note` |
| `ref` | `#7` 같은 참조 또는 빈 문자열 |
| `url` | 관련 주소 또는 빈 문자열 |
| `text` | 한 문장 (예: "PR #8 리뷰: 필수 1 · 권장 2") |

## 기록 규칙

| 일 | 쓰는 문서 |
|---|---|
| 이슈를 만들었을 때 | `issues/<번호>` 새로 (`status: open`), `events` (`issue`) |
| 작업을 시작했을 때 | `issues/<번호>` (`status: doing`, `branch`), 단계가 `todo`면 `steps/<id>` (`status: doing`, `startedAt`), `events` (`branch`) |
| PR을 열었을 때 | `prs/<번호>` 새로 (`status: open`, `ci: pending`), `issues/<번호>` (`status: review`, `prs`), `steps/<id>` (`status: review`), `events` (`pr`) |
| 리뷰를 마쳤을 때 | `prs/<번호>` (`status`: 필수가 있으면 `changes`, 없으면 `approved`; `review`, `reviewUrl`, `ci`, `tests`), `events` (`review`) |
| 리뷰를 반영했을 때 | `events` (`fix`). 다시 리뷰하면 위 줄대로 |
| 머지했을 때 | `prs/<번호>` (`status: merged`, `mergedAt`), `issues/<번호>` (`status: closed`, `closedAt`), 그 단계의 이슈가 모두 닫혔으면 `steps/<id>` (`status: done`, `doneAt`), `events` (`merge`, 단계가 끝났으면 `step` 한 줄 더) |

단계에 열린 이슈가 남아 있으면 단계 상태는 그 이슈들 중 가장 앞선 상태(`review` > `doing` > `todo`)를 따른다.

## 맞추기 (`/dev-board sync`)

1. GitHub를 읽는다.
   ```bash
   gh issue list --state all --limit 200 --json number,title,url,state,labels,createdAt,closedAt
   gh pr list --state all --limit 200 --json number,title,url,state,headRefName,createdAt,mergedAt,additions,deletions,closingIssuesReferences
   ```
2. 현황판을 읽는다: `ArtifactData` `list`로 `data/dev/steps`, `data/dev/issues`, `data/dev/prs`.
3. 다른 것만 고친다 (`batch`, `if_version`). 현황판에 없는 이슈·PR은 더하고, `events`에 `note`로 "현황판 맞춤: #n 추가"를 남긴다. `events`는 지우지 않는다.
4. 고친 것을 한 줄씩 보고한다.
