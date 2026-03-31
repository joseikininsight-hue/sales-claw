@echo off
cd /d "%~dp0"
echo.
echo =========================================
echo  Sales Claw - Setup
echo =========================================
echo.

REM --- Node.js チェック ---
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js が見つかりません。https://nodejs.org からインストールしてください。
    pause
    exit /b 1
)

REM --- npm install ---
echo [1/4] 依存パッケージをインストール中...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install に失敗しました。
    pause
    exit /b 1
)

REM --- Playwright ---
echo [2/4] Playwright (Chromium) をインストール中...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo [WARN] Playwright のインストールに失敗しました。後で手動で実行してください: npx playwright install chromium
)

REM --- settings.json ---
echo [3/4] 設定ファイルを準備中...
if not exist "data\settings.json" (
    copy "data\sample-settings.json" "data\settings.json" >nul
    echo        data\settings.json を作成しました。
) else (
    echo        data\settings.json はすでに存在します。スキップ。
)

REM --- デスクトップショートカット生成 ---
echo [4/4] デスクトップショートカットを作成中...

REM launch-silent.vbs を動的生成（パスをこのディレクトリに固定）
set "LAUNCH_BAT=%~dp0launch.bat"
(
    echo Set WshShell = CreateObject^("WScript.Shell"^)
    echo WshShell.Run "cmd /c """"%LAUNCH_BAT%""""", 0, False
) > "%~dp0launch-silent.vbs"

REM .lnk ショートカットを PowerShell で作成
powershell -NoProfile -Command ^
  "$s=New-Object -ComObject WScript.Shell;" ^
  "$lnk=$s.CreateShortcut([System.IO.Path]::Combine($env:USERPROFILE,'Desktop','Sales Claw.lnk'));" ^
  "$lnk.TargetPath='%~dp0launch-silent.vbs';" ^
  "$lnk.WorkingDirectory='%~dp0';" ^
  "$lnk.Description='Sales Claw ダッシュボードを起動';" ^
  "$lnk.IconLocation='C:\Windows\System32\shell32.dll,14';" ^
  "$lnk.Save()"

if %errorlevel% == 0 (
    echo        デスクトップに「Sales Claw」ショートカットを作成しました。
) else (
    echo [WARN] ショートカット作成に失敗しました。launch.bat を直接ダブルクリックしてください。
)

echo.
echo =========================================
echo  セットアップ完了！
echo  デスクトップ起動: launch.bat または npm start
echo  Webダッシュボード: npm run dashboard
echo =========================================
echo.
pause
