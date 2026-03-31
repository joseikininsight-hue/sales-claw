// Sales Claw — Electron メインプロセス
'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

let mainWindow = null;
let tray = null;
let serverStarted = false;
let dashboardRuntime = null;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

// ─── アイコン ────────────────────────────────────────────────
function getIcon(size = 'icon') {
  const candidates = [
    path.join(__dirname, 'assets', `${size}.png`),
    path.join(__dirname, 'assets', 'icon.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  // フォールバック: 16x16 の単色アイコンを生成
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAB3RJTUUH6AQRAyshSX0KUQAAAB' +
    'JJREFUGNNjYBgFgx8wEAIAAQABAAH/dswAAAAASUVORK5CYII='
  );
}

function getDashboardUrl() {
  return dashboardRuntime?.url || 'http://127.0.0.1:3765';
}

function getDashboardPortLabel() {
  return dashboardRuntime?.port || 3765;
}

// ─── ダッシュボードサーバー起動 ──────────────────────────────
async function startServer() {
  if (serverStarted && dashboardRuntime) return dashboardRuntime;
  try {
    const { startDashboardServer } = require('./src/dashboard-server.cjs');
    dashboardRuntime = await startDashboardServer();
    serverStarted = true;
    return dashboardRuntime;
  } catch (e) {
    console.error('[Electron] サーバー起動失敗:', e.message);
    throw e;
  }
}

function waitForServer(timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(getDashboardUrl(), () => resolve());
      req.on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('サーバー起動タイムアウト'));
        else setTimeout(check, 500);
      });
      req.end();
    };
    check();
  });
}

// ─── メインウィンドウ ─────────────────────────────────────────
function createWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Sales Claw',
    icon: getIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(getDashboardUrl());
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── システムトレイ ───────────────────────────────────────────
function createTray() {
  if (tray) return;
  tray = new Tray(getIcon('tray'));
  tray.setToolTip('Sales Claw');

  const updateMenu = () => Menu.buildFromTemplate([
    {
      label: 'ダッシュボードを開く',
      click: () => { createWindow(); mainWindow?.focus(); },
    },
    {
      label: 'ブラウザで開く',
      click: () => shell.openExternal(getDashboardUrl()),
    },
    { type: 'separator' },
    { label: `ポート: ${getDashboardPortLabel()}`, enabled: false },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);

  tray.setContextMenu(updateMenu());
  tray.on('click', () => { createWindow(); mainWindow?.focus(); });
  tray.on('double-click', () => { createWindow(); mainWindow?.focus(); });
}

// ─── 初回セットアップ ─────────────────────────────────────────
async function firstRunSetup() {
  const settingsPath = path.join(__dirname, 'data', 'settings.json');
  const samplePath   = path.join(__dirname, 'data', 'sample-settings.json');

  if (!fs.existsSync(settingsPath) && fs.existsSync(samplePath)) {
    fs.copyFileSync(samplePath, settingsPath);

    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'Sales Claw — 初回セットアップ',
      message: '初回起動を検出しました',
      detail:
        '設定ファイルを作成しました。\n\n' +
        'Playwright (ブラウザ自動化) のインストールが必要です。\n' +
        '「インストール」を押すとバックグラウンドでインストールします。\n\n' +
        '※ Claude Code CLI は別途インストールが必要です。\n' +
        '  詳細は「スキップ（後で）」後に Settings タブをご確認ください。',
      buttons: ['インストール', 'スキップ（後で）'],
      defaultId: 0,
    });

    if (choice.response === 0) {
      await installPlaywright();
    }
  }
}

function installPlaywright() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500,
      height: 200,
      title: 'Playwright インストール中...',
      resizable: false,
      webPreferences: { nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.loadURL('about:blank');
    win.webContents.executeJavaScript(`
      document.body.style.cssText = 'font-family:sans-serif;padding:30px;background:#1e1e2e;color:#cdd6f4';
      document.body.innerHTML = '<h3 style="margin:0 0 12px">Playwright (Chromium) をインストール中...</h3><p style="color:#a6adc8;margin:0">しばらくお待ちください。</p>';
    `);

    exec('npx playwright install chromium', { cwd: __dirname }, (err) => {
      win.close();
      if (err) {
        dialog.showMessageBox({
          type: 'warning',
          title: 'インストール警告',
          message: 'Playwright のインストールに失敗しました',
          detail: '後で手動でインストールしてください:\nnpx playwright install chromium',
        });
      }
      resolve();
    });
  });
}

// ─── アプリ起動 ───────────────────────────────────────────────
if (singleInstanceLock) {
  app.on('second-instance', () => {
    createWindow();
  });
}

app.whenReady().then(async () => {
  // macOS Dock 非表示（トレイアプリとして動作）
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox(
      'サーバー起動エラー',
      `ダッシュボードサーバーの起動に失敗しました。\n${e.message}`
    );
    app.quit();
    return;
  }

  try {
    await waitForServer();
  } catch (e) {
    dialog.showErrorBox(
      'サーバー起動エラー',
      'ダッシュボードサーバーの起動に失敗しました。\nNode.js がインストールされているか確認してください。'
    );
    app.quit();
    return;
  }

  await firstRunSetup();
  createTray();
  createWindow();

  // 起動から5秒後にアップデートチェック（初回ロードの邪魔をしない）
  setTimeout(() => checkForUpdates(), 5000);
});

// ─── 自動更新 ─────────────────────────────────────────────────
function checkForUpdates() {
  autoUpdater.checkForUpdates().catch(() => { /* オフライン時は無視 */ });
}

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: 'アップデート',
    message: `新しいバージョン ${info.version} が見つかりました`,
    detail: 'バックグラウンドでダウンロードします。完了後に通知します。',
    buttons: ['OK'],
  });
});

autoUpdater.on('update-downloaded', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: 'アップデート準備完了',
    message: `Sales Claw ${info.version} の準備ができました`,
    detail: '今すぐ再起動してインストールしますか？',
    buttons: ['今すぐ再起動', '後で'],
    defaultId: 0,
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', () => { /* サイレント失敗 */ });

// 全ウィンドウが閉じられてもアプリを終了しない（トレイに常駐）
app.on('window-all-closed', () => { /* tray に常駐 */ });

app.on('before-quit', () => {
  app.isQuiting = true;
  serverStarted = false;
});
