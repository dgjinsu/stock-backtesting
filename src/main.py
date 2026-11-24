"""HTTP 진입점: 라우트, 입력 검사, market → engine 이어 붙이기, web/ 정적 파일 제공.

python -m src.main          # 서버 켜기 (HOST, PORT 환경변수)
python -m src.main --open   # 켜고 준비되면 브라우저 열기
"""

import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Settings:
    """서버 설정. 기본값은 로컬 실행 기준이다 (아키텍처 5절)."""

    host: str = "127.0.0.1"
    port: int = 8000
    data_dir: Path = Path("data")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        """환경변수에서 설정을 읽는다. PORT가 1~65535 숫자가 아니면 ValueError."""
        port_text = env.get("PORT", "8000")
        if not port_text.isdecimal() or not 0 < int(port_text) < 65536:
            raise ValueError(f"PORT는 1~65535 사이 숫자여야 합니다: {port_text!r}")
        return cls(
            host=env.get("HOST", "127.0.0.1"),
            port=int(port_text),
            data_dir=Path(env.get("DATA_DIR", "data")),
        )


def create_app() -> FastAPI:
    """API 라우트를 먼저 두고, 남은 경로는 web/ 정적 파일로 넘긴다."""
    app = FastAPI(title="적립식 백테스트", version="0.1.0")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app


app = create_app()


def _open_browser_when_ready(url: str, timeout_s: float = 30.0) -> None:
    """서버가 /healthz에 답하면 브라우저를 연다. 시간 안에 안 뜨면 그냥 끝낸다."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}healthz", timeout=1):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.3)
    logger.warning("서버가 %s초 안에 뜨지 않아 브라우저를 열지 않았습니다", timeout_s)


def main(argv: list[str]) -> None:
    """서버를 켠다. `--open`이 있으면 준비된 뒤 브라우저를 연다."""
    import uvicorn

    settings = Settings.from_env(os.environ)
    if "--open" in argv:
        host = "127.0.0.1" if settings.host == "0.0.0.0" else settings.host
        url = f"http://{host}:{settings.port}/"
        threading.Thread(target=_open_browser_when_ready, args=(url,), daemon=True).start()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main(sys.argv[1:])
