"""환경변수에서 서버 설정을 읽는 것을 확인한다 (아키텍처 5절)."""

from pathlib import Path

import pytest

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


@pytest.mark.parametrize("port", ["abc", "0", "70000"], ids=["not-number", "zero", "too-big"])
def test_settings_with_bad_port_raises_value_error(port: str) -> None:
    with pytest.raises(ValueError, match="PORT"):
        Settings.from_env({"PORT": port})
