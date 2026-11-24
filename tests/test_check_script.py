"""확인 스크립트(scripts/check.py)의 웹 줄 길이 검사를 확인한다."""

import importlib.util
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parent.parent
CHECK_PATH = ROOT / "scripts" / "check.py"


def _load_check() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_script", CHECK_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = _load_check()


def test_long_lines_reports_file_line_and_length(tmp_path: Path) -> None:
    short = tmp_path / "ok.js"
    short.write_text("const a = 1;\n" + "x" * 100 + "\n", encoding="utf-8")
    long = tmp_path / "long.css"
    long.write_text("a {}\n" + "가" * 101 + "\n", encoding="utf-8")
    found = check.long_lines([short, long], limit=100, root=tmp_path)
    assert found == ["long.css:2 (101자)"]


def test_long_lines_ignores_line_endings(tmp_path: Path) -> None:
    crlf = tmp_path / "crlf.html"
    crlf.write_bytes(("y" * 100 + "\r\n").encode("utf-8"))
    assert check.long_lines([crlf], limit=100, root=tmp_path) == []


def test_long_lines_allows_one_unbreakable_html_attribute(tmp_path: Path) -> None:
    """주소·SRI 해시·SVG path처럼 나눌 수 없는 속성 하나만 있는 줄은 예외 (ruff가 긴 URL을 봐주듯)."""
    page = tmp_path / "index.html"
    url = "https://example.com/" + "a" * 100
    page.write_text(f'  <a\n    href="{url}"\n  >{"b" * 101}</a>\n', encoding="utf-8")
    assert check.long_lines([page], limit=100, root=tmp_path) == ["index.html:3 (108자)"]


def test_web_files_have_no_long_lines() -> None:
    """코드 컨벤션 1절: 한 줄은 100자 안쪽 (web/, tests/web/)."""
    assert check.long_lines(check.web_files(), limit=100, root=ROOT) == []
