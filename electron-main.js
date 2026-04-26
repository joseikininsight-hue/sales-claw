// Sales Claw — Electron メインプロセス
'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 開発モードでは専用ディレクトリを使う（%APPDATA%\Electron を他アプリと共有しない）
if (!app.isPackaged) {
  app.setPath('userData', path.join(__dirname, '.electron-userdata'));
}

const runtimeUserDataDir = path.join(app.getPath('userData'), 'runtime');
if (!process.env.SALES_CLAW_USER_DATA_DIR) {
  process.env.SALES_CLAW_USER_DATA_DIR = runtimeUserDataDir;
}
if (process.platform === 'win32') {
  // Windows では GPU process が大きく張り付きやすく、全体のカクつきに繋がるため無効化する。
  app.disableHardwareAcceleration();
}

const settingsManager = require('./src/settings-manager.cjs');
const { resolveDataPath } = require('./src/data-paths.cjs');
const { readRuntime } = require('./src/dashboard-runtime.cjs');
const { FormSessionManager } = require('./src/form-session-manager.cjs');
const { cleanupStaleFiles } = require('./src/startup-cleanup.cjs');
const localToolchain = require('./src/local-toolchain.cjs');

let mainWindow = null;
let tray = null;
let serverStarted = false;
let dashboardRuntime = null;

const formSessionManager = new FormSessionManager(() => mainWindow);

const APP_VERSION = app.getVersion();
const BUILD_SOURCE = app.isPackaged ? 'installed' : 'development';
const PLACEHOLDER_UPDATE_OWNERS = new Set(['', 'local', 'local-test', 'your-org', 'your-username', 'example']);

function readAppUpdateConfig() {
  try {
    const configPath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(configPath)) return null;
    const parsed = {};
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.+)\s*$/);
      if (!match) continue;
      parsed[match[1]] = match[2].trim();
    }
    return parsed;
  } catch (_) {
    return null;
  }
}

function resolveAutoUpdateState() {
  if (!app.isPackaged) {
    return { enabled: false, reason: 'Development build: auto-update is disabled.' };
  }
  if (process.env.SALES_CLAW_DISABLE_AUTO_UPDATE === '1') {
    return { enabled: false, reason: 'Auto-update is disabled by environment configuration.' };
  }
  const config = readAppUpdateConfig();
  const owner = String(config && config.owner || '').trim();
  const repo = String(config && config.repo || '').trim();
  if (!config || !owner || !repo) {
    return { enabled: false, reason: 'Auto-update feed is not configured for this build.' };
  }
  if (PLACEHOLDER_UPDATE_OWNERS.has(owner) || (owner === 'local-test' && repo === 'sales-claw')) {
    return { enabled: false, reason: 'Auto-update is disabled for local verification builds.' };
  }
  return { enabled: true, reason: null };
}

const AUTO_UPDATE_STATE = resolveAutoUpdateState();
const AUTO_UPDATE_ENABLED = AUTO_UPDATE_STATE.enabled;

process.env.SALES_CLAW_APP_VERSION = APP_VERSION;
process.env.SALES_CLAW_BUILD_SOURCE = BUILD_SOURCE;
process.env.SALES_CLAW_AUTO_UPDATE_ENABLED = AUTO_UPDATE_ENABLED ? '1' : '0';

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
  if (process.resourcesPath && app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'assets', `${size}.png`),
      path.join(process.resourcesPath, 'assets', 'icon.png')
    );
  }
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
  return (dashboardRuntime || readRuntime())?.url || 'http://127.0.0.1:3765';
}

function getDashboardPortLabel() {
  return (dashboardRuntime || readRuntime())?.port || 3765;
}

// ─── ダッシュボードサーバー起動 ──────────────────────────────
//
// Dev source override:
//   SALES_CLAW_DEV_DASHBOARD_SRC を絶対パスで指定すると、bundled
//   resources/app/src/dashboard-server.cjs ではなく、その path 直下の
//   dashboard-server.cjs を require する。
//   これにより、インストール済み Electron を使ったまま `C:\bp-outreach\src`
//   の編集を反映できる (UI 修正のたびに再インストールが不要になる)。
//
// Hot reload:
//   SALES_CLAW_DEV_HOT_RELOAD=1 を指定すると、dashboard-server 側で
//   render 直前に ./ui/* の require cache を捨てて、ブラウザ再読み込み
//   ごとに最新の client-script を読む。
function resolveDashboardModule() {
  const devSrc = process.env.SALES_CLAW_DEV_DASHBOARD_SRC;
  if (devSrc) {
    try {
      const candidate = path.join(devSrc, 'dashboard-server.cjs');
      if (fs.existsSync(candidate)) {
        console.log('[Electron] dev override: loading dashboard from', candidate);
        // Force a fresh load (in case this is called twice)
        delete require.cache[require.resolve(candidate)];
        return require(candidate);
      }
      console.warn('[Electron] SALES_CLAW_DEV_DASHBOARD_SRC set but no dashboard-server.cjs at:', candidate);
    } catch (e) {
      console.warn('[Electron] dev override failed, falling back to bundled:', e.message);
    }
  }
  return require('./src/dashboard-server.cjs');
}

async function startServer() {
  if (serverStarted && dashboardRuntime) return dashboardRuntime;
  try {
    const { startDashboardServer } = resolveDashboardModule();
    dashboardRuntime = await startDashboardServer({ formSessionManager });
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
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(getDashboardUrl());
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('resize', () => formSessionManager.onWindowResize());

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
  const settingsPath = settingsManager.SETTINGS_FILE;
  const samplePath = settingsManager.SAMPLE_SETTINGS_FILE;

  if (!fs.existsSync(settingsPath) && fs.existsSync(samplePath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.copyFileSync(samplePath, settingsPath);

    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'Sales Claw — 初回セットアップ',
      message: '初回起動を検出しました',
      detail:
        '設定ファイルを作成しました。\n\n' +
        'Sales Claw 内蔵セットアップで Playwright (Chromium) と Claude Code CLI の準備を試行できます。\n' +
        'PC 側に Node.js / npm / Playwright が入っていなくても、アプリ管理下に順番に配置します。\n\n' +
        '後からダッシュボードの「AI CLI を準備」ボタンでも実行できます。',
      buttons: ['インストール', 'スキップ（後で）'],
      defaultId: 0,
    });

    if (choice.response === 0) {
      await installPlaywright();
      await installClaudeCli();
    }
  }
}

function runInstaller(task, title, message, failureTitle, failureDetail) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 220,
      title,
      resizable: false,
      webPreferences: { nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.loadURL('about:blank');
    win.webContents.executeJavaScript(`
      document.body.style.cssText = 'font-family:sans-serif;padding:30px;background:#1e1e2e;color:#cdd6f4';
      document.body.innerHTML = '<h3 style="margin:0 0 12px">${message}</h3><p style="color:#a6adc8;margin:0">しばらくお待ちください。</p>';
    `);

    Promise.resolve()
      .then(task)
      .then((result) => {
        if (result && result.ok === false) {
          throw new Error(result.error || result.cli?.error || result.playwright?.error || 'セットアップに失敗しました。');
        }
        win.close();
        resolve(true);
      })
      .catch((err) => {
        win.close();
        dialog.showMessageBox({
          type: 'warning',
          title: failureTitle,
          message: `${title} に失敗しました`,
          detail: `${failureDetail}\n\n${err && err.message ? err.message : String(err || '')}`.trim(),
        });
        resolve(false);
      });
  });
}

function installPlaywright() {
  return runInstaller(
    () => localToolchain.installPlaywrightChromium(),
    'Playwright インストール中...',
    'Playwright (Chromium) をインストール中...',
    'インストール警告',
    '後でダッシュボードの「AI CLI を準備」ボタンから再試行してください。'
  );
}

function installClaudeCli() {
  return runInstaller(
    () => localToolchain.installProviderCli('claude'),
    'Claude CLI インストール中...',
    'Claude Code CLI をインストール中...',
    'インストール警告',
    '後でダッシュボードの「AI CLI を準備」ボタンから再試行してください。'
  );
}

// ─── アプリ起動 ───────────────────────────────────────────────
if (singleInstanceLock) {
  app.on('second-instance', () => {
    createWindow();
  });
}

app.whenReady().then(async () => {
  try {
    const cleanup = cleanupStaleFiles();
    if (cleanup.removed.length > 0) {
      console.log(`[startup-cleanup] removed ${cleanup.removed.length} stale files`);
    }
    if (cleanup.errors.length > 0) {
      console.warn(`[startup-cleanup] ${cleanup.errors.length} errors during cleanup`);
    }
  } catch (e) {
    console.warn('[startup-cleanup] unexpected error:', e.message);
  }

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

  if (AUTO_UPDATE_ENABLED) {
    // 起動から5秒後にアップデートチェック（初回ロードの邪魔をしない）
    setTimeout(() => checkForUpdates(), 5000);

    // ダッシュボードの「今すぐ再起動」ボタンからの install-update フラグ監視
    const installFlagFile = resolveDataPath('install-update.flag');
    setInterval(() => {
      try {
        if (fs.existsSync(installFlagFile)) {
          fs.unlinkSync(installFlagFile);
          autoUpdater.quitAndInstall();
        }
      } catch (e) { /* ignore */ }
    }, 2000);
  } else {
    writeUpdateStatus({
      state: BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
      version: APP_VERSION,
      message: AUTO_UPDATE_STATE.reason || (BUILD_SOURCE === 'development'
        ? 'Development build: auto-update is disabled.'
        : 'Auto-update is disabled.'),
    });
  }
});

// ─── 自動更新 ─────────────────────────────────────────────────
const UPDATE_STATUS_FILE = resolveDataPath('update-status.json');

function ensureUpdateDir() {
  const dir = path.dirname(UPDATE_STATUS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeUpdateStatus(status) {
  try {
    ensureUpdateDir();
    fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({
      appVersion: APP_VERSION,
      buildSource: BUILD_SOURCE,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED,
      ...status,
      ts: Date.now(),
    }));
  } catch (e) { /* ignore */ }
}

function checkForUpdates() {
  if (!AUTO_UPDATE_ENABLED) {
    writeUpdateStatus({
      state: BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
      version: APP_VERSION,
      message: AUTO_UPDATE_STATE.reason || (BUILD_SOURCE === 'development'
        ? 'Development build: auto-update is disabled.'
        : 'Auto-update is disabled.'),
    });
    return;
  }
  writeUpdateStatus({ state: 'checking' });
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[AutoUpdater] checkForUpdates error:', err?.message || err);
    writeUpdateStatus({ state: 'error', message: err?.message || String(err) });
  });
}

autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] checking for update...');
  writeUpdateStatus({ state: 'checking' });
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[AutoUpdater] already up to date:', info?.version);
  writeUpdateStatus({ state: 'up-to-date', version: info?.version });
});

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] update available:', info.version);
  writeUpdateStatus({ state: 'available', version: info.version });
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Sales Claw アップデート',
    message: `新しいバージョン ${info.version} が見つかりました`,
    detail: 'バックグラウンドでダウンロードします。完了後に通知します。',
    buttons: ['OK'],
  }).catch(() => {
    // mainWindow が null の場合は parent なしで再試行
    dialog.showMessageBox({
      type: 'info',
      title: 'Sales Claw アップデート',
      message: `新しいバージョン ${info.version} が見つかりました`,
      detail: 'バックグラウンドでダウンロードします。',
      buttons: ['OK'],
    });
  });
});

autoUpdater.on('download-progress', (progress) => {
  writeUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent), version: progress.version || '' });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] update downloaded:', info.version);
  writeUpdateStatus({ state: 'downloaded', version: info.version });
  const win = mainWindow || null;
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'アップデート準備完了',
    message: `Sales Claw ${info.version} の準備ができました`,
    detail: '今すぐ再起動してインストールしますか？',
    buttons: ['今すぐ再起動', '後で'],
    defaultId: 0,
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  }).catch(() => {
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
});

autoUpdater.on('error', (err) => {
  console.error('[AutoUpdater] error:', err?.message || err);
  writeUpdateStatus({ state: 'error', message: err?.message || String(err) });
});

// 全ウィンドウが閉じられてもアプリを終了しない（トレイに常駐）
app.on('window-all-closed', () => { /* tray に常駐 */ });
app.on('activate', () => { createWindow(); });

app.on('before-quit', () => {
  app.isQuiting = true;
  serverStarted = false;
});
