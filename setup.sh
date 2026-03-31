#!/bin/bash
# Sales Claw — Setup (Mac / Linux)
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "========================================="
echo " Sales Claw - Setup"
echo "========================================="
echo ""

# --- Node.js チェック ---
if ! command -v node &> /dev/null; then
  echo "[ERROR] Node.js が見つかりません。https://nodejs.org からインストールしてください。"
  exit 1
fi

# --- npm install ---
echo "[1/4] 依存パッケージをインストール中..."
npm install

# --- Playwright ---
echo "[2/4] Playwright (Chromium) をインストール中..."
npx playwright install chromium || echo "[WARN] Playwright のインストールに失敗しました。後で手動で実行してください: npx playwright install chromium"

# --- settings.json ---
echo "[3/4] 設定ファイルを準備中..."
if [ ! -f "data/settings.json" ]; then
  cp data/sample-settings.json data/settings.json
  echo "       data/settings.json を作成しました。"
else
  echo "       data/settings.json はすでに存在します。スキップ。"
fi

# --- デスクトップショートカット / アプリランチャー ---
echo "[4/4] ランチャーを作成中..."

OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  # macOS: .command ファイルをデスクトップに作成
  LAUNCHER="$HOME/Desktop/Sales Claw.command"
  cat > "$LAUNCHER" << EOF
#!/bin/bash
cd "$DIR"
npm start >/tmp/sales-claw.log 2>&1 &
EOF
  chmod +x "$LAUNCHER"
  echo "       デスクトップに「Sales Claw.command」を作成しました。"

else
  # Linux: .desktop ファイルを作成
  DESKTOP_DIR="$HOME/Desktop"
  [ -d "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME"
  cat > "$DESKTOP_DIR/sales-claw.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Sales Claw
Comment=Sales Claw ダッシュボードを起動
Exec=bash "$DIR/launch.sh"
Terminal=false
Categories=Office;Network;
EOF
  chmod +x "$DESKTOP_DIR/sales-claw.desktop"

  # launch.sh も生成
  cat > "$DIR/launch.sh" << 'LAUNCH'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
npm start >/tmp/sales-claw.log 2>&1 &
LAUNCH
  chmod +x "$DIR/launch.sh"
  echo "       デスクトップに sales-claw.desktop を作成しました。"
fi

echo ""
echo "========================================="
echo " セットアップ完了！"
echo " デスクトップ起動: npm start"
echo " Webダッシュボード: npm run dashboard"
echo "========================================="
echo ""
