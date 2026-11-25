@echo off
rem 적립식 백테스트 로컬 실행: 가상환경 준비 → 라이브러리 설치 → 서버 켜기 → 브라우저 열기
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행이라 가상환경을 만듭니다...
  python -m venv .venv || goto :python_error
)
".venv\Scripts\python" -m pip install --disable-pip-version-check -q -r requirements.txt || goto :install_error
echo 서버를 켭니다. 이 창을 닫으면 서버도 꺼집니다.
".venv\Scripts\python" -m src.main --open || goto :server_error
goto :eof

:python_error
echo 가상환경을 만들지 못했습니다. Python 3.12 이상이 설치되어 있고 python 명령으로 실행되는지 확인하세요.
pause
goto :eof

:install_error
echo 라이브러리를 설치하지 못했습니다. 인터넷 연결을 확인하고 다시 실행하세요.
pause
goto :eof

:server_error
echo 서버를 켜지 못했습니다. 위 메시지를 확인하세요. 8010 포트를 다른 프로그램이 쓰고 있으면 PORT 환경변수로 바꿉니다.
pause
