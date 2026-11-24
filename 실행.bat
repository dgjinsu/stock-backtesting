@echo off
rem 적립식 백테스트 로컬 실행: 가상환경 준비 → 라이브러리 설치 → 서버 켜기 → 브라우저 열기
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행이라 가상환경을 만듭니다...
  python -m venv .venv || goto :error
)
".venv\Scripts\python" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :error
echo 서버를 켭니다. 이 창을 닫으면 서버도 꺼집니다.
".venv\Scripts\python" -m src.main --open
goto :eof

:error
echo 실행하지 못했습니다. Python 3.12 이상이 설치되어 있고 python 명령으로 실행되는지 확인하세요.
pause
