"""PostToolUse 훅: `gh pr create`가 성공하면 Claude에게 곧바로 리뷰하라고 알린다.

Claude Code가 Bash·PowerShell 도구로 `gh pr create`를 실행한 뒤 이 스크립트를 부른다
(.claude/settings.json). 표준 입력으로 받은 이벤트 JSON의 출력에서 새 PR 주소를 찾으면,
리뷰를 부르라는 문장을 additionalContext로 돌려준다. 그 밖에는 아무것도 출력하지 않는다.
"""

import json
import re
import sys
from typing import Any

PR_URL = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/(\d+)")


def _response_text(response: Any) -> str:
    """도구 응답에서 명령 출력을 꺼낸다. Bash는 {"stdout": ...}, 그 밖의 모양도 받아 준다."""
    if isinstance(response, dict):
        for key in ("stdout", "output"):
            if response.get(key):
                return str(response[key])
        return json.dumps(response, ensure_ascii=False)
    return "" if response is None else str(response)


def build_output(event: dict[str, Any]) -> dict[str, Any] | None:
    """PR을 만든 명령이면 훅 출력(JSON 객체)을, 아니면 None을 돌려준다."""
    tool_input = event.get("tool_input")
    command = str(tool_input.get("command", "")) if isinstance(tool_input, dict) else ""
    if "gh pr create" not in command:
        return None
    match = PR_URL.search(_response_text(event.get("tool_response")))
    if match is None:
        return None
    number = match.group(1)
    context = (
        f"새 PR #{number}: {match.group(0)}\n"
        f"docs/7_개발워크플로우.md 8절대로 지금 `/dev-review {number}`를 실행해 "
        "code-reviewer 에이전트로 리뷰하고, 결과를 PR 댓글과 개발 현황판에 남긴다."
    )
    return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": context}}


def main() -> int:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    try:
        event = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if not isinstance(event, dict):
        return 0
    output = build_output(event)
    if output is not None:
        # ensure_ascii 기본값(True)이라 콘솔 인코딩과 상관없이 안전하다
        sys.stdout.write(json.dumps(output))
    return 0


if __name__ == "__main__":
    sys.exit(main())
