"""환경변수에서 서버 설정을 읽는 것과 브라우저 열기를 확인한다 (아키텍처 5절)."""

from pathlib import Path
from types import TracebackType

import pytest

from src import main as main_module
from src.main import Settings


def test_settings_without_env_uses_local_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.host == "127.0.0.1"
    assert settings.port == 8000
    assert settings.data_dir == Path("data")


def test_settings_reads_host_port_and_data_dir_from_env() -> None:
    settings = Settings.from_env({"HOST": "0.0.0.0", "PORT": "9000", "DATA_DIR": "/tmp/prices"})
    assert settings.host == "0.0.0.0"
    assert settings.port == 9000
    assert settings.data_dir == Path("/tmp/prices")


@pytest.mark.parametrize(
    "port", ["abc", "0", "70000", "²"], ids=["not-number", "zero", "too-big", "superscript"]
)
def test_settings_with_bad_port_raises_value_error(port: str) -> None:
    with pytest.raises(ValueError, match="PORT"):
        Settings.from_env({"PORT": port})


class _Answer:
    def __enter__(self) -> "_Answer":
        return self

    def __exit__(
        self, kind: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        return None


def test_open_browser_when_ready_opens_once_after_healthz_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asked: list[str] = []
    opened: list[str] = []

    def answer(url: str, timeout: float) -> _Answer:
        asked.append(url)
        return _Answer()

    monkeypatch.setattr(main_module.urllib.request, "urlopen", answer)
    monkeypatch.setattr(main_module.webbrowser, "open", opened.append)
    main_module._open_browser_when_ready("http://127.0.0.1:8000/", timeout_s=1)
    assert asked == ["http://127.0.0.1:8000/healthz"]
    assert opened == ["http://127.0.0.1:8000/"]


def test_open_browser_when_ready_gives_up_after_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []

    def refuse(url: str, timeout: float) -> _Answer:
        raise OSError("connection refused")

    monkeypatch.setattr(main_module.urllib.request, "urlopen", refuse)
    monkeypatch.setattr(main_module.webbrowser, "open", opened.append)
    monkeypatch.setattr(main_module.time, "sleep", lambda seconds: None)
    main_module._open_browser_when_ready("http://127.0.0.1:8000/", timeout_s=0.05)
    assert opened == []
