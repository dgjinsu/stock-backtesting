"""PR을 만든 뒤 리뷰를 부르는 훅(.claude/hooks/after_pr_create.py)을 확인한다."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent
HOOK_PATH = ROOT / ".claude" / "hooks" / "after_pr_create.py"
PR_URL = "https://github.com/dgjinsu/stock-backtesting/pull/12"


def _load_hook() -> ModuleType:
    spec = importlib.util.spec_from_file_location("after_pr_create", HOOK_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook()


def _context(output: dict[str, Any] | None) -> str:
    assert output is not None
    assert output["hookSpecificOutput"]["hookEventName"] == "PostToolUse"
    context: str = output["hookSpecificOutput"]["additionalContext"]
    return context


def test_build_output_bash_pr_create_asks_review_of_new_pr() -> None:
    event = {
        "tool_name": "Bash",
        "tool_input": {"command": "gh pr create --base main --title t --body-file b.md"},
        "tool_response": {"stdout": f"{PR_URL}\n", "stderr": "", "interrupted": False},
    }
    context = _context(hook.build_output(event))
    assert "/dev-review 12" in context
    assert PR_URL in context


def test_build_output_powershell_string_response_asks_review() -> None:
    event = {
        "tool_name": "PowerShell",
        "tool_input": {"command": "gh pr create --fill"},
        "tool_response": f"Creating pull request\n{PR_URL}\n",
    }
    assert "/dev-review 12" in _context(hook.build_output(event))


@pytest.mark.parametrize(
    "event",
    [
        {"tool_input": {"command": "gh pr view 12"}, "tool_response": {"stdout": PR_URL}},
        {"tool_input": {"command": "gh pr create --fill"}, "tool_response": {"stdout": ""}},
        {"tool_input": "gh pr create", "tool_response": PR_URL},
        {},
    ],
    ids=["other-command", "no-url-in-output", "input-not-object", "empty-event"],
)
def test_build_output_without_new_pr_returns_none(event: dict[str, Any]) -> None:
    assert hook.build_output(event) is None


def test_main_prints_json_for_pr_create_event() -> None:
    event = {"tool_input": {"command": "gh pr create --fill"}, "tool_response": {"stdout": PR_URL}}
    completed = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps(event).encode("utf-8"),
        capture_output=True,
        check=True,
        timeout=30,
    )
    assert "/dev-review 12" in _context(json.loads(completed.stdout))


def test_main_ignores_invalid_json() -> None:
    completed = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=b"not json",
        capture_output=True,
        check=True,
        timeout=30,
    )
    assert completed.stdout == b""
