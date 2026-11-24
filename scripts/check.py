"""PR을 열기 전에 돌리는 확인: 린트, 포맷, 타입, 테스트. CI도 이 스크립트를 쓴다.

    python scripts/check.py          # 확인만
    python scripts/check.py --fix    # 린트 자동 수정과 포맷을 먼저 적용한 뒤 확인

하나가 실패해도 나머지를 끝까지 돌리고, 하나라도 실패하면 종료 코드 1을 낸다.
"""

import io
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(label: str, args: list[str]) -> bool:
    """`python -m <args>`를 저장소 루트에서 돌리고 통과 여부를 돌려준다."""
    print(f"\n== {label}: {' '.join(args)}", flush=True)
    result = subprocess.run([sys.executable, "-m", *args], cwd=ROOT, check=False)
    passed = result.returncode == 0
    print(f"== {label}: {'통과' if passed else '실패'}", flush=True)
    return passed


def main() -> int:
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8")

    if "--fix" in sys.argv[1:]:
        run("린트 자동 수정", ["ruff", "check", "--fix", "."])
        run("포맷 적용", ["ruff", "format", "."])

    steps: list[tuple[str, list[str]]] = [
        ("린트", ["ruff", "check", "."]),
        ("포맷", ["ruff", "format", "--check", "."]),
    ]
    if (ROOT / "src").is_dir():
        steps.append(("타입", ["mypy"]))
    else:
        print("\n== 타입: src/가 아직 없어 건너뜀 (1단계부터 돈다)", flush=True)
    steps.append(("테스트", ["pytest"]))

    failed = [label for label, args in steps if not run(label, args)]
    if failed:
        print(f"\n실패: {', '.join(failed)}")
        return 1
    print("\n모두 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
