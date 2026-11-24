"""PR을 열기 전에 돌리는 확인: 린트, 포맷, 타입, 테스트, 웹 테스트. CI도 이 스크립트를 쓴다.

    python scripts/check.py          # 확인만
    python scripts/check.py --fix    # 린트 자동 수정과 포맷을 먼저 적용한 뒤 확인

하나가 실패해도 나머지를 끝까지 돌리고, 하나라도 실패하면 종료 코드 1을 낸다.
웹 단계(JS 문법, tests/web/*.test.mjs)는 Node.js 22.7 이상이 필요하다 (package.json 없이
ES 모듈을 알아본다). 로컬에 node가 없으면 건너뛰고, CI(환경변수 CI가 있을 때)에서는 실패로 친다.
"""

import io
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(label: str, command: list[str]) -> bool:
    """명령을 저장소 루트에서 돌리고 통과 여부를 돌려준다."""
    shown = [Path(command[0]).name, *command[1:]]
    print(f"\n== {label}: {' '.join(shown)}", flush=True)
    result = subprocess.run(command, cwd=ROOT, check=False)
    passed = result.returncode == 0
    print(f"== {label}: {'통과' if passed else '실패'}", flush=True)
    return passed


def python_module(*args: str) -> list[str]:
    """지금 파이썬으로 `-m <args>`를 돌리는 명령."""
    return [sys.executable, "-m", *args]


def web_files() -> list[Path]:
    """줄 길이를 보는 웹 파일 (web/의 js·css·html, tests/web/의 테스트)."""
    patterns = ["web/*.js", "web/*.css", "web/*.html", "tests/web/*.mjs"]
    return sorted(path for pattern in patterns for path in ROOT.glob(pattern))


# HTML에서 나눌 수 없는 값(주소, SRI 해시, SVG path) 속성 하나만 있는 줄
_ONE_ATTRIBUTE = re.compile(r'^\s*(href|src|integrity|d)="[^"]*"\s*/?>?\s*$')


def long_lines(paths: list[Path], limit: int, root: Path) -> list[str]:
    """limit자를 넘는 줄 ("파일:줄 (N자)"). 코드 컨벤션 1절. 테스트(test_check_script.py)가 부른다.

    HTML에서 나눌 수 없는 속성 하나만 있는 줄은 뺀다.
    """
    found: list[str] = []
    for path in paths:
        lines = path.read_text(encoding="utf-8").splitlines()
        for number, line in enumerate(lines, start=1):
            unbreakable = path.suffix == ".html" and _ONE_ATTRIBUTE.match(line)
            if len(line) > limit and not unbreakable:
                found.append(f"{path.relative_to(root).as_posix()}:{number} ({len(line)}자)")
    return found


def web_steps() -> list[tuple[str, list[str]]] | None:
    """웹 단계. node가 없으면 None."""
    node = shutil.which("node")
    if node is None:
        return None
    scripts = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "web").glob("*.js"))
    tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "tests" / "web").glob("*.test.mjs"))
    steps = [(f"JS 문법 ({name})", [node, "--check", name]) for name in scripts]
    if tests:
        steps.append(("웹 테스트", [node, "--test", "--test-reporter=dot", *tests]))
    return steps


def main() -> int:
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")

    if "--fix" in sys.argv[1:]:
        run("린트 자동 수정", python_module("ruff", "check", "--fix", "."))
        run("포맷 적용", python_module("ruff", "format", "."))

    steps: list[tuple[str, list[str]]] = [
        ("린트", python_module("ruff", "check", ".")),
        ("포맷", python_module("ruff", "format", "--check", ".")),
    ]
    if (ROOT / "src").is_dir():
        steps.append(("타입", python_module("mypy")))
    else:
        print("\n== 타입: src/가 아직 없어 건너뜀 (1단계부터 돈다)", flush=True)
    steps.append(("테스트", python_module("pytest")))

    failed: list[str] = []
    web = web_steps()
    if web is None:
        if os.environ.get("CI"):
            failed.append("웹 (CI에 node가 없음)")
        print("\n== 웹: node가 없어 건너뜀 (Node.js 22.7 이상을 깔면 돈다)", flush=True)
    else:
        steps.extend(web)

    failed += [label for label, command in steps if not run(label, command)]
    if failed:
        print(f"\n실패: {', '.join(failed)}")
        return 1
    print("\n모두 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
