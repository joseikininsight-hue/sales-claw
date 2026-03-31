@echo off
cd /d "%~dp0"

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] npm が見つかりません。Node.js をインストールしてから再実行してください。
    pause
    exit /b 1
)

REM デスクトップアプリを起動（多重起動時は既存ウィンドウを優先）
start "" cmd /c npm start
