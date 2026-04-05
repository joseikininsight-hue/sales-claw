// Sales Claw Dashboard Server
// fs.watch でファイル変更をイベント検知 → SSE → フロントで差分DOM更新

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const XLSX = require('xlsx');
const { getAllLogs, logAction, removeCompanyLogs } = require('./action-logger.cjs');
const { getAllHistorySummary, getHistory, removeHistory } = require('./contact-history.cjs');
const { readRuntime, toClientHost, writeRuntime, clearRuntime } = require('./dashboard-runtime.cjs');
const settings = require('./settings-manager.cjs');
const { getTranslations, t: i18nT } = require('./i18n.cjs');
const { ensureDataDir, resolveDataPath } = require('./data-paths.cjs');
const {
  getExpectedApprovalArtifacts,
  assertApprovalArtifacts,
  buildApprovalLogDetails,
  findScreenshotPath,
  getScreenshotSearchDirs,
} = require('./approval-artifacts.cjs');
const { findAvailablePort } = require('./port-utils.cjs');
const { appendCompany, deleteCompany, findCompaniesByNos, getTargetPreview, importTargetList, readTargetList, updateCompany } = require('./target-list.cjs');
const { getTargetMap, setTargets } = require('./outreach-targets.cjs');
const { finishLiveMonitor, getLiveMonitorFile, getLiveMonitorSummary, readMonitorState, removeCompanyMonitor, updateLiveMonitor } = require('./live-monitor.cjs');
const { buildWorkbookBuffer: buildSettingsWorkbookBuffer, parseWorkbookBuffer: parseSettingsWorkbookBuffer } = require('./settings-excel.cjs');
const {
  buildLaunchArgs,
  buildHeadlessArgs,
  buildManagedSpawnSpec,
  getExecutableFallbackCandidates,
  getInstallCommand,
  getInstallSpawnArgs,
  getProvider,
  hasAnyAuthFile,
  listProviders,
  normalizeProviderId,
} = require('./ai-providers.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const AI_STATUS_CACHE_TTL_MS = 15000;

// SSE クライアント管理
const sseClients = new Set();
const activeWatchers = new Map();
let heartbeatTimer = null;
let dashboardRuntime = null;
let serverStartPromise = null;
let _aiStatusCache = null;
let _aiStatusCacheTime = 0;
let _aiStatusCacheProvider = null;
let _aiExecutablePath = {};
let dashboardSessionToken = null;
let dashboardDataCacheKey = null;
let dashboardDataCacheValue = null;
let dashboardDataCacheBuiltAt = 0;
let standaloneDashboardLockHeld = false;

// Managed AI PTY process
let claudePty = null;
let claudeProcessMode = 'default';
let claudeProcess = null;
let headlessAiRun = null;
let activeAiProvider = normalizeProviderId(typeof settings.getAiProvider === 'function' ? settings.getAiProvider() : 'claude');
const aiInstallState = Object.fromEntries(listProviders().map((provider) => [provider.id, 'idle']));
const aiInstallError = Object.fromEntries(listProviders().map((provider) => [provider.id, null]));

// WebSocket server for PTY I/O
const wss = new WebSocket.Server({ noServer: true });
const ptyWsClients = new Set();

wss.on('connection', (ws) => {
  ptyWsClients.add(ws);
  ws.send(JSON.stringify({
    type: 'connected',
    running: !!claudePty,
    mode: claudeProcessMode,
    provider: activeAiProvider,
  }));
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'input' && claudePty) {
        claudePty.write(data.data);
      } else if (data.type === 'resize' && claudePty) {
        claudePty.resize(Math.max(2, data.cols), Math.max(1, data.rows));
      }
    } catch (_) {
      if (claudePty) claudePty.write(msg.toString());
    }
  });
  ws.on('close', () => ptyWsClients.delete(ws));
  ws.on('error', () => ptyWsClients.delete(ws));
});

function broadcastPty(payload) {
  const msg = JSON.stringify(payload);
  ptyWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

const APP_VERSION = process.env.SALES_CLAW_APP_VERSION || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return '?'; }
})();
const APP_BUILD_SOURCE = process.env.SALES_CLAW_BUILD_SOURCE
  || (process.versions.electron ? 'installed' : 'dashboard-only');
const AUTO_UPDATE_ENABLED = process.env.SALES_CLAW_AUTO_UPDATE_ENABLED === '1';

function getSettingsFiles() {
  const bootstrap = settings.SETTINGS_FILE;
  const active = typeof settings.getActiveSettingsFile === 'function'
    ? settings.getActiveSettingsFile()
    : bootstrap;
  return Array.from(new Set([bootstrap, active].filter(Boolean).map((entry) => path.resolve(entry))));
}

function getDashboardLockFile() {
  return resolveDataPath('dashboard-server.lock');
}

function readJsonFileSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readDashboardLock() {
  const lockFile = getDashboardLockFile();
  if (!fs.existsSync(lockFile)) return null;
  return readJsonFileSafe(lockFile, null);
}

function isProcessAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isFinite(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function writeDashboardLock(payload) {
  ensureDataDir();
  fs.writeFileSync(getDashboardLockFile(), JSON.stringify(payload, null, 2), 'utf8');
}

function releaseStandaloneDashboardLock() {
  if (!standaloneDashboardLockHeld) return;
  try {
    const current = readDashboardLock();
    if (current && Number(current.pid) !== process.pid) {
      standaloneDashboardLockHeld = false;
      return;
    }
    const lockFile = getDashboardLockFile();
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {
    // noop
  }
  standaloneDashboardLockHeld = false;
}

function canReachRuntimeUrl(runtimeUrl, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!runtimeUrl) {
      resolve(false);
      return;
    }
    const req = http.get(runtimeUrl, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function claimStandaloneDashboardLock() {
  const existing = readDashboardLock();
  if (existing && Number(existing.pid) !== process.pid && isProcessAlive(existing.pid)) {
    const runtime = readRuntime();
    if (runtime && await canReachRuntimeUrl(runtime.url)) {
      return { ok: false, runtime, pid: existing.pid };
    }
  }
  writeDashboardLock({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: PROJECT_ROOT,
  });
  standaloneDashboardLockHeld = true;
  return { ok: true };
}

function getPathFingerprint(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return `${targetPath || ''}:missing`;
    const stat = fs.statSync(targetPath);
    return `${path.resolve(targetPath)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch (_) {
    return `${targetPath || ''}:error`;
  }
}

function getDashboardDataCacheKey() {
  const targetPath = settings.getTargetListPath();
  const settingsFingerprints = getSettingsFiles().map(getPathFingerprint).join('|');
  const sourceFingerprints = [
    getPathFingerprint(getLogFile()),
    getPathFingerprint(getContactHistoryFile()),
    getPathFingerprint(getOutreachTargetsFile()),
    getPathFingerprint(getLiveMonitorFile()),
    getPathFingerprint(targetPath),
    getPathFingerprint(settings.getScreenshotDir()),
  ].join('|');
  const preferenceFingerprint = JSON.stringify({
    excludes: settings.getExcludeStatuses(),
    host: settings.getHost(),
    port: settings.getPort(),
    targetPath,
    screenshotDir: settings.getScreenshotDir(),
  });
  return `${settingsFingerprints}||${sourceFingerprints}||${preferenceFingerprint}`;
}

function invalidateDashboardDataCache() {
  dashboardDataCacheKey = null;
  dashboardDataCacheValue = null;
  dashboardDataCacheBuiltAt = 0;
}

function getLogFile() {
  return resolveDataPath('action-log.json');
}

function getContactHistoryFile() {
  return resolveDataPath('contact-history.json');
}

function getOutreachTargetsFile() {
  return resolveDataPath('outreach-targets.json');
}

function getSelectedAiProvider() {
  try {
    return normalizeProviderId(typeof settings.getAiProvider === 'function' ? settings.getAiProvider() : 'claude');
  } catch (_) {
    return normalizeProviderId(activeAiProvider || 'claude');
  }
}

function getManagedAiProvider() {
  return normalizeProviderId(activeAiProvider || getSelectedAiProvider());
}

function getProviderDisplayName(providerId) {
  return getProvider(providerId).displayName;
}

function getProviderModeLabel(providerId, mode, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  const currentMode = String(mode || '').trim();
  const isJa = lang === 'ja';
  const byProvider = {
    claude: {
      default: isJa ? '標準モード' : 'Default',
      acceptEdits: isJa ? '編集支援' : 'Assist edits',
      auto: isJa ? '完全自動' : 'Auto',
      bypassPermissions: isJa ? '権限スキップ' : 'Bypass permissions',
    },
    codex: {
      default: isJa ? 'on-request' : 'On-request',
      acceptEdits: isJa ? 'on-request（手動監視）' : 'On-request (manual)',
      auto: isJa ? 'full-auto' : 'Full-auto',
      bypassPermissions: isJa ? 'danger bypass' : 'Danger bypass',
      'danger-full-access': isJa ? 'danger bypass' : 'Danger bypass',
    },
    gemini: {
      default: isJa ? 'default approvals' : 'Default approvals',
      acceptEdits: isJa ? 'auto_edit（手動監視）' : 'auto_edit (manual)',
      auto: 'auto_edit',
      auto_edit: 'auto_edit',
      bypassPermissions: 'yolo',
      yolo: 'yolo',
      'headless-yolo': 'yolo',
    },
  };
  const labels = byProvider[provider] || byProvider.claude;
  return labels[currentMode] || currentMode || (isJa ? '未設定' : 'Unknown');
}

function getProviderRecommendedModesText(providerId, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  if (provider === 'codex') {
    return lang === 'ja'
      ? 'full-auto（auto）または danger bypass（bypassPermissions）'
      : 'full-auto (auto) or danger bypass (bypassPermissions)';
  }
  if (provider === 'gemini') {
    return lang === 'ja'
      ? 'auto_edit（auto）または yolo（bypassPermissions）'
      : 'auto_edit (auto) or yolo (bypassPermissions)';
  }
  return lang === 'ja'
    ? 'auto または bypassPermissions'
    : 'auto or bypassPermissions';
}

function isHeadlessAutomationProvider(providerId) {
  return ['codex', 'gemini'].includes(normalizeProviderId(providerId));
}

function getAutomationModeForProvider(providerId) {
  if (claudePty && getManagedAiProvider() === normalizeProviderId(providerId) && claudeProcessMode) {
    return claudeProcessMode;
  }
  return getProvider(providerId).defaultMode || 'auto';
}

function getActiveHeadlessRun(providerId = null) {
  if (!headlessAiRun) return null;
  if (!providerId) return headlessAiRun;
  return normalizeProviderId(providerId) === headlessAiRun.provider ? headlessAiRun : null;
}

function getConfiguredAiModel(providerId = getSelectedAiProvider()) {
  try {
    if (typeof settings.getAiModel === 'function') {
      return settings.getAiModel(providerId) || '';
    }
    const prefs = settings.getSection('preferences') || {};
    const models = prefs.aiModels && typeof prefs.aiModels === 'object' ? prefs.aiModels : {};
    const configured = typeof models[providerId] === 'string' ? models[providerId].trim() : '';
    if (configured) return configured;
    if (providerId === 'claude') {
      return typeof prefs.claudeModel === 'string' ? prefs.claudeModel.trim() : '';
    }
    return '';
  } catch (_) {
    return '';
  }
}

function getProviderInstallState(providerId) {
  const key = normalizeProviderId(providerId);
  return aiInstallState[key] || 'idle';
}

function getProviderInstallError(providerId) {
  const key = normalizeProviderId(providerId);
  return aiInstallError[key] || null;
}

function setProviderInstallState(providerId, state, error = null) {
  const key = normalizeProviderId(providerId);
  aiInstallState[key] = state;
  aiInstallError[key] = error;
}

function invalidateAiStatusCache(providerId = null) {
  if (!providerId || _aiStatusCacheProvider === normalizeProviderId(providerId)) {
    _aiStatusCache = null;
    _aiStatusCacheTime = 0;
    _aiStatusCacheProvider = null;
  }
}

function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function getCodexTrustProjectKeys(projectRoot = PROJECT_ROOT) {
  const resolved = path.resolve(projectRoot);
  const keys = [resolved];
  if (process.platform === 'win32' && !resolved.startsWith('\\\\?\\')) {
    keys.unshift(`\\\\?\\${resolved}`);
  }
  return Array.from(new Set(keys));
}

function ensureCodexWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const configPath = getCodexConfigPath();
  const trustKeys = getCodexTrustProjectKeys(projectRoot);
  let content = '';
  try {
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf8');
    } else {
      ensureParentDir(configPath);
    }
  } catch (_) {
    return false;
  }

  if (trustKeys.some((key) => content.includes(`[projects.'${key.replace(/'/g, "''")}']`))) {
    return false;
  }

  const preferredKey = trustKeys[0];
  const section = [
    '',
    `[projects.'${preferredKey.replace(/'/g, "''")}']`,
    'trust_level = "trusted"',
    '',
  ].join('\n');

  fs.writeFileSync(configPath, `${content.replace(/\s*$/, '')}${section}`, 'utf8');
  return true;
}

function buildCliCommandSpec(executable, args = []) {
  const exePath = String(executable || '').trim();
  const extension = path.extname(exePath).toLowerCase();
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.ps1')) {
    const escapedArgs = (args || []).map((arg) => {
      const text = String(arg || '');
      return `'${text.replace(/'/g, "''")}'`;
    });
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-Command', ['&', `'${exePath.replace(/'/g, "''")}'`, ...escapedArgs].join(' ')],
    };
  }
  return { command: exePath, args: args || [] };
}

async function runProviderCliCommand(providerId, args = [], options = {}) {
  const provider = getProvider(providerId);
  const executable = await resolveClaudeExecutable(provider.id);
  if (process.platform === 'win32' && executable === provider.id) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `${provider.cliLabel} executable was not found.`,
    };
  }

  const { spawnSync } = require('child_process');
  const spec = buildCliCommandSpec(executable, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 15000,
  });

  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
    error: result.error || null,
  };
}

async function ensureProviderPlaywrightMcp(providerId) {
  const normalized = normalizeProviderId(providerId);
  if (!['codex', 'gemini'].includes(normalized)) {
    return { ok: true, required: false };
  }

  const check = await runProviderCliCommand(normalized, ['mcp', 'list'], { timeout: 20000 });
  const combined = `${check.stdout}\n${check.stderr}`;
  if (check.ok && /playwright/i.test(combined)) {
    return { ok: true, required: true, configured: true };
  }

  const addArgs = normalized === 'codex'
    ? ['mcp', 'add', 'playwright', '--', 'npm', 'exec', '@playwright/mcp', '--browser', 'chrome']
    : ['mcp', 'add', 'playwright', 'npm', 'exec', '@playwright/mcp', '--browser', 'chrome'];
  const add = await runProviderCliCommand(normalized, addArgs, { timeout: 30000 });
  if (!add.ok) {
    const message = `${getProviderDisplayName(normalized)} で MCP Playwright の設定に失敗しました。${String(add.stderr || add.stdout || '').trim()}`;
    return { ok: false, required: true, configured: false, error: message };
  }

  const verify = await runProviderCliCommand(normalized, ['mcp', 'list'], { timeout: 20000 });
  const verifyOutput = `${verify.stdout}\n${verify.stderr}`;
  if (verify.ok && /playwright/i.test(verifyOutput)) {
    return { ok: true, required: true, configured: true, added: true };
  }

  return {
    ok: false,
    required: true,
    configured: false,
    error: `${getProviderDisplayName(normalized)} で MCP Playwright の設定確認に失敗しました。`,
  };
}

function getAssetCandidates(filename) {
  const safeName = path.basename(filename || '');
  const candidates = [
    path.join(__dirname, '..', 'assets', safeName),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'assets', safeName));
  }
  return Array.from(new Set(candidates.map((entry) => path.resolve(entry))));
}

function ensureDashboardSessionToken() {
  if (!dashboardSessionToken) {
    dashboardSessionToken = crypto.randomBytes(24).toString('hex');
  }
  return dashboardSessionToken;
}

const DASHBOARD_SESSION_COOKIE = 'sales_claw_session';

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getDashboardOrigin() {
  const runtime = dashboardRuntime || readRuntime();
  if (runtime && runtime.url) return runtime.url;
  return `http://${settings.getHost()}:${settings.getPort()}`;
}

function normalizeOriginForComparison(originValue) {
  if (!originValue) return null;
  try {
    const parsed = new URL(originValue);
    let hostname = String(parsed.hostname || '').toLowerCase();
    if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
      hostname = 'localhost';
    }
    const protocol = String(parsed.protocol || 'http:').toLowerCase();
    const port = parsed.port || (protocol === 'https:' ? '443' : '80');
    return `${protocol}//${hostname}:${port}`;
  } catch (_) {
    return null;
  }
}

function getRequestHostOrigin(req) {
  const hostHeader = Array.isArray(req.headers.host) ? (req.headers.host[0] || '') : (req.headers.host || '');
  if (!hostHeader) return null;
  const protoHeader = Array.isArray(req.headers['x-forwarded-proto'])
    ? (req.headers['x-forwarded-proto'][0] || '')
    : (req.headers['x-forwarded-proto'] || '');
  const protocol = String(protoHeader || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  return normalizeOriginForComparison(`${protocol}://${hostHeader}`);
}

function getAllowedOriginsForRequest(req) {
  const origins = new Set();
  const runtimeOrigin = normalizeOriginForComparison(getDashboardOrigin());
  const requestOrigin = getRequestHostOrigin(req);
  if (runtimeOrigin) origins.add(runtimeOrigin);
  if (requestOrigin) origins.add(requestOrigin);
  return origins;
}

function parseRequestCookies(req) {
  const raw = Array.isArray(req.headers.cookie) ? req.headers.cookie.join(';') : (req.headers.cookie || '');
  return raw.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index <= 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
}

function buildDashboardSessionCookie() {
  return `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(ensureDashboardSessionToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 60 * 60}`;
}

function isAllowedOrigin(req) {
  const allowedOrigins = getAllowedOriginsForRequest(req);
  const originHeader = req.headers.origin;
  if (originHeader) {
    const normalizedOrigin = normalizeOriginForComparison(Array.isArray(originHeader) ? originHeader[0] : originHeader);
    return !!(normalizedOrigin && allowedOrigins.has(normalizedOrigin));
  }

  const refererHeader = Array.isArray(req.headers.referer) ? (req.headers.referer[0] || '') : (req.headers.referer || '');
  if (refererHeader) {
    const normalizedRefererOrigin = normalizeOriginForComparison(refererHeader);
    if (normalizedRefererOrigin && allowedOrigins.has(normalizedRefererOrigin)) {
      return true;
    }
  }

  const secFetchSite = Array.isArray(req.headers['sec-fetch-site'])
    ? (req.headers['sec-fetch-site'][0] || '')
    : (req.headers['sec-fetch-site'] || '');
  if (secFetchSite) {
    const normalized = String(secFetchSite).toLowerCase();
    return normalized === 'same-origin' || normalized === 'same-site' || normalized === 'none';
  }

  return false;
}

function getRequestSessionToken(req) {
  try {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const queryToken = requestUrl.searchParams.get('session');
    if (queryToken) return queryToken;
  } catch (_) {
  }

  const headerToken = req.headers['x-sales-claw-session'];
  if (Array.isArray(headerToken) ? (headerToken[0] || '') : (headerToken || '')) {
    return Array.isArray(headerToken) ? (headerToken[0] || '') : (headerToken || '');
  }

  const cookies = parseRequestCookies(req);
  return cookies[DASHBOARD_SESSION_COOKIE] || '';
}

function isAuthorizedDashboardRequest(req) {
  if (!isAllowedOrigin(req)) {
    return { ok: false, statusCode: 403, error: 'Blocked cross-origin dashboard request.' };
  }

  const providedToken = getRequestSessionToken(req);
  const expectedToken = ensureDashboardSessionToken();
  if (!providedToken || providedToken !== expectedToken) {
    return { ok: false, statusCode: 401, error: 'Missing or invalid dashboard session token.' };
  }

  return { ok: true };
}

function rejectUpgradeRequest(socket, statusCode, message) {
  if (!socket || socket.destroyed) return;
  const statusText = statusCode === 403 ? 'Forbidden' : 'Unauthorized';
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

function getBuildSourceMeta(lang) {
  const isJa = lang === 'ja';
  const map = {
    installed: {
      label: 'INSTALLED',
      title: isJa ? 'インストール済みアプリ' : 'Installed app',
      bg: 'var(--success-container)',
      fg: 'var(--success)',
    },
    development: {
      label: 'DEV',
      title: isJa ? '開発版（自動更新は無効）' : 'Development build (auto-update disabled)',
      bg: 'var(--warning-container)',
      fg: 'var(--warning)',
    },
    'dashboard-only': {
      label: 'DASHBOARD',
      title: isJa ? 'ダッシュボード単体起動（自動更新なし）' : 'Dashboard-only mode (no auto-update)',
      bg: 'var(--surface-high)',
      fg: 'var(--on-surface-variant)',
    },
  };
  return map[APP_BUILD_SOURCE] || {
    label: 'UNKNOWN',
    title: isJa ? '実行元不明' : 'Unknown build source',
    bg: 'var(--surface-high)',
    fg: 'var(--on-surface-variant)',
  };
}

function notifyClients(payload) {
  const body = payload || { type: 'update', time: Date.now() };
  sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
  });
}

let debounceTimer = null;
function queueClientRefresh(reason, filePath) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    invalidateDashboardDataCache();
    refreshWatchTargets();
    if (filePath) {
      console.log(`[${new Date().toLocaleTimeString('ja-JP')}] 変更検知: ${path.basename(filePath)}`);
    }
    notifyClients({ type: 'update', reason, time: Date.now() });
  }, 250);
}

function closeWatchers() {
  activeWatchers.forEach(({ watcher }) => watcher.close());
  activeWatchers.clear();
}

function appendDiagnosticEvent(type, payload = {}) {
  try {
    ensureDataDir();
    const filePath = resolveDataPath('dashboard-diagnostics.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload,
    });
    fs.appendFileSync(filePath, entry + '\n', 'utf8');
  } catch (_) {}
}

function watchTarget(targetPath, mode) {
  if (!targetPath) return;

  const resolvedPath = path.resolve(targetPath);
  const effectiveMode = mode || (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory() ? 'dir' : 'file');
  const watchedPath = effectiveMode === 'dir'
    ? resolvedPath
    : (fs.existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath));
  const key = `${effectiveMode}:${resolvedPath}`;
  if (activeWatchers.has(key)) return;

  try {
    if (effectiveMode === 'dir' && !fs.existsSync(watchedPath)) {
      fs.mkdirSync(watchedPath, { recursive: true });
    }

    const watcher = fs.watch(watchedPath, (_, changedName) => {
      if (effectiveMode === 'file' && watchedPath !== resolvedPath && changedName) {
        if (String(changedName) !== path.basename(resolvedPath)) return;
      }
      queueClientRefresh(effectiveMode === 'dir' ? 'directory-change' : 'file-change', resolvedPath);
    });

    activeWatchers.set(key, { watcher, watchedPath });
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watching')}: ${path.basename(resolvedPath)}`);
  } catch (e) {
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watchFailed')}: ${path.basename(resolvedPath)} (${e.message})`);
  }
}

function refreshWatchTargets() {
  const desired = new Map();
  const screenshotDir = settings.getScreenshotDir();
  const targetPath = settings.getTargetListPath();
  const settingsPaths = getSettingsFiles();

  [
    { path: getLogFile(), mode: 'file' },
    { path: getContactHistoryFile(), mode: 'file' },
    { path: getOutreachTargetsFile(), mode: 'file' },
    { path: getLiveMonitorFile(), mode: 'file' },
    { path: screenshotDir, mode: 'dir' },
    ...settingsPaths.map((settingsPath) => ({ path: settingsPath, mode: 'file' })),
    ...(targetPath ? [{ path: targetPath, mode: 'file' }] : []),
  ].forEach((entry) => {
    if (!entry.path) return;
    desired.set(`${entry.mode}:${path.resolve(entry.path)}`, entry);
  });

  activeWatchers.forEach((value, key) => {
    if (!desired.has(key)) {
      value.watcher.close();
      activeWatchers.delete(key);
    }
  });

  desired.forEach((entry) => watchTarget(entry.path, entry.mode));
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    sseClients.forEach((res) => res.write(': heartbeat\n\n'));
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function getLatestLog(logs, action) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i].action === action) return logs[i];
  }
  return null;
}

function stringifyLogDetails(details) {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details.trim();
  if (typeof details === 'object') {
    const candidates = ['message', 'body', 'detail', 'text', 'content'];
    for (const key of candidates) {
      const value = typeof details[key] === 'string' ? details[key].trim() : '';
      if (value) return value;
    }
    try {
      return JSON.stringify(details);
    } catch (_) {
      return String(details);
    }
  }
  return String(details).trim();
}

function isUsefulDraftMessage(text) {
  const normalized = stringifyLogDetails(text);
  if (!normalized) return false;
  if (normalized.length < 40) return false;
  if (/^メッセージ生成完了$/i.test(normalized)) return false;
  if (/^message draft ready$/i.test(normalized)) return false;
  if (/^(入力完了|全フィールド入力完了)/.test(normalized)) return false;
  return true;
}

function getDisplayDraftMessage(logs, contactHist) {
  const draftLogs = (logs || []).filter((log) => log.action === 'message_draft');
  for (let i = draftLogs.length - 1; i >= 0; i -= 1) {
    const draftText = stringifyLogDetails(draftLogs[i].details);
    if (isUsefulDraftMessage(draftText)) return draftText;
  }

  if (contactHist && Array.isArray(contactHist.contacts) && contactHist.contacts.length > 0) {
    const latest = contactHist.contacts[contactHist.contacts.length - 1];
    const historyMessage = latest && typeof latest.message === 'string' ? latest.message.trim() : '';
    if (historyMessage) return historyMessage;
  }

  return null;
}

function truncateUiText(value, maxLength = 120) {
  const text = stringifyLogDetails(value);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getLatestLogDetail(logs, action) {
  const entry = getLatestLog(logs || [], action);
  return entry ? stringifyLogDetails(entry.details) : '';
}

function getCompanyProgressSearchTokens(company) {
  const tokens = [
    company.lastAction || '',
    company.progress || '',
    company.type || '',
    company.name || '',
    company.formUrl || '',
    company.url || '',
    company.sentMessage || '',
    company.manualReviewReason || '',
    company.lastErrorDetail || '',
    company.lastActionDetail || '',
  ];
  return tokens
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function buildOperationalIssues(targetData, runtime) {
  const lang = settings.getSection('preferences').language || 'ja';
  const issues = [];
  const sender = settings.getSender();

  if (!settings.isConfigured()) {
    issues.push(lang === 'ja'
      ? '自社情報が未設定です。Settings で会社情報を入力してください。'
      : 'Company profile is incomplete. Open Settings and fill in your sender information.');
  }

  if (sender.email && /example\.com|demo/i.test(sender.email)) {
    issues.push(lang === 'ja'
      ? 'サンプル設定が読み込まれています。公開利用前に Settings で自社情報へ置き換えてください。'
      : 'Sample settings are active. Replace them with your real company information before production use.');
  }

  if (!targetData.ok) {
    issues.push(lang === 'ja'
      ? `ターゲットリスト未準備: ${targetData.error}`
      : `Target list is not ready: ${targetData.error}`);
  }

  if (runtime && runtime.preferredPort && runtime.port !== runtime.preferredPort) {
    issues.push(lang === 'ja'
      ? `設定ポート ${runtime.preferredPort} は使用中のため、現在は ${runtime.port} 番で起動しています。`
      : `Preferred port ${runtime.preferredPort} was busy, so the dashboard is currently running on port ${runtime.port}.`);
  }

  return issues;
}

function getUiLang() {
  try {
    return settings.getSection('preferences').language || 'ja';
  } catch (_) {
    return 'ja';
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function waitForManagedPtyExit(targetPty, timeoutMs = 7000) {
  return new Promise((resolve) => {
    if (!targetPty || claudePty !== targetPty) {
      resolve(true);
      return;
    }

    const start = Date.now();
    const timer = setInterval(() => {
      if (claudePty !== targetPty) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);

    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function forceKillManagedPty(targetPty) {
  if (!targetPty) return false;

  if (process.platform === 'win32' && Number.isFinite(targetPty.pid) && targetPty.pid > 0) {
    const result = await execCommand(`taskkill /PID ${targetPty.pid} /T /F`, { timeout: 5000 });
    return !result.error;
  }

  try {
    targetPty.kill();
    return true;
  } catch (_) {
    return false;
  }
}

async function stopManagedClaudePty() {
  const targetPty = claudePty;
  if (!targetPty) {
    return { ok: true, stopped: false, method: 'noop' };
  }

  const providerId = getManagedAiProvider();
  const gracefulInput = providerId === 'claude' ? 'exit\r' : '\u0003';
  const gracefulTimeoutMs = providerId === 'claude' ? 7000 : 2000;
  const forcedTimeoutMs = providerId === 'claude' ? 4000 : 2000;

  try {
    targetPty.write(gracefulInput);
  } catch (_) {}

  if (await waitForManagedPtyExit(targetPty, gracefulTimeoutMs)) {
    return {
      ok: true,
      stopped: true,
      method: providerId === 'claude' ? 'exit' : 'interrupt',
    };
  }

  const forced = await forceKillManagedPty(targetPty);
  if (await waitForManagedPtyExit(targetPty, forcedTimeoutMs)) {
    return { ok: true, stopped: true, method: process.platform === 'win32' ? 'taskkill' : 'kill', forced };
  }

  return {
    ok: false,
    stopped: false,
    method: process.platform === 'win32' ? 'taskkill' : 'kill',
    forced,
    error: 'Managed AI process did not exit in time.',
  };
}

function getHeadlessRunStatus(providerId = getSelectedAiProvider()) {
  const run = getActiveHeadlessRun(providerId);
  if (!run) return null;
  return {
    provider: run.provider,
    providerLabel: getProviderDisplayName(run.provider),
    running: true,
    managed: false,
    headless: true,
    mode: run.mode,
    promptFile: run.promptFile,
    runLogFile: run.logFile,
    startedAt: run.startedAt,
  };
}

function createHeadlessAiLogFile(providerId) {
  ensureDataDir();
  const filePath = resolveDataPath(path.join('ai-runs', `${normalizeProviderId(providerId)}-${Date.now()}.log`));
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, '', 'utf8');
  return filePath;
}

function appendHeadlessAiLog(filePath, stream, text) {
  if (!filePath || !text) return;
  try {
    ensureParentDir(filePath);
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] [${stream}] ${String(text)}`, 'utf8');
  } catch (_) {}
}

async function stopHeadlessAiRun(providerId = null) {
  const run = getActiveHeadlessRun(providerId);
  if (!run) {
    return { ok: true, stopped: false, method: 'noop' };
  }

  const child = run.child;
  const pid = child && Number.isFinite(child.pid) ? child.pid : null;
  let stopped = false;

  if (pid && process.platform === 'win32') {
    const result = await execCommand(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
    stopped = !result.error;
  } else if (child && typeof child.kill === 'function') {
    try {
      stopped = child.kill('SIGTERM');
    } catch (_) {
      stopped = false;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  if (headlessAiRun === run) {
    headlessAiRun = null;
    invalidateAiStatusCache(run.provider);
  }

  return {
    ok: true,
    stopped: !!stopped,
    method: process.platform === 'win32' ? 'taskkill' : 'kill',
    provider: run.provider,
  };
}

function companyHasLogSince(companyNo, startedAtMs) {
  return getAllLogs().some((entry) => {
    if (String(entry.companyNo) !== String(companyNo)) return false;
    const timestampMs = Date.parse(entry.timestamp || '');
    return Number.isFinite(timestampMs) && timestampMs >= startedAtMs;
  });
}

function deriveHeadlessFailureReason(run, exitCode, signal) {
  const providerLabel = getProviderDisplayName(run.provider);
  const text = String(run.recentOutput || '');
  if (/usage limit/i.test(text)) {
    return `${providerLabel} の利用上限に達しており、今回の自動実行を開始できませんでした。`;
  }
  if (/CreateProcessAsUserW failed: 5/i.test(text) || /windows sandbox/i.test(text)) {
    return `${providerLabel} の Windows sandbox 実行で shell が失敗しました。headless no-approval 実行でもローカルコマンドを開始できていません。`;
  }
  if (/user cancelled MCP tool call/i.test(text)) {
    return `${providerLabel} が MCP Playwright の操作をキャンセルしました。権限・実行モード・provider 側の自動実行設定を確認してください。`;
  }
  if (/Not enough arguments following: p/i.test(text)) {
    return `${providerLabel} の headless prompt 引数が不正でした。`;
  }
  return exitCode === 0
    ? `${providerLabel} headless automation finished without processing the queued company.`
    : `${providerLabel} headless automation exited early (code=${exitCode}, signal=${signal || 'none'}).`;
}

function markHeadlessAutomationFailure(run, exitCode, signal) {
  const providerLabel = getProviderDisplayName(run.provider);
  const reason = deriveHeadlessFailureReason(run, exitCode, signal);

  (run.companies || []).forEach((company) => {
    if (companyHasLogSince(company.no, run.startedAtMs)) return;
    logAction(company.no, company.companyName || company.name || '', 'error', {
      source: `${run.provider}-headless`,
      action: 'error',
      detail: reason,
      promptFile: run.promptFile,
      runLogFile: run.logFile,
      provider: run.provider,
      exitCode,
      signal: signal || null,
    });
    finishLiveMonitor(company.no, {
      source: `${run.provider}-headless`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'error',
      step: providerLabel + ' headless automation failed',
      currentUrl: company.formUrl || company.url || '',
    });
  });
}

async function startHeadlessAiAutomationRun(companies, providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!isHeadlessAutomationProvider(normalizedProviderId)) {
    throw new Error(`${getProviderDisplayName(normalizedProviderId)} does not support headless automation routing.`);
  }
  if (headlessAiRun) {
    throw new Error(`${getProviderDisplayName(headlessAiRun.provider)} の headless automation がまだ実行中です。完了を待つか停止してください。`);
  }

  const provider = getProvider(normalizedProviderId);
  const sender = settings.getSender();
  const promptText = buildClaudeFormFillPrompt(companies, sender, normalizedProviderId);
  const promptFile = writeWorkspaceClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const model = getClaudeAutomationModel(normalizedProviderId);
  const kickoffPrompt = [
    `次の指示ファイルを読んで、その内容を実行してください: ${promptFile}`,
    `必ず ${provider.cliLabel} と MCP Playwright を使って進めてください。`,
    'リポジトリ内の direct Playwright worker / JS automation は使わないでください。',
    '送信は行わず、確認待ちまでで止め、フォームタブは閉じないでください。',
  ].join('\n');
  const invocationPrompt = normalizedProviderId === 'gemini'
    ? '以下に stdin で渡す Sales Claw automation instructions を、その場で実行してください。要約だけで終わらず、実際にツールを呼び出して処理してください。'
    : '';
  const stdinPrompt = normalizedProviderId === 'gemini' ? promptText : promptText;
  const automationMode = getAutomationModeForProvider(normalizedProviderId);
  const headlessSpec = buildHeadlessArgs(normalizedProviderId, automationMode, {
    model,
    cwd: PROJECT_ROOT,
    prompt: invocationPrompt,
  });
  const executable = await resolveClaudeExecutable(normalizedProviderId);
  const spawnSpec = buildCliCommandSpec(executable, headlessSpec.args);
  const logFile = createHeadlessAiLogFile(normalizedProviderId);
  const { spawn } = require('child_process');
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const run = {
    provider: normalizedProviderId,
    mode: `headless-${headlessSpec.effectiveMode}`,
    child,
    promptFile,
    logFile,
    companies: companies.map((company) => ({ ...company })),
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    recentOutput: '',
  };
  headlessAiRun = run;
  invalidateAiStatusCache(normalizedProviderId);

  const targets = companies.map((company) => ({
    companyNo: company.no,
    companyName: company.companyName || company.name || '',
  }));
  setTargets(targets, true);

  companies.forEach((company) => {
    updateLiveMonitor(company.no, {
      source: `${provider.id}-headless`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'queued',
      step: `${provider.displayName} headless CLI に作業指示を送信`,
      currentUrl: company.formUrl || company.url || '',
    });
  });

  emitClaudeAutomationLog(`[AIフォーム入力開始] ${companies.length}社の処理を ${provider.displayName} headless CLI に依頼しました。\n`, 'system', normalizedProviderId);
  emitClaudeAutomationLog(`[Prompt file] ${promptFile}\n`, 'system', normalizedProviderId);
  emitClaudeAutomationLog(`[Run log] ${logFile}\n`, 'system', normalizedProviderId);
  appendHeadlessAiLog(logFile, 'system', `[start] provider=${normalizedProviderId} mode=${run.mode} promptFile=${promptFile}\n`);

  child.stdout.on('data', (chunk) => {
    run.recentOutput = `${run.recentOutput || ''}${String(chunk)}`.slice(-12000);
    appendHeadlessAiLog(logFile, 'stdout', chunk);
    emitClaudeAutomationLog(String(chunk), 'stdout', normalizedProviderId);
  });
  child.stderr.on('data', (chunk) => {
    run.recentOutput = `${run.recentOutput || ''}${String(chunk)}`.slice(-12000);
    appendHeadlessAiLog(logFile, 'stderr', chunk);
    emitClaudeAutomationLog(String(chunk), 'stderr', normalizedProviderId);
  });
  child.on('error', (error) => {
    appendHeadlessAiLog(logFile, 'error', `${error.message}\n`);
    appendDiagnosticEvent('headless_ai_spawn_error', {
      provider: normalizedProviderId,
      error: error.message,
      promptFile,
      runLogFile: logFile,
    });
  });
  child.on('exit', (exitCode, signal) => {
    appendHeadlessAiLog(logFile, 'system', `[exit] code=${exitCode} signal=${signal || 'none'}\n`);
    emitClaudeAutomationLog(`\n[${provider.displayName} headless exit code=${exitCode} signal=${signal || 'none'}]\n`, 'system', normalizedProviderId);
    if (headlessAiRun === run) {
      headlessAiRun = null;
    }
    if (exitCode !== 0 || (run.companies || []).some((company) => !companyHasLogSince(company.no, run.startedAtMs))) {
      markHeadlessAutomationFailure(run, exitCode, signal);
    }
    appendDiagnosticEvent('headless_ai_exit', {
      provider: normalizedProviderId,
      exitCode,
      signal: signal || null,
      promptFile,
      runLogFile: logFile,
    });
    invalidateAiStatusCache(normalizedProviderId);
    notifyClients({ type: 'claude-exit', code: exitCode, provider: normalizedProviderId, time: Date.now() });
  });

  if (headlessSpec.promptViaStdin && child.stdin) {
    child.stdin.write(stdinPrompt);
    child.stdin.end();
  }

  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: run.mode,
    promptFile,
    runLogFile: logFile,
  };
}

function getScreenshotArtifacts(companyNo, options = {}) {
  const status = getExpectedApprovalArtifacts(companyNo, options);
  const actual = status.actual || status.screenshots || {};
  return {
    dir: settings.getScreenshotDir(),
    input: status.exists.input ? (actual.input || status.screenshots.input) : null,
    confirm: status.exists.confirm ? (actual.confirm || status.screenshots.confirm) : null,
    hasInput: status.exists.input,
    hasConfirm: status.exists.confirm,
    hasAny: status.exists.input || status.exists.confirm,
    readyForApproval: status.readyForApproval,
    readyForManualApproval: !!status.readyForManualApproval,
    manualReviewReason: status.manualActionReason || '',
    manualReviewDetail: status.manualActionDetail || '',
    captchaDetected: !!status.captchaDetected,
    directSubmitDetected: !!status.directSubmitDetected,
    auditState: status.auditState || (status.exists.confirm ? 'confirm' : (status.exists.input ? 'input-only' : 'missing')),
    artifacts: status,
  };
}

function getCompanyLogContext(companyNo) {
  const allLogs = getAllLogs();
  const logs = allLogs.filter((log) => String(log.companyNo) === String(companyNo));
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const formFillLog = getLatestLog(logs, 'form_fill');
  const submittedLog = getLatestLog(logs, 'submitted');
  const awaitingLog = getLatestLog(logs, 'awaiting_approval');
  const confirmLog = getLatestLog(logs, 'confirm_reached');
  const errorLog = getLatestLog(logs, 'error');
  return {
    allLogs,
    logs,
    lastLog,
    lastAction: lastLog ? lastLog.action : null,
    formFillLog,
    submittedLog,
    awaitingLog,
    confirmLog,
    errorLog,
    screenshot: getScreenshotArtifacts(companyNo, {
      logs,
      formFillLog,
      submittedLog,
      awaitingLog,
      confirmLog,
    }),
  };
}

function deleteCompanyScreenshots(companyNo) {
  const prefix = `ss-${companyNo}-`;
  const removed = new Set();
  for (const dirPath of getScreenshotSearchDirs()) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const fileNames = fs.readdirSync(dirPath);
      for (const fileName of fileNames) {
        if (!fileName.startsWith(prefix) || !fileName.endsWith('.png')) continue;
        const filePath = path.join(dirPath, fileName);
        try {
          fs.unlinkSync(filePath);
          removed.add(path.resolve(filePath));
        } catch (_) {}
      }
    } catch (_) {}
  }
  return Array.from(removed);
}

function removeSkipFeedback(companyNo) {
  const filePath = resolveDataPath('skip-feedback.json');
  if (!fs.existsSync(filePath)) return 0;
  try {
    const current = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(current)) return 0;
    const next = current.filter((entry) => String(entry && entry.companyNo) !== String(companyNo));
    const removedCount = current.length - next.length;
    if (removedCount > 0) {
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
    }
    return removedCount;
  } catch (_) {
    return 0;
  }
}

function findRuntimeCompanyRecord(companyNo) {
  const wanted = String(companyNo);
  return loadData().companies.find((company) => String(company.no) === wanted) || null;
}

function purgeHistoryOnlyCompany(companyNo) {
  const company = findRuntimeCompanyRecord(companyNo);
  const logsRemoved = removeCompanyLogs(companyNo);
  const historyRemoved = removeHistory(companyNo);
  const monitorRemoved = removeCompanyMonitor(companyNo);
  const screenshotsRemoved = deleteCompanyScreenshots(companyNo);
  const skipFeedbackRemoved = removeSkipFeedback(companyNo);
  const removed =
    logsRemoved > 0 ||
    historyRemoved ||
    monitorRemoved ||
    screenshotsRemoved.length > 0 ||
    skipFeedbackRemoved > 0;

  return {
    ok: removed,
    company: {
      no: company ? company.no : companyNo,
      companyName: company ? company.name : String(companyNo),
    },
    removed: {
      logs: logsRemoved,
      history: historyRemoved ? 1 : 0,
      monitor: monitorRemoved ? 1 : 0,
      screenshots: screenshotsRemoved.length,
      skipFeedback: skipFeedbackRemoved,
    },
  };
}

function getMonitorScreenshotFile(monitor) {
  const candidates = [];
  if (monitor && monitor.latestScreenshot) candidates.push(monitor.latestScreenshot);
  if (monitor && monitor.screenshot) candidates.push(monitor.screenshot);
  if (monitor && monitor.latestScreenshotName) candidates.push(monitor.latestScreenshotName);
  for (const candidate of candidates) {
    const existing = findScreenshotPath(candidate);
    if (existing) return path.basename(existing);
  }
  return null;
}

function buildMonitorPayload() {
  const summary = getLiveMonitorSummary();
  const monitor = summary && summary.primary ? summary.primary : readMonitorState();
  const events = summary && Array.isArray(summary.events)
    ? summary.events.map((entry) => ({
        ...entry,
        currentUrl: entry && (entry.currentUrl || entry.formUrl) ? (entry.currentUrl || entry.formUrl) : '',
        latestScreenshotName: getMonitorScreenshotFile(entry),
      }))
    : [];
  if (!monitor) {
    return {
      status: 'idle',
      companyNo: null,
      companyName: '',
      currentUrl: '',
      step: '',
      latestScreenshotName: null,
      updatedAt: summary ? summary.updatedAt : null,
      activeCount: 0,
      events,
    };
  }
  return {
    ...monitor,
    currentUrl: monitor.currentUrl || monitor.formUrl || '',
    latestScreenshotName: getMonitorScreenshotFile(monitor),
    activeCount: summary ? summary.activeCount || 0 : 0,
    events,
  };
}

function getLatestMonitorUrl(companyNo) {
  const wanted = String(companyNo);
  const summary = getLiveMonitorSummary();
  const candidates = [];
  if (summary && summary.primary && String(summary.primary.companyNo) === wanted) candidates.push(summary.primary);
  if (summary && Array.isArray(summary.events)) {
    summary.events.forEach((entry) => {
      if (entry && String(entry.companyNo) === wanted) candidates.push(entry);
    });
  }
  const latest = candidates.find((entry) => entry && (entry.currentUrl || entry.formUrl));
  return latest ? (latest.currentUrl || latest.formUrl || '') : '';
}

function getKnownFormUrl(companyNo, preferredUrl = '') {
  const direct = String(preferredUrl || '').trim();
  if (direct) return direct;

  const monitorUrl = getLatestMonitorUrl(companyNo);
  if (monitorUrl) return monitorUrl;

  const history = getHistory(companyNo);
  if (history && Array.isArray(history.contacts)) {
    for (let i = history.contacts.length - 1; i >= 0; i -= 1) {
      const formUrl = String((history.contacts[i] && history.contacts[i].formUrl) || '').trim();
      if (formUrl) return formUrl;
    }
  }

  return '';
}

function buildCompanyAutomationHints(company) {
  const hints = [];
  const knownFormUrl = getKnownFormUrl(company.no, company.formUrl || '');
  if (knownFormUrl) {
    hints.push(`   優先フォームURL: ${knownFormUrl}`);
  } else if (company.url) {
    hints.push(`   探索ルール: まず ${company.url} のヘッダー/フッター/サイト内の「お問い合わせ」「Contact」を確認すること`);
    hints.push(`   探索ルール: サイト内で見つからない場合のみ「${company.companyName || company.name || ''} 問い合わせ」で1回だけ検索し、公式ドメインの最上位候補だけを開くこと`);
    hints.push('   探索ルール: 関連ページをだらだら巡回したり、非公式ドメインを複数たどらないこと');
  } else {
    hints.push(`   探索ルール: 「${company.companyName || company.name || ''} 問い合わせ」で1回だけ検索し、公式ドメインの最上位候補だけを確認すること`);
  }

  const history = getHistory(company.no);
  if (history && Array.isArray(history.contacts) && history.contacts.length > 0) {
    const latest = history.contacts[history.contacts.length - 1];
    hints.push(`   学習メモ: 過去に ${history.contacts.length} 回送信履歴あり`);
    if (latest && latest.formUrl) hints.push(`   学習メモ: 前回利用フォームURL: ${latest.formUrl}`);
  }

  const logContext = getCompanyLogContext(company.no);
  if (logContext.screenshot && logContext.screenshot.captchaDetected) {
    hints.push('   学習メモ: 過去に CAPTCHA があり、最終送信は手動対応になった');
  }
  if (logContext.errorLog) {
    const errorDetail = truncateUiText(logContext.errorLog.details, 140);
    if (errorDetail) hints.push(`   学習メモ: 前回エラー: ${errorDetail}`);
  }

  return hints;
}

function isAwaitingTransitionAllowed(lastAction, decision) {
  if (decision === 'sent') {
    return ['awaiting_approval', 'confirm_reached'].includes(lastAction);
  }
  if (decision === 'skip') {
    return ['site_analysis', 'message_draft', 'form_fill', 'confirm_reached', 'awaiting_approval', 'error'].includes(lastAction);
  }
  return false;
}

function execCommand(command, options = {}) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(command, {
      windowsHide: process.platform === 'win32',
      ...options,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

function escapePowerShellArg(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function toPowerShellEncodedCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function normalizeProjectPath(inputPath, fallbackPath = PROJECT_ROOT) {
  const value = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!value) return fallbackPath;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function toStoredProjectPath(targetPath) {
  const value = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!value) return '';
  const relativePath = path.relative(PROJECT_ROOT, value);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return value;
  }
  return relativePath;
}

async function openDirectoryPicker(initialPath = '') {
  const runtimeRoot = typeof settings.getRuntimeRoot === 'function' ? settings.getRuntimeRoot() : PROJECT_ROOT;
  const resolvedInitial = normalizeProjectPath(initialPath, runtimeRoot);

  if (process.versions.electron) {
    const { dialog, BrowserWindow } = require('electron');
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const result = await dialog.showOpenDialog(parentWindow, {
      title: 'Select folder',
      defaultPath: fs.existsSync(resolvedInitial) ? resolvedInitial : runtimeRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths && result.filePaths[0]) || null;
  }

  throw new Error('Folder selection is available in the desktop app. In browser-only mode, enter the path manually.');
}

async function resolveClaudeExecutable(providerId = getSelectedAiProvider()) {
  const provider = getProvider(providerId);
  const cacheKey = provider.id;
  const cached = _aiExecutablePath[cacheKey];
  if (cached && fs.existsSync(cached)) return cached;
  if (process.platform !== 'win32') return provider.id;

  const whereNames = Array.from(new Set([
    ...provider.executableNames,
    ...provider.executableNames.map((entry) => path.parse(entry).name),
    provider.id,
  ])).filter(Boolean);

  const discoveredCandidates = [];
  for (const name of whereNames) {
    const result = await execCommand(`where ${name}`, { timeout: 3000 });
    if (result.error) continue;
    discoveredCandidates.push(...String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && fs.existsSync(line)));
  }

  const candidates = Array.from(new Set([
    ...discoveredCandidates,
    ...getExecutableFallbackCandidates(provider.id).filter((entry) => fs.existsSync(entry)),
  ])).sort((left, right) => {
    function score(entry) {
      const normalized = String(entry || '').toLowerCase();
      let value = 0;
      if (normalized.includes('\\appdata\\roaming\\npm\\')) value += 40;
      if (normalized.includes('\\.local\\bin\\')) value += 35;
      if (normalized.includes('\\windowsapps\\')) value -= 40;
      if (normalized.endsWith('.cmd')) value += 20;
      else if (normalized.endsWith('.exe')) value += 15;
      else if (normalized.endsWith('.ps1')) value += 5;
      return value;
    }
    return score(right) - score(left);
  });

  if (candidates[0]) {
    _aiExecutablePath[cacheKey] = candidates[0];
    return candidates[0];
  }

  return provider.id;
}

async function probeClaudeAuthStatus(providerId = getSelectedAiProvider()) {
  const provider = getProvider(providerId);
  const executable = await resolveClaudeExecutable(provider.id);
  const installed = process.platform !== 'win32' || executable !== provider.id;
  if (!installed) {
    return {
      provider: provider.id,
      installed: false,
      loggedIn: false,
      error: `${provider.cliLabel} is not installed.`,
    };
  }

  if (provider.id === 'claude') {
    const command = process.platform === 'win32'
      ? `"${executable}" auth status --json`
      : 'claude auth status --json';
    const result = await execCommand(command, { timeout: 8000 });
    if (result.error) {
      return {
        provider: provider.id,
        installed: true,
        loggedIn: false,
        error: String(result.stderr || result.stdout || result.error.message || 'Claude auth status failed.').trim(),
      };
    }

    try {
      const parsed = JSON.parse(String(result.stdout || '{}'));
      return {
        provider: provider.id,
        installed: true,
        loggedIn: !!parsed.loggedIn,
        authMethod: parsed.authMethod || null,
        email: parsed.email || null,
        orgName: parsed.orgName || null,
        subscriptionType: parsed.subscriptionType || null,
        error: parsed.loggedIn ? null : 'Claude CLI is not authenticated.',
      };
    } catch (error) {
      return {
        provider: provider.id,
        installed: true,
        loggedIn: false,
        error: String(result.stdout || result.stderr || error.message || 'Could not parse Claude auth status.').trim(),
      };
    }
  }

  if (provider.id === 'codex') {
    const command = process.platform === 'win32'
      ? `"${executable}" login status`
      : 'codex login status';
    const result = await execCommand(command, { timeout: 8000 });
    const output = String(result.stdout || result.stderr || '').trim();
    const loggedIn = /logged in/i.test(output) || /chatgpt/i.test(output);
    return {
      provider: provider.id,
      installed: true,
      loggedIn,
      authMethod: loggedIn ? 'chatgpt' : null,
      summary: output.split(/\r?\n/)[0] || null,
      error: loggedIn ? null : (output || 'Codex CLI is not authenticated.'),
    };
  }

  const loggedIn = hasAnyAuthFile(provider.id)
    || !!process.env.GEMINI_API_KEY
    || !!process.env.GOOGLE_API_KEY;
  return {
    provider: provider.id,
    installed: true,
    loggedIn,
    authMethod: loggedIn ? 'cached_credentials' : null,
    probeReliability: 'heuristic',
    error: loggedIn ? null : 'Gemini CLI cached credentials were not found.',
  };
}

async function ensureClaudeAutomationReady(providerId = getSelectedAiProvider()) {
  const selectedProviderId = normalizeProviderId(providerId);
  const managedProviderId = getManagedAiProvider();
  const provider = getProvider(selectedProviderId);
  const auth = await probeClaudeAuthStatus(selectedProviderId);
  if (!auth.installed) {
    return {
      ok: false,
      statusCode: 409,
      error: `${provider.cliLabel} が未インストールです。${provider.displayName} を起動してインストールしてください。`,
    };
  }
  if (!auth.loggedIn) {
    return {
      ok: false,
      statusCode: 409,
      error: `${provider.cliLabel} が未ログインです。先に ${provider.displayName} を起動してログインを完了してください。`,
    };
  }
  if (isHeadlessAutomationProvider(selectedProviderId)) {
    if (selectedProviderId === 'codex') {
      ensureCodexWorkspaceTrusted(PROJECT_ROOT);
    }
    const playwrightSetup = await ensureProviderPlaywrightMcp(selectedProviderId);
    if (!playwrightSetup.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: playwrightSetup.error || `${provider.displayName} の MCP Playwright 設定に失敗しました。`,
      };
    }
    const activeRun = getActiveHeadlessRun();
    if (activeRun && activeRun.provider !== selectedProviderId) {
      return {
        ok: false,
        statusCode: 409,
        error: `現在は ${getProviderDisplayName(activeRun.provider)} の headless automation が実行中です。完了を待つか停止してください。`,
      };
    }
  } else {
    if (!claudePty) {
      return {
        ok: false,
        statusCode: 409,
        error: `${provider.displayName} が未起動です。先に「AI を起動」でダッシュボード管理セッションを開始してください。外部ターミナルだけでは自動実行できません。`,
      };
    }
    if (managedProviderId !== selectedProviderId) {
      return {
        ok: false,
        statusCode: 409,
        error: `現在の管理セッションは ${getProviderDisplayName(managedProviderId)} です。Settings で選択した ${provider.displayName} に合わせて起動し直してください。`,
      };
    }
    if (!['auto', 'bypassPermissions'].includes(claudeProcessMode)) {
      return {
        ok: false,
        statusCode: 409,
        error: `現在の ${provider.displayName} 起動モードは ${getProviderModeLabel(provider.id, claudeProcessMode, 'ja')}（${claudeProcessMode}）です。このモードでは権限確認で停止しやすいため、AIフォーム入力は ${getProviderRecommendedModesText(provider.id, 'ja')} で起動してください。`,
      };
    }
  }
  const sender = settings.getSender();
  const missingSenderFields = [];
  if (!sender.companyName) missingSenderFields.push('会社名');
  if (!sender.name) missingSenderFields.push('担当者名');
  if (!sender.email) missingSenderFields.push('メールアドレス');
  if (!sender.phone) missingSenderFields.push('電話番号');
  if (missingSenderFields.length > 0) {
    return {
      ok: false,
      statusCode: 409,
      error: `送信者設定が不足しています: ${missingSenderFields.join(' / ')}。Settings で必須項目を入力してください。`,
    };
  }
  return {
    ok: true,
    auth,
    providerId: selectedProviderId,
    provider,
    execution: isHeadlessAutomationProvider(selectedProviderId) ? 'headless' : 'managed',
  };
}

function buildClaudeFormFillPrompt(companies, sender, providerId = getManagedAiProvider()) {
  const provider = getProvider(providerId);
  const configuredScreenshotDir = settings.getScreenshotDir();
  const promptScreenshotDir = path.join(PROJECT_ROOT, 'screenshots');
  const messageTemplates = settings.getSection('messageTemplates') || {};
  const approachObjective = typeof messageTemplates.approachObjective === 'string' ? messageTemplates.approachObjective.trim() : '';
  const approachGuardrails = typeof messageTemplates.approachGuardrails === 'string' ? messageTemplates.approachGuardrails.trim() : '';
  const companyListText = (companies || []).map((company, index) => {
    const lines = [
      `${index + 1}. 会社名: ${company.companyName || '(不明)'}`,
      `   管理番号: ${company.no}`,
    ];
    if (company.url) lines.push(`   WebサイトURL: ${company.url}`);
    if (company.formUrl) lines.push(`   問い合わせURL: ${company.formUrl}`);
    if (company.type) lines.push(`   種別: ${company.type}`);
    if (company.notes) lines.push(`   備考: ${company.notes}`);
    lines.push(`   inputスクショ保存先: ${path.join(promptScreenshotDir, `ss-${company.no}-input.png`)}`);
    lines.push(`   confirmスクショ保存先: ${path.join(promptScreenshotDir, `ss-${company.no}-confirm.png`)}`);
    lines.push(...buildCompanyAutomationHints(company));
    return lines.join('\n');
  }).join('\n\n');

  const senderLines = [
    `- 会社名: ${sender.companyName || ''}`,
    `- 担当者名: ${sender.name || ''}`,
    `- 担当者名カナ: ${sender.nameKana || ''}`,
    `- メールアドレス: ${sender.email || ''}`,
    `- 電話番号: ${sender.phone || ''}`,
    `- 携帯番号: ${sender.mobile || ''}`,
    `- FAX: ${sender.fax || ''}`,
    `- 役職: ${sender.title || ''}`,
    `- 部署: ${sender.department || ''}`,
    `- 郵便番号: ${sender.postalCode || ''}`,
    `- 住所: ${sender.address || ''}`,
    `- Webサイト: ${sender.website || ''}`,
    `- パートナーページ: ${sender.partnerPage || ''}`,
  ].join('\n');
  const approachLines = [];
  if (approachObjective) approachLines.push(`- 狙い: ${approachObjective}`);
  if (approachGuardrails) approachLines.push(`- 避けたいこと: ${approachGuardrails}`);

  return `以下の${companies.length}社に対して問い合わせフォーム入力作業を実行してください。

## 絶対条件
- この作業は ${provider.cliLabel} と MCP Playwright を使って進めること
- Web確認・フォーム解析・入力・スクリーンショットは **mcp__playwright__browser_navigate / browser_snapshot / browser_fill_form / browser_take_screenshot / browser_click / browser_tabs** だけを使うこと
- **darbot-windows-mcp - Scrape-Tool を含む他の MCP Web 取得ツールは使わないこと**
- リポジトリ内の direct Playwright worker / JS automation に依存しないこと
- 送信直前の画面で止め、送信は行わないこと
- 各社のフォームタブは閉じずに残し、ユーザーが手動送信できる状態にすること
- reCAPTCHA / hCaptcha / Cloudflare Turnstile などの手動認証は回避しないこと。検出したらユーザー手動対応待ちとして扱うこと
- 営業目的NG・対象外・利用目的不一致のフォームには入力しないこと
- スクリーンショットは対象企業リストに書かれたプロジェクト配下の絶対パスへ保存すること。今回の保存先は ${promptScreenshotDir} で、settings の保存先 ${configuredScreenshotDir} ではない
- Bash でスクリーンショットをコピー・移動しないこと。保存後のファイル移動は不要
- 問い合わせURLが既知なら、余計な探索をせずそのURLを最優先で開くこと
- 問い合わせURLが未登録なら、まず公式サイト内の「お問い合わせ / Contact」を確認し、それでも見つからない場合のみ「会社名 問い合わせ」で1回だけ検索すること
- 検索結果は公式ドメインの最上位候補を優先し、無関係なページへ横道探索しないこと

## 送信者情報
${senderLines}

${approachLines.length > 0 ? `## 営業アプローチ方針
${approachLines.join('\n')}
- 上記は AI への内部指示です。顧客向け本文にそのまま転記せず、文面のトーン・提案内容・避ける表現に反映してください

` : ''}## 対象企業リスト
${companyListText}

## 実行手順
1. 各社の Web サイトと問い合わせフォームを、MCP Playwright の navigate / snapshot で確認する
2. src/company-analyzer.cjs を使って企業分析し、src/message-builder.cjs の buildCustomMessage() または buildMessage() を使って本文を生成する
3. action-logger.cjs の logAction(no, name, 'message_draft', 生成した本文全文) を必ず記録する
3.1. action-logger.cjs の logAction は同期関数。.then() / .catch() を付けず、そのまま呼ぶこと
4. 「メッセージ生成完了」などの要約だけを残すのは禁止。確認待ちで全文を見られる状態にする
4.1. 本文は薄い一般文にしない。相手サイトで読み取れた固有要素を最低2点、こちらの提供価値を1点、近い支援実績や参考事例を1点は反映すること
4.2. 「お困りではないでしょうか」だけで終わらせず、どの案件のどの工程を補完できるかまで書くこと
5. フォーム本文や注意書きを読み、営業目的NG・利用目的不一致・対象外フォームではないか確認する
6. 対象外でなければ必要な項目を把握し、送信者情報と生成メッセージを入力する
7. input スクリーンショットを保存する
8. 確認画面があれば confirm スクリーンショットを保存する
8.1. Playwright の保存先は必ず ${promptScreenshotDir} を使う。ほかの絶対パスには保存しないこと
8.2. reCAPTCHA などでユーザーの手動操作が必要な場合や、確認画面がなく最終クリックが即送信になるフォームでは、最終送信ボタンを押さず input スクリーンショットで止めること
9. action-logger.cjs の logAction を使って form_fill → confirm_reached → awaiting_approval を記録する
10. src/live-monitor.cjs の updateLiveMonitor / finishLiveMonitor を使って currentUrl・step・latestScreenshot を更新する
11. タブは閉じずに残し、ユーザーがダッシュボードから判断できる状態にする

## 対象外の判定ルール
- フォーム本文や注意書きに「営業目的の問い合わせ禁止」「営業・売り込み禁止」「サービス導入相談専用」「既存顧客専用」「採用専用」「IR専用」「報道専用」などの記載がある場合は対象外
- 対象外の場合はフォーム入力しない
- 対象外の場合は logAction(no, name, 'skipped', '営業NG/対象外: 理由') を記録する
- 対象外の場合は finishLiveMonitor(companyNo, { status: 'skipped', step: '営業NG/対象外', ... }) で終了する
- 対象外なのに awaiting_approval へ進めてはいけない

## 入力項目ルール
- 最低限の基本項目は「会社名・担当者名・メール・電話・問い合わせ本文」。これらは設定値がある場合のみ使う
- 追加項目の「部署・役職・担当者名カナ・郵便番号・住所・携帯・FAX・Webサイト」は、フォーム上に明示的な対応項目がある場合だけ使う
- 設定に存在しない値は作らない。推測・補完・創作は禁止
- フォーム必須項目に対応する設定値が不足している場合は、その不足内容をログに明記する
- companyProfile.notes や内部メモはフォーム入力や送信本文に使わない
- valuePropositions や messageTemplates は message-builder.cjs 経由で反映し、本文をその場で好きに作り替えすぎない
- エラー時は action-logger.cjs の error ログに、原因・URL・不足項目・CAPTCHA有無を分かる形で残すこと

## 注意
- 相手企業ごとにフォーム構造が違っても、その場で判断して対応する
- 送信よりも、確認待ち状態の正確な記録を優先する
- 確認待ちでは status を awaiting_approval にする
- CAPTCHA / 手動送信待ちの確認待ちでは、awaiting_approval の details に「手動対応理由」を具体的に書くこと
- 完了・失敗・中断時は finishLiveMonitor を呼ぶ
- Playwright 以外の MCP ツールで権限確認が出そうな場合は、そのツールを使わず Playwright 側の操作に切り替える
- 進行状況とエラーは簡潔に報告する`;
}

function getClaudeAutomationModel(providerId = getSelectedAiProvider()) {
  const configured = getConfiguredAiModel(providerId);
  return configured || null;
}

function emitClaudeAutomationLog(text, stream = 'stdout', providerId = getManagedAiProvider()) {
  if (!text) return;
  notifyClients({
    type: 'claude-stdout',
    text: String(text),
    stream,
    provider: providerId,
    time: Date.now(),
  });
}

function writeClaudeFormFillPromptFile(companies, promptText, providerId = getManagedAiProvider()) {
  ensureDataDir();
  const promptFile = resolveDataPath(path.join('ai-prompts', `${providerId}-form-fill-${Date.now()}.md`));
  ensureParentDir(promptFile);
  const summary = (companies || []).map((company) => `- ${company.no}: ${company.companyName || company.name || '(unknown)'}`).join('\n');
  const content = [
    `# Sales Claw ${getProviderDisplayName(providerId)} Automation Request`,
    `Created: ${new Date().toISOString()}`,
    '',
    '## Companies',
    summary || '- none',
    '',
    '## Instructions',
    promptText,
    '',
  ].join('\n');
  fs.writeFileSync(promptFile, content, 'utf8');
  return promptFile;
}

function writeWorkspaceClaudeFormFillPromptFile(companies, promptText, providerId = getManagedAiProvider()) {
  const promptFile = path.join(PROJECT_ROOT, '.sales-claw-work', 'ai-prompts', `${providerId}-form-fill-${Date.now()}.md`);
  ensureParentDir(promptFile);
  const summary = (companies || []).map((company) => `- ${company.no}: ${company.companyName || company.name || '(unknown)'}`).join('\n');
  const content = [
    `# Sales Claw ${getProviderDisplayName(providerId)} Automation Request`,
    `Created: ${new Date().toISOString()}`,
    '',
    '## Companies',
    summary || '- none',
    '',
    '## Instructions',
    promptText,
    '',
  ].join('\n');
  fs.writeFileSync(promptFile, content, 'utf8');
  return promptFile;
}

function queueClaudeFormFillInManagedSession(companies, providerId = getManagedAiProvider()) {
  if (!claudePty) {
    throw new Error('Managed AI session is not running.');
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const sender = settings.getSender();
  const promptFile = writeClaudeFormFillPromptFile(companies, buildClaudeFormFillPrompt(companies, sender, normalizedProviderId), normalizedProviderId);
  const model = getClaudeAutomationModel(normalizedProviderId);
  const messageLines = [
    `次の指示ファイルを読んで、その内容を実行してください: ${promptFile}`,
    `必ず ${provider.cliLabel} と MCP Playwright を使って進めてください。`,
    'リポジトリ内の direct Playwright worker / JS automation は使わないでください。',
    '送信は行わず、確認待ちまでで止め、フォームタブは閉じないでください。',
  ];
  if (model) {
    messageLines.splice(1, 0, `優先モデル: ${model}`);
  }

  const targets = companies.map((company) => ({
    companyNo: company.no,
    companyName: company.companyName || company.name || '',
  }));
  setTargets(targets, true);

  companies.forEach((company) => {
    updateLiveMonitor(company.no, {
      source: `${provider.id}-cli`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'queued',
      step: `${provider.displayName} CLI に作業指示を送信`,
      currentUrl: company.formUrl || company.url || '',
    });
  });

  emitClaudeAutomationLog(`[AIフォーム入力開始] ${companies.length}社の処理を ${provider.displayName} CLI に依頼しました。\n`, 'system', providerId);
  claudePty.write(`${messageLines.join('\n')}\r`);
  notifyClients({ type: 'update', reason: 'claude-automation-queued', time: Date.now() });
  invalidateAiStatusCache(normalizedProviderId);
  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: `${provider.id}-cli-managed`,
    promptFile,
  };
}

async function queueAiFormFill(companies, providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (isHeadlessAutomationProvider(normalizedProviderId)) {
    return startHeadlessAiAutomationRun(companies, normalizedProviderId);
  }
  return queueClaudeFormFillInManagedSession(companies, normalizedProviderId);
}

async function launchClaudeInExternalTerminal(mode = 'default', providerId = getSelectedAiProvider()) {
  const provider = getProvider(providerId);
  const executable = await resolveClaudeExecutable(provider.id);
  if (process.platform === 'win32' && executable === provider.id) {
    throw new Error(`${provider.displayName} executable was not found.`);
  }

  const { spawn } = require('child_process');
  const flags = buildLaunchArgs(provider.id, mode, {
    model: getClaudeAutomationModel(provider.id),
    sessionId: provider.id === 'claude' ? crypto.randomUUID() : null,
  });

  if (process.platform === 'win32') {
    const command = [
      `Set-Location -LiteralPath ${escapePowerShellArg(PROJECT_ROOT)}`,
      ['&', escapePowerShellArg(executable), ...flags.map(escapePowerShellArg)].join(' '),
    ].join('; ');
    const encoded = toPowerShellEncodedCommand(command);
    const child = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-EncodedCommand', encoded], {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true, mode, provider: provider.id, providerLabel: provider.displayName };
  }

  if (process.platform === 'darwin') {
    const terminalCommand = `cd ${escapePowerShellArg(PROJECT_ROOT)}; ${[escapePowerShellArg(executable), ...flags.map(escapePowerShellArg)].join(' ')}`;
    const child = spawn('osascript', [
      '-e',
      `tell application "Terminal" to do script ${escapePowerShellArg(terminalCommand)}`,
      '-e',
      'tell application "Terminal" to activate',
    ], {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, mode, provider: provider.id, providerLabel: provider.displayName };
  }

  const terminalPrograms = [
    ['x-terminal-emulator', ['-e', executable, ...flags]],
    ['gnome-terminal', ['--', executable, ...flags]],
    ['konsole', ['-e', executable, ...flags]],
    ['xterm', ['-e', executable, ...flags]],
  ];
  for (const [program, args] of terminalPrograms) {
    try {
      const child = spawn(program, args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true, mode, provider: provider.id, providerLabel: provider.displayName };
    } catch (_) {
      // try next terminal
    }
  }

  throw new Error('No supported external terminal launcher was found.');
}

function getProviderRunningCheckCommand(providerId) {
  const provider = getProvider(providerId);
  if (process.platform === 'win32') {
    return `powershell -NoProfile -Command "$cliRegex = [regex]'[\\\\/]${provider.id}(\\\\.cmd|\\\\.exe)?([''\" ]|$)'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^${provider.id}(\\\\.cmd|\\\\.exe)?$') -or ($_.CommandLine -and $cliRegex.IsMatch($_.CommandLine)) } | Select-Object -First 1 -ExpandProperty ProcessId"`;
  }
  return `pgrep -f "${provider.id}"`;
}

async function probeClaudeStatus(providerId = getSelectedAiProvider()) {
  const selectedProviderId = normalizeProviderId(providerId);
  const activeHeadlessStatus = headlessAiRun ? getHeadlessRunStatus(headlessAiRun.provider) : null;
  if (activeHeadlessStatus) {
    return {
      ...activeHeadlessStatus,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      installed: true,
      version: null,
      installState: getProviderInstallState(activeHeadlessStatus.provider),
      installError: getProviderInstallError(activeHeadlessStatus.provider),
      installCommand: getInstallCommand(activeHeadlessStatus.provider),
    };
  }
  const runtimeProviderId = claudePty ? getManagedAiProvider() : selectedProviderId;
  const provider = getProvider(runtimeProviderId);
  const installCommand = getInstallCommand(runtimeProviderId);

  if (claudePty) {
    return {
      provider: runtimeProviderId,
      providerLabel: provider.displayName,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      installed: true,
      running: true,
      managed: true,
      mode: claudeProcessMode,
      version: null,
      installState: getProviderInstallState(runtimeProviderId),
      installError: getProviderInstallError(runtimeProviderId),
      installCommand,
    };
  }

  const now = Date.now();
  if (_aiStatusCache && _aiStatusCacheProvider === runtimeProviderId && now - _aiStatusCacheTime < AI_STATUS_CACHE_TTL_MS) {
    return {
      ..._aiStatusCache,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      installState: getProviderInstallState(runtimeProviderId),
      installError: getProviderInstallError(runtimeProviderId),
      installCommand,
    };
  }

  const executable = await resolveClaudeExecutable(runtimeProviderId);
  const installed = process.platform !== 'win32' || executable !== provider.id;
  if (!installed) {
    _aiStatusCache = {
      provider: runtimeProviderId,
      providerLabel: provider.displayName,
      installed: false,
      running: false,
      managed: false,
      version: null,
    };
    _aiStatusCacheProvider = runtimeProviderId;
    _aiStatusCacheTime = Date.now();
    return {
      ..._aiStatusCache,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      installState: getProviderInstallState(runtimeProviderId),
      installError: getProviderInstallError(runtimeProviderId),
      installCommand,
    };
  }

  const versionCommand = process.platform === 'win32'
    ? `"${executable}" --version`
    : `${provider.id} --version`;
  const versionResult = await execCommand(versionCommand, { timeout: 5000 });
  const version = versionResult.error ? null : (String(versionResult.stdout || versionResult.stderr || '').trim().split('\n')[0].trim() || null);
  const runningResult = await execCommand(getProviderRunningCheckCommand(runtimeProviderId), { timeout: 3000 });
  const running = !runningResult.error && (runningResult.stdout || '').trim().length > 0;
  const auth = await probeClaudeAuthStatus(runtimeProviderId);

  _aiStatusCache = {
    provider: runtimeProviderId,
    providerLabel: provider.displayName,
    installed: true,
    running,
    managed: false,
    version,
    loggedIn: !!auth.loggedIn,
    authMethod: auth.authMethod || null,
    authError: auth.error || null,
    probeReliability: auth.probeReliability || null,
  };
  _aiStatusCacheProvider = runtimeProviderId;
  _aiStatusCacheTime = Date.now();
  return {
    ..._aiStatusCache,
    selectedProvider: selectedProviderId,
    selectedProviderLabel: getProviderDisplayName(selectedProviderId),
    installState: getProviderInstallState(runtimeProviderId),
    installError: getProviderInstallError(runtimeProviderId),
    installCommand,
  };
}

// データ読み込み → JSON API 用
function buildDashboardDataFromSources() {
  const targetData = readTargetList();
  const targetRows = targetData.ok ? targetData.companies : [];
  const allLogs = getAllLogs();
  const historySummary = getAllHistorySummary();
  const historyMap = new Map(historySummary.map((entry) => [String(entry.companyNo), getHistory(entry.companyNo)]));
  const outreachTargets = getTargetMap();
  const monitorSummary = getLiveMonitorSummary();
  const liveEvents = monitorSummary && Array.isArray(monitorSummary.events) ? monitorSummary.events : [];
  const latestMonitorUrlByCompany = new Map();
  const logsByCompany = {};
  const nameToNo = {};
  const rowMap = new Map();
  const orderedNos = [];
  const targetNoSet = new Set();

  function upsertCompanyRow(row, source = 'target') {
    if (!row || row.no === undefined || row.no === null || row.no === '') return null;
    const key = String(row.no);
    const existing = rowMap.get(key) || {};
    const next = {
      no: row.no,
      status: row.status !== undefined && row.status !== null ? row.status : (existing.status || ''),
      companyName: row.companyName || row.name || existing.companyName || '',
      type: row.type || existing.type || '',
      url: row.url || existing.url || '',
      formUrl: row.formUrl || existing.formUrl || '',
      notes: row.notes || existing.notes || '',
      captcha: row.captcha || existing.captcha || '',
      progress: row.progress || existing.progress || '',
    };
    rowMap.set(key, next);
    if (!orderedNos.includes(key)) orderedNos.push(key);
    if (next.companyName) nameToNo[next.companyName] = next.no;
    if (source === 'target') targetNoSet.add(key);
    return key;
  }

  function resolveCompanyNoByName(companyName) {
    const name = (companyName || '').trim();
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(nameToNo, name)) return nameToNo[name];
    const match = Object.entries(nameToNo).find(([candidate]) => candidate.includes(name) || name.includes(candidate));
    return match ? match[1] : null;
  }

  targetRows.forEach((row) => {
    upsertCompanyRow(row, 'target');
  });

  allLogs.forEach(log => {
    let no = log.companyNo;
    if (no === undefined || no === null || no === '') {
      no = resolveCompanyNoByName(log.companyName || log.company || '');
    }
    if (no !== undefined && no !== null) {
      const key = String(no);
      if (!rowMap.has(key)) {
        upsertCompanyRow({
          no,
          companyName: log.companyName || log.company || '',
        }, 'log');
      }
      if (!logsByCompany[key]) logsByCompany[key] = [];
      logsByCompany[key].push(log);
    }
  });

  historySummary.forEach((entry) => {
    if (!entry || entry.companyNo === undefined || entry.companyNo === null || entry.companyNo === '') return;
    const key = String(entry.companyNo);
    if (!rowMap.has(key)) {
      upsertCompanyRow({
        no: entry.companyNo,
        companyName: entry.companyName || '',
      }, 'history');
    }
  });

  outreachTargets.forEach((entry, key) => {
    if (!rowMap.has(String(key))) {
      upsertCompanyRow({
        no: entry.companyNo || key,
        companyName: entry.companyName || '',
      }, 'targeted');
    }
  });

  const statusExclude = settings.getExcludeStatuses();
  const stats = { total: 0, approachable: 0, hasFormUrl: 0, noFormUrl: 0, excluded: 0, formFill: 0, confirmReached: 0, submitted: 0, error: 0, awaitingApproval: 0, actionNeeded: 0 };

  liveEvents.forEach((entry) => {
    if (!entry || entry.companyNo === undefined || entry.companyNo === null) return;
    const currentUrl = String(entry.currentUrl || entry.formUrl || '').trim();
    if (!currentUrl) return;
    const key = String(entry.companyNo);
    if (!latestMonitorUrlByCompany.has(key)) {
      latestMonitorUrlByCompany.set(key, currentUrl);
    }
  });

  const companies = orderedNos.map((key) => {
    const row = rowMap.get(key) || {};
    const no = row.no;
    const isDetachedFromTargetList = !targetNoSet.has(String(no));
    const status = row.status || '';
    const isExcluded = !isDetachedFromTargetList && statusExclude.includes(status);
    const isApproachable = !isExcluded;
    const logs = logsByCompany[key] || [];
    const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const contactHist = historyMap.get(String(no)) || null;
    const latestContact = contactHist && Array.isArray(contactHist.contacts) && contactHist.contacts.length > 0
      ? contactHist.contacts[contactHist.contacts.length - 1]
      : null;
    const effectiveName = row.companyName || (contactHist ? contactHist.companyName : '') || ((typeof no === 'number' || typeof no === 'string') ? String(no) : '');
    const effectiveFormUrl = row.formUrl || latestMonitorUrlByCompany.get(String(no)) || (latestContact && latestContact.formUrl) || '';

    stats.total++;
    if (!isDetachedFromTargetList && isExcluded) stats.excluded++;
    if (!isDetachedFromTargetList && isApproachable) {
      stats.approachable++;
      if (effectiveFormUrl) stats.hasFormUrl++; else stats.noFormUrl++;
    }
    if (lastLog) {
      if (lastLog.action === 'form_fill') stats.formFill++;
      if (lastLog.action === 'confirm_reached') stats.confirmReached++;
      if (lastLog.action === 'awaiting_approval') stats.awaitingApproval++;
      if (lastLog.action === 'submitted') stats.submitted++;
      if (lastLog.action === 'error') stats.error++;
    }

    const formFillLog = getLatestLog(logs, 'form_fill');
    const submittedLog = getLatestLog(logs, 'submitted');
    const siteAnalysis = getLatestLog(logs, 'site_analysis');
    const awaitingLog = getLatestLog(logs, 'awaiting_approval');
    const confirmLog = getLatestLog(logs, 'confirm_reached');
    const errorLog = getLatestLog(logs, 'error');
    const screenshot = getScreenshotArtifacts(no, {
      logs,
      formFillLog,
      submittedLog,
      awaitingLog,
      confirmLog,
    });
    const contactCount = contactHist ? contactHist.contacts.length : 0;
    const targetMeta = outreachTargets.get(String(no)) || null;
    const displayDraftMessage = getDisplayDraftMessage(logs, contactHist);
    const lastActionDetail = stringifyLogDetails(lastLog ? lastLog.details : '');
    const lastErrorDetail = stringifyLogDetails(errorLog ? errorLog.details : '');
    const requiresManualReview = !!screenshot.readyForManualApproval;

    if (lastLog && ['form_fill', 'confirm_reached', 'awaiting_approval'].includes(lastLog.action)) {
      stats.actionNeeded++;
    }

    return {
      no, status, name: effectiveName, type: row.type || '',
      url: row.url || '', formUrl: effectiveFormUrl,
      notes: row.notes || '', captcha: row.captcha || '', progress: row.progress || '',
      isApproachable,
      isDetachedFromTargetList,
      canManageInTargetList: !isDetachedFromTargetList,
      isOutreachTarget: !!targetMeta,
      targetedAt: targetMeta ? targetMeta.addedAt : null,
      outreachStatus: null,
      outreachDetail: null,
      outreachUpdatedAt: null,
      lastAction: lastLog ? lastLog.action : null,
      lastActionAt: lastLog ? lastLog.timestamp : null,
      lastLog,
      logs: logs.slice(-3).map(l => ({
        time: l.timestamp, action: l.action,
        details: typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '',
      })),
      hasInputScreenshot: screenshot.hasInput,
      hasConfirmScreenshot: screenshot.hasConfirm,
      hasAnyScreenshot: screenshot.hasAny,
      screenshotAuditState: screenshot.auditState,
      inputScreenshotName: screenshot.input ? path.basename(screenshot.input) : null,
      confirmScreenshotName: screenshot.confirm ? path.basename(screenshot.confirm) : null,
      readyForApproval: screenshot.readyForApproval,
      readyForManualApproval: requiresManualReview,
      manualReviewReason: screenshot.manualReviewReason || '',
      manualReviewDetail: screenshot.manualReviewDetail || '',
      captchaDetected: screenshot.captchaDetected,
      directSubmitDetected: screenshot.directSubmitDetected,
      sentMessage: displayDraftMessage,
      hasDraftMessage: !!displayDraftMessage,
      sentAt: submittedLog ? submittedLog.timestamp : null,
      analysis: siteAnalysis ? siteAnalysis.details : null,
      awaitingAt: awaitingLog ? awaitingLog.timestamp : (confirmLog ? confirmLog.timestamp : null),
      lastActionDetail,
      lastErrorDetail,
      contactCount,
      contactHistory: contactHist ? contactHist.contacts : [],
    };
  });

  // 7日間の日別処理推移（処理推移グラフ用、ユニーク企業数ベース）
  const today = new Date();
  const trendDays = 7;
  const trendActionNeededSets = Array.from({ length: trendDays }, () => new Set());
  const trendSentSets = Array.from({ length: trendDays }, () => new Set());
  const trendErrorSets = Array.from({ length: trendDays }, () => new Set());
  const trendLabels = [];
  const trendIndexByDay = new Map();
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    trendLabels.push(i === 0 ? '今日' : i === 1 ? '昨日' : `${i}日前`);
    trendIndexByDay.set(d.toISOString().slice(0, 10), trendDays - 1 - i);
  }
  allLogs.forEach((log) => {
    if (!log.timestamp || log.companyNo == null) return;
    const idx = trendIndexByDay.get(log.timestamp.slice(0, 10));
    if (idx === undefined) return;
    if (log.action === 'form_fill' || log.action === 'confirm_reached' || log.action === 'awaiting_approval') trendActionNeededSets[idx].add(log.companyNo);
    if (log.action === 'submitted') trendSentSets[idx].add(log.companyNo);
    if (log.action === 'error') trendErrorSets[idx].add(log.companyNo);
  });
  const trendActionNeeded = trendActionNeededSets.map((set) => set.size);
  const trendSent = trendSentSets.map((set) => set.size);
  const trendError = trendErrorSets.map((set) => set.size);

  const runtime = dashboardRuntime || readRuntime();
  return {
    companies,
    stats,
    recentLogs: allLogs.slice(-100).reverse(),
    issues: buildOperationalIssues(targetData, runtime),
    liveMonitor: buildMonitorPayload(),
    runtime,
    trendData: { labels: trendLabels, actionNeeded: trendActionNeeded, sent: trendSent, error: trendError },
  };
}

function loadData(options = {}) {
  const force = !!options.force;
  const cacheKey = getDashboardDataCacheKey();
  if (!force && dashboardDataCacheValue && dashboardDataCacheKey === cacheKey) {
    return dashboardDataCacheValue;
  }
  const data = buildDashboardDataFromSources();
  dashboardDataCacheKey = cacheKey;
  dashboardDataCacheValue = data;
  dashboardDataCacheBuiltAt = Date.now();
  return data;
}

// JSON body parser helper
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

// JSON response helper
function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// HTML テンプレート
function buildPage() {
  const _lang = settings.getSection('preferences').language || 'ja';
  const _t = getTranslations(_lang);
  const buildMeta = getBuildSourceMeta(_lang);
  const settingsTag = (kind) => `<span class="settings-field-chip ${kind}">${_t['settings.tag.' + kind] || kind}</span>`;
  const providerOptions = listProviders();
  const providerSelectHtml = providerOptions.map((provider) =>
    `<option value="${provider.id}">${provider.displayName}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sales Claw</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet">
<script>
tailwind={config:{darkMode:'class',theme:{extend:{colors:{'primary':'#004ccd','primary-c':'#0f62fe','surface':'#f7f9fd','surface-low':'#f2f4f8','surface-lowest':'#ffffff','surface-container':'#eceef2','surface-high':'#e6e8ec','on-surface':'#191c1f','on-surface-v':'#424656','outline-v':'#c3c6d8','outline':'#737687','error':'#ba1a1a','tertiary':'#9e3100','secondary':'#445ba1'},fontFamily:{sans:['Inter','sans-serif'],mono:['"JetBrains Mono"','monospace']},borderRadius:{DEFAULT:'0',none:'0',sm:'0',md:'0',lg:'0',xl:'0','2xl':'0','full':'9999px'}}}}}
</script>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<style>
:root{
  /* Base surfaces — light */
  --bg-deep:#f0f2f8;--bg-base:#f4f6fb;--bg-surface:#f8f9fd;--bg-card:#ffffff;--bg-raised:#eef0f6;--bg-hover:#e8ebf4;
  /* Brand */
  --primary:#2563eb;--primary-dim:#1d4ed8;--primary-glow:rgba(37,99,235,.12);--on-primary:#ffffff;
  /* Semantic */
  --success:#059669;--success-dim:rgba(5,150,105,.1);
  --error:#dc2626;--error-dim:rgba(220,38,38,.1);
  --warning:#d97706;--warning-dim:rgba(217,119,6,.1);
  --info:#7c3aed;--info-dim:rgba(124,58,237,.1);
  /* Text */
  --text-1:#0f172a;--text-2:#475569;--text-3:#94a3b8;
  /* Borders */
  --border-subtle:rgba(15,23,42,.07);--border-default:rgba(15,23,42,.12);--border-strong:rgba(15,23,42,.22);
  /* Legacy compat aliases */
  --surface:var(--bg-base);--surface-low:var(--bg-deep);--surface-lowest:var(--bg-card);--surface-high:var(--bg-raised);--surface-container:var(--bg-hover);
  --on-surface:var(--text-1);--on-surface-variant:var(--text-2);--outline-variant:var(--border-subtle);--outline:var(--text-3);
  --error-container:var(--error-dim);--success-container:var(--success-dim);--warning-container:var(--warning-dim);--info-container:var(--info-dim);
  --secondary-container:rgba(124,58,237,.1);
  /* Typography */
  --font-body:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono','Fira Code',monospace;
  /* Radii */
  --radius-sm:4px;--radius-md:8px;--radius-lg:12px;--radius-xl:20px;
  /* Shadows */
  --shadow-ambient:0 1px 8px rgba(15,23,42,.08);--shadow-card:0 4px 20px rgba(15,23,42,.1);--shadow-modal:0 24px 60px rgba(15,23,42,.2);
}
*{box-sizing:border-box}
body{font-family:var(--font-body);background:var(--bg-base);margin:0;color:var(--text-1);font-size:.875rem;line-height:1.5}
.mono{font-family:var(--font-mono)}
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 20;vertical-align:middle;line-height:1}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg-deep)}
::-webkit-scrollbar-thumb{background:var(--border-default);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}

/* Header brand */
.app-header{position:fixed;top:0;left:0;right:0;height:48px;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;padding:0 14px;gap:10px;z-index:50;box-shadow:0 1px 12px rgba(15,23,42,.08)}
.app-brand{display:flex;align-items:center;gap:10px;flex:0 0 220px;min-width:220px;padding-right:14px;border-right:1px solid var(--border-subtle);height:100%}
.app-brand-mark{width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg,#eff6ff,#dbeafe);border:1px solid rgba(37,99,235,.14);box-shadow:0 4px 16px rgba(37,99,235,.12);overflow:hidden;flex-shrink:0;border-radius:10px}
.app-brand-logo{width:100%;height:100%;object-fit:contain;display:block}
.app-brand-fallback{display:none;align-items:center;justify-content:center;width:100%;height:100%;font-size:.78rem;font-weight:800;letter-spacing:.08em;color:var(--primary);font-family:var(--font-mono)}
.app-brand-copy{display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:0}
.app-brand-title{font-size:.82rem;font-weight:800;letter-spacing:.02em;color:var(--text-1);line-height:1;white-space:nowrap}
.app-brand-caption{font-size:.58rem;color:var(--text-3);font-family:var(--font-mono);line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:152px}
.app-brand-meta{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
.app-version-chip{font-size:.58rem;font-weight:700;background:var(--primary);color:#fff;padding:1px 6px;letter-spacing:.03em;flex-shrink:0;border-radius:999px}
.app-build-chip{font-size:.56rem;font-weight:700;padding:2px 6px;letter-spacing:.05em;flex-shrink:0;border-radius:999px}
@media (max-width: 900px){.app-brand{flex-basis:170px;min-width:170px}.app-brand-caption{display:none}.app-build-chip{display:none}}

/* Stat cards */
.sn{font-family:var(--font-mono);font-size:1.6rem;font-weight:700;transition:color .3s;line-height:1}
.sn.changed{animation:pop .4s}
.sl{font-size:.6rem;color:var(--text-2);margin-top:6px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
@keyframes pop{0%{transform:scale(1)}50%{transform:scale(1.15)}100%{transform:scale(1)}}
#statsRow > div{background:var(--bg-card)!important;border:1px solid var(--border-subtle)!important;border-radius:var(--radius-md)!important;transition:box-shadow .15s,transform .15s,border-color .15s;cursor:default}
#statsRow > div:hover{box-shadow:var(--shadow-card);transform:translateY(-2px);border-color:var(--border-default)!important}

/* Table */
.sc{background:var(--bg-card);box-shadow:var(--shadow-ambient);border-radius:var(--radius-lg)!important;overflow:hidden;border:1px solid var(--border-subtle)}
.tc{background:var(--bg-card);box-shadow:var(--shadow-ambient);border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important}
.furl{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sort-icon{font-size:.55rem;color:var(--primary);margin-left:2px}
.main-table{width:100%;border-collapse:collapse;font-size:.8rem;table-layout:fixed}
.main-table thead th{font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);user-select:none;padding:.7rem .75rem;background:var(--bg-surface);border-bottom:1px solid var(--border-default);white-space:nowrap;overflow:hidden}
.main-table thead th[onclick]:hover{background:var(--bg-raised);cursor:pointer;color:var(--text-1)}
.main-table tbody td{padding:.55rem .75rem;border-bottom:1px solid var(--border-subtle);vertical-align:middle;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:44px;max-height:44px}
.main-table tbody tr{background:var(--bg-card);transition:background .1s;cursor:pointer}
.main-table tbody tr:nth-child(even){background:var(--bg-raised)}
.main-table tbody tr:hover{background:var(--primary-glow)}
.main-table .company-meta{display:none}
.main-table td.action-cell{overflow:visible;cursor:default}
tr.excluded{opacity:.3}
tr.updated{animation:rowFlash .8s}
@keyframes rowFlash{0%{background:rgba(16,185,129,.15)}100%{background:transparent}}

/* Filter buttons */
.fb{font-size:.7rem;padding:4px 13px;border:1px solid var(--border-default);background:transparent;color:var(--text-2);cursor:pointer;transition:all .15s;font-weight:500;border-radius:var(--radius-xl)!important}
.fb.active{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:0 2px 10px rgba(59,130,246,.3)}
.fb:not(.active):hover{background:var(--bg-raised);color:var(--text-1);border-color:var(--border-strong)}

/* Filter bar */
.filter-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:10px;margin-top:8px}
.filter-field{display:flex;align-items:center;gap:4px;background:var(--bg-deep);border:1px solid var(--border-default);border-radius:7px;padding:0 8px;height:30px;transition:border-color .15s,box-shadow .15s;flex-shrink:0}
.filter-field:focus-within{border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,130,246,.1)}
.filter-field .ms{font-size:14px;color:var(--text-3);flex-shrink:0;font-family:'Material Symbols Outlined';font-variation-settings:'FILL' 0,'wght' 300}
.filter-field select,.filter-field input{border:none;background:transparent;outline:none;font-size:.78rem;color:var(--text-1);font-family:var(--font-body);min-width:0}
.filter-field select{min-width:100px;cursor:pointer}
.filter-field input{width:170px}
.filter-field input::placeholder{color:var(--text-3)}
.filter-clear-btn{display:none;align-items:center;gap:3px;padding:3px 9px;font-size:.7rem;font-weight:600;border:1px solid var(--border-default);border-radius:6px;background:transparent;color:var(--text-2);cursor:pointer;transition:all .15s;white-space:nowrap}
.filter-clear-btn:hover{background:var(--bg-raised);color:var(--text-1)}
.filter-clear-btn.visible{display:flex}

/* Tab system */
.tab-content{display:none}
.tab-content.active{display:block}

/* Horizontal tab bar */
#mainTabNav{position:sticky;top:48px;z-index:39;background:var(--bg-surface);border-bottom:1px solid var(--border-subtle);display:flex;align-items:stretch;padding:0 12px;gap:0;box-shadow:0 2px 12px rgba(0,0,0,.3)}
.tab-btn{display:inline-flex;align-items:center;gap:7px;padding:10px 16px;font-size:.78rem;font-weight:500;background:none;border:none;border-bottom:2px solid transparent;color:var(--text-2);cursor:pointer;transition:all .15s;white-space:nowrap;flex-shrink:0;border-radius:0!important;letter-spacing:.01em}
.tab-btn:hover{color:var(--text-1);background:var(--bg-hover)}
.tab-btn.active{color:var(--primary);border-bottom-color:var(--primary);font-weight:700;background:var(--primary-glow)}
.tab-btn .tab-icon{font-size:16px;opacity:.6;flex-shrink:0}
.tab-btn.active .tab-icon{opacity:1}

/* Badges / chips */
.badge,.chip{display:inline-block;font-size:.58rem;font-weight:700;letter-spacing:.04em;padding:2px 7px;border-radius:var(--radius-xl)!important}
.chip-success{background:var(--success-dim);color:var(--success);border:1px solid rgba(16,185,129,.2)}
.chip-error{background:var(--error-dim);color:var(--error);border:1px solid rgba(239,68,68,.2)}
.chip-warning{background:var(--warning-dim);color:var(--warning);border:1px solid rgba(245,158,11,.2)}
.chip-info{background:var(--info-dim);color:var(--info);border:1px solid rgba(139,92,246,.2)}
.chip-neutral{background:var(--bg-raised);color:var(--text-2);border:1px solid var(--border-subtle)}
.chip-primary{background:rgba(59,130,246,.15);color:var(--primary);border:1px solid rgba(59,130,246,.25)}
.badge{border-radius:var(--radius-xl)!important}
.badge.bg-success{background:var(--success-dim)!important;color:var(--success)!important}
.badge.bg-danger{background:var(--error-dim)!important;color:var(--error)!important}
.badge.bg-warning,.badge.bg-warning.text-dark{background:var(--warning-dim)!important;color:var(--warning)!important}
.badge.bg-info{background:var(--info-dim)!important;color:var(--info)!important}
.badge.bg-secondary{background:var(--bg-raised)!important;color:var(--text-2)!important}
.badge.bg-primary{background:rgba(59,130,246,.15)!important;color:var(--primary)!important;border:1px solid rgba(59,130,246,.25)}

/* Live dot */
.live-dot{width:7px;height:7px;border-radius:50%!important;display:inline-block;flex-shrink:0;background:var(--text-3)}
.live-dot.on{background:var(--success);box-shadow:0 0 0 0 rgba(16,185,129,.5);animation:pulse 2.2s infinite}
.live-dot.off{background:var(--error);animation:none}
.live-dot.warn{background:var(--warning)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}70%{box-shadow:0 0 0 6px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}

/* Progress pipeline */
.progress-pipeline{display:flex;gap:1px;align-items:stretch;height:8px;margin:.4rem 0;border-radius:var(--radius-sm);overflow:hidden}
.pip-seg{height:8px;transition:width .5s;min-width:2px}
.log-entry{font-size:.72rem;font-family:var(--font-mono);color:var(--text-2);padding:4px 10px;margin:2px 0;background:var(--bg-surface);border-left:2px solid var(--border-default);border-radius:0 var(--radius-sm) var(--radius-sm) 0!important;transition:background .1s}
.log-entry:hover{background:var(--bg-hover)}
.log-entry.error{background:var(--error-dim);border-left-color:var(--error)}
.log-entry.success{background:var(--success-dim);border-left-color:var(--success)}
.ts{font-size:.65rem;color:var(--text-3)}

/* Toast */
.toast-container{position:fixed;top:3.5rem;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px}
.toast-msg{padding:11px 18px;font-size:.8rem;font-weight:600;box-shadow:var(--shadow-modal);animation:slideIn .25s cubic-bezier(.34,1.56,.64,1);border-radius:var(--radius-md)!important;border:1px solid var(--border-default);backdrop-filter:blur(8px)}
.toast-msg.success{background:rgba(16,185,129,.15);color:var(--success);border-color:rgba(16,185,129,.3)}
.toast-msg.error{background:rgba(239,68,68,.15);color:var(--error);border-color:rgba(239,68,68,.3)}
.toast-msg.info{background:rgba(59,130,246,.15);color:var(--primary);border-color:rgba(59,130,246,.3)}
@keyframes slideIn{from{opacity:0;transform:translateX(24px) scale(.95)}to{opacity:1;transform:translateX(0) scale(1)}}

/* Memo dropdown panel */
#memoBtn{display:none;align-items:center;gap:5px;background:var(--warning-dim);border:1px solid rgba(245,158,11,.25);padding:4px 10px;font-size:.72rem;font-weight:600;cursor:pointer;color:var(--warning);transition:all .12s;white-space:nowrap;border-radius:var(--radius-sm)!important}
#memoBtn:hover{filter:brightness(1.15)}
#memoBtn.has-issues{display:flex}
#memoBadge{background:var(--warning);color:#000;font-size:.58rem;font-weight:700;padding:1px 5px;border-radius:var(--radius-xl)}
#memoPanel{display:none;position:fixed;top:48px;right:0;z-index:48;width:360px;background:var(--bg-card);border:1px solid rgba(245,158,11,.2);border-top:none;box-shadow:var(--shadow-modal);padding:14px 18px;animation:slideIn .15s ease}
#memoPanel.open{display:block}
#memoPanel strong{font-size:.82rem;font-weight:700;color:#92400e}
#memoPanel ul{margin:6px 0 0;padding-left:16px}
#memoPanel li{font-size:.78rem;line-height:1.5;margin-bottom:3px;color:var(--on-surface)}
.status-meta{font-size:.72rem;color:var(--on-surface-variant);margin-top:6px}

/* Action buttons */
.btn-act{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;font-size:.72rem;font-weight:600;border:1px solid;cursor:pointer;transition:all .15s;border-radius:var(--radius-sm)!important}
.btn-act:active{transform:translateY(1px)}
.btn-act-primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.btn-act-primary:hover{background:var(--primary-dim);border-color:var(--primary-dim);box-shadow:0 0 12px rgba(59,130,246,.3)}
.btn-act-success{background:var(--success);color:#000;border-color:var(--success)}
.btn-act-success:hover{opacity:.85;box-shadow:0 0 12px rgba(16,185,129,.25)}
.btn-act-danger{background:none;color:var(--error);border-color:rgba(239,68,68,.4)}
.btn-act-danger:hover{background:var(--error-dim);border-color:var(--error)}
.btn-act-neutral{background:var(--bg-raised);color:var(--text-1);border-color:var(--border-default)}
.btn-act-neutral:hover{background:rgba(255,255,255,.1);border-color:var(--border-strong)}
.company-action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%;max-width:196px}
.company-action-grid.single-row{grid-template-columns:repeat(2,minmax(0,1fr))}
.company-action-btn{display:inline-flex;align-items:center;justify-content:center;width:100%;min-width:0;padding:6px 8px;font-size:.71rem;font-weight:700;line-height:1.2;border-radius:var(--radius-sm)!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.company-action-grid .btn{margin:0!important}
/* legacy Bootstrap compat — used in JS-generated table buttons */
.btn{display:inline-flex;align-items:center;gap:3px;font-size:.73rem;font-weight:600;border:1px solid var(--border-default);cursor:pointer;transition:all .15s;padding:4px 11px;border-radius:var(--radius-sm)!important;background:rgba(255,255,255,.05);color:var(--text-1)}
.btn:active{transform:translateY(1px)}
.btn-sm{padding:3px 9px;font-size:.68rem}
.btn-success{background:var(--success);color:#000;border-color:var(--success)}
.btn-success:hover{opacity:.85;box-shadow:0 0 12px rgba(16,185,129,.25)}
.btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.btn-primary:hover{background:var(--primary-dim);box-shadow:0 0 12px rgba(59,130,246,.25)}
.btn-outline-danger{background:none;color:var(--error);border-color:rgba(239,68,68,.4)}
.btn-outline-danger:hover{background:var(--error-dim);border-color:var(--error)}
.btn-outline-primary{background:none;color:var(--primary);border-color:rgba(59,130,246,.4)}
.btn-outline-primary:hover{background:var(--primary-glow);border-color:var(--primary)}
.btn-outline-secondary{background:none;color:var(--text-2);border-color:var(--border-default)}
.btn-outline-secondary:hover{background:var(--bg-raised);color:var(--text-1)}
.btn-close{background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-2);padding:0;line-height:1}
.btn-close:hover{color:var(--text-1)}

/* Spinner */
.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.15);border-top-color:var(--primary);border-radius:50%!important;animation:spin .6s linear infinite;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

/* Card containers for awaiting/sent */
.awaiting-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-left:3px solid var(--warning);margin-bottom:10px;border-radius:var(--radius-md)!important;box-shadow:var(--shadow-ambient);transition:box-shadow .15s,border-color .15s}
.awaiting-card:hover{box-shadow:var(--shadow-card);border-color:var(--border-default)}
.sent-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-left:3px solid var(--success);margin-bottom:10px;border-radius:var(--radius-md)!important;box-shadow:var(--shadow-ambient);transition:box-shadow .15s}
.sent-card:hover{box-shadow:var(--shadow-card)}
.row-danger td{background:rgba(239,68,68,.06)!important}
.row-success td{background:rgba(16,185,129,.06)!important}
.row-warning td{background:rgba(245,158,11,.06)!important}

/* Bootstrap grid compat — used in render() JS */
.row{display:flex;flex-wrap:wrap;gap:12px}.col-md-4{width:calc(33.333% - 8px);min-width:200px}.col-md-8{width:calc(66.666% - 4px)}.g-3,.row.g-3{gap:12px}
.d-flex{display:flex}.align-items-center{align-items:center}.justify-content-between{justify-content:space-between}.flex-wrap{flex-wrap:wrap}.flex-column{flex-direction:column}.gap-1{gap:4px}.gap-2{gap:8px}.gap-3{gap:12px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:12px}.mt-1{margin-top:4px}.mt-2{margin-top:8px}.ms-2{margin-left:8px}.ms-auto{margin-left:auto}.me-1{margin-right:4px}.me-2{margin-right:8px}.fw-bold{font-weight:700}.text-muted{color:var(--on-surface-variant)}.text-center{text-align:center}.py-4{padding:16px 0}.py-0{padding-top:0;padding-bottom:0}.px-1{padding-left:4px;padding-right:4px}.form-check-input{width:16px;height:16px;cursor:pointer}

/* Form inputs */
.form-control,.form-control-sm{width:100%;padding:7px 11px;border:1px solid var(--border-default);background:var(--bg-deep);color:var(--text-1);font-size:.82rem;font-family:var(--font-body);transition:border-color .15s,box-shadow .15s;border-radius:var(--radius-sm)!important}
.form-control-sm{font-size:.78rem;padding:5px 9px}
.form-control:focus,.form-control-sm:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,130,246,.15)}

/* Settings */
.settings-layout{display:flex;gap:0;min-height:500px}
.settings-sidebar{width:210px;background:var(--bg-surface);border-right:1px solid var(--border-subtle);padding:8px 0;flex-shrink:0}
.settings-sidebar-btn{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;border-left:3px solid transparent;padding:9px 18px;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);cursor:pointer;transition:all .12s}
.settings-sidebar-btn:hover{background:var(--bg-hover);color:var(--text-1)}
.settings-sidebar-btn.active{background:var(--primary-glow);color:var(--primary);font-weight:700;border-left-color:var(--primary)}
.settings-sidebar-label{min-width:0;flex:1}
.settings-sidebar-status{display:inline-flex;align-items:center;justify-content:center;padding:2px 6px;border:1px solid var(--border-default);font-size:.58rem;font-weight:700;letter-spacing:.04em;text-transform:none;color:var(--text-3);background:var(--bg-card);white-space:nowrap;border-radius:var(--radius-sm)!important}
.settings-sidebar-status.ready{border-color:rgba(16,185,129,.3);color:var(--success);background:var(--success-dim)}
.settings-sidebar-status.attention{border-color:rgba(245,158,11,.3);color:var(--warning);background:var(--warning-dim)}
.settings-sidebar-status.optional{border-color:var(--border-subtle);color:var(--text-3);background:transparent}
.settings-main{flex:1;padding:20px 24px;background:var(--bg-card);overflow-y:auto;max-height:75vh}
.settings-section{display:none}
.settings-section.active{display:block}
.settings-section h3{font-size:.9rem;font-weight:700;margin-bottom:4px;color:var(--text-1);text-transform:uppercase;letter-spacing:.06em}
.settings-section .section-desc{font-size:.78rem;color:var(--text-2);margin-bottom:18px}
.settings-callout{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid var(--border-subtle);margin-bottom:16px;background:var(--bg-surface);font-size:.76rem;color:var(--text-2);border-radius:var(--radius-sm)!important}
.settings-callout.required{background:var(--warning-dim);border-color:rgba(245,158,11,.25);color:var(--warning)}
.settings-callout.recommended{background:var(--info-dim);border-color:rgba(139,92,246,.25);color:var(--info)}
.settings-callout.optional{background:var(--bg-surface);color:var(--text-2)}
.settings-callout strong{color:inherit}
.settings-group{margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border-subtle)}
.settings-group:last-child{border-bottom:none}
.settings-group label{display:block;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin-bottom:5px}
.settings-group .help-text{font-size:.68rem;color:var(--text-3);margin-top:3px}
.settings-group input[type="text"],.settings-group input[type="number"],.settings-group input[type="email"],.settings-group input[type="tel"],.settings-group textarea,.settings-group select{width:100%;padding:7px 11px;border:1px solid var(--border-default);font-size:.82rem;background:var(--bg-deep);color:var(--text-1);transition:border-color .15s,box-shadow .15s;font-family:var(--font-body);border-radius:var(--radius-sm)!important}
.settings-group input:focus,.settings-group textarea:focus,.settings-group select:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.settings-group textarea{min-height:80px;resize:vertical}
.settings-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.settings-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.settings-field-chip{display:inline-flex;align-items:center;padding:1px 6px;border:1px solid var(--outline-variant);font-size:.56rem;font-weight:800;letter-spacing:.04em;color:var(--on-surface-variant);background:var(--surface-lowest);vertical-align:middle;margin-left:6px}
.settings-field-chip.required{background:var(--warning-container);border-color:rgba(138,87,0,.22);color:var(--warning)}
.settings-field-chip.recommended{background:var(--info-container);border-color:rgba(26,111,154,.22);color:var(--info)}
.settings-field-chip.optional{background:var(--surface-low);color:var(--outline)}
/* === Setup Guide redesign: compact list === */
.settings-setup-guide{border:1px solid var(--border-default);background:var(--bg-card);padding:0;margin-bottom:18px;box-shadow:var(--shadow-ambient);border-radius:var(--radius-lg)!important;overflow:hidden}
.settings-setup-head{display:flex;align-items:center;gap:16px;padding:14px 18px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,var(--primary-glow) 0%,transparent 100%)}
.settings-setup-eyebrow{font-size:.58rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--primary);margin-bottom:3px}
.settings-setup-title{font-size:.88rem;font-weight:800;margin:0;color:var(--text-1);letter-spacing:.02em}
.settings-setup-overview{display:flex;align-items:center;gap:12px;margin-left:auto;flex-shrink:0}
.settings-setup-progress-label{font-size:.78rem;font-weight:800;color:var(--text-1);white-space:nowrap}
.settings-setup-progress-track{width:120px;height:6px;background:var(--bg-raised);overflow:hidden;border-radius:3px!important;flex-shrink:0}
.settings-setup-progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--primary) 0%,#60a5fa 100%);width:0;transition:width .3s ease;border-radius:3px!important}
.settings-setup-progress-note{font-size:.7rem;color:var(--text-2);white-space:nowrap}
/* Grid → list rows */
.settings-setup-grid{display:flex;flex-direction:column;gap:0}
.setup-check-card{display:flex;align-items:center;gap:14px;width:100%;padding:11px 18px;background:var(--bg-card);border:none;border-bottom:1px solid var(--border-subtle);text-align:left;cursor:pointer;transition:background .12s;border-radius:0!important}
.setup-check-card:last-child{border-bottom:none}
.setup-check-card:hover{background:var(--bg-raised)}
.setup-check-card-head{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.setup-check-card-title{font-size:.8rem;font-weight:700;color:var(--text-1);white-space:nowrap}
.setup-check-card-hint{font-size:.72rem;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.setup-status-chip{display:inline-flex;align-items:center;justify-content:center;padding:2px 10px;font-size:.6rem;font-weight:700;letter-spacing:.03em;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-3);white-space:nowrap;border-radius:var(--radius-xl)!important;flex-shrink:0}
.setup-status-chip.ready{background:var(--success-dim);border-color:rgba(5,150,105,.25);color:var(--success)}
.setup-status-chip.attention{background:var(--warning-dim);border-color:rgba(217,119,6,.25);color:var(--warning)}
.setup-status-chip.optional{background:transparent;border-color:var(--border-subtle);color:var(--text-3)}
/* show setup checklist items inline so minimum required fields are always visible */
.setup-check-list{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:8px;padding:0;list-style:none}
.setup-check-item{display:flex;align-items:flex-start;gap:8px;font-size:.72rem;color:var(--text-1)}
.setup-check-item.pending{color:var(--text-2)}
.setup-check-dot{width:10px;height:10px;border:2px solid var(--border-default);margin-top:3px;flex-shrink:0;background:transparent;border-radius:2px!important}
.setup-check-item.done .setup-check-dot{background:var(--success);border-color:var(--success)}
.setup-check-level{margin-left:6px}
.list-manager{border:1px solid var(--border-subtle);padding:10px;background:var(--bg-surface);border-radius:var(--radius-sm)!important}
.list-manager .list-item{display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg-card);border:1px solid var(--border-subtle);margin-bottom:4px;font-size:.78rem;border-radius:var(--radius-sm)!important}
.list-manager .list-item .remove-btn{background:none;border:none;color:var(--error);cursor:pointer;font-size:1rem;padding:0 4px;line-height:1}
.list-manager .add-row{display:flex;gap:6px;margin-top:8px}
.list-manager .add-row input{flex:1;padding:5px 9px;border:1px solid var(--border-default);font-size:.78rem;background:var(--bg-deep);color:var(--text-1);border-radius:var(--radius-sm)!important}
.list-manager .add-row button{padding:5px 13px;background:var(--primary);color:#fff;border:none;font-size:.75rem;cursor:pointer;font-weight:600;border-radius:var(--radius-sm)!important}
.save-bar{position:sticky;bottom:0;background:var(--bg-card);border-top:1px solid var(--border-subtle);padding:10px 0;display:flex;justify-content:flex-end;gap:8px;z-index:10}
.save-bar .btn-save{padding:7px 22px;background:var(--primary);color:#fff;border:none;font-size:.8rem;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.05em;transition:all .12s;border-radius:var(--radius-sm)!important}
.save-bar .btn-save:hover{opacity:.85;box-shadow:0 0 14px rgba(59,130,246,.3)}

/* Preview/mapping tables */
.preview-table{font-size:.72rem;width:100%;border-collapse:collapse;margin-top:8px}
.preview-table th,.preview-table td{padding:4px 8px;border:1px solid var(--border-subtle);text-align:left;color:var(--text-1)}
.preview-table th{background:var(--bg-surface);font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-size:.62rem;color:var(--text-2)}
.settings-path-picker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.btn-picker{padding:7px 12px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-1);font-size:.75rem;font-weight:700;cursor:pointer;white-space:nowrap;border-radius:var(--radius-sm)!important}
.btn-picker:hover{background:var(--bg-raised)}
.column-map-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.column-map-list{display:flex;flex-direction:column;gap:6px}
.column-map-row{display:grid;grid-template-columns:minmax(0,1fr) 92px auto;gap:8px;align-items:center}
.column-map-row label,.column-map-label{font-size:.75rem;font-weight:700;color:var(--text-1)}
.column-map-row input[type="number"]{width:92px;padding:4px 8px;border:1px solid var(--border-default);font-size:.78rem;text-align:center;background:var(--bg-deep);color:var(--text-1);border-radius:var(--radius-sm)!important}
.column-map-row .column-map-key{width:100%;padding:4px 8px;border:1px solid var(--border-default);font-size:.78rem;background:var(--bg-deep);color:var(--text-1);border-radius:var(--radius-sm)!important}
.column-map-row .remove-btn{justify-self:end}
.obj-list-item{border:1px solid var(--border-subtle);padding:10px;margin-bottom:8px;background:var(--bg-surface);border-radius:var(--radius-sm)!important}
.obj-list-item .obj-row{display:flex;gap:8px;margin-bottom:4px;align-items:center}
.obj-list-item .obj-row label{font-size:.7rem;color:var(--text-2);min-width:60px}
.obj-list-item .obj-row input{flex:1;padding:4px 8px;border:1px solid var(--border-default);font-size:.78rem;background:var(--bg-deep);color:var(--text-1);border-radius:var(--radius-sm)!important}
.company-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.bulk-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.company-meta{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.checkbox-cell{text-align:center;width:34px}
.modal-shell{position:fixed;top:0;left:0;width:100%;height:100%;padding:18px;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:9998;display:none;align-items:center;justify-content:center}
.modal-shell.open{display:flex}
.modal-panel{background:var(--bg-card);border:1px solid var(--border-default);width:min(760px,100%);max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-modal);border-radius:var(--radius-lg)!important}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border-subtle)}
.modal-head h3{margin:0;font-size:.88rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--text-1)}
.modal-body{padding:18px}
.modal-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modal-grid-full{grid-column:1/-1}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;padding:0 18px 18px}
@media (max-width: 960px){#liveMonitorBody{grid-template-columns:1fr!important}#liveMonitorBody > div:first-child{border-right:none!important;border-bottom:1px solid var(--border-subtle)!important}}
@keyframes monitorPulse{0%,100%{opacity:1}50%{opacity:.4}}
.monitor-dot-active{animation:monitorPulse 1.6s ease-in-out infinite}
@media (max-width: 840px){.modal-grid{grid-template-columns:1fr}.company-toolbar{flex-direction:column}.bulk-toolbar{justify-content:flex-start}.settings-row,.settings-row-3{grid-template-columns:1fr}.settings-setup-head{flex-direction:column}.settings-sidebar{width:180px}}

/* Analytics cards */
.stat-card{transition:transform .18s,box-shadow .18s}
.stat-card:hover{transform:translateY(-2px)}
.stat-card-primary{background:linear-gradient(135deg,rgba(59,130,246,.25),rgba(29,78,216,.35));color:var(--text-1);border:1px solid rgba(59,130,246,.2)}

/* Chart containers */
.chart-panel{background:var(--bg-card);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-card);padding:20px;border:1px solid var(--border-subtle)}
@keyframes modalIn{from{opacity:0;transform:scale(.95) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
/* Launch Modal Provider Cards */
.launch-provider-card{flex:1;display:flex;flex-direction:column;align-items:center;padding:12px 8px 10px;border:2px solid #e2e8f0;border-radius:14px;cursor:pointer;transition:all .2s;background:#fff;gap:5px;position:relative;min-width:0;text-align:center}
.launch-provider-card:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.1)}
.launch-provider-card.selected.claude{border-color:#CC785C;background:linear-gradient(145deg,#fff7f3,#fff)}
.launch-provider-card.selected.codex{border-color:#10a37f;background:linear-gradient(145deg,#f0fdf8,#fff)}
.launch-provider-card.selected.gemini{border-color:#4285F4;background:linear-gradient(145deg,#eff6ff,#fff)}
.lp-icon{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.lp-name{font-size:.74rem;font-weight:800;letter-spacing:.02em;line-height:1}
.lp-sub{font-size:.58rem;color:#94a3b8;line-height:1}
.lp-check{position:absolute;top:7px;right:7px;width:16px;height:16px;border-radius:50%;display:none;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff}
.launch-provider-card.selected .lp-check{display:flex}
.launch-provider-card.selected.claude .lp-check{background:#CC785C}
.launch-provider-card.selected.codex .lp-check{background:#10a37f}
.launch-provider-card.selected.gemini .lp-check{background:#4285F4}
</style>
</head>
<body>
<!-- Toast container -->
<div class="toast-container" id="toastContainer"></div>

<!-- Top App Bar -->
<header class="app-header">
  <!-- Logo area -->
  <div class="app-brand">
    <div class="app-brand-mark">
      <img src="/assets/icon.png" alt="Sales Claw" class="app-brand-logo" onerror="this.style.display='none';var fallback=this.nextElementSibling;if(fallback)fallback.style.display='flex'">
      <span class="app-brand-fallback">SC</span>
    </div>
    <div class="app-brand-copy">
      <span class="app-brand-title">Sales Claw</span>
      <span class="app-brand-caption">${buildMeta.title}</span>
    </div>
  </div>
  <div class="app-brand-meta">
    <span title="Version ${APP_VERSION}" class="app-version-chip">v${APP_VERSION}</span>
    <span class="app-build-chip" style="color:${buildMeta.fg};background:${buildMeta.bg}" title="${buildMeta.title}">${buildMeta.label}</span>
  <!-- Live status -->
  <div style="display:flex;align-items:center;gap:6px;margin-right:2px">
    <span class="live-dot on" id="liveDot"></span>
    <span style="font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-2)" id="liveLabel">${_t['app.live'] || 'LIVE'}</span>
  </div>
  <small style="font-size:.62rem;color:var(--text-3);margin-right:auto;font-family:var(--font-mono)" id="lastUpdate"></small>
  </div>
  <!-- AI status + mode widget -->
  <div style="display:flex;align-items:center;gap:0;background:var(--bg-raised);border:1px solid var(--border-default);font-size:.72rem;border-radius:var(--radius-sm)">
    <div id="claudeStatusWidget" style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-right:1px solid var(--border-subtle)">
      <span id="claudeStatusDot" class="live-dot" style="width:7px;height:7px"></span>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" style="flex-shrink:0;opacity:.6"><path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>
      <span id="claudeStatusLabel" style="color:var(--text-2);white-space:nowrap">AI</span>
    </div>
    <button id="claudeActionBtn" onclick="claudeAction()" style="display:none;background:var(--primary);border:none;border-left:1px solid var(--border-subtle);color:#fff;font-size:.68rem;padding:4px 10px;cursor:pointer;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;border-radius:0 var(--radius-sm) var(--radius-sm) 0"></button>
    <button id="claudeStopBtn" onclick="stopClaude()" style="display:none;background:#dc2626;border:none;border-left:1px solid var(--border-subtle);color:#fff;font-size:.68rem;padding:4px 10px;cursor:pointer;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;border-radius:0 var(--radius-sm) var(--radius-sm) 0">STOP</button>
  </div>
  <!-- Icon buttons -->
  <button onclick="showDocsModal()" title="${_t['app.docsTitle']}" style="display:flex;align-items:center;gap:4px;background:var(--bg-raised);border:1px solid var(--border-default);padding:4px 10px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;color:var(--text-2);transition:all .12s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)'" onmouseout="this.style.background='var(--bg-raised)';this.style.color='var(--text-2)'">
    <span class="material-symbols-outlined" style="font-size:15px">description</span>
    ${_t['app.docs']}
  </button>
  <button onclick="location.href='/api/export'" style="display:flex;align-items:center;gap:4px;background:var(--bg-raised);border:1px solid var(--border-default);padding:4px 10px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;color:var(--text-2);transition:all .12s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)'" onmouseout="this.style.background='var(--bg-raised)';this.style.color='var(--text-2)'">
    <span class="material-symbols-outlined" style="font-size:15px">download</span>
    ${_t['app.export'] || 'Export'}
  </button>
  <!-- 運用メモボタン -->
  <button id="memoBtn" onclick="toggleMemoPanel()" title="運用メモ">
    <span class="material-symbols-outlined" style="font-size:15px">sticky_note_2</span>
    運用メモ
    <span id="memoBadge">0</span>
  </button>
</header>

<!-- 運用メモパネル (dropdown) -->
<div id="memoPanel"></div>

<!-- sidebarLastUpdate hidden element (kept for JS compat) -->
<span id="sidebarLastUpdate" style="display:none"></span>
<span id="headerLastUpdate" style="display:none"></span>

<!-- Auto-update banner (shown by pollUpdateStatus) -->
<div id="updateBanner" style="display:none;position:fixed;top:48px;left:0;right:0;z-index:49;background:#0043ce;color:#fff;padding:6px 16px;font-size:.75rem;font-weight:600;align-items:center;gap:8px;justify-content:center"></div>

<!-- Docs Modal -->
<!-- AI 起動モード選択モーダル -->
<div id="launchModal" onclick="if(event.target===this)closeLaunchModal()" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,.75);backdrop-filter:blur(6px);z-index:10000;align-items:center;justify-content:center">
  <div style="background:#fff;width:560px;max-width:95vw;border-radius:24px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.28);animation:modalIn .22s cubic-bezier(.34,1.2,.64,1)">
    <!-- ヘッダー: プロバイダー別動的グラデーション -->
    <div id="launchModalHeader" style="background:linear-gradient(135deg,#CC785C,#E8935A);padding:20px 24px;position:relative;overflow:hidden">
      <div style="position:absolute;top:-30px;right:-30px;width:130px;height:130px;background:rgba(255,255,255,.07);border-radius:50%"></div>
      <div style="position:absolute;bottom:-40px;right:55px;width:80px;height:80px;background:rgba(0,0,0,.06);border-radius:50%"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;position:relative">
        <div style="display:flex;align-items:center;gap:14px">
          <div id="launchModalHeaderIcon" style="width:46px;height:46px;border-radius:14px;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.64 5.64l1.77 1.77M16.59 16.59l1.77 1.77M5.64 18.36l1.77-1.77M16.59 7.41l1.77-1.77" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>
          </div>
          <div>
            <div id="launchProviderTitle" style="color:#fff;font-size:1.15rem;font-weight:900;letter-spacing:.02em">AI を起動</div>
            <div id="launchProviderSubtitle" style="color:rgba(255,255,255,.78);font-size:.72rem;margin-top:2px">起動する AI とモードを選択してください</div>
          </div>
        </div>
        <button onclick="closeLaunchModal()" style="background:rgba(255,255,255,.15);border:none;color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:1.1rem;display:flex;align-items:center;justify-content:center;transition:background .15s" onmouseover="this.style.background='rgba(255,255,255,.28)'" onmouseout="this.style.background='rgba(255,255,255,.15)'">&times;</button>
      </div>
    </div>
    <!-- ボディ -->
    <div style="padding:20px 20px 12px">
      <div style="display:flex;flex-direction:column;gap:14px">
        <!-- プロバイダー選択カード -->
        <div>
          <div style="font-size:.6rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px">${_lang === 'ja' ? '起動する AI' : 'AI Provider'}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <div id="launchProviderCard_claude" class="launch-provider-card claude" onclick="selectLaunchProvider('claude')">
              <div class="lp-check">✓</div>
              <div class="lp-icon" style="background:linear-gradient(135deg,#CC785C,#E8935A)">
                <img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/claude-code/default.svg" width="26" height="26" alt="Claude Code" style="filter:brightness(0) invert(1)">
              </div>
              <div class="lp-name" style="color:#7c3d1e">Claude</div>
              <div class="lp-sub">Anthropic</div>
            </div>
            <div id="launchProviderCard_codex" class="launch-provider-card codex" onclick="selectLaunchProvider('codex')">
              <div class="lp-check">✓</div>
              <div class="lp-icon" style="background:linear-gradient(135deg,#ecfdf5,#d1fae5)">
                <img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/codex-openai/default.svg" width="26" height="26" alt="Codex">
              </div>
              <div class="lp-name" style="color:#065f46">Codex</div>
              <div class="lp-sub">OpenAI</div>
            </div>
            <div id="launchProviderCard_gemini" class="launch-provider-card gemini" onclick="selectLaunchProvider('gemini')">
              <div class="lp-check">✓</div>
              <div class="lp-icon" style="background:linear-gradient(135deg,#eff6ff,#dbeafe)">
                <img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/gemini-cli/default.svg" width="26" height="26" alt="Gemini CLI">
              </div>
              <div class="lp-name" style="color:#1d4ed8">Gemini</div>
              <div class="lp-sub">Google</div>
            </div>
          </div>
        </div>
        <select id="launchProviderSelect" style="display:none">${providerSelectHtml}</select>
        <div id="launchProviderBadge" style="display:none"></div>
        <!-- プロバイダーノート -->
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:11px 14px">
          <div style="font-size:.6rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:3px">${_lang === 'ja' ? '通常利用' : 'Recommended'}</div>
          <div id="launchProviderNote" style="font-size:.76rem;color:#475569;line-height:1.6">${_lang === 'ja' ? '選択した AI に合わせて、起動モードの実際の意味をここに表示します。' : 'Provider-specific mode guidance will appear here.'}</div>
        </div>
        <div id="launchModeOptions" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <!-- auto -->
        <div id="launchOpt_auto" onclick="selectLaunchMode('auto')" style="border:2px solid #e2e8f0;border-radius:14px;padding:14px;cursor:pointer;transition:all .18s;position:relative;background:#fff" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(59,130,246,.12)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
          <input type="radio" name="launchMode" value="auto" style="display:none">
          <div id="launchCheck_auto" style="display:none;position:absolute;top:10px;right:10px;background:#3b82f6;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;align-items:center;justify-content:center">✓</div>
          <div id="launchOptTag_auto" style="position:absolute;top:10px;left:10px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;font-size:.58rem;font-weight:800;padding:2px 7px;border-radius:20px;letter-spacing:.04em">推奨</div>
          <div style="background:#fef3c7;border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;margin-top:16px">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          </div>
          <div id="launchOptTitle_auto" style="font-weight:700;font-size:.8rem;color:#1e293b;margin-bottom:4px">auto</div>
          <div id="launchOptDesc_auto" style="font-size:.7rem;color:#64748b;line-height:1.5">ダッシュボード自動化向け。通常の許可待ちで止まりにくい推奨モードです。</div>
        </div>
        <!-- bypassPermissions -->
        <div id="launchOpt_bypassPermissions" onclick="selectLaunchMode('bypassPermissions')" style="border:2px solid #e2e8f0;border-radius:14px;padding:14px;cursor:pointer;transition:all .18s;position:relative;background:#fff" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(239,68,68,.12)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
          <input type="radio" name="launchMode" value="bypassPermissions" style="display:none">
          <div id="launchCheck_bypassPermissions" style="display:none;position:absolute;top:10px;right:10px;background:#ef4444;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;align-items:center;justify-content:center">✓</div>
          <div id="launchOptTag_bypassPermissions" style="position:absolute;top:10px;left:10px;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;font-size:.58rem;font-weight:800;padding:2px 7px;border-radius:20px;letter-spacing:.04em">危険</div>
          <div style="background:#fef2f2;border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;margin-top:16px">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>
          </div>
          <div id="launchOptTitle_bypassPermissions" style="font-weight:700;font-size:.8rem;color:#1e293b;margin-bottom:4px">bypassPermissions</div>
          <div id="launchOptDesc_bypassPermissions" style="font-size:.7rem;color:#64748b;line-height:1.5">最も強いモードです。権限確認をほぼ飛ばします。通常は auto を優先してください。</div>
        </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;background:#fff">
          <div>
            <div style="font-size:.74rem;font-weight:700;color:#334155">${_lang === 'ja' ? '開発者向けモード' : 'Developer modes'}</div>
            <div style="font-size:.68rem;color:#64748b;line-height:1.5">${_lang === 'ja' ? 'default / acceptEdits はログイン確認や手動デバッグ用です。通常の自動化では使いません。' : 'default / acceptEdits are only for login checks or manual debugging.'}</div>
          </div>
          <button id="launchAdvancedToggle" type="button" onclick="toggleLaunchAdvancedModes()" style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;padding:8px 12px;font-size:.72rem;font-weight:700;cursor:pointer;border-radius:10px;white-space:nowrap">${_lang === 'ja' ? '開く' : 'Show'}</button>
        </div>
        <div id="launchAdvancedModes" style="display:none">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <!-- default -->
            <div id="launchOpt_default" onclick="selectLaunchMode('default')" style="border:2px solid #e2e8f0;border-radius:14px;padding:14px;cursor:pointer;transition:all .18s;position:relative;background:#fff" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(59,130,246,.12)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
              <input type="radio" name="launchMode" value="default" style="display:none">
              <div id="launchCheck_default" style="display:none;position:absolute;top:10px;right:10px;background:#3b82f6;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;align-items:center;justify-content:center">✓</div>
              <div id="launchOptTag_default" style="position:absolute;top:10px;left:10px;background:linear-gradient(135deg,#64748b,#475569);color:#fff;font-size:.58rem;font-weight:800;padding:2px 7px;border-radius:20px;letter-spacing:.04em">${_lang === 'ja' ? '開発' : 'Dev'}</div>
              <div style="background:#eff6ff;border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;margin-top:16px">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
              </div>
              <div id="launchOptTitle_default" style="font-weight:700;font-size:.8rem;color:#1e293b;margin-bottom:4px">default</div>
              <div id="launchOptDesc_default" style="font-size:.7rem;color:#64748b;line-height:1.5">標準モード。許可プロンプトは AI のターミナルに出ます。放置すると自動化が止まります。</div>
            </div>
            <!-- acceptEdits -->
            <div id="launchOpt_acceptEdits" onclick="selectLaunchMode('acceptEdits')" style="border:2px solid #e2e8f0;border-radius:14px;padding:14px;cursor:pointer;transition:all .18s;position:relative;background:#fff" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 20px rgba(59,130,246,.12)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
              <input type="radio" name="launchMode" value="acceptEdits" style="display:none">
              <div id="launchCheck_acceptEdits" style="display:none;position:absolute;top:10px;right:10px;background:#3b82f6;color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;align-items:center;justify-content:center">✓</div>
              <div id="launchOptTag_acceptEdits" style="position:absolute;top:10px;left:10px;background:linear-gradient(135deg,#64748b,#475569);color:#fff;font-size:.58rem;font-weight:800;padding:2px 7px;border-radius:20px;letter-spacing:.04em">${_lang === 'ja' ? '開発' : 'Dev'}</div>
              <div style="background:#eff6ff;border-radius:10px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;margin-top:16px">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div id="launchOptTitle_acceptEdits" style="font-weight:700;font-size:.8rem;color:#1e293b;margin-bottom:4px">acceptEdits</div>
              <div id="launchOptDesc_acceptEdits" style="font-size:.7rem;color:#64748b;line-height:1.5">編集は通りやすいですが、コマンドやブラウザ操作は確認待ちで止まることがあります。</div>
            </div>
          </div>
        </div>
      </div>
      <div id="launchModeHelpNote" style="margin-top:12px;padding:10px 12px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:.72rem;color:#475569;line-height:1.6">
        選択した AI に合わせて、自動実行向けのモードと手動確認向けのモードをここに表示します。
      </div>
    </div>
    <!-- フッター -->
    <div style="padding:12px 20px 20px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #f1f5f9">
      <div id="launchSelectedLabel" style="font-size:.72rem;color:#64748b;font-weight:600">AI とモードを選択してください</div>
      <div style="display:flex;gap:8px">
        <button onclick="closeLaunchModal()" style="background:#f1f5f9;border:none;padding:9px 20px;font-size:.78rem;font-weight:600;cursor:pointer;color:#64748b;border-radius:10px;transition:background .15s" onmouseover="this.style.background='#e2e8f0'" onmouseout="this.style.background='#f1f5f9'">キャンセル</button>
        <button id="launchExternalBtn" onclick="confirmExternalLaunch()" style="background:#fff;border:1px solid #cbd5e1;color:#334155;padding:9px 16px;font-size:.76rem;font-weight:700;cursor:pointer;border-radius:10px;letter-spacing:.03em;transition:all .15s" onmouseover="this.style.borderColor='#94a3b8';this.style.color='#334155'" onmouseout="this.style.borderColor='#cbd5e1';this.style.color='#334155'">外部で開く</button>
        <button id="launchConfirmBtn" onclick="confirmLaunch()" style="background:linear-gradient(135deg,#CC785C,#E8935A);border:none;color:#fff;padding:9px 24px;font-size:.78rem;font-weight:700;cursor:pointer;border-radius:10px;letter-spacing:.04em;box-shadow:0 4px 14px rgba(204,120,92,.4);transition:all .15s" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">AI を起動</button>
      </div>
    </div>
  </div>
</div>

<div id="docsModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:none;align-items:center;justify-content:center">
  <div style="background:var(--surface-lowest);border-radius:var(--radius-lg);padding:0;max-width:700px;width:90%;max-height:85vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="background:var(--primary);color:var(--on-primary);padding:16px 24px;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-family:var(--font-display);font-size:1rem">${_t['docs.title']}</h3>
      <button onclick="closeDocsModal()" style="background:none;border:none;color:var(--on-primary);font-size:1.2rem;cursor:pointer">&times;</button>
    </div>
    <div style="padding:24px;overflow-y:auto;max-height:calc(85vh - 60px)">
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">1. ${_t['docs.quickStart']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.quickStartContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">2. ${_t['docs.settingsGuide']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.settingsGuideContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">3. ${_t['docs.workflow']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.workflowContent']}</pre>
      </div>
      <div style="text-align:center;padding-top:12px;border-top:1px solid var(--surface-high)">
        <button onclick="closeDocsModal()" style="padding:8px 24px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius-md);font-size:.82rem;cursor:pointer">${_t['docs.close']}</button>
      </div>
    </div>
  </div>
</div>

<input type="file" id="companyImportInput" accept=".xlsx,.xls,.csv" style="display:none">
<input type="file" id="settingsWorkbookImportInput" accept=".xlsx,.xls" style="display:none">

<div id="companyFormModal" class="modal-shell">
  <div class="modal-panel">
    <div class="modal-head">
      <h3 id="companyFormTitle">${_t['companyModal.title'] || 'Add Company'}</h3>
      <button class="btn-close" onclick="closeCompanyFormModal()">&times;</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="companyFormMode" value="create">
      <input type="hidden" id="companyFormCompanyNo" value="">
      <div class="modal-grid">
        <div class="settings-group">
          <label>${_t['field.companyName']}</label>
          <input type="text" id="new-companyName" placeholder="${_t['ph.companyName']}">
        </div>
        <div class="settings-group">
          <label>${_t['field.type'] || (_lang === 'ja' ? '種別' : 'Type')}</label>
          <input type="text" id="new-type" placeholder="${_lang === 'ja' ? '例: SIer / SaaS / 製造' : 'e.g. SIer / SaaS / Manufacturing'}">
        </div>
        <div class="settings-group">
          <label>${_t['field.website']}</label>
          <input type="text" id="new-url" placeholder="https://example.com">
        </div>
        <div class="settings-group">
          <label>${_t['field.colFormUrl']}</label>
          <input type="text" id="new-formUrl" placeholder="https://example.com/contact">
        </div>
        <div class="settings-group">
          <label>${_t['field.colStatus']}</label>
          <input type="text" id="new-status" placeholder="${_lang === 'ja' ? '例: ○ / 空欄' : 'e.g. target'}">
        </div>
        <div class="settings-group">
          <label>${_t['field.colProgress']}</label>
          <input type="text" id="new-progress" placeholder="${_lang === 'ja' ? '任意' : 'Optional'}">
        </div>
        <div class="settings-group modal-grid-full">
          <label>${_t['field.colNotes']}</label>
          <textarea id="new-notes" placeholder="${_lang === 'ja' ? '社内メモや補足' : 'Internal note'}"></textarea>
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:600;color:var(--on-surface)">
        <input type="checkbox" id="new-addTarget" checked style="width:16px;height:16px">
        ${_t['companyModal.addToTarget'] || 'Add this company to outreach targets'}
      </label>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline-secondary" onclick="closeCompanyFormModal()">${_t['companyModal.cancel'] || 'Cancel'}</button>
      <button class="btn btn-primary" id="companyFormSubmitBtn" onclick="submitCompanyForm()">${_t['companyModal.submit'] || 'Add Company'}</button>
    </div>
  </div>
</div>

<!-- Main content area -->
<main style="margin-top:48px;padding:0;min-height:calc(100vh - 48px);background:var(--surface)">

<!-- Horizontal tab nav -->
<div id="mainTabNav">
  <button class="tab-btn active" data-tab="companies">
    <span class="material-symbols-outlined tab-icon">table_view</span>
    ${_t['tab.companies']}
  </button>
  <button class="tab-btn" data-tab="awaiting">
    <span class="material-symbols-outlined tab-icon">pending_actions</span>
    ${_t['tab.awaiting']}
    <span style="background:var(--warning-container);color:var(--warning);font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:var(--radius-xl);font-family:var(--font-mono)" id="awaitingCount">0</span>
  </button>
  <button class="tab-btn" data-tab="sent">
    <span class="material-symbols-outlined tab-icon">mark_email_read</span>
    ${_t['tab.sent']}
  </button>
  <button class="tab-btn" data-tab="logs">
    <span class="material-symbols-outlined tab-icon">terminal</span>
    ${_t['tab.logs']}
    <span class="live-dot on" id="cliDot" style="margin-left:4px;width:7px;height:7px"></span>
  </button>
  <button class="tab-btn" data-tab="settings">
    <span class="material-symbols-outlined tab-icon">settings</span>
    ${_t['tab.settings']}
  </button>
</div>

<div style="padding:16px">

  <!-- Unified Analytics Panel (always visible) -->
  <div id="analyticsRow" style="display:grid;grid-template-columns:1.1fr 1fr 1.8fr;gap:10px;margin-bottom:12px">
    <!-- Col 1: 全体進捗 + 統計内訳 -->
    <div class="chart-panel" style="display:flex;flex-direction:column;gap:0">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);margin-bottom:7px">全体進捗</div>
      <div style="display:flex;align-items:baseline;gap:5px;margin-bottom:6px">
        <span id="analyticsPercent" style="font-size:2rem;font-weight:800;color:var(--primary);line-height:1">0</span>
        <span style="font-size:.85rem;color:var(--primary);font-weight:700">%</span>
        <span id="analyticsRatio" style="font-size:.65rem;color:var(--text-2);background:var(--bg-raised);padding:1px 6px;border-radius:3px;margin-left:2px">0 / 0 送信済み</span>
      </div>
      <div style="height:5px;background:var(--bg-raised);border-radius:3px;overflow:hidden;margin-bottom:3px">
        <div id="analyticsProgressBar" style="height:100%;background:linear-gradient(90deg,var(--primary),#6366f1);border-radius:3px;transition:width .6s;width:0%"></div>
      </div>
      <div class="progress-pipeline" id="pipeline" style="border-radius:3px;overflow:hidden;gap:1px;margin-bottom:4px">
        <div class="pip-seg" style="background:var(--bg-raised);flex:1"></div>
      </div>
      <div style="display:flex;gap:8px;font-size:.57rem;color:var(--text-3);flex-wrap:wrap;margin-bottom:9px">
        <span style="display:flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:1px;background:#f59e0b;flex-shrink:0"></span>${_t['progress.filled']}</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:1px;background:#10b981;flex-shrink:0"></span>${_t['progress.sent']}</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:1px;background:#ef4444;flex-shrink:0"></span>${_t['progress.error']}</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:6px;height:6px;border-radius:1px;background:var(--bg-raised);border:1px solid var(--border-default);flex-shrink:0"></span>${_t['progress.unprocessed']}</span>
        <span id="progressLabel" style="margin-left:auto;font-family:var(--font-mono);font-size:.57rem;color:var(--text-3)">-</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px">
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #6366f1">
          <div class="sn" id="s-approachable" style="color:#6366f1;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.target']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #94a3b8">
          <div class="sn" id="s-hasFormUrl" style="color:#94a3b8;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.hasForm']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #3b82f6">
          <div class="sn" id="s-formFill" style="color:#3b82f6;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.filled']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #f59e0b">
          <div class="sn" id="s-awaitingApproval" style="color:#f59e0b;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.awaiting']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #10b981">
          <div class="sn" id="s-submitted" style="color:#10b981;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.sent']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #ef4444">
          <div class="sn" id="s-error" style="color:#ef4444;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.error']}</div>
        </div>
        <div style="padding:4px 7px;background:var(--bg-deep);border-radius:5px;border-left:2px solid #64748b;grid-column:span 2">
          <div class="sn" id="s-excluded" style="color:#64748b;font-size:.95rem;font-weight:700;line-height:1.3">-</div>
          <div class="sl" style="font-size:.58rem;margin-top:1px">${_t['stats.excluded']}</div>
        </div>
      </div>
    </div>
    <!-- Col 2: ステータス内訳 -->
    <div class="chart-panel">
      <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);margin-bottom:8px">ステータス内訳</div>
      <div style="height:200px;position:relative"><canvas id="statusDonutChart"></canvas></div>
    </div>
    <!-- Col 3: 処理推移 -->
    <div class="chart-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2)">処理推移</div>
        <div style="display:flex;gap:10px;font-size:.6rem;color:var(--text-2)">
          <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#f59e0b;margin-right:3px"></span>要対応</span>
          <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;margin-right:3px"></span>送信済</span>
        </div>
      </div>
      <div style="height:200px;position:relative"><canvas id="trendAreaChart"></canvas></div>
    </div>
  </div>

  <div id="liveMonitorCard" style="background:#fff;border:1px solid var(--outline-variant);border-radius:8px;margin-bottom:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;background:linear-gradient(135deg,#1e293b 0%,#334155 100%);user-select:none">
      <span id="monitorDot" style="width:8px;height:8px;border-radius:50%;background:#94a3b8;flex-shrink:0;transition:background .3s"></span>
      <span style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#e2e8f0;flex:1">${_lang === 'ja' ? '進行状況ログ' : 'Progress Log'}</span>
      <div id="monitorStatusChip" style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);color:#94a3b8;font-size:.63rem;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.04em">${_lang === 'ja' ? '待機中' : 'Idle'}</div>
      <button id="liveMonitorToggleBtn" onclick="toggleLiveMonitor()" style="display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e2e8f0;font-size:.68rem;font-weight:700;padding:5px 10px;border-radius:999px;cursor:pointer;transition:all .15s" onmouseover="this.style.background='rgba(255,255,255,.14)'" onmouseout="this.style.background='rgba(255,255,255,.08)'">
        <span id="liveMonitorChevron" style="color:#cbd5e1;font-size:14px;line-height:1;transition:transform .25s">▾</span>
        <span id="liveMonitorToggleLabel">${_lang === 'ja' ? '閉じる' : 'Collapse'}</span>
      </button>
    </div>
    <div id="liveMonitorBody" style="display:grid;grid-template-columns:minmax(0,1.05fr) minmax(280px,.95fr)">
      <div style="display:flex;flex-direction:column;min-height:260px;border-right:1px solid var(--outline-variant)">
        <div style="padding:12px 14px;border-bottom:1px solid var(--outline-variant);display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline)">${_lang === 'ja' ? '進行状況ログ' : 'Progress Log'}</div>
            <div id="monitorActiveSummary" style="margin-top:5px;font-size:.8rem;color:var(--on-surface-variant)">${_lang === 'ja' ? '待機中' : 'Idle'}</div>
          </div>
          <div id="monitorUpdatedAt" style="font-size:.66rem;font-family:var(--font-mono);color:var(--outline);white-space:nowrap">-</div>
        </div>
        <div id="monitorEventList" style="display:flex;flex-direction:column;max-height:340px;overflow:auto;background:#fff;overscroll-behavior:contain"></div>
      </div>
      <div style="padding:12px 14px;background:var(--surface-lowest);display:flex;flex-direction:column;gap:8px">
        <div>
          <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline)">${_lang === 'ja' ? '最新アクティビティ' : 'Latest Activity'}</div>
          <div id="monitorCompany" style="margin-top:5px;font-size:.88rem;font-weight:700;color:var(--on-surface)">-</div>
        </div>
        <div style="background:var(--bg-surface);border-radius:6px;padding:10px 12px">
          <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline);margin-bottom:4px">${_lang === 'ja' ? '最新ステップ' : 'Latest Step'}</div>
          <div id="monitorStep" style="font-size:.82rem;color:var(--on-surface);font-weight:500">-</div>
        </div>
        <div>
          <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline);margin-bottom:4px">${_lang === 'ja' ? 'URL' : 'URL'}</div>
          <a id="monitorCurrentUrl" href="#" target="_blank" style="display:block;font-size:.75rem;color:var(--primary);font-family:var(--font-mono);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:6px 8px;background:var(--bg-surface);border-radius:4px">-</a>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline)">${_lang === 'ja' ? '最新スクショ' : 'Latest Screenshot'}</div>
          <a id="monitorScreenshotLink" href="#" target="_blank" style="display:none;font-size:.68rem;color:var(--primary);text-decoration:none;font-weight:600">${_lang === 'ja' ? '別タブで開く ↗' : 'Open ↗'}</a>
        </div>
        <div id="monitorScreenshotWrap" style="flex:1;min-height:200px;max-height:340px;overflow:auto;overscroll-behavior:contain;border:1px dashed var(--outline-variant);border-radius:6px;background:var(--surface-low);display:flex;align-items:flex-start;justify-content:flex-start;color:var(--outline);font-size:.75rem;text-align:center;padding:12px">${_lang === 'ja' ? 'スクリーンショット待機中' : 'Waiting for screenshot'}</div>
      </div>
    </div>
  </div>

  <!-- Companies tab -->
  <div class="tab-content active" id="tab-companies">
    <div class="company-toolbar" style="flex-direction:column;gap:0">
      <!-- Row 1: Quick filter tabs + Action buttons -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          <button class="fb active" data-f="all">${_t['filter.all']}</button>
          <button class="fb" data-f="approachable">${_t['filter.target']}</button>
          <button class="fb" data-f="targeted">${_t['filter.targeted'] || '営業対象'}</button>
          <button class="fb" data-f="has-form">${_t['filter.hasForm']}</button>
          <button class="fb" data-f="no-form">${_t['filter.noForm']}</button>
          <button class="fb" data-f="submitted">${_t['filter.sent']}</button>
          <button class="fb" data-f="error">${_t['filter.error']}</button>
          <button class="fb" data-f="excluded">${_t['filter.excluded']}</button>
        </div>
        <div class="bulk-toolbar">
          <button class="btn btn-outline-primary btn-sm" onclick="triggerCompanyImport()">${_t['action.importTargets'] || 'Import Excel/CSV'}</button>
          <button class="btn btn-outline-secondary btn-sm" onclick="openCompanyFormModal()">${_t['action.addCompany'] || 'Add Company'}</button>
          <button class="btn btn-outline-secondary btn-sm" onclick="toggleAllCompanies()">${_t['action.selectAll']}</button>
          <button class="btn btn-outline-danger btn-sm" onclick="bulkDeleteCompanies()">${_t['action.bulkDeleteCompanies'] || 'Delete Selected'}</button>
          <button class="btn btn-outline-primary btn-sm" onclick="markSelectedTargets(true)">${_t['action.markTarget'] || 'Mark Target'}</button>
          <button class="btn btn-outline-secondary btn-sm" onclick="markSelectedTargets(false)">${_t['action.unmarkTarget'] || 'Unmark Target'}</button>
          <button class="btn btn-primary btn-sm" onclick="prepareSelectedOutreach()">${_t['action.prepareOutreach'] || 'Prepare Outreach'}</button>
        </div>
      </div>
      <!-- Row 2: Filter bar -->
      <div class="filter-bar">
        <span class="material-symbols-outlined" style="font-size:16px;color:var(--text-3);flex-shrink:0">tune</span>
        <div class="filter-field">
          <span class="ms">category</span>
          <select id="companyTypeFilter">
            <option value="">${_lang === 'ja' ? '種別: すべて' : 'Type: All'}</option>
          </select>
        </div>
        <div class="filter-field">
          <span class="ms">trending_up</span>
          <select id="companyProgressFilter">
            <option value="">${_lang === 'ja' ? '進捗: すべて' : 'Progress: All'}</option>
          </select>
        </div>
        <div class="filter-field" style="flex:1;min-width:180px">
          <span class="ms">search</span>
          <input type="text" id="q" placeholder="${_t['filter.search']}">
        </div>
        <button id="clearFiltersBtn" class="filter-clear-btn" onclick="clearAllFilters()">
          <span class="material-symbols-outlined" style="font-size:13px">close</span>
          ${_lang === 'ja' ? 'リセット' : 'Reset'}
        </button>
      </div>
    </div>
    <div style="background:#fff;border:1px solid var(--outline-variant);overflow-x:auto">
      <table class="main-table" id="mt">
<colgroup><col style="width:36px"><col style="width:44px"><col><col style="width:110px"><col style="width:110px"><col style="width:52px"><col style="width:170px"><col style="width:180px"><col style="width:200px"></colgroup>
<thead><tr><th class="checkbox-cell"><input type="checkbox" id="companySelectAll" class="form-check-input" onclick="toggleAllCompanies(this.checked)"></th><th onclick="sortTable('no')">${_t['th.no']} <span class="sort-icon" data-col="no"></span></th><th onclick="sortTable('name')">${_t['th.company']} <span class="sort-icon" data-col="name"></span></th><th onclick="sortTable('type')">${_t['th.type']} <span class="sort-icon" data-col="type"></span></th><th onclick="sortTable('progress')">${_t['th.progress']} <span class="sort-icon" data-col="progress"></span></th><th onclick="sortTable('sent')">${_t['th.sent']} <span class="sort-icon" data-col="sent"></span></th><th>${_t['th.formUrl']}</th><th>${_t['th.message']}</th><th class="action-cell">${_t['th.action']}</th></tr></thead>
        <tbody id="companyBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Awaiting tab -->
  <div class="tab-content" id="tab-awaiting">
    <div style="background:#fff;border:1px solid var(--outline-variant);border-bottom:2px solid var(--primary);padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="material-symbols-outlined" style="font-size:16px;color:var(--primary)">pending_actions</span>
        <span style="font-size:.75rem;color:var(--on-surface-variant)">${_t['awaiting.description']}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm btn-outline-primary" onclick="toggleAllAwaiting()">${_t['action.selectAll']}</button>
        <button class="btn btn-sm btn-success" onclick="bulkApprove('sent')">${_t['action.bulkSent']}</button>
        <button class="btn btn-sm btn-outline-danger" onclick="bulkSkipWithFeedback()">${_t['action.bulkSkip']}</button>
        <button class="btn btn-sm btn-outline-danger" onclick="bulkDeleteAwaiting()">${_t['action.bulkDeleteCompanies'] || 'Delete Selected'}</button>
      </div>
    </div>
    <div id="awaitingList" style="padding:16px;background:var(--bg-base)"></div>
  </div>

  <!-- Sent tab -->
  <div class="tab-content" id="tab-sent">
    <div style="background:#fff;border:1px solid var(--outline-variant);border-bottom:2px solid #198038;padding:10px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:8px">
      <span class="material-symbols-outlined" style="font-size:16px;color:#198038">mark_email_read</span>
      <input type="text" id="sentSearch" class="form-control-sm" style="width:200px" placeholder="${_t['sent.search']}">
      <button class="fb-sent fb active" data-sf="all">${_t['sent.all']}</button>
      <button class="fb-sent fb" data-sf="1">${_t['sent.firstOnly']}</button>
      <button class="fb-sent fb" data-sf="2+">${_t['sent.multipleOnly']}</button>
      <small style="margin-left:auto;font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="sentCount">0 items</small>
    </div>
    <div id="sentList" style="padding:16px;background:var(--bg-base)"></div>
  </div>

  <!-- CLI Activity tab -->
  <div class="tab-content" id="tab-logs">
    <!-- Activity log table -->
    <div style="background:#fff;border:1px solid var(--outline-variant)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--on-surface)">${_t['cli.actionLog']}</span>
          <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="cliLastEvent">—</span>
        </div>
        <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="logCount">0 items</span>
      </div>
      <table class="main-table">
        <thead><tr><th>${_t['cli.datetime']}</th><th>${_t['th.no']}</th><th>${_t['cli.companyName']}</th><th>${_t['cli.actionType']}</th><th>${_t['cli.details']}</th></tr></thead>
        <tbody id="logBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Settings tab -->
  <div class="tab-content" id="tab-settings">
    <div style="background:#fff;border:1px solid var(--outline-variant)" class="settings-layout">
      <div class="settings-sidebar">
        <button class="settings-sidebar-btn active" data-section="companyProfile"><span class="settings-sidebar-label">${_t['settings.companyProfile']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-companyProfile"></span></button>
        <button class="settings-sidebar-btn" data-section="valuePropositions"><span class="settings-sidebar-label">${_t['settings.valuePropositions']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-valuePropositions"></span></button>
        <button class="settings-sidebar-btn" data-section="targetList"><span class="settings-sidebar-label">${_t['settings.targetList']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-targetList"></span></button>
        <button class="settings-sidebar-btn" data-section="exclusionRules"><span class="settings-sidebar-label">${_t['settings.exclusionRules']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-exclusionRules"></span></button>
        <button class="settings-sidebar-btn" data-section="messageTemplates"><span class="settings-sidebar-label">${_t['settings.messageTemplates']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-messageTemplates"></span></button>
        <button class="settings-sidebar-btn" data-section="preferences"><span class="settings-sidebar-label">${_t['settings.preferences']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-preferences"></span></button>
      </div>
      <div class="settings-main" id="settingsMain">
        <div class="settings-setup-guide" id="settingsSetupGuide">
          <div class="settings-setup-head">
            <div style="min-width:0">
              <div class="settings-setup-eyebrow">${_t['settings.setupGuide.eyebrow']}</div>
              <h3 class="settings-setup-title">${_t['settings.setupGuide.title']}</h3>
            </div>
            <div class="settings-setup-overview">
              <div class="settings-setup-progress-track"><span id="settingsSetupProgressBar"></span></div>
              <div class="settings-setup-progress-label" id="settingsSetupProgressLabel" style="font-size:.72rem">0 / 5</div>
              <div class="settings-setup-progress-note" id="settingsSetupProgressNote"></div>
            </div>
          </div>
          <div class="settings-setup-grid">
            <button type="button" class="setup-check-card" onclick="openSettingsSection('companyProfile')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.companyProfile']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.companyProfile.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-companyProfile"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-companyProfile"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('valuePropositions')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.valuePropositions']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.valuePropositions.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-valuePropositions"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-valuePropositions"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('targetList')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.targetList']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.targetList.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-targetList"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-targetList"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('messageTemplates')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.messageTemplates']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.messageTemplates.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-messageTemplates"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-messageTemplates"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('preferences')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.preferences']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.preferences.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-preferences"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-preferences"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('exclusionRules')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.exclusionRules']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.optionalSection.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-exclusionRules"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-exclusionRules"></ul>
            </button>
          </div>
        </div>

        <!-- Company Profile section -->
        <div class="settings-section active" id="sec-companyProfile">
          <h3>${_t['settings.companyProfile']}</h3>
          <p class="section-desc">${_t['settings.companyProfile.desc']}</p>
          <div class="settings-callout required"><strong>${_t['settings.tag.required']}</strong><span>${_t['settings.setup.companyProfile.hint']}</span></div>
          <div class="settings-callout" style="justify-content:space-between;align-items:center;flex-wrap:wrap">
            <div style="min-width:260px">
              <strong>${_t['settings.excel.title']}</strong><br>
              <span>${_t['settings.excel.desc']}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="downloadSettingsWorkbook('template')">${_t['settings.excel.template']}</button>
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="downloadSettingsWorkbook('current')">${_t['settings.excel.exportCurrent']}</button>
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="triggerSettingsWorkbookImport()">${_t['settings.excel.import']}</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyName']} ${settingsTag('required')}</label>
              <input type="text" id="cp-companyName" placeholder="${_t['ph.companyName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.companyNameEn']}</label>
              <input type="text" id="cp-companyNameEn" placeholder="${_t['ph.companyNameEn']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyNameKana']}</label>
              <input type="text" id="cp-companyNameKana" placeholder="${_t['ph.companyNameKana']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.representative']}</label>
              <input type="text" id="cp-representative" placeholder="${_t['ph.representative']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactName']} ${settingsTag('required')}</label>
              <input type="text" id="cp-contactName" placeholder="${_t['ph.contactName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.contactNameKana']}</label>
              <input type="text" id="cp-contactNameKana" placeholder="${_t['ph.contactNameKana']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactTitle']}</label>
              <input type="text" id="cp-contactTitle" placeholder="${_t['ph.contactTitle']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.department']}</label>
              <input type="text" id="cp-department" placeholder="${_t['ph.department']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.email']} ${settingsTag('required')}</label>
              <input type="email" id="cp-email" placeholder="${_t['ph.email']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.phone']} ${settingsTag('required')}</label>
              <input type="tel" id="cp-phone" placeholder="03-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fax']}</label>
              <input type="tel" id="cp-fax" placeholder="03-1234-5679">
            </div>
            <div class="settings-group">
              <label>${_t['field.mobile']}</label>
              <input type="tel" id="cp-mobile" placeholder="090-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.postalCode']}</label>
              <input type="text" id="cp-postalCode" placeholder="100-0001">
            </div>
            <div class="settings-group">
              <label>${_t['field.address']}</label>
              <input type="text" id="cp-address" placeholder="${_t['ph.addressFull']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.addressEn']}</label>
            <input type="text" id="cp-addressEn" placeholder="${_t['ph.addressEn']}">
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.website']}</label>
              <input type="text" id="cp-website" placeholder="https://example.com">
            </div>
            <div class="settings-group">
              <label>${_t['field.partnerPage']}</label>
              <input type="text" id="cp-partnerPage" placeholder="${_t['ph.partnerPage']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.corporateProfile']}</label>
            <input type="text" id="cp-corporateProfile" placeholder="${_t['ph.corporateProfile']}">
          </div>
          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.established']}</label>
              <input type="text" id="cp-established" placeholder="${_t['ph.established']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.employeeCount']}</label>
              <input type="text" id="cp-employeeCount" placeholder="${_t['ph.employeeCount']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.capital']}</label>
              <input type="text" id="cp-capital" placeholder="${_t['ph.capital']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.industry']}</label>
              <input type="text" id="cp-industry" placeholder="${_t['ph.industry']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.businessDescription']}</label>
              <input type="text" id="cp-businessDescription" placeholder="${_t['ph.businessDescription']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.notes']}</label>
            <textarea id="cp-notes" placeholder="${_t['ph.notes']}"></textarea>
            <div class="help-text">${_t['help.notes']}</div>
          </div>
          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('companyProfile')">${_t['settings.save']} ${_t['settings.companyProfile']}</button>
          </div>
        </div>

        <!-- Value Propositions section -->
        <div class="settings-section" id="sec-valuePropositions">
          <h3>${_t['settings.valuePropositions']}</h3>
          <p class="section-desc">${_t['settings.valuePropositions.desc']}</p>
          <div class="settings-callout recommended"><strong>${_t['settings.tag.recommended']}</strong><span>${_t['settings.setup.valuePropositions.hint']}</span></div>
          <div class="settings-callout"><strong>${_t['settings.excel.coverage']}</strong><span>${_t['settings.excel.coverage.desc']}</span></div>

          <div class="settings-group">
            <label>${_t['field.companyUrl']} ${settingsTag('optional')}</label>
            <input type="text" id="vp-companyUrl" placeholder="${_t['ph.websiteUrl']}">
            <div class="help-text">${_t['help.companyUrl']}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.serviceUrls']}</label>
            <div class="help-text mb-2">${_t['help.serviceUrls']}</div>
            <div class="list-manager" id="vp-serviceUrls-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.documents']}</label>
            <div class="help-text mb-2">${_t['help.documents']}</div>
            <div class="list-manager" id="vp-documentPaths-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.strengths']} ${settingsTag('required')}</label>
            <div class="help-text mb-2">${_t['help.strengths']}</div>
            <div id="vp-strengths-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addStrengthItem()">${_t['field.addStrength']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.successPatterns']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.successPatterns']}</div>
            <div id="vp-successPatterns-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addSuccessPatternItem()">${_t['field.addPattern']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.industryProfiles']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.industryProfiles']}</div>
            <div id="vp-industryProfiles-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addIndustryProfile()">${_t['field.addProfile']}</button>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('valuePropositions')">${_t['settings.save']} ${_t['settings.valuePropositions']}</button>
          </div>
        </div>

        <!-- Target List section -->
        <div class="settings-section" id="sec-targetList">
          <h3>${_t['settings.targetList']}</h3>
          <p class="section-desc">${_t['settings.targetList.desc']}</p>
          <div class="settings-callout required"><strong>${_t['settings.tag.required']}</strong><span>${_t['settings.setup.targetList.hint']}</span></div>

          <div class="settings-group">
            <label>${_t['field.filePath']} ${settingsTag('required')}</label>
            <input type="text" id="tl-filePath" placeholder="${_t['ph.filePath']}">
            <div class="help-text">${_t['help.filePath']}</div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fileType']}</label>
              <select id="tl-fileType">
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV (.csv)</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.sheetIndex']}</label>
              <input type="number" id="tl-sheetIndex" min="0" value="0">
              <div class="help-text">${_t['help.sheetIndex']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.columnMapping']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.columnMapping']}</div>
            <div class="help-text mb-2">${_t['help.columnMappingCustom']}</div>
            <div class="column-map-toolbar">
              <small class="text-muted">${_t['field.columnMapping']}</small>
              <button type="button" class="btn btn-sm btn-outline-primary" onclick="addCustomColumnMappingRow()">${_t['field.addColumnMapping']}</button>
            </div>
            <div class="column-map-list" id="tl-columnMappingList"></div>
          </div>

          <div class="settings-group">
            <label>${_t['settings.preview']}</label>
            <div class="help-text mb-2">${_t['help.targetPreview']}</div>
            <button class="btn btn-sm btn-outline-primary mb-2" onclick="loadTargetPreview()">${_t['field.loadPreview']}</button>
            <div id="targetPreview"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('targetList')">${_t['settings.save']} ${_t['settings.targetList']}</button>
          </div>
        </div>

        <!-- Exclusion Rules section -->
        <div class="settings-section" id="sec-exclusionRules">
          <h3>${_t['settings.exclusionRules']}</h3>
          <p class="section-desc">${_t['settings.exclusionRules.desc']}</p>
          <div class="settings-callout optional"><strong>${_t['settings.tag.optional']}</strong><span>${_t['settings.setup.optionalSection.hint']}</span></div>

          <div class="settings-group">
            <label>${_t['field.competitors']}</label>
            <div class="help-text mb-2">${_t['help.competitors']}</div>
            <div id="er-competitors-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('competitors')">${_t['field.addCompetitor']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.existingClients']}</label>
            <div class="help-text mb-2">${_t['help.existingClients']}</div>
            <div id="er-existingClients-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('existingClients')">${_t['field.addClient']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.ngList']}</label>
            <div class="help-text mb-2">${_t['help.ngList']}</div>
            <div id="er-ngList-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addNgItem()">${_t['field.addNg']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.customRules']}</label>
            <div class="help-text mb-2">${_t['help.customRules']}</div>
            <div id="er-customRules-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addCustomRule()">${_t['field.addCustomRule']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.excludeStatuses']}</label>
            <div class="help-text mb-2">${_t['help.excludeStatuses']}</div>
            <div class="list-manager" id="er-excludeStatuses-list"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('exclusionRules')">${_t['settings.save']} ${_t['settings.exclusionRules']}</button>
          </div>
        </div>

        <!-- Message Templates section -->
        <div class="settings-section" id="sec-messageTemplates">
          <h3>${_t['settings.messageTemplates']}</h3>
          <p class="section-desc">${_t['settings.messageTemplates.desc']}</p>
          <div class="settings-callout recommended"><strong>${_t['settings.tag.recommended']}</strong><span>${_t['settings.setup.messageTemplates.hint']}</span></div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.tone']}</label>
              <select id="mt-tone">
                <option value="formal">${_t['field.toneOptions.formal']}</option>
                <option value="casual">${_t['field.toneOptions.casual']}</option>
                <option value="business">${_t['field.toneOptions.business']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.msgLanguage']}</label>
              <select id="mt-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLength']}</label>
              <input type="number" id="mt-maxLength" min="100" max="10000">
              <div class="help-text">${_t['help.maxLength']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.signatureFormat']}</label>
            <select id="mt-signatureFormat">
              <option value="full">${_t['field.sigFull']}</option>
              <option value="minimal">${_t['field.sigMinimal']}</option>
              <option value="none">${_t['field.sigNone']}</option>
            </select>
          </div>

          <div class="settings-group">
            <label>${_t['field.inquiryTypes']}</label>
            <div class="help-text mb-2">${_t['help.inquiryTypes']}</div>
            <div class="list-manager" id="mt-inquiryTypes-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.greetingLine']} ${settingsTag('required')}</label>
            <input type="text" id="mt-greetingLine" placeholder="${_t['ph.greeting']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.approachObjective']} ${settingsTag('recommended')}</label>
            <textarea id="mt-approachObjective" placeholder="${_t['ph.approachObjective']}"></textarea>
            <div class="help-text">${_t['help.approachObjective']}</div>
          </div>
          <div class="settings-group">
            <label>${_t['field.approachGuardrails']}</label>
            <textarea id="mt-approachGuardrails" placeholder="${_t['ph.approachGuardrails']}"></textarea>
            <div class="help-text">${_t['help.approachGuardrails']}</div>
          </div>
          <div class="settings-group">
            <label>${_t['field.closingLine']} ${settingsTag('required')}</label>
            <textarea id="mt-closingLine" placeholder="${_t['ph.closing']}"></textarea>
          </div>
          <div class="settings-group">
            <label>${_t['field.cta']} ${settingsTag('recommended')}</label>
            <input type="text" id="mt-cta" placeholder="${_t['ph.cta']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.referenceUrlText']}</label>
            <input type="text" id="mt-referenceUrlText" placeholder="${_t['ph.referenceUrl']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.signatureTemplate']} ${settingsTag('required')}</label>
            <textarea id="mt-signatureTemplate" placeholder="${_t['ph.signature']}"></textarea>
            <div class="help-text">${_t['help.signaturePlaceholders']}</div>
          </div>

          <div class="settings-group" style="margin-top:16px;padding-top:16px;border-top:2px solid var(--surface-high)">
            <label>${_t['field.letterTemplate']}</label>
            <div class="help-text mb-2">${_t['help.letterTemplate']}</div>
            <div class="settings-row-3">
              <div class="settings-group">
                <label>${_t['field.letterEnabled']}</label>
                <select id="mt-letter-enabled">
                  <option value="false">${_t['field.yesNo.no']}</option>
                  <option value="true">${_t['field.yesNo.yes']}</option>
                </select>
              </div>
              <div class="settings-group">
                <label>${_t['field.letterFormat']}</label>
                <select id="mt-letter-format">
                  <option value="A4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </div>
              <div></div>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterHeader']}</label>
              <textarea id="mt-letter-header" placeholder="${_t['ph.letterHeader']}"></textarea>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterFooter']}</label>
              <textarea id="mt-letter-footer" placeholder="${_t['ph.letterFooter']}"></textarea>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('messageTemplates')">${_t['settings.save']} ${_t['settings.messageTemplates']}</button>
          </div>
        </div>

        <!-- Preferences section -->
        <div class="settings-section" id="sec-preferences">
          <h3>${_t['settings.preferences']}</h3>
          <p class="section-desc">${_t['settings.preferences.desc']}</p>
          <div class="settings-callout optional"><strong>${_t['settings.tag.optional']}</strong><span>${_t['settings.setup.preferences.hint']}</span></div>

          <div class="settings-group" style="background:var(--info-container);padding:12px;border-radius:var(--radius-md);margin-bottom:16px">
            <small style="color:var(--info)">${_t['help.portRestart']}</small>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.dashboardPort']}</label>
              <input type="number" id="pf-dashboardPort" min="1024" max="65535">
            </div>
            <div class="settings-group">
              <label>${_t['field.dashboardHost']}</label>
              <input type="text" id="pf-dashboardHost" placeholder="127.0.0.1">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.language']}</label>
              <select id="pf-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.timezone']}</label>
              <input type="text" id="pf-timezone" placeholder="Asia/Tokyo">
            </div>
            <div class="settings-group">
              <label>${_t['field.dateFormat']}</label>
              <input type="text" id="pf-dateFormat" placeholder="YYYY-MM-DD HH:mm">
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.screenshotDir']} ${settingsTag('recommended')}</label>
              <div class="settings-path-picker">
                <input type="text" id="pf-screenshotDir" placeholder="screenshots">
                <button type="button" class="btn-picker" onclick="browseForDirectory('pf-screenshotDir')" ${process.versions.electron ? '' : 'title="' + _t['settings.dirPicker.desktopOnlyTitle'] + '"'}>${process.versions.electron ? _t['action.browseFolder'] : _t['action.browseFolderDesktop']}</button>
              </div>
              <div class="help-text">${process.versions.electron ? _t['settings.dirPicker.desktopHelp'] : _t['settings.dirPicker.browserHelp']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.dataDir']} ${settingsTag('recommended')}</label>
              <div class="settings-path-picker">
                <input type="text" id="pf-dataDir" placeholder="data">
                <button type="button" class="btn-picker" onclick="browseForDirectory('pf-dataDir')" ${process.versions.electron ? '' : 'title="' + _t['settings.dirPicker.desktopOnlyTitle'] + '"'}>${process.versions.electron ? _t['action.browseFolder'] : _t['action.browseFolderDesktop']}</button>
              </div>
              <div class="help-text">${process.versions.electron ? _t['settings.dirPicker.desktopHelp'] : _t['settings.dirPicker.browserHelp']}</div>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.emailKeyword']}</label>
              <input type="text" id="pf-emailSearchKeyword" placeholder="${_t['ph.emailKeyword']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.emailProvider']}</label>
              <select id="pf-emailProvider">
                <option value="outlook">Outlook</option>
                <option value="gmail">Gmail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.maxRetries']}</label>
              <input type="number" id="pf-maxRetries" min="0" max="10">
              <div class="help-text">${_t['help.maxRetries']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.pageTimeout']}</label>
              <input type="number" id="pf-pageTimeout" min="1000" max="120000">
            </div>
            <div class="settings-group">
              <label>${_t['field.formFillTimeout']}</label>
              <input type="number" id="pf-formFillTimeout" min="1000" max="60000">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.headless']}</label>
              <select id="pf-headless">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.headless']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.locale']}</label>
              <input type="text" id="pf-locale" placeholder="ja-JP">
            </div>
            <div class="settings-group">
              <label>${_t['field.requireApproval']}</label>
              <select id="pf-requireApprovalBeforeSend">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.requireApproval']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.userAgent']}</label>
            <input type="text" id="pf-userAgent" placeholder="${_t['ph.userAgent']}">
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.logLevel']}</label>
              <select id="pf-logLevel">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLogEntries']}</label>
              <input type="number" id="pf-maxLogEntries" min="100" max="100000">
            </div>
            <div class="settings-group">
              <label>${_t['field.exportPrefix']}</label>
              <input type="text" id="pf-exportFilenamePrefix" placeholder="${_t['ph.exportPrefix']}">
            </div>
          </div>

          <div class="settings-group" style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
            <label>${_t['field.aiProvider']} ${settingsTag('recommended')}</label>
            <select id="pf-aiProvider">
              ${providerSelectHtml}
            </select>
            <div class="help-text">${_t['help.aiProvider']}</div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.aiModelClaude']} ${settingsTag('recommended')}</label>
              <input type="text" id="pf-aiModelClaude" placeholder="claude-sonnet-4-6">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.aiModelCodex']}</label>
              <input type="text" id="pf-aiModelCodex" placeholder="gpt-5-codex">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.aiModelGemini']}</label>
              <input type="text" id="pf-aiModelGemini" placeholder="gemini-2.5-pro">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('preferences')">${_t['settings.save']} ${_t['settings.preferences']}</button>
          </div>
        </div>

      </div>
    </div>
  </div>
</div><!-- /padding:16px -->
</main>

<script>
const LANG = ${serializeForInlineScript(_lang)};
const I18N = ${serializeForInlineScript(_t)};
const AVAILABLE_AI_PROVIDERS = ${serializeForInlineScript(providerOptions)};
const NATIVE_DIRECTORY_PICKER_AVAILABLE = ${process.versions.electron ? 'true' : 'false'};
function t(key, params) {
  let text = I18N[key] || key;
  if (params) Object.entries(params).forEach(([k,v]) => { text = text.replace('{'+k+'}', v); });
  return text;
}
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function withSessionQuery(urlLike) {
  const url = new URL(urlLike, window.location.origin);
  return url.pathname + url.search + url.hash;
}
const nativeFetch = window.fetch.bind(window);
window.fetch = function(input, init = {}) {
  return nativeFetch(input, { credentials: 'same-origin', ...init });
};
function createSessionEventSource(urlLike) {
  return new EventSource(withSessionQuery(urlLike));
}
function createSessionWebSocket(pathname) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const endpoint = new URL(proto + '//' + location.host + pathname);
  return new WebSocket(endpoint.toString());
}
const TARGET_COLUMN_FIELDS = ['no','status','companyName','type','url','formUrl','notes','captcha','progress'];
const TARGET_COLUMN_LABELS = {
  no: t('field.colNo'),
  status: t('field.colStatus'),
  companyName: t('field.colCompanyName'),
  type: t('field.colType'),
  url: t('field.colUrl'),
  formUrl: t('field.colFormUrl'),
  notes: t('field.colNotes'),
  captcha: t('field.colCaptcha'),
  progress: t('field.colProgress'),
};

// Docs modal
function showDocsModal(){const m=document.getElementById('docsModal');m.style.display='flex';}
function closeDocsModal(){document.getElementById('docsModal').style.display='none';}
document.getElementById('docsModal').addEventListener('click',function(e){if(e.target===this)closeDocsModal();});

// AI mode
let _currentClaudeMode = 'auto';
let _launchModalMode = 'auto';
let _launchAdvancedModesOpen = false;
let _tabTerm = null;
let _drawerTerm = null;
let _ptyWs = null;
let _ptyWsRetryTimer = null;
let _termDrawerOpen = false;
let _currentAiProvider = 'claude';
function getAiProviderMeta(providerId) {
  return AVAILABLE_AI_PROVIDERS.find((provider) => provider.id === providerId) || AVAILABLE_AI_PROVIDERS[0] || { id: 'claude', displayName: 'Claude' };
}
function getAiProviderLabel(providerId) {
  const meta = getAiProviderMeta(providerId);
  return t('provider.' + meta.id) !== ('provider.' + meta.id) ? t('provider.' + meta.id) : meta.displayName;
}
function getLaunchModeUi(providerId) {
  const isJa = LANG === 'ja';
  if (providerId === 'codex') {
    return {
      note: isJa
        ? 'Codex は full-auto 系で自動処理します。手動確認したいときだけ on-request を使ってください。'
        : 'Codex uses full-auto modes for automation. Use on-request only when you want manual confirmation.',
      help: isJa
        ? 'Codex の自動フォーム入力は <strong>full-auto</strong> か <strong>danger bypass</strong> 前提です。<strong>on-request</strong> 系はログイン確認や手動デバッグ向けで、途中停止しやすくなります。'
        : 'Codex form fill expects <strong>full-auto</strong> or <strong>danger bypass</strong>. <strong>On-request</strong> modes are for login checks or manual debugging and may pause.',
      modes: {
        auto: {
          label: isJa ? 'full-auto（推奨）' : 'Full-auto (recommended)',
          description: isJa
            ? 'Codex の --full-auto で起動します。通常のキュー投入やフォーム処理はこのモードです。'
            : 'Launches Codex with --full-auto. Use this for normal queued runs and form work.',
          tag: isJa ? '推奨' : 'Recommended',
          tagTone: 'recommend',
        },
        bypassPermissions: {
          label: isJa ? 'danger bypass' : 'Danger bypass',
          description: isJa
            ? 'Codex の --dangerously-bypass-approvals-and-sandbox を使います。詰まるときだけ使ってください。'
            : 'Uses Codex --dangerously-bypass-approvals-and-sandbox. Reserve this for fallback cases.',
          tag: isJa ? '高権限' : 'High access',
          tagTone: 'danger',
        },
        default: {
          label: isJa ? 'on-request' : 'On-request',
          description: isJa
            ? 'Codex の -a on-request / -s workspace-write です。許可確認が出るので手動監視向けです。'
            : 'Uses Codex -a on-request / -s workspace-write. Best when you want to supervise approvals.',
          tag: isJa ? '手動' : 'Manual',
          tagTone: 'dev',
        },
        acceptEdits: {
          label: isJa ? 'on-request（編集支援）' : 'On-request (edit assist)',
          description: isJa
            ? 'Codex に acceptEdits 専用モードはないため、on-request で起動します。ログイン確認や軽い手動デバッグ向けです。'
            : 'Codex has no dedicated acceptEdits mode, so this also uses on-request for login checks or light debugging.',
          tag: isJa ? '手動' : 'Manual',
          tagTone: 'dev',
        },
      },
    };
  }
  if (providerId === 'gemini') {
    return {
      note: isJa
        ? 'Gemini は auto で auto_edit、強制実行では yolo を使います。完全放置より、途中確認を前提に見てください。'
        : 'Gemini uses auto_edit for auto and yolo for aggressive runs. Treat it as guided automation rather than fully hands-off.',
      help: isJa
        ? 'Gemini の自動フォーム入力は <strong>auto_edit</strong> か <strong>yolo</strong> 前提です。<strong>default approvals</strong> は確認待ちで止まりやすいため、ログイン確認向けです。'
        : 'Gemini form fill expects <strong>auto_edit</strong> or <strong>yolo</strong>. <strong>Default approvals</strong> is mainly for login checks and often pauses.',
      modes: {
        auto: {
          label: isJa ? 'auto_edit（推奨）' : 'auto_edit (recommended)',
          description: isJa
            ? 'Gemini CLI の --approval-mode auto_edit で起動します。通常の自動化はこのモードです。'
            : 'Launches Gemini CLI with --approval-mode auto_edit. This is the normal automation mode.',
          tag: isJa ? '推奨' : 'Recommended',
          tagTone: 'recommend',
        },
        bypassPermissions: {
          label: 'yolo',
          description: isJa
            ? 'Gemini CLI の --approval-mode yolo を使います。止まりやすいケースの切り札です。'
            : 'Uses Gemini CLI --approval-mode yolo. Keep this as the fallback when auto_edit still pauses.',
          tag: isJa ? '高権限' : 'High access',
          tagTone: 'danger',
        },
        default: {
          label: isJa ? 'default approvals' : 'Default approvals',
          description: isJa
            ? 'Gemini CLI の --approval-mode default です。許可待ちが出るので、ログイン確認向けです。'
            : 'Uses Gemini CLI --approval-mode default. Best for login checks because it will ask before acting.',
          tag: isJa ? '手動' : 'Manual',
          tagTone: 'dev',
        },
        acceptEdits: {
          label: isJa ? 'auto_edit（手動監視）' : 'auto_edit (manual)',
          description: isJa
            ? 'Gemini に acceptEdits 専用モードはないため、auto_edit で起動します。人が見守る前提の別名です。'
            : 'Gemini has no dedicated acceptEdits mode, so this also uses auto_edit as a supervised variant.',
          tag: isJa ? '手動' : 'Manual',
          tagTone: 'dev',
        },
      },
    };
  }
  return {
    note: isJa
      ? 'Claude は auto を通常運用の既定にし、必要な場合だけ bypassPermissions に切り替えてください。'
      : 'Use auto as the normal mode for Claude, and switch to bypassPermissions only when needed.',
    help: isJa
      ? 'Claude の自動フォーム入力は <strong>auto</strong> または <strong>bypassPermissions</strong> 前提です。<strong>default</strong> / <strong>acceptEdits</strong> はログイン確認や手動監視には使えますが、承認待ちで止まることがあります。'
      : 'Claude form fill expects <strong>auto</strong> or <strong>bypassPermissions</strong>. <strong>default</strong> / <strong>acceptEdits</strong> are mainly for login checks or manual monitoring.',
    modes: {
      auto: {
        label: isJa ? '完全自動（推奨）' : 'Auto (recommended)',
        description: isJa
          ? 'ダッシュボード自動化向け。通常の許可待ちで止まりにくい推奨モードです。'
          : 'Best for dashboard automation. It is less likely to stop on permission prompts.',
        tag: isJa ? '推奨' : 'Recommended',
        tagTone: 'recommend',
      },
      bypassPermissions: {
        label: isJa ? '権限スキップ（危険）' : 'Bypass permissions (danger)',
        description: isJa
          ? '最も強いモードです。権限確認をほぼ飛ばします。通常は auto を優先してください。'
          : 'The strongest mode. It skips most permission prompts, so prefer auto when possible.',
        tag: isJa ? '危険' : 'Danger',
        tagTone: 'danger',
      },
      default: {
        label: isJa ? '標準モード' : 'Default',
        description: isJa
          ? '標準モード。許可プロンプトは AI のターミナルに出ます。放置すると自動化が止まります。'
          : 'Standard mode. Prompts appear in the AI terminal and may pause automation until you respond.',
        tag: isJa ? '開発' : 'Dev',
        tagTone: 'dev',
      },
      acceptEdits: {
        label: isJa ? '編集支援' : 'Assist edits',
        description: isJa
          ? '編集は通りやすいですが、コマンドやブラウザ操作は確認待ちで止まることがあります。'
          : 'Edits are easier to allow, but commands and browser actions can still pause for confirmation.',
        tag: isJa ? '開発' : 'Dev',
        tagTone: 'dev',
      },
    },
  };
}
function getLaunchModeLabels(providerId) {
  const ui = getLaunchModeUi(providerId);
  return Object.fromEntries(Object.entries(ui.modes || {}).map(([mode, meta]) => [mode, meta.label || mode]));
}
function getProviderLaunchNote(providerId) {
  return getLaunchModeUi(providerId).note;
}
function getLaunchModeDisplayLabel(providerId, mode) {
  const labels = getLaunchModeLabels(providerId);
  if (labels[mode]) return labels[mode];
  if (providerId === 'codex' && mode === 'danger-full-access') return labels.bypassPermissions || 'danger bypass';
  if (providerId === 'gemini' && (mode === 'yolo' || mode === 'headless-yolo')) return labels.bypassPermissions || 'yolo';
  if (providerId === 'gemini' && mode === 'auto_edit') return labels.auto || 'auto_edit';
  return mode || '';
}
function updateLaunchProviderUi(providerId) {
  const meta = getAiProviderMeta(providerId || _currentAiProvider);
  const providerLabel = getAiProviderLabel(meta.id);
  const modeUi = getLaunchModeUi(meta.id);
  _currentAiProvider = meta.id;
  const title = document.getElementById('launchProviderTitle');
  if (title) {
    title.textContent = LANG === 'ja'
      ? 'AI を起動'
      : 'Launch AI';
  }
  const subtitle = document.getElementById('launchProviderSubtitle');
  if (subtitle) {
    subtitle.textContent = LANG === 'ja'
      ? '起動する AI とモードを選択してください'
      : 'Choose the AI provider and startup mode';
  }
  const providerSelect = document.getElementById('launchProviderSelect');
  if (providerSelect && providerSelect.value !== meta.id) {
    providerSelect.value = meta.id;
  }
  const badge = document.getElementById('launchProviderBadge');
  if (badge) badge.textContent = providerLabel;
  const note = document.getElementById('launchProviderNote');
  if (note) note.textContent = getProviderLaunchNote(meta.id);
  const help = document.getElementById('launchModeHelpNote');
  if (help) {
    help.innerHTML = modeUi.help;
  }
  ['default', 'acceptEdits', 'auto', 'bypassPermissions'].forEach((mode) => {
    const metaUi = (modeUi.modes || {})[mode] || {};
    const titleEl = document.getElementById('launchOptTitle_' + mode);
    if (titleEl) titleEl.textContent = metaUi.label || mode;
    const descEl = document.getElementById('launchOptDesc_' + mode);
    if (descEl) descEl.textContent = metaUi.description || '';
    const tagEl = document.getElementById('launchOptTag_' + mode);
    if (tagEl) {
      tagEl.textContent = metaUi.tag || '';
      tagEl.style.display = metaUi.tag ? '' : 'none';
      if (metaUi.tagTone === 'danger') {
        tagEl.style.background = 'linear-gradient(135deg,#ef4444,#dc2626)';
      } else if (metaUi.tagTone === 'recommend') {
        tagEl.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
      } else {
        tagEl.style.background = 'linear-gradient(135deg,#64748b,#475569)';
      }
    }
  });
  // プロバイダーカード選択状態を更新
  ['claude', 'codex', 'gemini'].forEach((id) => {
    const card = document.getElementById('launchProviderCard_' + id);
    if (card) {
      if (id === meta.id) card.classList.add('selected');
      else card.classList.remove('selected');
    }
  });
  // ヘッダーグラデーションをプロバイダー色に変更
  const _providerTheme = {
    claude: { grad: 'linear-gradient(135deg,#CC785C,#E8935A)', shadow: 'rgba(204,120,92,.4)',
      icon: '<img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/claude-code/default.svg" width="30" height="30" alt="Claude Code">' },
    codex: { grad: 'linear-gradient(135deg,#10a37f,#0d8a6a)', shadow: 'rgba(16,163,127,.4)',
      icon: '<img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/codex-openai/default.svg" width="30" height="30" alt="Codex">' },
    gemini: { grad: 'linear-gradient(135deg,#4285F4,#1a6fe0)', shadow: 'rgba(66,133,244,.4)',
      icon: '<img src="https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/gemini-cli/default.svg" width="30" height="30" alt="Gemini CLI">' },
  };
  const _theme = _providerTheme[meta.id] || _providerTheme.claude;
  const headerEl = document.getElementById('launchModalHeader');
  if (headerEl) headerEl.style.background = _theme.grad;
  const iconEl = document.getElementById('launchModalHeaderIcon');
  if (iconEl) iconEl.innerHTML = _theme.icon;
  const externalBtn = document.getElementById('launchExternalBtn');
  if (externalBtn) {
    externalBtn.textContent = LANG === 'ja'
      ? (providerLabel + ' を外部で開く')
      : ('Open ' + providerLabel + ' externally');
  }
  const confirmBtn = document.getElementById('launchConfirmBtn');
  if (confirmBtn) {
    confirmBtn.textContent = LANG === 'ja'
      ? (providerLabel + ' を起動')
      : ('Launch ' + providerLabel);
    confirmBtn.style.background = _theme.grad;
    confirmBtn.style.boxShadow = '0 4px 14px ' + _theme.shadow;
  }
  const selectedLabel = document.getElementById('launchSelectedLabel');
  if (selectedLabel) {
    const labels = getLaunchModeLabels(meta.id);
    const currentMode = _launchModalMode || _currentClaudeMode || 'auto';
    selectedLabel.textContent = (LANG === 'ja' ? '選択中: ' : 'Selected: ') + providerLabel + ' / ' + (labels[currentMode] || currentMode);
  }
}
function setClaudeMode(mode) {
  _currentClaudeMode = mode;
  const lbl = document.getElementById('termModeLabel');
  if (lbl) lbl.textContent = getLaunchModeDisplayLabel(_currentAiProvider, mode);
  const dml = document.getElementById('termDrawerModeLabel');
  if (dml) dml.textContent = getLaunchModeDisplayLabel(_currentAiProvider, mode);
  updateLaunchModalSelection(mode);
}

  function setLaunchAdvancedModesOpen(open) {
    _launchAdvancedModesOpen = !!open;
    const panel = document.getElementById('launchAdvancedModes');
    const btn = document.getElementById('launchAdvancedToggle');
    if (panel) panel.style.display = _launchAdvancedModesOpen ? 'block' : 'none';
    if (btn) btn.textContent = _launchAdvancedModesOpen
      ? (LANG === 'ja' ? '閉じる' : 'Hide')
      : (LANG === 'ja' ? '開く' : 'Show');
  }

  function toggleLaunchAdvancedModes() {
    setLaunchAdvancedModesOpen(!_launchAdvancedModesOpen);
  }

  function updateLaunchModalSelection(mode) {
    const current = mode || 'auto';
    _launchModalMode = current;
    const shouldOpenAdvanced = ['default', 'acceptEdits'].includes(current);
    if (shouldOpenAdvanced) setLaunchAdvancedModesOpen(true);
    document.querySelectorAll('input[name="launchMode"]').forEach((input) => {
      input.checked = input.value === current;
    });
  const modes = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];
  const isDanger = current === 'bypassPermissions';
  modes.forEach((value) => {
    const card = document.getElementById('launchOpt_' + value);
    const check = document.getElementById('launchCheck_' + value);
    if (!card) return;
    const isSelected = value === current;
    const borderColor = isSelected ? (isDanger && value === 'bypassPermissions' ? '#ef4444' : '#3b82f6') : '#e2e8f0';
    const bgColor = isSelected ? (isDanger && value === 'bypassPermissions' ? '#fef2f2' : '#eff6ff') : '#fff';
    card.style.borderColor = borderColor;
    card.style.background = bgColor;
    if (check) check.style.display = isSelected ? 'flex' : 'none';
  });
  const lbl = document.getElementById('launchSelectedLabel');
  const labels = getLaunchModeLabels(_currentAiProvider);
  if (lbl) {
    const providerLabel = getAiProviderLabel(_currentAiProvider);
    lbl.textContent = (LANG === 'ja' ? '選択中: ' : 'Selected: ') + providerLabel + ' / ' + (labels[current] || current);
  }
}

  function openLaunchModal(mode) {
    updateLaunchProviderUi(_currentAiProvider);
    setLaunchAdvancedModesOpen(['default', 'acceptEdits'].includes(mode || _currentClaudeMode));
    updateLaunchModalSelection(mode || _currentClaudeMode || 'auto');
    const modal = document.getElementById('launchModal');
    if (modal) modal.style.display = 'flex';
  }

function closeLaunchModal() {
  const modal = document.getElementById('launchModal');
  if (modal) modal.style.display = 'none';
}

function selectLaunchProvider(providerId) {
  updateLaunchProviderUi(providerId);
}

function selectLaunchMode(mode) {
  updateLaunchModalSelection(mode);
}

async function confirmLaunch() {
  const mode = _launchModalMode || _currentClaudeMode || 'auto';
  _currentClaudeMode = mode;
  closeLaunchModal();
  await launchClaude(mode, _currentAiProvider);
}

async function confirmExternalLaunch() {
  const mode = _launchModalMode || _currentClaudeMode || 'auto';
  _currentClaudeMode = mode;
  closeLaunchModal();
  await launchClaudeExternal(mode, _currentAiProvider);
}

// Launch AI (in-process spawn via API)
async function launchClaude(mode = _currentClaudeMode, providerId = _currentAiProvider) {
  const providerLabel = getAiProviderLabel(providerId);
  try {
    const res = await fetch('/api/launch-ai', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ mode, provider: providerId })
    });
    const data = await res.json();
    if (data.ok) {
      _currentAiProvider = data.provider || providerId;
      showToast(t('app.launchAi.success', { provider: providerLabel }) + ' [' + getLaunchModeDisplayLabel(providerId, mode) + ']', 'success');
      document.querySelector('.tab-btn[data-tab="logs"]')?.click();
      setTimeout(() => { pollClaudeStatus(); }, 800);
    } else {
      showToast(t('app.launchAi.error', { provider: providerLabel }) + ': ' + (data.error || ''), 'error');
    }
  } catch (e) {
    showToast(t('app.launchAi.error', { provider: providerLabel }) + ': ' + e.message, 'error');
  }
}

async function launchClaudeExternal(mode = _currentClaudeMode, providerId = _currentAiProvider) {
  const providerLabel = getAiProviderLabel(providerId);
  try {
    const res = await fetch('/api/launch-ai-external', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ mode, provider: providerId })
    });
    const data = await res.json();
    if (data.ok) {
      _currentAiProvider = data.provider || providerId;
      showToast(t('app.launchAi.external', { provider: providerLabel }) + ' [' + getLaunchModeDisplayLabel(providerId, mode) + ']', 'success');
      setTimeout(() => { pollClaudeStatus(); }, 800);
    } else {
      showToast(t('app.launchAi.error', { provider: providerLabel }) + ': ' + (data.error || ''), 'error');
    }
  } catch (e) {
    showToast(t('app.launchAi.error', { provider: providerLabel }) + ': ' + e.message, 'error');
  }
}

async function stopClaude() {
  try {
    const providerLabel = getAiProviderLabel(_currentAiProvider);
    await fetch('/api/stop-ai', { method: 'POST' });
    showToast(t('app.stopAi.success', { provider: providerLabel }), 'info');
    setTimeout(pollClaudeStatus, 800);
  } catch(e) {}
}


// AI CLI status polling
let _claudeStatusTimer = null;
async function pollClaudeStatus() {
  if (document.hidden) return;
  try {
    const res = await fetch('/api/ai/status');
    const data = await res.json();
    const dot = document.getElementById('claudeStatusDot');
    const label = document.getElementById('claudeStatusLabel');
    const btn = document.getElementById('claudeActionBtn');
    const stopBtn = document.getElementById('claudeStopBtn');
    const launchModal = document.getElementById('launchModal');
    const launchModalOpen = !!(launchModal && launchModal.style.display === 'flex');
    if (!dot) return;
    const providerId = data.provider || data.selectedProvider || _currentAiProvider;
    const providerLabel = data.providerLabel || getAiProviderLabel(providerId);
    if (!launchModalOpen) {
      _currentAiProvider = providerId;
      updateLaunchProviderUi(data.selectedProvider || providerId);
    }
    if (data.installState === 'installing') {
      dot.className = 'live-dot warn';
      label.textContent = t('ai.status.installing', { provider: providerLabel });
      btn.textContent = t('ai.status.installing', { provider: providerLabel });
      btn.style.display = '';
      btn._action = 'install';
      btn.disabled = true;
      if (stopBtn) stopBtn.style.display = 'none';
      return;
    }
    btn.disabled = false;
    if (data.managed) {
      // ダッシュボードが起動・管理中 → green
      dot.className = 'live-dot on';
      label.textContent = t('ai.status.connected', { provider: providerLabel }) + ' [' + getLaunchModeDisplayLabel(providerId, data.mode || 'default') + ']';
      btn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
      const dml = document.getElementById('termDrawerModeLabel');
      if (dml) { dml.textContent = getLaunchModeDisplayLabel(providerId, data.mode || 'default'); dml.style.display = ''; }
      const tml = document.getElementById('termModeLabel');
      if (tml) tml.textContent = getLaunchModeDisplayLabel(providerId, data.mode || 'default');
    } else if (data.headless && data.running) {
      dot.className = 'live-dot on';
      label.textContent = t('ai.status.connected', { provider: providerLabel }) + ' [' + getLaunchModeDisplayLabel(providerId, data.mode || 'headless') + ']';
      btn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = '';
      const dml = document.getElementById('termDrawerModeLabel');
      if (dml) { dml.textContent = getLaunchModeDisplayLabel(providerId, data.mode || 'headless'); dml.style.display = ''; }
      const tml = document.getElementById('termModeLabel');
      if (tml) tml.textContent = getLaunchModeDisplayLabel(providerId, data.mode || 'headless');
    } else if (data.running) {
      dot.className = 'live-dot warn';
      label.textContent = t('ai.status.externalRunning', { provider: providerLabel });
      btn.textContent = LANG === 'ja' ? 'AI を起動' : 'Launch AI';
      btn.style.display = '';
      btn._action = 'launch';
      if (stopBtn) stopBtn.style.display = 'none';
      if (!launchModalOpen) updateLaunchModalSelection(_currentClaudeMode);
    } else if (data.installed) {
      dot.className = 'live-dot warn';
      label.textContent = t('ai.status.notRunning', { provider: providerLabel });
      btn.textContent = LANG === 'ja' ? 'AI を起動' : 'Launch AI';
      btn.style.display = '';
      btn._action = 'launch';
      if (stopBtn) stopBtn.style.display = 'none';
      if (!launchModalOpen) updateLaunchModalSelection(_currentClaudeMode);
    } else {
      dot.className = 'live-dot off';
      label.textContent = t('ai.status.notInstalled', { provider: providerLabel });
      btn.textContent = LANG === 'ja' ? 'AI CLI を準備' : 'Prepare AI CLI';
      btn.style.display = '';
      btn._action = 'install';
      if (stopBtn) stopBtn.style.display = 'none';
      if (!launchModalOpen) updateLaunchModalSelection(_currentClaudeMode);
    }
  } catch (e) {
    // network error — leave as-is
  }
}
function claudeAction() {
  const btn = document.getElementById('claudeActionBtn');
  if (!btn) return;
  if (btn._action === 'launch') {
    openLaunchModal(_currentClaudeMode);
  } else if (btn._action === 'install') {
    installClaudeCli();
  }
}

async function installClaudeCli() {
  const btn = document.getElementById('claudeActionBtn');
  if (btn) btn.disabled = true;
  const providerLabel = getAiProviderLabel(_currentAiProvider);
  try {
    showToast(t('ai.install.started', { provider: providerLabel }), 'info');
    const res = await fetch('/api/install-ai-cli', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ provider: _currentAiProvider }),
    });
    const data = await res.json();
    if (res.status === 401 || isDashboardSessionErrorMessage(data.error || data.message || '')) {
      handleDashboardSessionExpired();
      return;
    }
    if (data.ok) {
      showToast(t('ai.install.success', { provider: providerLabel }), 'success');
      setTimeout(pollClaudeStatus, 500);
    } else {
      showToast(t('ai.install.failed', { provider: providerLabel }) + ': ' + (data.error || ''), 'error');
      setTimeout(pollClaudeStatus, 500);
    }
  } catch (e) {
    showToast(t('ai.install.failed', { provider: providerLabel }) + ': ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

updateLaunchProviderUi(_currentAiProvider);

const launchProviderSelectEl = document.getElementById('launchProviderSelect');
if (launchProviderSelectEl) {
  launchProviderSelectEl.addEventListener('change', (event) => {
    updateLaunchProviderUi(event && event.target ? event.target.value : _currentAiProvider);
  });
}

const statusBadge=s=>{
  const m={'':'secondary">'+t('status.unclassified'),'\\u3007':'success">'+t('status.priority'),'\\u00d7':'danger">'+t('status.excluded'),'web\\u00d7':'warning text-dark">'+t('status.webNg')};
  return '<span class="badge bg-'+(m[s]||'secondary">'+esc(s))+'</span>';
};

const actionBadge=a=>{
  if(!a)return'<span class="text-muted">-</span>';
  const m={form_analysis:'info text-dark">'+t('status.analyzed'),form_fill:'primary">'+t('status.filled'),confirm_reached:'warning text-dark">'+t('status.confirmScreen'),awaiting_approval:'warning text-dark">'+t('status.awaitingApproval'),submitted:'success">'+t('status.sent'),skipped:'secondary">'+t('status.skipped'),error:'danger">'+t('status.error')};
  return'<span class="badge bg-'+(m[a]||'secondary">'+esc(a))+'</span>';
};

let currentFilter='all';
let prevStats={};

function updateStat(id,val){
  const el=document.getElementById(id);
  if(el.textContent!==String(val)){
    el.textContent=val;
    el.classList.add('changed');
    setTimeout(()=>el.classList.remove('changed'),500);
  }
}

// Toast notification
function showToast(message, type) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast-msg ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

let selectedCompanyNos = new Set();
let _settingsLoaded = false;
let _settingsDirty = false;

function rowMatchesCurrentFilter(tr) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'approachable') return tr.dataset.f !== 'excluded';
  if (currentFilter === 'targeted') return tr.dataset.targeted === '1';
  return tr.dataset.f === currentFilter;
}

function buildCompanySearchTextClient(company) {
  const action = String((company && company.lastAction) || '').trim();
  const actionAliases = {
    awaiting_approval: '確認待ち awaiting approval',
    confirm_reached: '確認画面 confirm ready',
    form_fill: '入力済み 要対応 form fill',
    submitted: '送信済み sent submitted',
    error: 'エラー error failed',
    skipped: 'スキップ skipped',
  };
  const values = [
    company && company.name,
    company && company.type,
    company && company.lastAction,
    actionAliases[action] || '',
    company && company.progress,
    company && company.formUrl,
    company && company.url,
    company && company.sentMessage,
    company && company.manualReviewReason,
    company && company.lastErrorDetail,
    company && company.lastActionDetail,
  ];
  return values
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function truncateUiTextClient(value, maxLength = 120) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

function populateCompanyFilterOptions(companies) {
  const typeSelect = document.getElementById('companyTypeFilter');
  const progressSelect = document.getElementById('companyProgressFilter');
  if (!typeSelect || !progressSelect) return;

  const currentType = typeSelect.value || '';
  const currentProgress = progressSelect.value || '';
  const typeOptions = Array.from(new Set((companies || []).map((company) => String(company.type || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));
  const progressOptions = Array.from(new Set((companies || []).map((company) => String(company.lastAction || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));

  typeSelect.innerHTML = '<option value="">' + (LANG === 'ja' ? '種別: すべて' : 'Type: All') + '</option>'
    + typeOptions.map((value) => '<option value="' + esc(value.toLowerCase()) + '">' + esc(value) + '</option>').join('');
  progressSelect.innerHTML = '<option value="">' + (LANG === 'ja' ? '進捗: すべて' : 'Progress: All') + '</option>'
    + progressOptions.map((value) => '<option value="' + esc(value.toLowerCase()) + '">' + esc(value) + '</option>').join('');

  if (currentType && Array.from(typeSelect.options).some((option) => option.value === currentType)) typeSelect.value = currentType;
  if (currentProgress && Array.from(progressSelect.options).some((option) => option.value === currentProgress)) progressSelect.value = currentProgress;
}

function applyCompanyFilters() {
  const q = (document.getElementById('q').value || '').toLowerCase();
  const typeFilter = (document.getElementById('companyTypeFilter')?.value || '').toLowerCase();
  const progressFilter = (document.getElementById('companyProgressFilter')?.value || '').toLowerCase();
  // リセットボタンの表示制御
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) {
    const hasFilter = q || typeFilter || progressFilter || currentFilter !== 'all';
    clearBtn.classList.toggle('visible', !!hasFilter);
  }
  const visibleCompanyNos = new Set();
  document.querySelectorAll('#mt tbody tr').forEach((tr) => {
    const matchQ = !q || (tr.dataset.search || '').includes(q);
    const matchType = !typeFilter || (tr.dataset.typeExact || '') === typeFilter;
    const matchProgress = !progressFilter || (tr.dataset.progressExact || '') === progressFilter;
    const visible = matchQ && matchType && matchProgress && rowMatchesCurrentFilter(tr);
    tr.style.display = visible ? '' : 'none';
    if (visible) visibleCompanyNos.add(String(tr.dataset.no));
  });
  selectedCompanyNos = new Set(Array.from(selectedCompanyNos).filter((companyNo) => visibleCompanyNos.has(String(companyNo))));
  syncCompanySelectionUi();
}

function clearAllFilters() {
  document.getElementById('q').value = '';
  const tf = document.getElementById('companyTypeFilter');
  if (tf) tf.value = '';
  const pf = document.getElementById('companyProgressFilter');
  if (pf) pf.value = '';
  currentFilter = 'all';
  document.querySelectorAll('#tab-companies .fb').forEach(b => b.classList.remove('active'));
  document.querySelector('#tab-companies .fb[data-f="all"]')?.classList.add('active');
  applyCompanyFilters();
}

function syncCompanySelectionUi() {
  document.querySelectorAll('.company-select').forEach((checkbox) => {
    checkbox.checked = selectedCompanyNos.has(String(checkbox.dataset.no));
  });

  const visibleCheckboxes = Array.from(document.querySelectorAll('.company-select')).filter((checkbox) => {
    const row = checkbox.closest('tr');
    return row && row.style.display !== 'none';
  });
  const allVisibleChecked = visibleCheckboxes.length > 0 && visibleCheckboxes.every((checkbox) => selectedCompanyNos.has(String(checkbox.dataset.no)));
  const master = document.getElementById('companySelectAll');
  if (master) master.checked = allVisibleChecked;
}

function toggleCompanySelection(companyNo, checked) {
  const key = String(companyNo);
  if (checked) selectedCompanyNos.add(key);
  else selectedCompanyNos.delete(key);
  syncCompanySelectionUi();
}

function toggleAllCompanies(forceChecked) {
  const visibleCheckboxes = Array.from(document.querySelectorAll('.company-select')).filter((checkbox) => {
    const row = checkbox.closest('tr');
    return row && row.style.display !== 'none' && !checkbox.disabled;
  });
  const nextChecked = typeof forceChecked === 'boolean'
    ? forceChecked
    : !(visibleCheckboxes.length > 0 && visibleCheckboxes.every((checkbox) => checkbox.checked));
  visibleCheckboxes.forEach((checkbox) => {
    const key = String(checkbox.dataset.no);
    if (nextChecked) selectedCompanyNos.add(key);
    else selectedCompanyNos.delete(key);
  });
  syncCompanySelectionUi();
}

function getSelectedCompanyNos() {
  return Array.from(selectedCompanyNos).map((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  });
}

function openCompanyFormModal() {
  document.getElementById('companyFormMode').value = 'create';
  document.getElementById('companyFormCompanyNo').value = '';
  document.getElementById('companyFormTitle').textContent = t('companyModal.title') || 'Add Company';
  document.getElementById('companyFormSubmitBtn').textContent = t('companyModal.submit') || 'Add Company';
  ['companyName', 'type', 'url', 'formUrl', 'status', 'progress', 'notes'].forEach((field) => {
    const input = document.getElementById('new-' + field);
    if (input) input.value = '';
  });
  const addTarget = document.getElementById('new-addTarget');
  if (addTarget) addTarget.checked = true;
  document.getElementById('companyFormModal').classList.add('open');
}

function closeCompanyFormModal() {
  document.getElementById('companyFormModal').classList.remove('open');
}

function openCompanyEditModal(companyNo) {
  const company = _allCompanies.find((entry) => String(entry.no) === String(companyNo));
  if (!company) {
    showToast(t('companyModal.loadFailed') || 'Could not load company data.', 'error');
    return;
  }

  document.getElementById('companyFormMode').value = 'edit';
  document.getElementById('companyFormCompanyNo').value = String(company.no);
  document.getElementById('companyFormTitle').textContent = t('companyModal.editTitle') || 'Edit Company';
  document.getElementById('companyFormSubmitBtn').textContent = t('companyModal.update') || 'Save Changes';
  document.getElementById('new-companyName').value = company.name || '';
  document.getElementById('new-type').value = company.type || '';
  document.getElementById('new-url').value = company.url || '';
  document.getElementById('new-formUrl').value = company.formUrl || '';
  document.getElementById('new-status').value = company.status || '';
  document.getElementById('new-progress').value = company.progress || '';
  document.getElementById('new-notes').value = company.notes || '';
  const addTarget = document.getElementById('new-addTarget');
  if (addTarget) addTarget.checked = !!company.isOutreachTarget;
  document.getElementById('companyFormModal').classList.add('open');
}

document.getElementById('companyFormModal').addEventListener('click', function (event) {
  if (event.target === this) closeCompanyFormModal();
});

async function submitCompanyForm() {
  const companyName = (document.getElementById('new-companyName').value || '').trim();
  const mode = document.getElementById('companyFormMode').value || 'create';
  const companyNo = document.getElementById('companyFormCompanyNo').value || '';
  if (!companyName) {
    showToast(t('companyModal.companyRequired') || 'Company name is required.', 'error');
    return;
  }

  try {
    const res = await fetch(mode === 'edit' ? ('/api/companies/' + encodeURIComponent(companyNo)) : '/api/companies', {
      method: mode === 'edit' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName,
        type: document.getElementById('new-type').value,
        url: document.getElementById('new-url').value,
        formUrl: document.getElementById('new-formUrl').value,
        status: document.getElementById('new-status').value,
        progress: document.getElementById('new-progress').value,
        notes: document.getElementById('new-notes').value,
        addToTarget: document.getElementById('new-addTarget').checked,
      }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || (mode === 'edit' ? 'Failed to update company.' : 'Failed to add company.'));

    closeCompanyFormModal();
    showToast(mode === 'edit' ? (t('companyModal.updated') || 'Company updated.') : (t('companyModal.added') || 'Company added.'), 'success');
    refreshData();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

async function deleteCompanyRow(companyNo) {
  const company = _allCompanies.find((entry) => String(entry.no) === String(companyNo));
  if (!company) {
    showToast(t('companyModal.loadFailed') || 'Could not load company data.', 'error');
    return;
  }

  if (!confirm(t('companyModal.deleteConfirm', { company: company.name || String(companyNo) }))) return;

  try {
    const res = await fetch('/api/companies/' + encodeURIComponent(companyNo), {
      method: 'DELETE',
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to delete company.');
    selectedCompanyNos.delete(String(companyNo));
    showToast(t('companyModal.deleted') || 'Company deleted.', 'success');
    removeAwaitingCardFromUi(companyNo);
    removeCompanyRowFromUi(companyNo);
    refreshAfterMutation();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

async function bulkDeleteCompanies() {
  const companyNos = getSelectedCompanyNos();
  if (companyNos.length === 0) {
    alert(t('alert.selectCompanies'));
    return;
  }

  if (!confirm(t('confirm.bulkDeleteCompanies', { count: companyNos.length }))) return;

  try {
    const res = await fetch('/api/companies/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to delete selected companies.');
    selectedCompanyNos = new Set();
    showToast(t('companyModal.bulkDeleted', { count: result.deletedCount || companyNos.length }) || 'Selected companies deleted.', 'success');
    if (result.skippedCount > 0) {
      showToast((LANG === 'ja' ? '一部の行は削除対象外のためスキップしました。' : 'Some rows were skipped because they are not deletable.'), 'info');
    }
    companyNos.forEach((companyNo) => {
      removeAwaitingCardFromUi(companyNo);
      removeCompanyRowFromUi(companyNo);
    });
    refreshAfterMutation();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

function triggerCompanyImport() {
  const input = document.getElementById('companyImportInput');
  input.value = '';
  input.click();
}

function downloadSettingsWorkbook(mode) {
  const selectedMode = mode === 'template' ? 'template' : 'current';
  const link = document.createElement('a');
  link.href = withSessionQuery('/api/settings/excel/export?mode=' + encodeURIComponent(selectedMode));
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function triggerSettingsWorkbookImport() {
  const input = document.getElementById('settingsWorkbookImportInput');
  if (!input) return;
  input.value = '';
  input.click();
}

function describeImportedSettingsSections(sectionKeys) {
  const labels = {
    companyProfile: t('settings.companyProfile') || 'Company Profile',
    valuePropositions: t('settings.valuePropositions') || 'Value Propositions',
  };
  return (sectionKeys || []).map((key) => labels[key] || key).join(' / ');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

document.getElementById('companyImportInput').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    showToast((t('action.importTargets') || 'Importing') + ': ' + file.name, 'info');
    const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
    const res = await fetch('/api/target-list/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64 }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Import failed.');

    showToast((t('companyImport.success') || 'Imported') + ': ' + (result.companyCount || 0), 'success');
    refreshData();
    loadTargetPreview().catch(() => {});
  } catch (e) {
    showToast((t('companyImport.failed') || 'Import failed') + ': ' + e.message, 'error');
  } finally {
    event.target.value = '';
  }
});

document.getElementById('settingsWorkbookImportInput').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    showToast((t('settings.excel.importing') || 'Importing Excel') + ': ' + file.name, 'info');
    const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
    const res = await fetch('/api/settings/excel/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64 }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Import failed.');

    await loadSettings({ force: true });
    showToast((t('settings.excel.importSuccess') || 'Imported settings') + ': ' + describeImportedSettingsSections(result.applied), 'success');
  } catch (e) {
    showToast((t('settings.excel.importFailed') || 'Import failed') + ': ' + e.message, 'error');
  } finally {
    event.target.value = '';
  }
});

async function markSelectedTargets(active) {
  const companyNos = getSelectedCompanyNos();
  if (companyNos.length === 0) {
    alert(t('alert.selectCompanies'));
    return;
  }

  try {
    const res = await fetch('/api/outreach-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos, active }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to update targets.');
    showToast(active ? (t('target.updatedOn') || 'Outreach targets updated.') : (t('target.updatedOff') || 'Outreach targets removed.'), 'success');
    refreshData();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

async function prepareSelectedOutreach() {
  const companyNos = getSelectedCompanyNos();
  if (companyNos.length === 0) { alert(t('alert.selectCompanies')); return; }
  const providerId = _currentAiProvider;
  const providerLabel = getAiProviderLabel(providerId);
  if (!confirm(t('outreach.prepareConfirm', { company: companyNos.length + '社' }))) return;
  try {
    const res = await fetch('/api/ai-form-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos, provider: providerId }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to start');
    showToast(t('outreach.queueStarted', { count: companyNos.length }) + ' (' + providerLabel + ')', 'success');
    refreshData();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

async function prepareOutreach(companyNo, companyName) {
  if (!confirm(t('outreach.prepareConfirm', { company: companyName }))) return;
  const providerId = _currentAiProvider;
  const providerLabel = getAiProviderLabel(providerId);
  selectedCompanyNos.add(String(companyNo));
  syncCompanySelectionUi();
  try {
    const res = await fetch('/api/ai-form-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos: [companyNo], provider: providerId }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to start');
    showToast(t('outreach.singleQueued', { company: companyName }) + ' (' + providerLabel + ')', 'success');
    refreshData();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

function outreachStatusBadge(status, detail) {
  if (!status) return '';
  const label = status === 'pending' ? (t('outreach.status.pending') || 'Queued')
    : status === 'processing' ? (t('outreach.status.processing') || 'Processing')
    : status === 'awaiting_approval' ? (t('outreach.status.awaiting') || 'Awaiting')
    : status === 'error' ? (t('outreach.status.error') || 'Error')
    : esc(status);
  const className = status === 'error' ? 'chip chip-error'
    : status === 'awaiting_approval' ? 'chip chip-warning'
    : status === 'processing' ? 'chip chip-info'
    : 'chip chip-primary';
  return '<span class="' + className + '" title="' + esc(detail || label) + '">' + label + '</span>';
}

let renderVersion = 0;
let lastScreenshotRenderSignature = '';
let refreshInFlight = false;
let pendingRefresh = false;
let refreshStartedAt = 0;
let refreshAbortController = null;
let mutationRefreshTimer = null;
let mutationRefreshFollowupTimer = null;
let scheduledRefreshTimer = null;
let scheduledRefreshForce = false;
let _latestDashboardData = null;
let es = null;
let reconnectTimer = null;
let offlinePollTimer = null;

function screenshotUrl(fileName) {
  return withSessionQuery('/screenshots/' + encodeURIComponent(fileName) + '?v=' + renderVersion);
}

function monitorScreenshotUrl(monitor) {
  const fileName = monitor && monitor.latestScreenshotName ? monitor.latestScreenshotName : '';
  return fileName ? screenshotUrl(fileName) : '';
}

function buildScreenshotRenderSignature(data) {
  const liveMonitor = data && data.liveMonitor ? data.liveMonitor : {};
  const companies = Array.isArray(data && data.companies) ? data.companies : [];
  const parts = companies
    .filter((company) => company && (company.inputScreenshotName || company.confirmScreenshotName || company.lastAction === 'awaiting_approval' || company.lastAction === 'confirm_reached'))
    .map((company) => [
      company.no,
      company.inputScreenshotName || '',
      company.confirmScreenshotName || '',
      company.screenshotAuditState || '',
      company.lastAction || '',
      company.lastActionAt || '',
    ].join(':'));
  parts.push(liveMonitor.latestScreenshotName || '', liveMonitor.updatedAt || '', liveMonitor.companyNo || '');
  return parts.join('|');
}

function syncScreenshotRenderVersion(data) {
  const signature = buildScreenshotRenderSignature(data);
  if (signature !== lastScreenshotRenderSignature) {
    lastScreenshotRenderSignature = signature;
    renderVersion += 1;
  }
}

function requestDashboardRefresh(options = {}) {
  const delay = Number.isFinite(Number(options.delay)) ? Math.max(0, Number(options.delay)) : 120;
  if (options.force) scheduledRefreshForce = true;
  if (scheduledRefreshTimer) return;
  scheduledRefreshTimer = setTimeout(() => {
    const shouldForce = scheduledRefreshForce;
    scheduledRefreshTimer = null;
    scheduledRefreshForce = false;
    refreshData({ force: shouldForce, toastOnError: !!options.toastOnError });
  }, delay);
}

function renderLiveMonitor(monitor) {
  const statusEl = document.getElementById('monitorStatusChip');
  const updatedAtEl = document.getElementById('monitorUpdatedAt');
  const activeSummaryEl = document.getElementById('monitorActiveSummary');
  const eventListEl = document.getElementById('monitorEventList');
  const companyEl = document.getElementById('monitorCompany');
  const stepEl = document.getElementById('monitorStep');
  const urlEl = document.getElementById('monitorCurrentUrl');
  const screenshotWrap = document.getElementById('monitorScreenshotWrap');
  const screenshotLink = document.getElementById('monitorScreenshotLink');
  if (!statusEl || !updatedAtEl || !activeSummaryEl || !eventListEl || !companyEl || !stepEl || !urlEl || !screenshotWrap || !screenshotLink) return;

  const status = monitor && monitor.status ? monitor.status : 'idle';
  const locale = LANG === 'ja' ? 'ja-JP' : undefined;
  const labels = {
    idle: LANG === 'ja' ? '待機中' : 'Idle',
    queued: LANG === 'ja' ? 'キュー投入済み' : 'Queued',
    processing: LANG === 'ja' ? '処理中' : 'Processing',
    awaiting_approval: LANG === 'ja' ? '確認待ち' : 'Awaiting Approval',
    completed: LANG === 'ja' ? '完了' : 'Completed',
    submitted: LANG === 'ja' ? '送信済み' : 'Submitted',
    skipped: LANG === 'ja' ? 'スキップ' : 'Skipped',
    user_required: LANG === 'ja' ? '要対応' : 'User Required',
    error: LANG === 'ja' ? 'エラー' : 'Error',
  };
  const styles = {
    idle: { bg: 'var(--surface-low)', fg: 'var(--on-surface-variant)' },
    queued: { bg: 'var(--surface-container)', fg: 'var(--primary)' },
    processing: { bg: 'var(--info-container)', fg: 'var(--info)' },
    awaiting_approval: { bg: 'var(--warning-container)', fg: 'var(--warning)' },
    completed: { bg: 'var(--success-container)', fg: 'var(--success)' },
    submitted: { bg: 'var(--success-container)', fg: 'var(--success)' },
    skipped: { bg: 'var(--surface-low)', fg: 'var(--on-surface-variant)' },
    user_required: { bg: 'var(--warning-container)', fg: 'var(--warning)' },
    error: { bg: 'var(--error-container)', fg: 'var(--error)' },
  };
  const dotColors = { processing:'#3b82f6', awaiting_approval:'#f59e0b', user_required:'#f59e0b', error:'#ef4444', submitted:'#10b981', completed:'#10b981', queued:'#6366f1' };
  const tone = styles[status] || styles.idle;
  const events = monitor && Array.isArray(monitor.events) ? monitor.events : [];
  const activeCount = monitor && Number.isFinite(Number(monitor.activeCount)) ? Number(monitor.activeCount) : 0;
  statusEl.textContent = labels[status] || status;
  statusEl.style.background = tone.bg;
  statusEl.style.color = tone.fg;
  const dot = document.getElementById('monitorDot');
  if (dot) {
    dot.style.background = dotColors[status] || '#94a3b8';
    dot.className = status === 'processing' ? 'monitor-dot-active' : '';
  }
  updatedAtEl.textContent = monitor && monitor.updatedAt ? new Date(monitor.updatedAt).toLocaleString(locale) : '-';
  activeSummaryEl.textContent = activeCount > 0
    ? (LANG === 'ja'
        ? (activeCount + '件進行中 / 最新: ' + (labels[status] || status))
        : (activeCount + ' active / latest: ' + (labels[status] || status)))
    : (events.length > 0
        ? (LANG === 'ja' ? '直近の処理履歴を表示しています' : 'Showing recent activity')
        : (LANG === 'ja' ? '待機中' : 'Idle'));
  companyEl.textContent = monitor && monitor.companyName ? ((monitor.companyNo ? '#' + monitor.companyNo + ' ' : '') + monitor.companyName) : (LANG === 'ja' ? '実行待ち' : 'Waiting');
  stepEl.textContent = monitor && monitor.step ? monitor.step : (LANG === 'ja' ? 'まだ処理は開始されていません' : 'No active step');

  if (events.length === 0) {
    eventListEl.innerHTML = '<div style="padding:18px 14px;color:var(--outline);font-size:.78rem">' + (LANG === 'ja' ? 'まだ進行状況ログはありません。' : 'No progress log yet.') + '</div>';
  } else {
    eventListEl.innerHTML = events.slice(0, 14).map((event, index) => {
      const eventStatus = event && event.status ? event.status : 'idle';
      const eventTone = styles[eventStatus] || styles.idle;
      const companyLabel = event && event.companyName
        ? ((event.companyNo ? '#' + event.companyNo + ' ' : '') + event.companyName)
        : (LANG === 'ja' ? '対象未設定' : 'Unknown target');
      const stepLabel = event && event.step ? event.step : (LANG === 'ja' ? 'ステップ未設定' : 'No step');
      const timeLabel = event && event.updatedAt ? new Date(event.updatedAt).toLocaleTimeString(locale) : '--:--:--';
      const urlLabel = event && event.currentUrl ? esc(event.currentUrl) : '';
      const screenshotHref = monitorScreenshotUrl(event);
      return ''
        + '<div style="padding:12px 14px;border-bottom:1px solid var(--outline-variant);background:' + (index === 0 ? 'var(--surface-lowest)' : '#fff') + '">'
        +   '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:6px">'
        +     '<div style="min-width:0">'
        +       '<div style="font-size:.82rem;font-weight:700;color:var(--on-surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(companyLabel) + '</div>'
        +       '<div style="margin-top:2px;font-size:.74rem;color:var(--on-surface-variant)">' + esc(stepLabel) + '</div>'
        +     '</div>'
        +     '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">'
        +       '<span style="display:inline-flex;align-items:center;gap:4px;background:' + eventTone.bg + ';color:' + eventTone.fg + ';font-size:.62rem;font-weight:700;padding:2px 8px;border-radius:999px">' + esc(labels[eventStatus] || eventStatus) + '</span>'
        +       '<span style="font-size:.68rem;color:var(--outline);font-family:var(--font-mono)">' + esc(timeLabel) + '</span>'
        +     '</div>'
        +   '</div>'
        +   '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
        +     (urlLabel
              ? '<a href="' + urlLabel + '" target="_blank" style="min-width:0;max-width:100%;font-size:.69rem;color:var(--primary);text-decoration:none;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + urlLabel + '</a>'
              : '<span style="font-size:.69rem;color:var(--outline)">' + (LANG === 'ja' ? 'URLなし' : 'No URL') + '</span>')
        +     (screenshotHref
              ? '<a href="' + screenshotHref + '" target="_blank" style="font-size:.68rem;color:var(--primary);text-decoration:none;font-weight:600">' + (LANG === 'ja' ? 'スクショ ↗' : 'Screenshot ↗') + '</a>'
              : '')
        +   '</div>'
        + '</div>';
    }).join('');
  }

  if (monitor && monitor.currentUrl) {
    urlEl.textContent = monitor.currentUrl;
    urlEl.href = monitor.currentUrl;
    urlEl.style.pointerEvents = 'auto';
    urlEl.style.color = 'var(--primary)';
  } else {
    urlEl.textContent = '-';
    urlEl.href = '#';
    urlEl.style.pointerEvents = 'none';
    urlEl.style.color = 'var(--outline)';
  }

  const screenshotHref = monitorScreenshotUrl(monitor);
  if (screenshotHref) {
    screenshotLink.href = screenshotHref;
    screenshotLink.style.display = 'inline';
    screenshotWrap.innerHTML = ''
      + '<img src="' + screenshotHref + '"'
      + ' alt="Latest screenshot"'
      + ' style="width:100%;min-width:100%;height:auto;display:block;flex:0 0 auto;border:1px solid var(--outline-variant);cursor:pointer;background:#fff"'
      + ' onclick="window.open(this.src)"'
      + ' onerror="this.parentElement.innerHTML=(LANG===\\'ja\\'?\\'スクリーンショット待機中\\':\\'Waiting for screenshot\\')">';
  } else {
    screenshotLink.href = '#';
    screenshotLink.style.display = 'none';
    screenshotWrap.innerHTML = LANG === 'ja' ? 'スクリーンショット待機中' : 'Waiting for screenshot';
  }
}

function renderStatusBanner(data) {
  const btn = document.getElementById('memoBtn');
  const panel = document.getElementById('memoPanel');
  const badge = document.getElementById('memoBadge');
  const issues = Array.isArray(data.issues) ? data.issues.filter(Boolean) : [];
  if (issues.length === 0) {
    btn.classList.remove('has-issues');
    panel.classList.remove('open');
    panel.innerHTML = '';
    return;
  }

  const runtime = data.runtime || null;
  const runtimeMeta = runtime && runtime.url
    ? '<div class="status-meta">Runtime: <a href="' + esc(runtime.url) + '" target="_blank">' + esc(runtime.url) + '</a></div>'
    : '';

  badge.textContent = issues.length;
  btn.classList.add('has-issues');
  panel.innerHTML =
    '<strong>' + (LANG === 'ja' ? '運用メモ' : 'Operational Notice') + '</strong>' +
    '<ul>' + issues.map(issue => '<li>' + esc(issue) + '</li>').join('') + '</ul>' +
    runtimeMeta;
}

function toggleMemoPanel() {
  const panel = document.getElementById('memoPanel');
  panel.classList.toggle('open');
}

// Close memo panel on outside click
document.addEventListener('click', function(e) {
  const panel = document.getElementById('memoPanel');
  const btn = document.getElementById('memoBtn');
  if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('open');
  }
});

async function refreshData(options = {}) {
  const isForce = !!options.force;
  const now = Date.now();
  if (refreshInFlight) {
    if (isForce || (refreshStartedAt && (now - refreshStartedAt) > 8000)) {
      try { if (refreshAbortController) refreshAbortController.abort(); } catch (_) {}
      refreshInFlight = false;
      refreshStartedAt = 0;
      refreshAbortController = null;
      pendingRefresh = false;
    } else {
      pendingRefresh = true;
      return;
    }
  }

  refreshInFlight = true;
  refreshStartedAt = Date.now();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  refreshAbortController = controller;
  const timeoutId = setTimeout(() => {
    try {
      if (refreshAbortController === controller && controller) controller.abort();
    } catch (_) {}
  }, 8000);

  try {
    const res = await fetch('/api/data', { cache: 'no-store', signal: controller ? controller.signal : undefined });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load dashboard data.');
    render(data);
  } catch (e) {
    const isAbort = !!(e && (e.name === 'AbortError' || /aborted|abort/i.test(String(e.message || ''))));
    if (!isAbort) {
      renderStatusBanner({ issues: [e.message] });
      if (options.toastOnError) showToast((LANG === 'ja' ? '読込失敗: ' : 'Load failed: ') + e.message, 'error');
    } else if (options.toastOnError) {
      showToast((LANG === 'ja' ? '読込がタイムアウトしました。再試行します。' : 'Dashboard refresh timed out. Retrying.'), 'warning');
    }
  } finally {
    clearTimeout(timeoutId);
    if (refreshAbortController === controller) refreshAbortController = null;
    refreshInFlight = false;
    refreshStartedAt = 0;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshData();
    }
  }
}

function render(data){
  syncScreenshotRenderVersion(data);
  _latestDashboardData = data;
  renderStatusBanner(data);
  const{companies,stats,recentLogs,liveMonitor}=data;
  _allCompanies=companies;
  renderLiveMonitor(liveMonitor);

  // Stats
  updateStat('s-approachable', stats.approachable);
  updateStat('s-hasFormUrl', stats.hasFormUrl);
  updateStat('s-formFill', stats.actionNeeded);
  updateStat('s-awaitingApproval', stats.awaitingApproval);
  updateStat('s-submitted', stats.submitted);
  updateStat('s-error', stats.error);
  updateStat('s-excluded', stats.excluded);

  // Company table
  const body=document.getElementById('companyBody');
  const validCompanyNos = new Set(companies.filter((company) => company.canManageInTargetList).map((company) => String(company.no)));
  selectedCompanyNos = new Set(Array.from(selectedCompanyNos).filter((companyNo) => validCompanyNos.has(companyNo)));
  const oldRows={};
  body.querySelectorAll('tr').forEach(tr=>oldRows[tr.dataset.no]=tr.dataset.la);

  let html='';
  companies.forEach(c=>{
    const f=!c.isApproachable?'excluded':c.lastAction==='submitted'?'submitted':c.lastAction==='error'?'error':c.formUrl?'has-form':'no-form';
    const excl=c.isApproachable?'':'excluded';
    const isNew=oldRows[c.no]!==undefined&&oldRows[c.no]!==(c.lastAction||'');
    const upd=isNew?' updated':'';

    const display=currentFilter==='all'?'':currentFilter==='approachable'?(f!=='excluded'?'':'none'):currentFilter==='targeted'?(c.isOutreachTarget?'':'none'):(f===currentFilter?'':'none');

    const cnt=c.contactCount||0;
    const cntHtml=cnt===0?'<span class="text-muted">-</span>':cnt===1?'<span class="badge bg-success">1x</span>':'<span class="badge bg-info">'+cnt+'x</span>';

    let msgHtml='<span class="text-muted" style="font-size:.72rem">' + esc(t('message.notLogged') || '-') + '</span>';
    if(c.sentMessage){
      const preview=esc(c.sentMessage).substring(0,50);
      msgHtml='<span class="text-muted" style="font-size:.75rem;cursor:pointer" title="Click to view full message" onclick="showMsg('+c.no+')">'+preview+'...</span>';
    }

    const targetBadge=c.isOutreachTarget?'<span class="chip chip-primary">'+(t('target.badge')||'Target')+'</span>':'';
    const detachedBadge=c.isDetachedFromTargetList?'<span class="chip">'+(LANG==='ja'?'履歴のみ':'History only')+'</span>':'';
    const queueBadge=outreachStatusBadge(c.outreachStatus,c.outreachDetail);
    const companyUrlHtml=c.url?'<a href="'+esc(c.url)+'" target="_blank">'+esc(c.name)+'</a>':'<span>'+esc(c.name)+'</span>';
    const manualBadge=(c.readyForManualApproval&&['awaiting_approval','confirm_reached'].includes(c.lastAction||''))?'<span class="chip chip-warning" title="'+esc(c.manualReviewDetail||c.manualReviewReason||'')+'">'+esc(truncateUiTextClient(c.manualReviewReason || (LANG==='ja'?'手動送信待ち':'Manual action required'), 40))+'</span>':'';
    const directSubmitBadge=(c.directSubmitDetected&&['awaiting_approval','confirm_reached'].includes(c.lastAction||''))?'<span class="chip chip-warning" title="'+esc(c.manualReviewDetail||c.manualReviewReason||'')+'">'+(LANG==='ja'?'直接送信型の可能性':'Direct-submit form')+'</span>':'';
    const errorBadge=(c.lastAction==='error'&&c.lastErrorDetail)?'<span class="chip chip-error" title="'+esc(c.lastErrorDetail)+'">'+esc(truncateUiTextClient(c.lastErrorDetail, 48))+'</span>':'';
    const progressMeta=[queueBadge, manualBadge, directSubmitBadge, errorBadge].filter(Boolean).join('');
    const progressHtml=(c.lastAction?actionBadge(c.lastAction):'<span class="text-muted">-</span>')+(progressMeta?'<div class="company-meta">'+progressMeta+'</div>':'');
    const searchText=buildCompanySearchTextClient(c);

    let actionHtml='';
    const cname=esc(c.name).replace(/'/g,"\\'");
    if(c.lastAction==='awaiting_approval'||c.lastAction==='confirm_reached'){
      actionHtml='<div class="company-action-grid">'
        +'<button class="btn btn-success btn-sm company-action-btn" onclick="approveCompany('+c.no+',\\x27'+cname+'\\x27,\\x27sent\\x27)">'+t('action.markSent')+'</button>'
        +'<button class="btn btn-outline-secondary btn-sm company-action-btn" onclick="skipWithFeedback('+c.no+',\\x27'+cname+'\\x27)">'+t('action.skip')+'</button>'
        +(c.canManageInTargetList
          ? '<button class="btn btn-outline-secondary btn-sm company-action-btn" onclick="openCompanyEditModal('+c.no+')">'+(t('action.editCompany')||'Edit')+'</button>'
            +'<button class="btn btn-outline-danger btn-sm company-action-btn" onclick="deleteCompanyRow('+c.no+')">'+(t('action.deleteCompany')||'Delete')+'</button>'
          : '<span class="company-action-btn text-muted" style="border:1px dashed var(--border-default);background:var(--bg-surface)">'+(LANG==='ja'?'履歴のみ':'History only')+'</span>'
            +'<button class="btn btn-outline-danger btn-sm company-action-btn" onclick="deleteCompanyRow('+c.no+')">'+(t('action.deleteCompany')||'Delete')+'</button>')
        +'</div>';
    }else if(c.lastAction==='submitted'){
      actionHtml='<span style="font-size:.7rem;color:#198754">'+t('action.done')+'</span>';
    }else if(c.outreachStatus==='pending'||c.outreachStatus==='processing'){
      actionHtml='<small class="text-muted">'+esc(c.outreachDetail||'Processing')+'</small>';
    }else if(c.isApproachable){
      actionHtml='<button class="btn btn-outline-primary btn-sm" onclick="prepareOutreach('+c.no+',\\x27'+cname+'\\x27)">'+(t('action.prepareOutreach')||'Prepare')+'</button>';
    }

    const manageHtml=c.canManageInTargetList
      ? '<div class="company-action-grid single-row">'
        +'<button class="btn btn-outline-secondary btn-sm company-action-btn" onclick="openCompanyEditModal('+c.no+')">'+(t('action.editCompany')||'Edit')+'</button>'
        +'<button class="btn btn-outline-danger btn-sm company-action-btn" onclick="deleteCompanyRow('+c.no+')">'+(t('action.deleteCompany')||'Delete')+'</button>'
        +'</div>'
      : '<div class="company-action-grid single-row">'
        +'<span class="company-action-btn text-muted" style="border:1px dashed var(--border-default);background:var(--bg-surface)">'+(LANG==='ja'?'履歴のみ':'History only')+'</span>'
        +'<button class="btn btn-outline-danger btn-sm company-action-btn" onclick="deleteCompanyRow('+c.no+')">'+(t('action.deleteCompany')||'Delete')+'</button>'
        +'</div>';
    actionHtml = actionHtml ? actionHtml : manageHtml;
    const selectTitle = c.canManageInTargetList
      ? (LANG==='ja'?'この行を選択':'Select this row')
      : (LANG==='ja'?'履歴のみの行も削除対象として選択できます':'History-only rows can also be selected for deletion');
    const selectCellHtml = '<input type="checkbox" class="form-check-input company-select" data-manageable="'+(c.canManageInTargetList?'1':'0')+'" data-no="'+c.no+'" title="'+selectTitle+'" onchange="toggleCompanySelection('+c.no+', this.checked)">';

    html+='<tr class="'+excl+upd+'" data-f="'+f+'" data-targeted="'+(c.isOutreachTarget?'1':'0')+'" data-n="'+esc(c.name).toLowerCase()+'" data-no="'+c.no+'" data-la="'+(c.lastAction||'')+'" data-type="'+esc(c.type).toLowerCase()+'" data-type-exact="'+esc((c.type||'').trim().toLowerCase())+'" data-cnt="'+cnt+'" data-progress="'+(c.lastAction||'')+'" data-progress-exact="'+esc((c.lastAction||'').trim().toLowerCase())+'" data-search="'+esc(searchText)+'" style="display:'+display+'" onclick="showCompanyDetail('+c.no+',event)">'
      +'<td class="checkbox-cell" onclick="event.stopPropagation()">'+selectCellHtml+'</td>'
      +'<td>'+c.no+'</td>'
      +'<td title="'+esc(c.name)+(c.isOutreachTarget?' [営業対象]':'')+(c.isDetachedFromTargetList?' [履歴のみ]':'')+'">'+companyUrlHtml+((targetBadge||detachedBadge)?'<div class="company-meta">'+targetBadge+detachedBadge+'</div>':'')+'</td>'
      +'<td title="'+esc(c.type)+'"><small>'+esc(c.type)+'</small></td>'
      +'<td title="'+(c.lastAction||'-')+(c.lastErrorDetail?' | '+esc(c.lastErrorDetail):'')+'">'+progressHtml+'</td>'
      +'<td class="text-center">'+cntHtml+'</td>'
      +'<td title="'+(c.formUrl||'-')+'">'+(c.formUrl?'<a href="'+esc(c.formUrl)+'" target="_blank" onclick="event.stopPropagation()" title="'+esc(c.formUrl)+'">'+esc(c.formUrl).substring(0,30)+'…</a>':'-')+'</td>'
      +'<td title="'+(c.sentMessage?esc(c.sentMessage).substring(0,100):'')+'">'+msgHtml+'</td>'
      +'<td class="action-cell" onclick="event.stopPropagation()">'+actionHtml+'</td>'
      +'</tr>';
  });
  body.innerHTML=html;
  populateCompanyFilterOptions(companies);
  syncCompanySelectionUi();
  applyCompanyFilters();

  // Log table
  const lbody=document.getElementById('logBody');
  lbody.innerHTML=recentLogs.map(l=>{
    const t=new Date(l.timestamp).toLocaleString('ja-JP');
    const actionBg={error:'#da1e28',submitted:'#198038',confirm_reached:'#f59e0b',analyzing:'#0043ce',form_fill:'#6929c4',skip:'#6f6f6f'};
    const bg=actionBg[l.action]||'#393939';
    const fgDark=['confirm_reached'];
    const fg=fgDark.includes(l.action)?'#000':'#fff';
    const d=typeof l.details==='object'?JSON.stringify(l.details):l.details||'';
    return'<tr><td class="ts">'+t+'</td><td>'+l.companyNo+'</td><td>'+esc(l.companyName)+'</td>'
      +'<td><span style="background:'+bg+';color:'+fg+';font-size:.62rem;font-weight:700;padding:1px 8px;letter-spacing:.04em;white-space:nowrap">'+esc(l.action)+'</span></td>'
      +'<td><small style="color:var(--on-surface-variant)">'+esc(d).substring(0,120)+'</small></td></tr>';
  }).join('');

  // Awaiting list
  const awaitingCompanies=companies.filter(c=>
    c.lastAction==='awaiting_approval'||
    (c.lastAction==='confirm_reached'&&!c.sentAt)
  );
  const awEl=document.getElementById('awaitingList');
  document.getElementById('awaitingCount').textContent=awaitingCompanies.length||'';
  if(awaitingCompanies.length===0){
    awEl.innerHTML='<div class="text-center text-muted py-4">'+t('awaiting.empty')+'</div>';
  }else{
    awEl.innerHTML=awaitingCompanies.map(c=>{
      const date=c.awaitingAt?new Date(c.awaitingAt).toLocaleString('ja-JP'):'-';
      const msgBody=c.sentMessage
        ? esc(c.sentMessage).split(String.fromCharCode(10)).join('<br>')
        : '<span style="color:var(--error);font-weight:700">' + t('message.missingDraft') + '</span>';
      const screenshotState=c.screenshotAuditState||'missing';
      const inputScreenshotSrc=c.inputScreenshotName?screenshotUrl(c.inputScreenshotName):'';
      const confirmScreenshotSrc=c.confirmScreenshotName?screenshotUrl(c.confirmScreenshotName):'';
      const manualReason=esc(c.manualReviewReason || (LANG==='ja' ? 'ブラウザで手動送信してください。' : 'Complete the final submission manually in the browser.'));
      const manualDetail=esc(c.manualReviewDetail || c.manualReviewReason || '');
      const manualBanner=(screenshotState==='manual-send-pending'||screenshotState==='direct-submit')
        ? '<div style="background:var(--warning-container);color:var(--warning);padding:10px 12px;font-size:.72rem;font-weight:700;line-height:1.6">'+manualReason+(manualDetail?'<div style="margin-top:6px;font-weight:600;color:var(--on-surface-variant)">'+manualDetail+'</div>':'')+'</div>'
        : '';
      const ssConfirm=screenshotState==='confirm'
        ?'<img src="'+confirmScreenshotSrc+'" style="width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--outline-variant)" onclick="window.open(this.src)" alt="Confirm screenshot">'
        : (screenshotState==='manual-send-pending'||screenshotState==='direct-submit')
          ?'<div style="display:flex;flex-direction:column;gap:6px"><img src="'+inputScreenshotSrc+'" style="width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--outline-variant)" onclick="window.open(this.src)" alt="Input screenshot"><div style="background:var(--warning-container);color:var(--warning);font-size:.68rem;font-weight:700;padding:8px 10px;line-height:1.6">'+manualReason+'</div></div>'
        : screenshotState==='input-only'
          ?'<div style="display:flex;flex-direction:column;gap:6px"><img src="'+inputScreenshotSrc+'" style="width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--outline-variant)" onclick="window.open(this.src)" alt="Input screenshot"><div style="background:var(--warning-container);color:var(--warning);font-size:.68rem;font-weight:700;padding:8px 10px;line-height:1.6">'+t('awaiting.auditPartial')+'</div></div>'
          :'<div style="background:var(--error-container);color:var(--error);font-size:.72rem;font-weight:700;padding:12px;line-height:1.7;border:1px solid var(--error);min-height:140px;display:flex;align-items:center;justify-content:center;text-align:center">'+t('awaiting.auditMissingScreenshot')+'</div>';
      const auditBadge=screenshotState==='confirm'
        ?'<span style="background:var(--success-container);color:var(--success);font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+t('awaiting.auditReady')+'</span>'
        : screenshotState==='direct-submit'
          ?'<span style="background:var(--warning-container);color:var(--warning);font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+(LANG==='ja'?'直接送信型':'Direct-submit')+'</span>'
        : screenshotState==='manual-send-pending'
          ?'<span style="background:var(--warning-container);color:var(--warning);font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+(LANG==='ja'?'手動送信待ち':'Manual send required')+'</span>'
        : screenshotState==='input-only'
          ?'<span style="background:var(--warning-container);color:var(--warning);font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+t('awaiting.auditPartial')+'</span>'
          :'<span style="background:var(--error-container);color:var(--error);font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+t('awaiting.auditMissingScreenshot')+'</span>';
      const cname=esc(c.name).replace(/'/g,"\\'");
      return'<div class="awaiting-card" data-no="'+c.no+'" data-name="'+cname+'" data-state="'+esc(c.lastAction||'')+'" data-has-input="'+(c.hasInputScreenshot?'1':'0')+'" data-has-confirm="'+(c.hasConfirmScreenshot?'1':'0')+'" data-has-any="'+(c.hasAnyScreenshot?'1':'0')+'" data-ready-approval="'+(c.readyForApproval?'1':'0')+'" data-manual-approval="'+(c.readyForManualApproval?'1':'0')+'" data-screenshot-state="'+esc(screenshotState)+'" style="background:#fff;border:1px solid var(--outline-variant);border-left:3px solid var(--primary);margin-bottom:12px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant);background:var(--surface-low)">'
        +'<div style="display:flex;align-items:center;gap:10px">'
        +'<input type="checkbox" class="form-check-input awaiting-check" data-no="'+c.no+'" style="width:16px;height:16px;cursor:pointer">'
        +'<span style="background:#f59e0b;color:#000;font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+t('awaiting.badge')+'</span>'
        +auditBadge
        +'<strong style="font-size:.88rem">'+esc(c.name)+'</strong>'
        +'<span style="font-size:.72rem;color:var(--on-surface-variant);background:var(--surface-container);padding:2px 8px">'+esc(c.type)+'</span>'
        +'</div>'
        +'<span style="font-size:.7rem;color:var(--on-surface-variant);font-family:var(--font-mono)">'+date+'</span>'
        +'</div>'
        +'<div style="display:flex">'
        +'<div style="width:200px;min-width:200px;border-right:1px solid var(--outline-variant);overflow-y:auto;max-height:400px;padding:10px;background:var(--surface-lowest)">'
        +ssConfirm
        +'</div>'
        +'<div style="flex:1;padding:14px 16px;display:flex;flex-direction:column;gap:12px">'
        +((screenshotState==='manual-send-pending'||screenshotState==='direct-submit')?manualBanner:(screenshotState!=='confirm'?'<div style="background:var(--error-container);color:var(--error);padding:10px 12px;font-size:.72rem;font-weight:700;line-height:1.6">'+t('awaiting.auditBlocked')+'</div>':''))
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'
        +'<div style="font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--outline)">'+t('awaiting.messageTitle')+'</div>'
        +(c.sentMessage?'<button class="btn btn-outline-secondary btn-sm py-0 px-1" style="font-size:.68rem" onclick="showMsg('+c.no+')">'+t('message.openFull')+'</button>':'')
        +'</div>'
        +'<div style="font-size:.82rem;background:var(--surface-low);padding:12px;white-space:pre-wrap;line-height:1.7;max-height:300px;overflow-y:auto;border:1px solid var(--outline-variant)">'+msgBody+'</div>'
        +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--outline-variant)">'
        +'<button class="btn btn-success btn-sm" onclick="approveCompany('+c.no+',\\x27'+cname+'\\x27,\\x27sent\\x27)">'+t('action.markSent')+'</button>'
        +'<button class="btn btn-outline-danger btn-sm" onclick="skipWithFeedback('+c.no+',\\x27'+cname+'\\x27)">'+t('action.skip')+'</button>'
        +'<button class="btn btn-outline-danger btn-sm" onclick="deleteCompanyRow('+c.no+')">'+(t('action.deleteCompany')||'Delete')+'</button>'
        +'<small style="margin-left:auto;font-size:.7rem;color:var(--outline)">'+(c.formUrl?'<a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a>':(LANG==='ja'?'フォームURL未記録':'No form URL recorded'))+'</small>'
        +'</div>'
        +'</div>'
        +'</div>'
        +'</div>';
    }).join('');
  }

  // Sent list
  const sentCompanies=companies.filter(c=>c.sentAt).sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt));
  const sentEl=document.getElementById('sentList');
  document.getElementById('sentCount').textContent=sentCompanies.length+' items';
  if(sentCompanies.length===0){
    sentEl.innerHTML='<div class="text-center text-muted py-4">'+t('sent.empty')+'</div>';
  }else{
    sentEl.innerHTML=sentCompanies.map(c=>{
      const count=c.contactCount||1;
      const countBadge=count>=2?'<span style="background:#0052dd;color:#fff;font-size:.62rem;font-weight:700;padding:1px 8px;margin-left:4px">'+count+'x</span>':'<span style="background:#6f6f6f;color:#fff;font-size:.62rem;font-weight:700;padding:1px 8px;margin-left:4px">1st</span>';
      let historyHtml='';
      if(c.contactHistory&&c.contactHistory.length>0){
        historyHtml='<div style="margin-top:12px;border-top:1px solid var(--outline-variant);padding-top:10px">'
          +'<div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--on-surface-variant);margin-bottom:8px">'+t('sent.contactHistory')+'</div>'
          +'<div style="position:relative;padding-left:20px">'
          +'<div style="position:absolute;left:6px;top:4px;bottom:4px;width:1px;background:var(--outline-variant)"></div>';
        historyHtml+=c.contactHistory.map((h,i)=>{
          const d=new Date(h.date).toLocaleString('ja-JP');
          let respBg='#6f6f6f',respText=t('sent.replyWaiting');
          if(h.response==='replied'||h.response==='\u8fd4\u4fe1\u3042\u308a'){respBg='#198038';respText=h.response;}
          else if(h.response==='meeting'||h.response==='\u5546\u8ac7\u8a2d\u5b9a'){respBg='#0052dd';respText=h.response;}
          else if(h.response){respBg='#8a3800';respText=h.response;}
          const resp='<span style="background:'+respBg+';color:#fff;font-size:.6rem;font-weight:700;padding:1px 7px;letter-spacing:.04em">'+esc(respText)+'</span>';
          return'<div style="position:relative;margin-bottom:8px;background:var(--surface-low);border:1px solid var(--outline-variant);padding:8px 12px">'
            +'<div style="position:absolute;left:-17px;top:50%;transform:translateY(-50%);width:8px;height:8px;background:var(--primary)"></div>'
            +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">'
            +'<span style="font-size:.72rem;font-family:var(--font-mono);font-weight:700;color:var(--on-surface)">#'+(i+1)+'</span>'
            +'<div style="display:flex;align-items:center;gap:8px">'+resp+'<span style="font-size:.65rem;color:var(--on-surface-variant);font-family:var(--font-mono)">'+d+'</span></div>'
            +'</div>'
            +'<div style="font-size:.75rem;color:var(--on-surface-variant);cursor:pointer" onclick="var n=this.nextElementSibling;n.style.display=n.style.display===\\x27none\\x27?\\x27block\\x27:\\x27none\\x27">'+esc(h.message||'').substring(0,80)+'... <span style="color:var(--primary)">'+t('sent.showFull')+'</span></div>'
            +'<div style="display:none;white-space:pre-wrap;background:#fff;padding:8px;border:1px solid var(--outline-variant);margin-top:6px;font-size:.78rem;max-height:180px;overflow-y:auto">'+esc(h.message||'').split(String.fromCharCode(10)).join('<br>')+'</div>'
            +(h.notes?'<div style="margin-top:4px;font-size:.7rem;color:var(--on-surface-variant)">Note: '+esc(h.notes)+'</div>':'')
            +'</div>';
        }).join('');
        historyHtml+='</div></div>';
      }
      const date=new Date(c.sentAt).toLocaleString('ja-JP');
      const msg=esc(c.sentMessage||'').split(String.fromCharCode(10)).join('<br>');
      const ssInput=c.inputScreenshotName?'<img src="'+screenshotUrl(c.inputScreenshotName)+'" style="width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--outline-variant);margin-bottom:6px" onclick="window.open(this.src)" onerror="this.style.display=\\x27none\\x27" title="Input screenshot">':'';
      const ssConfirm=c.confirmScreenshotName?'<img src="'+screenshotUrl(c.confirmScreenshotName)+'" style="width:100%;height:auto;display:block;cursor:pointer;border:1px solid var(--outline-variant)" onclick="window.open(this.src)" onerror="this.style.display=\\x27none\\x27" title="Confirm screenshot">':'';
      return'<div class="sent-card" data-sn="'+esc(c.name).toLowerCase()+' '+esc(c.type).toLowerCase()+'" data-sc="'+count+'" style="background:#fff;border:1px solid var(--outline-variant);border-left:3px solid #198038;margin-bottom:12px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant);background:var(--surface-low)">'
        +'<div style="display:flex;align-items:center;gap:6px">'
        +'<span style="background:#198038;color:#fff;font-size:.62rem;font-weight:700;padding:2px 8px;letter-spacing:.05em">'+t('sent.badge')+'</span>'
        +countBadge
        +'<strong style="font-size:.88rem;margin-left:4px">'+esc(c.name)+'</strong>'
        +'<span style="font-size:.72rem;color:var(--on-surface-variant);background:var(--surface-container);padding:2px 8px">'+esc(c.type)+'</span>'
        +'</div>'
        +'<span style="font-size:.7rem;color:var(--on-surface-variant);font-family:var(--font-mono)">Last: '+date+'</span>'
        +'</div>'
        +'<div style="display:flex">'
        +'<div style="flex:1;padding:14px 16px">'
        +'<div style="font-size:.82rem;background:var(--surface-low);padding:12px;white-space:pre-wrap;line-height:1.7;max-height:240px;overflow-y:auto;border:1px solid var(--outline-variant)">'+msg+'</div>'
        +historyHtml
        +'<div style="margin-top:8px;font-size:.7rem;color:var(--outline)"><a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a></div>'
        +'</div>'
        +'<div style="width:160px;min-width:160px;border-left:1px solid var(--outline-variant);padding:10px;background:var(--surface-lowest);overflow-y:auto;max-height:400px">'
        +ssInput+ssConfirm
        +'</div>'
        +'</div>'
        +'</div>';
    }).join('');
  }

  const _ts = new Date().toLocaleString('ja-JP');
  document.getElementById('lastUpdate').textContent=t('app.lastUpdate')+': '+_ts;
  const _sl=document.getElementById('sidebarLastUpdate');if(_sl)_sl.textContent=_ts;
  const _hl=document.getElementById('headerLastUpdate');if(_hl)_hl.textContent=_ts;
  updatePipeline(stats);
  if (typeof _analyticsOpen !== 'undefined' && _analyticsOpen) updateCharts(data);
}

// Approve / Skip
function getAwaitingCardMeta(companyNo) {
  const card = document.querySelector('.awaiting-card[data-no="' + companyNo + '"]');
  if (!card) return null;
  return {
    state: card.dataset.state || '',
    hasInput: card.dataset.hasInput === '1',
    hasConfirm: card.dataset.hasConfirm === '1',
    hasAny: card.dataset.hasAny === '1',
    readyForApproval: card.dataset.readyApproval === '1',
    manualApproval: card.dataset.manualApproval === '1',
    screenshotState: card.dataset.screenshotState || 'missing',
  };
}

function getAwaitingDecisionBlockReason(companyNo, decision) {
  if (decision === 'skip') {
    return '';
  }
  const cardMeta = getAwaitingCardMeta(companyNo);
  if (cardMeta && !['awaiting_approval', 'confirm_reached'].includes(cardMeta.state)) {
    return t('audit.blockedInvalidState',{state:cardMeta.state||'-'});
  }
  if (decision === 'sent' && cardMeta && !cardMeta.readyForApproval) {
    return t('audit.blockedMissingScreenshot');
  }
  return '';
}

function isDashboardSessionErrorMessage(message) {
  return /dashboard session token|session token|認証|セッション/i.test(String(message || ''));
}

function createDashboardSessionError(message) {
  const error = new Error(message || 'Dashboard session expired.');
  error.code = 'DASHBOARD_SESSION_EXPIRED';
  return error;
}

function handleDashboardSessionExpired() {
  const message = LANG === 'ja'
    ? 'ダッシュボードの認証が切れました。画面を再読み込みします。'
    : 'Dashboard session expired. Reloading the page.';
  try { showToast(message, 'warning'); } catch (_) {}
  setTimeout(() => {
    try { window.location.reload(); } catch (_) {}
  }, 400);
}

async function submitApprovalDecision(companyNo, companyName, decision, feedback) {
  const res = await fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyNo, companyName, decision, feedback: feedback || '' }),
  });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401 || isDashboardSessionErrorMessage(d.error || d.message || '')) {
    throw createDashboardSessionError(d.error || d.message || 'Dashboard session expired.');
  }
  if (!res.ok || !d.ok) {
    throw new Error(d.error || 'Unknown');
  }
  return d;
}

function updateAwaitingListUiState() {
  const list = document.getElementById('awaitingList');
  const count = list ? list.querySelectorAll('.awaiting-card').length : 0;
  const badge = document.getElementById('awaitingCount');
  if (badge) badge.textContent = count || '';
  if (list && count === 0) {
    list.innerHTML = '<div class="text-center text-muted py-4">' + t('awaiting.empty') + '</div>';
  }
}

function removeAwaitingCardFromUi(companyNo) {
  const cards = Array.from(document.querySelectorAll('.awaiting-card[data-no="' + String(companyNo) + '"]'));
  cards.forEach((card) => card.remove());
  updateAwaitingListUiState();
  return cards.length;
}

function removeCompanyRowFromUi(companyNo) {
  const row = document.querySelector('#companyBody tr[data-no="' + String(companyNo) + '"]');
  if (!row) return false;
  row.remove();
  return true;
}

function refreshAfterMutation() {
  if (mutationRefreshTimer) clearTimeout(mutationRefreshTimer);
  if (mutationRefreshFollowupTimer) clearTimeout(mutationRefreshFollowupTimer);
  mutationRefreshTimer = setTimeout(() => {
    mutationRefreshTimer = null;
    requestDashboardRefresh({ force: true, delay: 0 });
  }, 250);
  mutationRefreshFollowupTimer = setTimeout(() => {
    mutationRefreshFollowupTimer = null;
    requestDashboardRefresh({ force: true, delay: 0 });
  }, 900);
}

async function approveCompany(companyNo,companyName,decision){
  const blockedReason = getAwaitingDecisionBlockReason(companyNo, decision);
  if (blockedReason) {
    alert(blockedReason);
    return;
  }
  if(!confirm(decision==='sent'?t('confirm.markSent',{company:companyName}):t('confirm.skip',{company:companyName})))return;
  try{
    await submitApprovalDecision(companyNo, companyName, decision, '');
    removeAwaitingCardFromUi(companyNo);
    refreshAfterMutation();
  }catch(e){
    if (e && e.code === 'DASHBOARD_SESSION_EXPIRED') {
      handleDashboardSessionExpired();
      return;
    }
    alert(t('alert.commError')+': '+e.message);
  }
}

// Show full message
let _allCompanies=[];
function showCompanyDetail(no, event) {
  if (event && event.target.tagName === 'A') return;
  const c = _allCompanies.find(x => x.no === no);
  if (!c) return;
  const e2 = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cnt = c.contactCount || 0;
  const sc = {error:'#ef4444',submitted:'#10b981',awaiting_approval:'#f59e0b',confirm_reached:'#f59e0b',form_fill:'#6366f1',analyzing:'#3b82f6',site_analysis:'#3b82f6',skipped:'#94a3b8'}[c.lastAction] || '#94a3b8';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.onclick = () => overlay.remove();
  const box = document.createElement('div');
  box.style.cssText = 'background:#fff;border-radius:14px;padding:0;max-width:640px;width:100%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25)';
  box.onclick = e => e.stopPropagation();
  const chips = (c.type ? '<span style="font-size:.7rem;color:#64748b;background:#f1f5f9;padding:1px 8px;border-radius:4px">'+e2(c.type)+'</span>' : '')
    + (c.isOutreachTarget ? '<span style="font-size:.68rem;color:#2563eb;background:#eff6ff;padding:1px 8px;border-radius:4px;font-weight:600">営業対象</span>' : '')
    + (c.isDetachedFromTargetList ? '<span style="font-size:.68rem;color:#94a3b8;background:#f8fafc;padding:1px 8px;border-radius:4px">履歴のみ</span>' : '')
    + (cnt > 0 ? '<span style="font-size:.68rem;color:#fff;background:#10b981;padding:1px 8px;border-radius:4px;font-weight:600">'+cnt+'回送信済</span>' : '');
  const formUrlHtml = c.formUrl
    ? '<a href="'+e2(c.formUrl)+'" target="_blank" style="font-size:.75rem;color:#2563eb;word-break:break-all">'+e2(c.formUrl)+'</a>'
    : '<div style="font-size:.8rem;color:#94a3b8">-</div>';
  const errorHtml = (c.lastErrorDetail || c.manualReviewReason)
    ? '<div style="padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px"><div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#ef4444;margin-bottom:4px">詳細 / エラー</div><div style="font-size:.78rem;color:#7f1d1d;line-height:1.5">'+e2(c.lastErrorDetail || c.manualReviewReason)+'</div></div>'
    : '';
  const urlHtml = c.url
    ? '<div style="padding:8px 12px;background:#f8fafc;border-radius:8px"><div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px">企業URL</div><a href="'+e2(c.url)+'" target="_blank" style="font-size:.78rem;color:#2563eb">'+e2(c.url)+'</a></div>'
    : '';
  const msgHtml2 = c.sentMessage
    ? '<div><div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:6px">送信メッセージ</div><div style="white-space:pre-wrap;font-size:.82rem;line-height:1.7;background:#f8fafc;padding:14px;border-radius:8px;border:1px solid #e2e8f0;color:#1e293b">'+e2(c.sentMessage)+'</div></div>'
    : '<div style="padding:10px 12px;background:#f8fafc;border-radius:8px;font-size:.8rem;color:#94a3b8">送信メッセージなし</div>';
  window._cdClose = () => overlay.remove();
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '\u2715';
  closeBtn.style.cssText = 'background:none;border:none;font-size:1.2rem;color:#94a3b8;cursor:pointer;padding:0;line-height:1;flex-shrink:0';
  closeBtn.onclick = () => overlay.remove();
  box.innerHTML =
    '<div id="cd-header" style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">'
    + '<div><div style="font-size:1rem;font-weight:700;color:#0f172a;margin-bottom:3px">'+e2(c.name)+'</div>'
    + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+chips+'</div></div>'
    + '</div>'
    + '<div style="overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px">'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
    + '<div style="padding:10px 12px;background:#f8fafc;border-radius:8px"><div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px">進捗</div>'
    + '<div style="font-size:.82rem;font-weight:600;color:'+sc+'">'+e2(c.lastAction || '-')+'</div></div>'
    + '<div style="padding:10px 12px;background:#f8fafc;border-radius:8px"><div style="font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:4px">フォームURL</div>'+formUrlHtml+'</div>'
    + '</div>'
    + errorHtml + urlHtml + msgHtml2
    + '</div>';
  box.querySelector('#cd-header').appendChild(closeBtn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function showMsg(no){
  const c=_allCompanies.find(x=>x.no===no);
  if(!c||!c.sentMessage)return;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.onclick=()=>overlay.remove();
  const box=document.createElement('div');
  box.style.cssText='background:#fff;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)';
  box.onclick=e=>e.stopPropagation();
  const cnt=c.contactCount||0;
  box.innerHTML='<div class="d-flex justify-content-between align-items-center mb-3"><div><strong>'+esc(c.name)+'</strong> <small class="text-muted">'+esc(c.type)+'</small>'
    +(cnt>0?' <span class="badge bg-'+(cnt>=2?'info':'success')+'">'+cnt+'x sent</span>':'')
    +'</div><button class="btn-close" onclick="this.closest(\\x27div[style]\\x27).remove()"></button></div>'
    +'<div style="white-space:pre-wrap;font-size:.85rem;line-height:1.7;background:#f8f9fa;padding:16px;border-radius:8px">'+esc(c.sentMessage)+'</div>'
    +(c.formUrl?'<div class="mt-2" style="font-size:.75rem;color:#888">Target: <a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a></div>':'');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// Skip with feedback
async function skipWithFeedback(companyNo, companyName) {
  const blockedReason = getAwaitingDecisionBlockReason(companyNo, 'skip');
  if (blockedReason) {
    alert(blockedReason);
    return;
  }
  const feedback = prompt(t('confirm.skipReason', {company: companyName}));
  if (feedback === null) return;
  try {
    await submitApprovalDecision(companyNo, companyName, 'skip', feedback || '');
    removeAwaitingCardFromUi(companyNo);
    refreshAfterMutation();
  } catch (e) {
    if (e && e.code === 'DASHBOARD_SESSION_EXPIRED') {
      handleDashboardSessionExpired();
      return;
    }
    alert(t('alert.error') + ': ' + e.message);
  }
}

// Bulk awaiting operations
function toggleAllAwaiting(){
  const cbs=document.querySelectorAll('.awaiting-check');
  const allChecked=Array.from(cbs).every(c=>c.checked);
  cbs.forEach(c=>c.checked=!allChecked);
}

async function bulkApprove(decision){
  const checked=document.querySelectorAll('.awaiting-check:checked');
  if(checked.length===0){alert(t('alert.selectCompanies'));return;}
  if(!confirm(decision==='sent'?t('confirm.bulkSent',{count:checked.length}):t('confirm.bulkSkip',{count:checked.length})))return;
  let ok=0,fail=0;
  const errors=[];
  const succeededNos = [];
  for(const cb of checked){
    const card=cb.closest('.awaiting-card');
    const no=parseInt(card.dataset.no);
    const name=card.dataset.name;
    try{
      const blockedReason = getAwaitingDecisionBlockReason(no, decision);
      if (blockedReason) throw new Error(blockedReason);
      await submitApprovalDecision(no, name, decision, '');
      ok++;
      succeededNos.push(no);
    }catch(e){
      if (e && e.code === 'DASHBOARD_SESSION_EXPIRED') {
        handleDashboardSessionExpired();
        return;
      }
      fail++;
      errors.push(name + ': ' + e.message);
    }
  }
  if(fail>0){
    alert(t('alert.success',{ok:ok})+t('alert.failure',{fail:fail})+(errors.length?'\\n\\n'+errors.slice(0,3).join('\\n'):'')); 
  }
  succeededNos.forEach((companyNo) => removeAwaitingCardFromUi(companyNo));
  refreshAfterMutation();
}

async function bulkSkipWithFeedback(){
  const checked=document.querySelectorAll('.awaiting-check:checked');
  if(checked.length===0){alert(t('alert.selectCompanies'));return;}
  const feedback=prompt(t('confirm.bulkSkipReason',{count:checked.length}));
  if(feedback===null)return;
  let ok=0,fail=0;
  const errors=[];
  const succeededNos = [];
  for(const cb of checked){
    const card=cb.closest('.awaiting-card');
    try{
      const no = parseInt(card.dataset.no);
      const name = card.dataset.name;
      const blockedReason = getAwaitingDecisionBlockReason(no, 'skip');
      if (blockedReason) throw new Error(blockedReason);
      await submitApprovalDecision(no, name, 'skip', feedback||'');
      ok++;
      succeededNos.push(no);
    }catch(e){
      if (e && e.code === 'DASHBOARD_SESSION_EXPIRED') {
        handleDashboardSessionExpired();
        return;
      }
      fail++;
      errors.push((card && card.dataset && card.dataset.name ? card.dataset.name : 'Unknown') + ': ' + e.message);
    }
  }
  if(fail>0){
    alert(t('alert.success',{ok:ok})+t('alert.failure',{fail:fail})+(errors.length?'\\n\\n'+errors.slice(0,3).join('\\n'):'')); 
  }
  succeededNos.forEach((companyNo) => removeAwaitingCardFromUi(companyNo));
  refreshAfterMutation();
}

async function bulkDeleteAwaiting() {
  const checked = document.querySelectorAll('.awaiting-check:checked');
  if (checked.length === 0) {
    alert(t('alert.selectCompanies'));
    return;
  }
  const companyNos = Array.from(checked)
    .map((cb) => {
      const card = cb.closest('.awaiting-card');
      return card ? parseInt(card.dataset.no, 10) : null;
    })
    .filter((value) => Number.isFinite(value));
  if (companyNos.length === 0) {
    alert(t('alert.selectCompanies'));
    return;
  }
  if (!confirm(t('confirm.bulkDeleteCompanies', { count: companyNos.length }))) return;
  try {
    const res = await fetch('/api/companies/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos }),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || 'Failed to delete selected companies.');
    showToast(t('companyModal.bulkDeleted', { count: result.deletedCount || companyNos.length }) || 'Selected companies deleted.', 'success');
    if (result.skippedCount > 0) {
      showToast((LANG === 'ja' ? '一部の行は削除対象外のためスキップしました。' : 'Some rows were skipped because they are not deletable.'), 'info');
    }
    companyNos.forEach((companyNo) => {
      removeAwaitingCardFromUi(companyNo);
      removeCompanyRowFromUi(companyNo);
    });
    refreshAfterMutation();
  } catch (e) {
    showToast((t('alert.error') || 'Error') + ': ' + e.message, 'error');
  }
}

function connectEvents(){
  if(es){
    es.close();
    es=null;
  }
  es=createSessionEventSource('/events');
  es.onmessage=function(e){
    try{
      const d=JSON.parse(e.data);
      if(d.type==='cli-log'){
        appendCliLog(d.message,d.logType,d.time);
        if(d.logType==='action') requestDashboardRefresh({ delay: 180 });
      }else if(d.type==='claude-stdout'){
        appendRawTerminal(d.text, d.stream);
      }else if(d.type==='claude-exit'){
        appendRawTerminal('\\n[AI 終了 code=' + d.code + ']\\n','system');
        pollClaudeStatus();
      }else{
        requestDashboardRefresh({ delay: 160 });
      }
    }catch(err){
      requestDashboardRefresh({ delay: 220 });
    }
  };
  es.onerror=function(){
    document.getElementById('liveLabel').textContent=t('app.offline');
    document.getElementById('liveDot').className='live-dot off';
    document.getElementById('cliDot').className='live-dot off';
    if(es){
      es.close();
      es=null;
    }
    if(!reconnectTimer){
      reconnectTimer=setTimeout(()=>{
        reconnectTimer=null;
        connectEvents();
      },3000);
    }
    if(!offlinePollTimer){
      offlinePollTimer=setInterval(()=>requestDashboardRefresh({ delay: 0 }),15000);
    }
  };
  es.onopen=function(){
    document.getElementById('liveLabel').textContent=t('app.live');
    document.getElementById('liveDot').className='live-dot on';
    document.getElementById('cliDot').className='live-dot on';
    if(reconnectTimer){
      clearTimeout(reconnectTimer);
      reconnectTimer=null;
    }
    if(offlinePollTimer){
      clearInterval(offlinePollTimer);
      offlinePollTimer=null;
    }
  };
}

const _assetPromises = {};
function ensureScriptOnce(src) {
  if (_assetPromises[src]) return _assetPromises[src];
  _assetPromises[src] = new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts || []).find((script) => script.src === src);
    if (existing) {
      if (existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load script: ' + src)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load script: ' + src));
    document.head.appendChild(script);
  });
  return _assetPromises[src];
}

function ensureStyleOnce(href) {
  if (_assetPromises[href]) return _assetPromises[href];
  _assetPromises[href] = new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((link) => link.href === href);
    if (existing) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => reject(new Error('Failed to load stylesheet: ' + href));
    document.head.appendChild(link);
  });
  return _assetPromises[href];
}

function ensureChartAssets() {
  return ensureScriptOnce('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
}

function ensureXtermAssets() {
  return Promise.all([
    ensureStyleOnce('https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css'),
    ensureScriptOnce('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js'),
    ensureScriptOnce('https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js'),
  ]);
}

// ─── Analytics Charts ─────────────────────────────────────────────
let _statusDonut = null;
let _trendChart = null;

function initCharts() {
  if (typeof Chart === 'undefined') return;

  // Doughnut - ステータス内訳
  const ctxD = document.getElementById('statusDonutChart');
  if (ctxD && !_statusDonut) {
    _statusDonut = new Chart(ctxD.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['送信済', '要対応', 'エラー', '未処理'],
        datasets: [{
          data: [0,0,0,0],
          backgroundColor: ['#10b981','#f59e0b','#ef4444','#cbd5e1'],
          borderWidth: 2, borderColor: '#fff', hoverOffset: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, usePointStyle: true, padding: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + c.raw + '件' } }
        }
      }
    });
  }

  // Area chart - 処理推移 (last 7 days)
    const ctxA = document.getElementById('trendAreaChart');
  if (ctxA && !_trendChart) {
    const grad1 = ctxA.getContext('2d').createLinearGradient(0,0,0,180);
    grad1.addColorStop(0,'rgba(245,158,11,0.35)'); grad1.addColorStop(1,'rgba(245,158,11,0)');
    const grad2 = ctxA.getContext('2d').createLinearGradient(0,0,0,180);
    grad2.addColorStop(0,'rgba(16,185,129,0.35)'); grad2.addColorStop(1,'rgba(16,185,129,0)');
    Chart.defaults.font.family = "'Inter','Noto Sans JP',sans-serif";
    Chart.defaults.color = '#8fa0b5';
    _trendChart = new Chart(ctxA.getContext('2d'), {
      type: 'line',
      data: {
        labels: ['6日前','5日前','4日前','3日前','2日前','昨日','今日'],
        datasets: [
          { label:'要対応', data:[0,0,0,0,0,0,0], borderColor:'#f59e0b', backgroundColor:grad1, borderWidth:2, tension:0.4, fill:true, pointRadius:0 },
          { label:'送信済', data:[0,0,0,0,0,0,0], borderColor:'#10b981', backgroundColor:grad2, borderWidth:2, tension:0.4, fill:true, pointRadius:0 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode:'index', intersect:false },
        plugins: { legend: { display:false } },
        scales: {
          y: { beginAtZero:true, border:{display:false}, grid:{color:'#f1f5f9'}, ticks:{stepSize:1} },
          x: { border:{display:false}, grid:{display:false} }
        }
      }
    });
  }
}

function updateCharts(data) {
  if (!data || typeof Chart === 'undefined') return;
  const companies = data.companies || [];
  const countByAction = (st) => companies.filter(c => c.lastAction === st).length;
  const actionNeeded = countByAction('form_fill') + countByAction('confirm_reached') + countByAction('awaiting_approval');
  const awaiting = countByAction('awaiting_approval');
  const sent = countByAction('submitted');
  const errors = countByAction('error');
  const actionableTotal = (data.stats && data.stats.approachable) || 0;
  const unprocessed = Math.max(0, actionableTotal - sent - actionNeeded - errors);

  if (_statusDonut) {
    _statusDonut.data.datasets[0].data = [sent, actionNeeded, errors, unprocessed];
    _statusDonut.update('none');
  }

  // Update trend chart with per-day data
  if (_trendChart && data.trendData) {
    _trendChart.data.labels = data.trendData.labels;
    _trendChart.data.datasets[0].data = data.trendData.actionNeeded;
    _trendChart.data.datasets[1].data = data.trendData.sent;
    _trendChart.update('none');
  }

  // Update analytics progress panel
  const stats = data.stats || {};
  const total = stats.approachable || 0;
  const done = stats.submitted || 0;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  const pEl = document.getElementById('analyticsPercent');
  const rEl = document.getElementById('analyticsRatio');
  const bEl = document.getElementById('analyticsProgressBar');
  if (pEl) pEl.textContent = pct;
  if (rEl) rEl.textContent = done + ' / ' + total + ' 送信済み';
  if (bEl) bEl.style.width = pct + '%';
}

let _liveMonitorOpen = true;
function setLiveMonitorOpen(nextOpen, { persist = true } = {}) {
  _liveMonitorOpen = !!nextOpen;
  const body = document.getElementById('liveMonitorBody');
  const chevron = document.getElementById('liveMonitorChevron');
  const label = document.getElementById('liveMonitorToggleLabel');
  if (body) body.style.display = _liveMonitorOpen ? 'grid' : 'none';
  if (chevron) chevron.style.transform = _liveMonitorOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
  if (label) label.textContent = _liveMonitorOpen
    ? (LANG === 'ja' ? '閉じる' : 'Collapse')
    : (LANG === 'ja' ? '開く' : 'Expand');
  if (persist) {
    try { localStorage.setItem('liveMonitorOpen', _liveMonitorOpen ? '1' : '0'); } catch(_) {}
  }
}

function toggleLiveMonitor() {
  setLiveMonitorOpen(!_liveMonitorOpen);
}
(function() {
  const s = (function() { try { return localStorage.getItem('liveMonitorOpen'); } catch(_) { return null; } })();
  if (s === '0') setTimeout(() => setLiveMonitorOpen(false, { persist: false }), 0);
  else setTimeout(() => setLiveMonitorOpen(true, { persist: false }), 0);
})();

let _analyticsOpen = true;
// Analytics panel is always visible — auto-init charts on page load
(function() {
  setTimeout(() => {
    ensureChartAssets()
      .then(() => {
        initCharts();
        if (typeof _latestDashboardData !== 'undefined' && _latestDashboardData) updateCharts(_latestDashboardData);
      })
      .catch(() => {});
  }, 400);
})();

// Initial data fetch
refreshData({toastOnError:true});
connectEvents();

// Claude CLI status — initial check + periodic polling
pollClaudeStatus();
_claudeStatusTimer = setInterval(pollClaudeStatus, 15000);

// Auto-update status polling
async function pollUpdateStatus() {
  if (document.hidden) return;
  try {
    const res = await fetch('/api/update-status');
    const d = await res.json();
    const banner = document.getElementById('updateBanner');
    if (!banner) return;
    if (d.state === 'available') {
      banner.style.display = 'flex';
      banner.style.background = '#0043ce';
      banner.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">system_update</span> <b>v' + esc(d.version) + '</b> が利用可能です — バックグラウンドでダウンロード中...';
    } else if (d.state === 'downloading') {
      banner.style.display = 'flex';
      banner.style.background = '#0043ce';
      banner.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">downloading</span> アップデートダウンロード中 <b>' + (d.percent || 0) + '%</b>...';
    } else if (d.state === 'downloaded') {
      banner.style.display = 'flex';
      banner.style.background = '#198038';
      banner.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">check_circle</span> v' + esc(d.version) + ' の準備完了 — <b style="cursor:pointer;text-decoration:underline" onclick="fetch(\\'/api/install-update\\',{method:\\'POST\\'})">今すぐ再起動してインストール</b>';
    } else if (d.state === 'error') {
      banner.style.display = 'flex';
      banner.style.background = '#da1e28';
      banner.innerHTML = '<span class="material-symbols-outlined" style="font-size:15px">error</span> 自動更新エラー: ' + esc(d.message || '');
    } else if (d.state === 'disabled-dev' || d.state === 'dashboard-only' || d.state === 'disabled') {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'none';
    }
  } catch(e) { /* ignore */ }
}
pollUpdateStatus();
setInterval(pollUpdateStatus, 30000);

// CLI log stream
const cliColors={info:'#8bc5ed',action:'#3fb950',error:'#f85149',warn:'#e3b341',step:'#d2a8ff'};
const cliLabels={info:'INF',action:'ACT',error:'ERR',warn:'WRN',step:'STP'};
function appendCliLog(msg,type,time){
  const el=document.getElementById('cliStream');
  const ts=time?new Date(time).toLocaleTimeString('ja-JP'):'';
  const lastEventEl=document.getElementById('cliLastEvent');
  if (lastEventEl) lastEventEl.textContent=ts;
  if(!el)return;
  const color=cliColors[type]||'#c9d1d9';
  const label=cliLabels[type]||'LOG';
  const line=document.createElement('div');
  line.className='cli-line';
  line.innerHTML='<span style="color:#484f58;user-select:none">'+ts+'</span> <span style="background:'+color+';color:#0d1117;font-size:.62rem;font-weight:700;padding:0 5px;vertical-align:middle">'+label+'</span> <span style="color:'+color+'">'+esc(msg)+'</span>';
  el.appendChild(line);
  el.scrollTop=el.scrollHeight;
  while(el.children.length>300){
    el.removeChild(el.firstElementChild);
  }
}

// ─── xterm.js + WebSocket PTY ───────────────────────────────────────────
function _xtermOptions() {
  return {
    theme: {
      background: '#0d1117', foreground: '#c9d1d9',
      cursor: '#58a6ff', selectionBackground: '#264f78',
    },
    fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    scrollback: 2000,
    cursorBlink: true,
    convertEol: true,
  };
}

function initXtermTerminals() {
  if (typeof Terminal === 'undefined') return;

  // Tab terminal
  const tabContainer = document.getElementById('xtermTabContainer');
  if (tabContainer && !_tabTerm) {
    _tabTerm = new Terminal(_xtermOptions());
    const fitTab = new FitAddon.FitAddon();
    _tabTerm.loadAddon(fitTab);
    _tabTerm.open(tabContainer);
    fitTab.fit();
    _tabTerm.onData((d) => _sendPtyInput(d));
    new ResizeObserver(() => { try { fitTab.fit(); } catch(_){} }).observe(tabContainer);
  }

  // Drawer terminal
  const drawerContainer = document.getElementById('xtermDrawerContainer');
  if (drawerContainer && !_drawerTerm) {
    _drawerTerm = new Terminal(_xtermOptions());
    const fitDrawer = new FitAddon.FitAddon();
    _drawerTerm.loadAddon(fitDrawer);
    _drawerTerm.open(drawerContainer);
    fitDrawer.fit();
    _drawerTerm.onData((d) => _sendPtyInput(d));
    new ResizeObserver(() => { try { fitDrawer.fit(); _notifyResize(); } catch(_){} }).observe(drawerContainer);
  }
}

function _notifyResize() {
  if (!_ptyWs || _ptyWs.readyState !== WebSocket.OPEN) return;
  const cols = (_drawerTerm || _tabTerm)?.cols || 120;
  const rows = (_drawerTerm || _tabTerm)?.rows || 30;
  _ptyWs.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function _sendPtyInput(data) {
  if (_ptyWs && _ptyWs.readyState === WebSocket.OPEN) {
    _ptyWs.send(JSON.stringify({ type: 'input', data }));
  }
}

function _setWsStatus(status) {
  const s1 = document.getElementById('termWsStatus');
  const s2 = document.getElementById('termDrawerWsStatus');
  if (s1) s1.textContent = status;
  if (s2) s2.textContent = status;
}

function connectPtyWs() {
  if (_ptyWsRetryTimer) { clearTimeout(_ptyWsRetryTimer); _ptyWsRetryTimer = null; }
  const ws = createSessionWebSocket('/terminal');
  _ptyWs = ws;
  _setWsStatus('connecting…');

  ws.onopen = () => _setWsStatus('connected');

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output') {
        _tabTerm?.write(msg.data);
        _drawerTerm?.write(msg.data);
        document.getElementById('cliLastEvent').textContent = new Date().toLocaleTimeString('ja-JP');
      } else if (msg.type === 'exit') {
        const txt = '\\r\\n\\x1b[2m[AI 終了 code=' + msg.code + ']\\x1b[0m\\r\\n';
        _tabTerm?.write(txt);
        _drawerTerm?.write(txt);
        setTimeout(pollClaudeStatus, 500);
      } else if (msg.type === 'connected') {
        _setWsStatus(msg.running ? 'PTY active' : 'ready');
        if (msg.mode) {
          const l1 = document.getElementById('termModeLabel');
          const l2 = document.getElementById('termDrawerModeLabel');
          if (l1) l1.textContent = msg.mode;
          if (l2) l2.textContent = msg.mode;
        }
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    _setWsStatus('disconnected');
    if (_ptyWs === ws) {
      _ptyWs = null;
      _ptyWsRetryTimer = setTimeout(connectPtyWs, 4000);
    }
  };

  ws.onerror = () => ws.close();
}

// Legacy: sendClaudeInput now routes through PTY WebSocket
function sendClaudeInput(text) {
  const msg = text !== undefined ? text : '';
  if (!msg.trim()) return;
  _sendPtyInput(msg + '\\r');
}

// Stub kept for compatibility (output now comes via WS, not SSE)
function appendRawTerminal(text, stream) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  const el = document.getElementById('cliLastEvent');
  if (el) el.textContent = ts;
}
// ─────────────────────────────────────────────────────────────────────────

// Filters
document.querySelectorAll('#tab-companies .fb').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('#tab-companies .fb').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    currentFilter=b.dataset.f;
    applyCompanyFilters();
  });
});

// Company search
document.getElementById('q').addEventListener('input',e=>{
  applyCompanyFilters();
});
document.getElementById('companyTypeFilter')?.addEventListener('change',()=>applyCompanyFilters());
document.getElementById('companyProgressFilter')?.addEventListener('change',()=>applyCompanyFilters());

// Sort table
let sortCol='no',sortAsc=true;
function sortTable(col){
  if(sortCol===col){sortAsc=!sortAsc;}else{sortCol=col;sortAsc=true;}
  document.querySelectorAll('.sort-icon').forEach(s=>s.textContent='');
  const icon=document.querySelector('.sort-icon[data-col="'+col+'"]');
  if(icon)icon.textContent=sortAsc?'\\u25B2':'\\u25BC';
  const tbody=document.getElementById('companyBody');
  const rows=Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b)=>{
    let va,vb;
    if(col==='no'){va=parseInt(a.dataset.no)||0;vb=parseInt(b.dataset.no)||0;}
    else if(col==='name'){va=a.dataset.n||'';vb=b.dataset.n||'';}
    else if(col==='type'){va=a.dataset.type||'';vb=b.dataset.type||'';}
    else if(col==='progress'){
      const order={submitted:5,awaiting_approval:4,confirm_reached:3,form_fill:2,error:1,'':0};
      va=order[a.dataset.progress]||0;vb=order[b.dataset.progress]||0;
    }
    else if(col==='sent'){va=parseInt(a.dataset.cnt)||0;vb=parseInt(b.dataset.cnt)||0;}
    else{va=0;vb=0;}
    if(typeof va==='string'){return sortAsc?va.localeCompare(vb):vb.localeCompare(va);}
    return sortAsc?va-vb:vb-va;
  });
  rows.forEach(r=>tbody.appendChild(r));
  syncCompanySelectionUi();
}

// Sent tab filter
let sentFilter='all';
document.querySelectorAll('.fb-sent').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.fb-sent').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    sentFilter=b.dataset.sf;
    applySentFilter();
  });
});
document.getElementById('sentSearch').addEventListener('input',()=>applySentFilter());
function applySentFilter(){
  const q=(document.getElementById('sentSearch').value||'').toLowerCase();
  let visible=0;
  document.querySelectorAll('.sent-card').forEach(card=>{
    const matchQ=!q||(card.dataset.sn||'').includes(q);
    const cnt=parseInt(card.dataset.sc)||1;
    const matchF=sentFilter==='all'||(sentFilter==='1'&&cnt===1)||(sentFilter==='2+'&&cnt>=2);
    const show=matchQ&&matchF;
    card.style.display=show?'':'none';
    if(show)visible++;
  });
  document.getElementById('sentCount').textContent=visible+' items';
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='settings') loadSettings();
    if (b.dataset.tab === 'cli') {
      ensureXtermAssets()
        .then(() => {
          initXtermTerminals();
          connectPtyWs();
        })
        .catch((error) => showToast((LANG === 'ja' ? 'CLIビューの読込失敗: ' : 'Failed to load CLI view: ') + error.message, 'error'));
    }
  });
});

// Progress pipeline
function updatePipeline(stats){
  const total=stats.approachable||1;
  const actionNeeded=(stats.actionNeeded||0);
  const segments=[
    {val:stats.submitted,color:'#10b981',label:t('progress.sent')},
    {val:actionNeeded,color:'#f59e0b',label:t('progress.filled')},
    {val:stats.error,color:'#dc3545',label:t('progress.error')},
  ];
  const remaining=total-segments.reduce((s,x)=>s+Math.max(0,x.val),0);
  segments.push({val:remaining,color:'#dee2e6',label:t('progress.unprocessed')});

  const el=document.getElementById('pipeline');
  el.innerHTML=segments.filter(s=>s.val>0).map(s=>
    '<div class="pip-seg" style="background:'+s.color+';flex:'+Math.max(s.val,0)+'" title="'+s.label+': '+s.val+'"></div>'
  ).join('');

  const done=stats.submitted;
  document.getElementById('progressLabel').textContent=done+' / '+total+' '+t('progress.complete')+' ('+Math.round(done/total*100)+'%)';
}

// ===================== SETTINGS TAB LOGIC =====================

// Settings sidebar navigation
function openSettingsSection(section) {
  document.querySelectorAll('.settings-sidebar-btn').forEach(x => x.classList.toggle('active', x.dataset.section === section));
  document.querySelectorAll('.settings-section').forEach(x => x.classList.toggle('active', x.id === 'sec-' + section));
}

document.querySelectorAll('.settings-sidebar-btn').forEach(b=>{
  b.addEventListener('click',()=> openSettingsSection(b.dataset.section));
});

let _settingsCache = null;
let _settingsSetupRefreshTimer = null;

async function loadSettings(options = {}) {
  const force = !!(options && options.force);
  if (_settingsLoaded && !force) {
    renderSettingsSetupGuide();
    return;
  }
  if (_settingsDirty && !force) {
    renderSettingsSetupGuide();
    return;
  }
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    _settingsCache = data;
    populateCompanyProfile(data.companyProfile);
    populateValuePropositions(data.valuePropositions);
    populateTargetList(data.targetList);
    populateExclusionRules(data.exclusionRules);
    populateMessageTemplates(data.messageTemplates);
    populatePreferences(data.preferences);
    _settingsLoaded = true;
    _settingsDirty = false;
    renderSettingsSetupGuide();
  } catch (e) {
    showToast(t('alert.error') + ': ' + e.message, 'error');
  }
}

function scheduleSettingsSetupRefresh() {
  _settingsDirty = true;
  clearTimeout(_settingsSetupRefreshTimer);
  _settingsSetupRefreshTimer = setTimeout(renderSettingsSetupGuide, 0);
}

function getFieldValue(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function countMeaningfulItems(items, fields) {
  return (items || []).filter(item => fields.some(field => String((item && item[field]) || '').trim())).length;
}

function countIndustryProfiles(profiles) {
  return Object.entries(profiles || {}).filter(([key, value]) => {
    if (!String(key || '').trim()) return false;
    return ['opener','point','examples','strength'].some(field => String((value && value[field]) || '').trim());
  }).length;
}

function createSetupCheck(label, done, level) {
  return { label, done: !!done, level: level || 'required' };
}

function getSettingsSetupState() {
  const strengthCount = countMeaningfulItems(collectStrengthItems(), ['key', 'label', 'detail']);
  const successPatternCount = countMeaningfulItems(collectSuccessPatternItems(), ['partner', 'proof', 'type']);
  const industryProfileCount = countIndustryProfiles(collectIndustryProfiles());
  const hasTargetMapping = hasFilledTargetColumn('companyName')
    && (hasFilledTargetColumn('url') || hasFilledTargetColumn('formUrl'));

  const sections = {
    companyProfile: {
      status: ['cp-companyName', 'cp-contactName', 'cp-email', 'cp-phone'].every(id => !!getFieldValue(id)) ? 'ready' : 'attention',
      items: [
        createSetupCheck(t('field.companyName'), !!getFieldValue('cp-companyName'), 'required'),
        createSetupCheck(t('field.contactName'), !!getFieldValue('cp-contactName'), 'required'),
        createSetupCheck(t('field.email'), !!getFieldValue('cp-email'), 'required'),
        createSetupCheck(t('field.phone'), !!getFieldValue('cp-phone'), 'required'),
      ],
    },
    valuePropositions: {
      status: strengthCount > 0 ? 'ready' : 'attention',
      items: [
        createSetupCheck(t('field.strengths'), strengthCount > 0, 'required'),
        createSetupCheck(t('field.successPatterns'), successPatternCount > 0, 'recommended'),
        createSetupCheck(t('field.industryProfiles'), industryProfileCount > 0, 'recommended'),
      ],
    },
    targetList: {
      status: getFieldValue('tl-filePath') ? 'ready' : 'attention',
      items: [
        createSetupCheck(t('field.filePath'), !!getFieldValue('tl-filePath'), 'required'),
        createSetupCheck(t('field.columnMapping'), hasTargetMapping, 'recommended'),
        createSetupCheck(t('field.fileType'), !!getFieldValue('tl-fileType'), 'recommended'),
      ],
    },
        messageTemplates: {
          status: ['mt-greetingLine', 'mt-closingLine', 'mt-signatureTemplate'].every(id => !!getFieldValue(id)) ? 'ready' : 'attention',
          items: [
            createSetupCheck(t('field.greetingLine'), !!getFieldValue('mt-greetingLine'), 'required'),
            createSetupCheck(t('field.closingLine'), !!getFieldValue('mt-closingLine'), 'required'),
            createSetupCheck(t('field.signatureTemplate'), !!getFieldValue('mt-signatureTemplate'), 'required'),
            createSetupCheck(t('field.approachObjective'), !!getFieldValue('mt-approachObjective'), 'recommended'),
            createSetupCheck(t('field.cta'), !!getFieldValue('mt-cta'), 'recommended'),
          ],
    },
    preferences: {
      status: ['pf-screenshotDir', 'pf-dataDir', 'pf-aiProvider'].every(id => !!getFieldValue(id)) ? 'ready' : 'attention',
      items: [
        createSetupCheck(t('field.screenshotDir'), !!getFieldValue('pf-screenshotDir'), 'recommended'),
        createSetupCheck(t('field.dataDir'), !!getFieldValue('pf-dataDir'), 'recommended'),
        createSetupCheck(t('field.aiProvider'), !!getFieldValue('pf-aiProvider'), 'recommended'),
        createSetupCheck(t('field.aiModelClaude'), !!getFieldValue('pf-aiModelClaude'), 'recommended'),
      ],
    },
    exclusionRules: {
      status: 'optional',
      items: [
        createSetupCheck(t('field.excludeStatuses'), getStringListItems('er-excludeStatuses-list').length > 0, 'optional'),
        createSetupCheck(t('field.ngList'), countMeaningfulItems(collectNgItems(), ['pattern', 'reason']) > 0, 'optional'),
        createSetupCheck(t('field.customRules'), countMeaningfulItems(collectCustomRules(), ['pattern', 'status', 'reason']) > 0, 'optional'),
      ],
    },
  };

  const coreSections = ['companyProfile', 'valuePropositions', 'targetList', 'messageTemplates', 'preferences'];
  const coreReadyCount = coreSections.filter(section => sections[section].status === 'ready').length;
  return { sections, coreSections, coreReadyCount };
}

function renderSetupChecklist(items) {
  return items.map(item =>
    '<li class="setup-check-item ' + (item.done ? 'done' : 'pending') + '">'
      + '<span class="setup-check-dot"></span>'
      + '<span>' + esc(item.label) + '<span class="settings-field-chip ' + item.level + ' setup-check-level">' + esc(t('settings.tag.' + item.level)) + '</span></span>'
      + '</li>'
  ).join('');
}

function applySettingsStatus(targetId, status) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.textContent = t('settings.setupGuide.status.' + status);
  el.className = el.className.replace(/\b(ready|attention|optional)\b/g, '').trim();
  el.classList.add(status);
}

function renderSettingsSetupGuide() {
  const guide = document.getElementById('settingsSetupGuide');
  if (!guide) return;

  const state = getSettingsSetupState();
  const total = state.coreSections.length;
  const done = state.coreReadyCount;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const label = document.getElementById('settingsSetupProgressLabel');
  if (label) label.textContent = t('settings.setupGuide.progress', { done: String(done), total: String(total) });

  const bar = document.getElementById('settingsSetupProgressBar');
  if (bar) bar.style.width = percent + '%';

  const note = document.getElementById('settingsSetupProgressNote');
  if (note) note.textContent = done === total ? t('settings.setupGuide.progressDone') : t('settings.setupGuide.progressPending');

  Object.entries(state.sections).forEach(([section, config]) => {
    applySettingsStatus('setupStatus-' + section, config.status);
    applySettingsStatus('settingsSidebarStatus-' + section, config.status);
    const list = document.getElementById('setupList-' + section);
    if (list) list.innerHTML = renderSetupChecklist(config.items);
  });
}

const settingsMainEl = document.getElementById('settingsMain');
if (settingsMainEl) {
  settingsMainEl.addEventListener('input', scheduleSettingsSetupRefresh);
  settingsMainEl.addEventListener('change', scheduleSettingsSetupRefresh);
  settingsMainEl.addEventListener('change', (event) => {
    if (event && event.target && event.target.id === 'pf-aiProvider') {
      updateLaunchProviderUi(event.target.value || _currentAiProvider);
    }
  });
}

// --- Populate helpers ---

function populateCompanyProfile(cp) {
  const fields = ['companyName','companyNameEn','companyNameKana','representative','contactName','contactNameKana','contactTitle','department','email','phone','fax','mobile','postalCode','address','addressEn','website','partnerPage','corporateProfile','established','employeeCount','capital','industry','businessDescription','notes'];
  fields.forEach(f => {
    const el = document.getElementById('cp-'+f);
    if (el) el.value = cp[f] || '';
  });
}

function populateValuePropositions(vp) {
  document.getElementById('vp-companyUrl').value = vp.companyUrl || '';

  // Service URLs
  renderSimpleObjList('vp-serviceUrls-list', vp.serviceUrls || [], ['label','url'], {label:LANG==='ja'?'ラベル':'Label',url:'URL'});

  // Document paths
  renderSimpleObjList('vp-documentPaths-list', vp.documentPaths || [], ['name','path','description'], {name:LANG==='ja'?'名前':'Name',path:LANG==='ja'?'ファイルパス':'Path',description:LANG==='ja'?'説明':'Description'});

  // Strengths
  renderStrengthsList(vp.strengths || []);

  // Success patterns
  renderSuccessPatternsList(vp.successPatterns || []);

  // Industry profiles
  renderIndustryProfilesList(vp.industryProfiles || {});
}

function populateTargetList(tl) {
  document.getElementById('tl-filePath').value = tl.filePath || '';
  document.getElementById('tl-fileType').value = tl.fileType || 'xlsx';
  document.getElementById('tl-sheetIndex').value = tl.sheetIndex || 0;
  renderTargetColumnMapping(tl.columnMapping || {});
}

function populateExclusionRules(er) {
  renderExclusionList('er-competitors-list', er.competitors || [], ['pattern','status']);
  renderExclusionList('er-existingClients-list', er.existingClients || [], ['pattern','status']);
  renderNgList(er.ngList || []);
  renderCustomRulesList(er.customRules || []);
  renderStringList('er-excludeStatuses-list', er.excludeStatuses || []);
}

function populateMessageTemplates(mt) {
  const style = mt.style || {};
  document.getElementById('mt-tone').value = style.tone || 'formal';
  document.getElementById('mt-language').value = style.language || 'ja';
  document.getElementById('mt-maxLength').value = style.maxLength || 2000;
  document.getElementById('mt-signatureFormat').value = style.signatureFormat || 'full';
  renderStringList('mt-inquiryTypes-list', mt.inquiryTypes || []);
  document.getElementById('mt-greetingLine').value = mt.greetingLine || '';
  document.getElementById('mt-approachObjective').value = mt.approachObjective || '';
  document.getElementById('mt-approachGuardrails').value = mt.approachGuardrails || '';
  document.getElementById('mt-closingLine').value = mt.closingLine || '';
  document.getElementById('mt-cta').value = mt.cta || '';
  document.getElementById('mt-referenceUrlText').value = mt.referenceUrlText || '';
  document.getElementById('mt-signatureTemplate').value = mt.signatureTemplate || '';
  const letter = mt.letterTemplate || {};
  document.getElementById('mt-letter-enabled').value = String(letter.enabled || false);
  document.getElementById('mt-letter-format').value = letter.format || 'A4';
  document.getElementById('mt-letter-header').value = letter.header || '';
  document.getElementById('mt-letter-footer').value = letter.footer || '';
}

function populatePreferences(pf) {
  const fields = {
    dashboardPort:'number', dashboardHost:'text', language:'select', timezone:'text', dateFormat:'text',
    screenshotDir:'text', dataDir:'text', emailSearchKeyword:'text', emailProvider:'select',
    maxRetries:'number', pageTimeout:'number', formFillTimeout:'number',
    headless:'select', locale:'text', requireApprovalBeforeSend:'select',
    userAgent:'text', logLevel:'select', maxLogEntries:'number', exportFilenamePrefix:'text',
    aiProvider:'select'
  };
  Object.keys(fields).forEach(f => {
    const el = document.getElementById('pf-'+f);
    if (!el) return;
    const val = pf[f];
    if (fields[f] === 'select') {
      el.value = String(val !== undefined ? val : '');
    } else {
      el.value = val !== undefined ? val : '';
    }
  });
  const aiModels = pf.aiModels || {};
  const aiModelClaude = document.getElementById('pf-aiModelClaude');
  const aiModelCodex = document.getElementById('pf-aiModelCodex');
  const aiModelGemini = document.getElementById('pf-aiModelGemini');
  if (aiModelClaude) aiModelClaude.value = aiModels.claude || pf.claudeModel || '';
  if (aiModelCodex) aiModelCodex.value = aiModels.codex || '';
  if (aiModelGemini) aiModelGemini.value = aiModels.gemini || '';
  if (pf.aiProvider) {
    _currentAiProvider = pf.aiProvider;
    updateLaunchProviderUi(_currentAiProvider);
  }
}

async function browseForDirectory(fieldId) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  if (!NATIVE_DIRECTORY_PICKER_AVAILABLE) {
    showToast(t('settings.dirPicker.desktopOnly'), 'info');
    input.focus();
    input.select?.();
    return;
  }
  try {
    const res = await fetch('/api/settings/select-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPath: input.value || '' }),
    });
    const result = await res.json();
    if (result && result.ok && result.path) {
      input.value = result.path;
      scheduleSettingsSetupRefresh();
      return;
    }
    if (result && result.cancelled) return;
    showToast(t('alert.error') + ': ' + ((result && result.error) || 'Directory selection failed.'), 'error');
  } catch (e) {
    showToast(t('alert.error') + ': ' + e.message, 'error');
  }
}

function renderTargetColumnMapping(mapping) {
  const container = document.getElementById('tl-columnMappingList');
  if (!container) return;
  const current = { ...(mapping || {}) };
  const fixedRows = TARGET_COLUMN_FIELDS.map((field) => {
    const value = current[field];
    return '<div class="column-map-row" data-key="' + esc(field) + '" data-fixed="1">'
      + '<span class="column-map-label">' + esc(TARGET_COLUMN_LABELS[field] || field) + '</span>'
      + '<input type="number" min="0" data-field="columnIndex" value="' + (value !== undefined && value !== null && value !== '' ? esc(value) : '') + '">'
      + '<span></span>'
      + '</div>';
  }).join('');

  const customEntries = Object.entries(current).filter(([field]) => !TARGET_COLUMN_FIELDS.includes(field));
  const customRows = customEntries.map(([field, value], index) =>
    '<div class="column-map-row" data-fixed="0">'
      + '<input type="text" class="column-map-key" data-field="columnKey" value="' + esc(field) + '" placeholder="' + esc(t('field.customColumnKey')) + '">'
      + '<input type="number" min="0" data-field="columnIndex" value="' + (value !== undefined && value !== null && value !== '' ? esc(value) : '') + '">'
      + '<button type="button" class="remove-btn" onclick="removeCustomColumnMappingRow(' + index + ')">&times;</button>'
      + '</div>'
  ).join('');

  container.innerHTML = fixedRows + customRows;
  container.dataset.mapping = JSON.stringify(current);
  scheduleSettingsSetupRefresh();
}

function collectTargetColumnMapping() {
  const container = document.getElementById('tl-columnMappingList');
  if (!container) return {};
  const rows = container.querySelectorAll('.column-map-row');
  const result = {};
  rows.forEach((row) => {
    const fixedKey = row.dataset.key || '';
    const keyInput = row.querySelector('[data-field="columnKey"]');
    const key = (fixedKey || (keyInput ? keyInput.value.trim() : '')).trim();
    if (!key) return;
    const indexInput = row.querySelector('[data-field="columnIndex"]');
    const raw = indexInput ? String(indexInput.value || '').trim() : '';
    if (raw === '') {
      if (row.dataset.fixed === '1') result[key] = 0;
      return;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      result[key] = parsed;
    } else if (row.dataset.fixed === '1') {
      result[key] = 0;
    }
  });
  return result;
}

function hasFilledTargetColumn(field) {
  const row = document.querySelector('#tl-columnMappingList .column-map-row[data-key="' + field + '"]');
  if (!row) return false;
  const input = row.querySelector('[data-field="columnIndex"]');
  return !!(input && String(input.value || '').trim() !== '');
}

function addCustomColumnMappingRow() {
  const mapping = collectTargetColumnMapping();
  let suffix = 1;
  let key = 'customField' + suffix;
  while (Object.prototype.hasOwnProperty.call(mapping, key)) {
    suffix += 1;
    key = 'customField' + suffix;
  }
  mapping[key] = '';
  renderTargetColumnMapping(mapping);
}

function removeCustomColumnMappingRow(index) {
  const mapping = collectTargetColumnMapping();
  const customKeys = Object.keys(mapping).filter((field) => !TARGET_COLUMN_FIELDS.includes(field));
  const key = customKeys[index];
  if (!key) return;
  delete mapping[key];
  renderTargetColumnMapping(mapping);
}

// --- String list renderer (for excludeStatuses, inquiryTypes) ---
function renderStringList(containerId, items) {
  const container = document.getElementById(containerId);
  let html = '';
  items.forEach((item, i) => {
    html += '<div class="list-item"><span style="flex:1">'+esc(item)+'</span><button class="remove-btn" onclick="removeStringItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button></div>';
  });
  html += '<div class="add-row"><input type="text" placeholder="'+t('settings.add')+'..." onkeydown="if(event.key===\\x27Enter\\x27)addStringItem(\\x27'+containerId+'\\x27,this)"><button onclick="addStringItem(\\x27'+containerId+'\\x27,this.previousElementSibling)">'+t('settings.add')+'</button></div>';
  container.innerHTML = html;
  container.dataset.items = JSON.stringify(items);
  scheduleSettingsSetupRefresh();
}

function addStringItem(containerId, input) {
  const val = input.value.trim();
  if (!val) return;
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  items.push(val);
  renderStringList(containerId, items);
}

function removeStringItem(containerId, idx) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  items.splice(idx, 1);
  renderStringList(containerId, items);
}

function getStringListItems(containerId) {
  const container = document.getElementById(containerId);
  return JSON.parse(container.dataset.items || '[]');
}

// --- Simple object list renderer (for serviceUrls, documentPaths) ---
function renderSimpleObjList(containerId, items, fields, labels) {
  const container = document.getElementById(containerId);
  let html = '';
  items.forEach((item, i) => {
    const display = fields.map(f => esc(item[f] || '')).join(' | ');
    html += '<div class="list-item"><span style="flex:1;font-size:.78rem">'+display+'</span><button class="remove-btn" onclick="removeObjItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button></div>';
  });
  const addInputs = fields.map(f => '<input type="text" placeholder="'+esc(labels[f]||f)+'" data-field="'+f+'">').join('');
  html += '<div class="add-row">'+addInputs+'<button onclick="addObjItem(\\x27'+containerId+'\\x27,['+fields.map(f=>"\\x27"+f+"\\x27").join(',')+'])">'+t('settings.add')+'</button></div>';
  container.innerHTML = html;
  container.dataset.items = JSON.stringify(items);
  container.dataset.fields = JSON.stringify(fields);
  scheduleSettingsSetupRefresh();
}

function addObjItem(containerId, fields) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  const storedFields = JSON.parse(container.dataset.fields || '[]');
  const inputs = container.querySelectorAll('.add-row input');
  const obj = {};
  let hasVal = false;
  inputs.forEach(input => {
    obj[input.dataset.field] = input.value.trim();
    if (input.value.trim()) hasVal = true;
  });
  if (!hasVal) return;
  items.push(obj);
  const labels = {};
  inputs.forEach(input => { labels[input.dataset.field] = input.placeholder; });
  renderSimpleObjList(containerId, items, storedFields, labels);
}

function removeObjItem(containerId, idx) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  const fields = JSON.parse(container.dataset.fields || '[]');
  items.splice(idx, 1);
  const labels = {};
  fields.forEach(f => { labels[f] = f; });
  renderSimpleObjList(containerId, items, fields, labels);
}

function getObjListItems(containerId) {
  const container = document.getElementById(containerId);
  return JSON.parse(container.dataset.items || '[]');
}

// --- Strengths list ---
function renderStrengthsList(items) {
  const container = document.getElementById('vp-strengths-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+(item.label||item.key||'Strength '+(i+1))+'</strong><button class="remove-btn" onclick="removeStrengthItem('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'キー':'Key')+'</label><input type="text" value="'+esc(item.key||'')+'" data-field="key"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'ラベル':'Label')+'</label><input type="text" value="'+esc(item.label||'')+'" data-field="label"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'詳細':'Detail')+'</label><input type="text" value="'+esc(item.detail||'')+'" data-field="detail"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'キーワード':'Keywords')+'</label><input type="text" value="'+esc((item.keywords||[]).join(', '))+'" data-field="keywords" placeholder="'+(LANG==='ja'?'カンマ区切り':'comma separated')+'"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  scheduleSettingsSetupRefresh();
}

function addStrengthItem() {
  const container = document.getElementById('vp-strengths-list');
  const items = collectStrengthItems();
  items.push({ key: '', label: '', detail: '', keywords: [] });
  renderStrengthsList(items);
}

function removeStrengthItem(idx) {
  const items = collectStrengthItems();
  items.splice(idx, 1);
  renderStrengthsList(items);
}

function collectStrengthItems() {
  const container = document.getElementById('vp-strengths-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => {
      if (inp.dataset.field === 'keywords') {
        obj.keywords = inp.value.split(',').map(s=>s.trim()).filter(Boolean);
      } else {
        obj[inp.dataset.field] = inp.value;
      }
    });
    return obj;
  });
}

// --- Success patterns list ---
function renderSuccessPatternsList(items) {
  const container = document.getElementById('vp-successPatterns-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+(item.partner||'Pattern '+(i+1))+'</strong><button class="remove-btn" onclick="removeSuccessPatternItem('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'パートナー':'Partner')+'</label><input type="text" value="'+esc(item.partner||'')+'" data-field="partner"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'実績内容':'Proof')+'</label><input type="text" value="'+esc(item.proof||'')+'" data-field="proof"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'カテゴリ':'Type')+'</label><input type="text" value="'+esc(item.type||'')+'" data-field="type"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  scheduleSettingsSetupRefresh();
}

function addSuccessPatternItem() {
  const items = collectSuccessPatternItems();
  items.push({ partner: '', proof: '', type: '' });
  renderSuccessPatternsList(items);
}

function removeSuccessPatternItem(idx) {
  const items = collectSuccessPatternItems();
  items.splice(idx, 1);
  renderSuccessPatternsList(items);
}

function collectSuccessPatternItems() {
  const container = document.getElementById('vp-successPatterns-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// --- Industry profiles ---
function renderIndustryProfilesList(profiles) {
  const container = document.getElementById('vp-industryProfiles-list');
  const entries = Object.entries(profiles);
  container.innerHTML = entries.map(([key, val], i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+esc(key)+'</strong><button class="remove-btn" onclick="removeIndustryProfile('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'業種キー':'Key')+'</label><input type="text" value="'+esc(key)+'" data-field="__key"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'オープナー':'Opener')+'</label><input type="text" value="'+esc(val.opener||'')+'" data-field="opener"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'ポイント':'Point')+'</label><input type="text" value="'+esc(val.point||'')+'" data-field="point"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'実績例':'Examples')+'</label><input type="text" value="'+esc(val.examples||'')+'" data-field="examples"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'強み':'Strength')+'</label><input type="text" value="'+esc(val.strength||'')+'" data-field="strength"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(profiles);
  scheduleSettingsSetupRefresh();
}

function addIndustryProfile() {
  const profiles = collectIndustryProfiles();
  profiles['new_type'] = { opener: '', point: '', examples: '', strength: '' };
  renderIndustryProfilesList(profiles);
}

function removeIndustryProfile(idx) {
  const profiles = collectIndustryProfiles();
  const keys = Object.keys(profiles);
  if (keys[idx]) delete profiles[keys[idx]];
  renderIndustryProfilesList(profiles);
}

function collectIndustryProfiles() {
  const container = document.getElementById('vp-industryProfiles-list');
  const cards = container.querySelectorAll('.obj-list-item');
  const result = {};
  cards.forEach(card => {
    const inputs = card.querySelectorAll('input');
    let key = '';
    const obj = {};
    inputs.forEach(inp => {
      if (inp.dataset.field === '__key') key = inp.value.trim();
      else obj[inp.dataset.field] = inp.value;
    });
    if (key) result[key] = obj;
  });
  return result;
}

// --- Exclusion lists ---
const _exclPh = LANG==='ja' ? {pattern:'会社名パターン',status:'ステータス',reason:'理由'} : {pattern:'Pattern',status:'Status',reason:'Reason'};
function renderExclusionList(containerId, items, fields) {
  const container = document.getElementById(containerId);
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +fields.map(f => '<input type="text" value="'+esc(item[f]||'')+'" data-field="'+f+'" placeholder="'+(_exclPh[f]||f)+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">').join('')
    +'</div>'
    +'<button class="remove-btn" onclick="removeExclusionItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  container.dataset.fields = JSON.stringify(fields);
  scheduleSettingsSetupRefresh();
}

function addExclusionItem(type) {
  const containerId = 'er-'+type+'-list';
  const items = collectExclusionItems(containerId);
  items.push({ pattern: '', status: '' });
  const fields = JSON.parse(document.getElementById(containerId).dataset.fields || '["pattern","status"]');
  renderExclusionList(containerId, items, fields);
}

function removeExclusionItem(containerId, idx) {
  const items = collectExclusionItems(containerId);
  items.splice(idx, 1);
  const fields = JSON.parse(document.getElementById(containerId).dataset.fields || '["pattern","status"]');
  renderExclusionList(containerId, items, fields);
}

function collectExclusionItems(containerId) {
  const container = document.getElementById(containerId);
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// NG list
function renderNgList(items) {
  const container = document.getElementById('er-ngList-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +'<input type="text" value="'+esc(item.pattern||'')+'" data-field="pattern" placeholder="'+(LANG==='ja'?'会社名パターン':'Pattern')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.reason||'')+'" data-field="reason" placeholder="'+(LANG==='ja'?'除外理由':'Reason')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.status||'NG')+'" data-field="status" placeholder="'+(LANG==='ja'?'ステータス':'Status')+'" style="width:80px;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'</div>'
    +'<button class="remove-btn" onclick="removeNgItem('+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  scheduleSettingsSetupRefresh();
}

function addNgItem() {
  const items = collectNgItems();
  items.push({ pattern: '', reason: '', status: 'NG' });
  renderNgList(items);
}

function removeNgItem(idx) {
  const items = collectNgItems();
  items.splice(idx, 1);
  renderNgList(items);
}

function collectNgItems() {
  const container = document.getElementById('er-ngList-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// Custom rules
function renderCustomRulesList(items) {
  const container = document.getElementById('er-customRules-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +'<input type="text" value="'+esc(item.pattern||'')+'" data-field="pattern" placeholder="'+(LANG==='ja'?'正規表現パターン':'Regex pattern')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.status||'')+'" data-field="status" placeholder="'+(LANG==='ja'?'ステータス':'Status')+'" style="width:120px;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.reason||'')+'" data-field="reason" placeholder="'+(LANG==='ja'?'理由':'Reason')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'</div>'
    +'<button class="remove-btn" onclick="removeCustomRule('+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  scheduleSettingsSetupRefresh();
}

function addCustomRule() {
  const items = collectCustomRules();
  items.push({ pattern: '', status: '', reason: '' });
  renderCustomRulesList(items);
}

function removeCustomRule(idx) {
  const items = collectCustomRules();
  items.splice(idx, 1);
  renderCustomRulesList(items);
}

function collectCustomRules() {
  const container = document.getElementById('er-customRules-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// --- Save section ---
async function saveSection(section) {
  let data;
  try {
    if (section === 'companyProfile') {
      data = {};
      ['companyName','companyNameEn','companyNameKana','representative','contactName','contactNameKana','contactTitle','department','email','phone','fax','mobile','postalCode','address','addressEn','website','partnerPage','corporateProfile','established','employeeCount','capital','industry','businessDescription','notes'].forEach(f => {
        data[f] = document.getElementById('cp-'+f).value;
      });
    } else if (section === 'valuePropositions') {
      data = {
        companyUrl: document.getElementById('vp-companyUrl').value,
        serviceUrls: getObjListItems('vp-serviceUrls-list'),
        documentPaths: getObjListItems('vp-documentPaths-list'),
        strengths: collectStrengthItems(),
        successPatterns: collectSuccessPatternItems(),
        industryProfiles: collectIndustryProfiles(),
      };
    } else if (section === 'targetList') {
      data = {
        filePath: document.getElementById('tl-filePath').value,
        fileType: document.getElementById('tl-fileType').value,
        sheetIndex: parseInt(document.getElementById('tl-sheetIndex').value) || 0,
        columnMapping: collectTargetColumnMapping(),
      };
    } else if (section === 'exclusionRules') {
      data = {
        competitors: collectExclusionItems('er-competitors-list'),
        existingClients: collectExclusionItems('er-existingClients-list'),
        ngList: collectNgItems(),
        customRules: collectCustomRules(),
        excludeStatuses: getStringListItems('er-excludeStatuses-list'),
      };
    } else if (section === 'messageTemplates') {
      data = {
        style: {
          tone: document.getElementById('mt-tone').value,
          language: document.getElementById('mt-language').value,
          maxLength: parseInt(document.getElementById('mt-maxLength').value) || 2000,
          signatureFormat: document.getElementById('mt-signatureFormat').value,
        },
        inquiryTypes: getStringListItems('mt-inquiryTypes-list'),
        greetingLine: document.getElementById('mt-greetingLine').value,
        approachObjective: document.getElementById('mt-approachObjective').value,
        approachGuardrails: document.getElementById('mt-approachGuardrails').value,
        closingLine: document.getElementById('mt-closingLine').value,
        cta: document.getElementById('mt-cta').value,
        referenceUrlText: document.getElementById('mt-referenceUrlText').value,
        signatureTemplate: document.getElementById('mt-signatureTemplate').value,
        letterTemplate: {
          enabled: document.getElementById('mt-letter-enabled').value === 'true',
          format: document.getElementById('mt-letter-format').value,
          header: document.getElementById('mt-letter-header').value,
          footer: document.getElementById('mt-letter-footer').value,
        },
      };
    } else if (section === 'preferences') {
      data = {
        dashboardPort: parseInt(document.getElementById('pf-dashboardPort').value) || 3765,
        dashboardHost: document.getElementById('pf-dashboardHost').value,
        language: document.getElementById('pf-language').value,
        timezone: document.getElementById('pf-timezone').value,
        dateFormat: document.getElementById('pf-dateFormat').value,
        screenshotDir: document.getElementById('pf-screenshotDir').value,
        dataDir: document.getElementById('pf-dataDir').value,
        emailSearchKeyword: document.getElementById('pf-emailSearchKeyword').value,
        emailProvider: document.getElementById('pf-emailProvider').value,
        maxRetries: parseInt(document.getElementById('pf-maxRetries').value) || 3,
        pageTimeout: parseInt(document.getElementById('pf-pageTimeout').value) || 15000,
        formFillTimeout: parseInt(document.getElementById('pf-formFillTimeout').value) || 5000,
        headless: document.getElementById('pf-headless').value === 'true',
        locale: document.getElementById('pf-locale').value,
        requireApprovalBeforeSend: document.getElementById('pf-requireApprovalBeforeSend').value === 'true',
        userAgent: document.getElementById('pf-userAgent').value,
        logLevel: document.getElementById('pf-logLevel').value,
        maxLogEntries: parseInt(document.getElementById('pf-maxLogEntries').value) || 10000,
        exportFilenamePrefix: document.getElementById('pf-exportFilenamePrefix').value,
        aiProvider: document.getElementById('pf-aiProvider').value,
        aiModels: {
          claude: document.getElementById('pf-aiModelClaude').value,
          codex: document.getElementById('pf-aiModelCodex').value,
          gemini: document.getElementById('pf-aiModelGemini').value,
        },
        claudeModel: document.getElementById('pf-aiModelClaude').value,
      };
    }

    const res = await fetch('/api/settings/' + section, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
  if (result.ok) {
      _settingsCache = { ...(_settingsCache || {}), [section]: data };
      _settingsLoaded = true;
      _settingsDirty = false;
      renderSettingsSetupGuide();
      if (section === 'targetList') loadTargetPreview();
      if (section === 'preferences') {
        _currentAiProvider = data.aiProvider || _currentAiProvider;
        updateLaunchProviderUi(_currentAiProvider);
        setTimeout(pollClaudeStatus, 300);
      }
      showToast(t('settings.saved'), 'success');
    } else {
      showToast(t('settings.saveError') + ': ' + (result.error || 'Unknown'), 'error');
    }
  } catch (e) {
    showToast(t('settings.saveError') + ': ' + e.message, 'error');
  }
}

// Target list preview
async function loadTargetPreview() {
  try {
    const res = await fetch('/api/settings/target-list/preview');
    const data = await res.json();
    if (data.error) { document.getElementById('targetPreview').innerHTML = '<div class="text-danger">'+esc(data.error)+'</div>'; return; }
    const rows = data.rows || [];
    if (rows.length === 0) { document.getElementById('targetPreview').innerHTML = '<div class="text-muted">No data found.</div>'; return; }
    const headers = data.headers || [];
    let html = '<table class="preview-table"><thead><tr>';
    headers.forEach((h,i) => { html += '<th>Col '+i+(h?' ('+esc(h)+')':'')+'</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
      html += '<tr>';
      for (let i = 0; i < headers.length; i++) { html += '<td>'+esc(row[i]||'')+'</td>'; }
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('targetPreview').innerHTML = html;
  } catch (e) {
    document.getElementById('targetPreview').innerHTML = '<div class="text-danger">'+esc(e.message)+'</div>';
  }
}

// ─── フローティングターミナルドロワー ───────────────────────────────
// ヘッダーのターミナルボタンで全タブから開閉できる固定ドロワー
function toggleTermDrawer() {
  _termDrawerOpen = !_termDrawerOpen;
  const drawer = document.getElementById('termDrawer');
  const btn = document.getElementById('termDrawerToggleBtn');
  if (!drawer) return;
  drawer.style.transform = _termDrawerOpen ? 'translateY(0)' : 'translateY(100%)';
  if (btn) btn.style.background = _termDrawerOpen ? 'var(--primary)' : 'var(--surface-low)';
  if (btn) {
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.style.color = _termDrawerOpen ? '#fff' : '';
  }
  if (_termDrawerOpen) {
    const s = document.getElementById('termDrawerStream');
    if (s) s.scrollTop = s.scrollHeight;
    try { localStorage.setItem('termDrawerOpen','1'); } catch(_){}
  } else {
    try { localStorage.setItem('termDrawerOpen','0'); } catch(_){}
  }
}
// ターミナルドロワーは主監視UIから外したため、自動復元しない
</script>

</body>
</html>`;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = requestUrl.pathname;

  if (pathname === '/events' || pathname.startsWith('/screenshots/') || pathname.startsWith('/api/')) {
    const auth = isAuthorizedDashboardRequest(req);
    if (!auth.ok) {
      if (pathname.startsWith('/api/approve') || pathname.startsWith('/api/install-claude-cli') || pathname.startsWith('/api/install-ai-cli')) {
        appendDiagnosticEvent('auth_rejected', {
          path: pathname,
          method: req.method,
          statusCode: auth.statusCode,
          error: auth.error,
        });
        console.warn(`[dashboard-auth] ${req.method} ${pathname} rejected: ${auth.error}`);
      }
      jsonResponse(res, auth.statusCode, { ok: false, error: auth.error });
      return;
    }
  }

  // WebSocket upgrade is handled below
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Assets serving (favicon, icons)
  if (pathname.startsWith('/assets/')) {
    const filename = path.basename(pathname);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.ico' ? 'image/x-icon' : ext === '.png' ? 'image/png' : 'application/octet-stream';
    for (const filepath of getAssetCandidates(filename)) {
      try {
        const data = fs.readFileSync(filepath);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
        return;
      } catch (_) {}
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Screenshot serving
  if (pathname.startsWith('/screenshots/')) {
    const filename = path.basename(pathname);
    const filepath = findScreenshotPath(filename);
    if (!filepath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      const img = fs.readFileSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- Settings API endpoints ---

  // POST /api/settings/select-directory - open native folder picker
  if (req.url === '/api/settings/select-directory' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const selectedPath = await openDirectoryPicker(body.currentPath || '');
      if (!selectedPath) {
        jsonResponse(res, 200, { ok: true, cancelled: true });
        return;
      }
      jsonResponse(res, 200, { ok: true, path: toStoredProjectPath(selectedPath) });
    } catch (e) {
      const statusCode = /desktop app|browser-only mode/i.test(String(e.message || '')) ? 409 : 500;
      jsonResponse(res, statusCode, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/settings/excel/export - export Company Profile + Value Propositions workbook
  if (req.url.startsWith('/api/settings/excel/export') && req.method === 'GET') {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const mode = requestUrl.searchParams.get('mode') === 'template' ? 'template' : 'current';
      const buffer = buildSettingsWorkbookBuffer({
        mode,
        settingsData: settings.getAll(),
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `sales-claw-settings-${mode}-${stamp}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/settings/excel/import - import Company Profile + Value Propositions workbook
  if (req.url === '/api/settings/excel/import' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { contentBase64 } = data || {};
      if (!contentBase64) {
        jsonResponse(res, 400, { ok: false, error: 'contentBase64 is required.' });
        return;
      }
      const imported = parseSettingsWorkbookBuffer(Buffer.from(contentBase64, 'base64'));
      if (imported.sections.companyProfile) {
        settings.replaceSection('companyProfile', imported.sections.companyProfile);
      }
      if (imported.sections.valuePropositions) {
        settings.replaceSection('valuePropositions', imported.sections.valuePropositions);
      }
      notifyClients({ type: 'update', reason: 'settings-excel-imported', time: Date.now() });
      jsonResponse(res, 200, {
        ok: true,
        applied: imported.applied,
        summary: imported.summary,
        companyProfile: imported.sections.companyProfile || null,
        valuePropositions: imported.sections.valuePropositions || null,
      });
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/settings - returns all settings
  if (req.url === '/api/settings' && req.method === 'GET') {
    try {
      jsonResponse(res, 200, settings.getAll());
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // PUT /api/settings/:section - update a section
  if (req.url.match(/^\/api\/settings\/(companyProfile|valuePropositions|targetList|exclusionRules|messageTemplates|preferences)$/) && req.method === 'PUT') {
    try {
      const section = req.url.split('/').pop();
      const data = await parseJsonBody(req);
      settings.replaceSection(section, data);

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'settings-saved', time: Date.now() });
      jsonResponse(res, 200, { ok: true, data: settings.getSection(section) });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/settings/upload-document - register document file path
  if (req.url === '/api/settings/upload-document' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { name, filePath, description } = data;
      if (!name || !filePath) {
        jsonResponse(res, 400, { error: 'name and filePath are required' });
        return;
      }
      const vp = settings.getSection('valuePropositions');
      const docs = vp.documentPaths || [];
      docs.push({ name, path: filePath, description: description || '' });
      settings.updateSection('valuePropositions', { documentPaths: docs });
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/settings/target-list/preview - preview first 10 rows
  if (req.url === '/api/settings/target-list/preview' && req.method === 'GET') {
    try {
      const preview = getTargetPreview(10);
      if (!preview.ok) {
        jsonResponse(res, 200, { error: preview.error });
        return;
      }
      jsonResponse(res, 200, { headers: preview.headers, rows: preview.rows });
    } catch (e) {
      jsonResponse(res, 200, { error: e.message });
    }
    return;
  }

  // POST /api/target-list/import - import Excel/CSV and switch target list
  if (req.url === '/api/target-list/import' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { fileName, contentBase64 } = data || {};
      if (!fileName || !contentBase64) {
        jsonResponse(res, 400, { ok: false, error: 'fileName and contentBase64 are required.' });
        return;
      }

      const imported = importTargetList({
        fileName,
        buffer: Buffer.from(contentBase64, 'base64'),
      });

      if (!imported.ok) {
        jsonResponse(res, 400, { ok: false, error: imported.error || 'Import failed.' });
        return;
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'target-list-imported', time: Date.now() });
      jsonResponse(res, 200, { ok: true, ...imported });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/companies - add a company row to current target list
  if (req.url === '/api/companies' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const created = appendCompany(data || {});
      if (!created.ok) {
        jsonResponse(res, 400, { ok: false, error: created.error || 'Company add failed.' });
        return;
      }

      if (data && data.addToTarget) {
        setTargets([{
          companyNo: created.company.no,
          companyName: created.company.companyName,
        }], true);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-added', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: created.company, targetPath: created.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.url === '/api/companies/bulk-delete' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }

      const uniqueCompanyNos = Array.from(new Set(companyNos.map((value) => String(value))));
      const deletedCompanies = [];
      const skippedCompanies = [];
      const runtimeCompanyMap = new Map(loadData().companies.map((company) => [String(company.no), company]));
      for (const companyNo of uniqueCompanyNos) {
        let removed = deleteCompany(companyNo);
        if (!removed.ok) removed = purgeHistoryOnlyCompany(companyNo);
        if (!removed.ok) {
          skippedCompanies.push({ companyNo, error: removed.error || `Failed to delete company ${companyNo}.` });
          continue;
        }
        const runtimeCompany = runtimeCompanyMap.get(String(companyNo));
        deletedCompanies.push({
          ...removed.company,
          no: removed.company && removed.company.no !== undefined ? removed.company.no : companyNo,
          companyName: (removed.company && removed.company.companyName) || (runtimeCompany && runtimeCompany.name) || String(companyNo),
        });
      }

      if (deletedCompanies.length > 0) {
        setTargets(deletedCompanies.map((company) => ({
          companyNo: company.no,
          companyName: company.companyName,
        })), false);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-bulk-deleted', time: Date.now() });
      jsonResponse(res, 200, {
        ok: true,
        deletedCount: deletedCompanies.length,
        companies: deletedCompanies,
        skippedCount: skippedCompanies.length,
        skippedCompanies,
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  const companyApiMatch = pathname.match(/^\/api\/companies\/([^/]+)$/);
  if (companyApiMatch && req.method === 'PUT') {
    try {
      const companyNo = decodeURIComponent(companyApiMatch[1]);
      const data = await parseJsonBody(req);
      const updated = updateCompany(companyNo, data || {});
      if (!updated.ok) {
        jsonResponse(res, 400, { ok: false, error: updated.error || 'Company update failed.' });
        return;
      }

      if (data && Object.prototype.hasOwnProperty.call(data, 'addToTarget')) {
        setTargets([{
          companyNo: updated.company.no,
          companyName: updated.company.companyName,
        }], !!data.addToTarget);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-updated', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: updated.company, targetPath: updated.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (companyApiMatch && req.method === 'DELETE') {
    try {
      const companyNo = decodeURIComponent(companyApiMatch[1]);
      const runtimeCompany = findRuntimeCompanyRecord(companyNo);
      let removed = deleteCompany(companyNo);
      if (!removed.ok) removed = purgeHistoryOnlyCompany(companyNo);
      if (!removed.ok) {
        jsonResponse(res, 400, { ok: false, error: removed.error || 'Company delete failed.' });
        return;
      }

      setTargets([{
        companyNo: removed.company.no,
        companyName: removed.company.companyName || (runtimeCompany && runtimeCompany.name) || String(companyNo),
      }], false);

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-deleted', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: removed.company, targetPath: removed.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/outreach-targets - persist outreach target selection
  if (req.url === '/api/outreach-targets' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      const active = data && data.active !== false;
      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }

      const found = findCompaniesByNos(companyNos);
      if (!found.ok) {
        jsonResponse(res, 400, { ok: false, error: found.error || 'Target companies not found.' });
        return;
      }

      const targets = found.companies.map((company) => ({
        companyNo: company.no,
        companyName: company.companyName,
      }));
      setTargets(targets, active);
      notifyClients({ type: 'update', reason: 'outreach-targets-updated', time: Date.now() });
      jsonResponse(res, 200, { ok: true, count: targets.length, active });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/outreach/prepare - disabled to prevent direct JS automation fallback
  if (req.url === '/api/outreach/prepare' && req.method === 'POST') {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS outreach preparation has been removed. Use /api/ai-form-fill with a managed AI session.',
    });
    return;
  }

  // --- Existing API endpoints ---

  // Approve / Skip
  if (req.url === '/api/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { companyNo, companyName, decision, feedback } = JSON.parse(body);
        const companyNoNum = Number(companyNo);
        const lang = getUiLang();
        const normalizedDecision = String(decision || '').trim();
        if (!Number.isFinite(companyNoNum) || !normalizedDecision) {
          appendDiagnosticEvent('approve_invalid_request', {
            companyNo,
            decision: normalizedDecision || '',
          });
          console.warn(`[approve] invalid request: companyNo=${companyNo} decision=${normalizedDecision || '-'}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: i18nT(lang, 'audit.invalidRequest') || 'companyNo and decision required' }));
          return;
        }
        const { logAction } = require('./action-logger.cjs');
        const { recordContact, getHistory } = require('./contact-history.cjs');
        const auditContext = getCompanyLogContext(companyNoNum);
        let approvalArtifacts = null;
        const allowInputOnlyApproval = !!(auditContext.screenshot && auditContext.screenshot.readyForManualApproval);
        if (normalizedDecision === 'sent' || normalizedDecision === 'skip') {
          if (!isAwaitingTransitionAllowed(auditContext.lastAction, normalizedDecision)) {
            appendDiagnosticEvent('approve_blocked_invalid_state', {
              companyNo: companyNoNum,
              companyName,
              decision: normalizedDecision,
              state: auditContext.lastAction || '',
            });
            console.warn(`[approve] blocked invalid state: companyNo=${companyNoNum} decision=${normalizedDecision} state=${auditContext.lastAction || '-'}`);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: i18nT(lang, 'audit.blockedInvalidState', { state: auditContext.lastAction || '-' }),
            }));
            return;
          }
          if (normalizedDecision === 'sent') {
            try {
              approvalArtifacts = assertApprovalArtifacts(companyNoNum, {
                logs: auditContext.logs,
                formFillLog: auditContext.formFillLog,
                awaitingLog: auditContext.awaitingLog,
                confirmLog: auditContext.confirmLog,
                submittedLog: auditContext.submittedLog,
                allowInputOnly: allowInputOnlyApproval,
                message: i18nT(lang, 'audit.blockedMissingScreenshot'),
              });
            } catch (error) {
              appendDiagnosticEvent('approve_blocked_missing_screenshot', {
                companyNo: companyNoNum,
                companyName,
                decision: normalizedDecision,
                allowInputOnlyApproval,
                screenshotState: auditContext.screenshot ? auditContext.screenshot.auditState : '',
              });
              console.warn(`[approve] blocked missing screenshot: companyNo=${companyNoNum} decision=${normalizedDecision}`);
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: i18nT(lang, 'audit.blockedMissingScreenshot') }));
              return;
            }
          } else {
            approvalArtifacts = getExpectedApprovalArtifacts(companyNoNum, {
              logs: auditContext.logs,
              formFillLog: auditContext.formFillLog,
              awaitingLog: auditContext.awaitingLog,
              confirmLog: auditContext.confirmLog,
              submittedLog: auditContext.submittedLog,
            });
          }
        }
        if (normalizedDecision === 'sent') {
          const approvalScreenshot = approvalArtifacts
            ? (approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
            : null;
          logAction(companyNoNum, companyName, 'submitted', buildApprovalLogDetails({
            companyNo: companyNoNum,
            source: 'dashboard-approve',
            action: 'submitted',
            mode: 'manual',
            screenshot: approvalScreenshot,
            success: true,
            verified: true,
            detail: allowInputOnlyApproval ? 'ダッシュボードで手動送信完了を確認' : 'ダッシュボードで承認済み',
            approvalRequired: true,
          }));
          const draft = auditContext.allLogs.filter(l => String(l.companyNo) === String(companyNoNum) && l.action === 'message_draft').pop();
          const existingHistory = getHistory(companyNoNum);
          const knownFormUrl = getKnownFormUrl(companyNoNum, findRuntimeCompanyRecord(companyNoNum)?.formUrl || '');
          const alreadyRecorded = existingHistory && existingHistory.contacts.length > 0 &&
            existingHistory.contacts.some(c => draft && c.message === draft.details);
          if (!alreadyRecorded) {
            recordContact(companyNoNum, companyName, {
              message: draft ? draft.details : '',
              formUrl: knownFormUrl,
              method: 'web_form',
            });
          }
          finishLiveMonitor(companyNoNum, {
            companyNo: companyNoNum,
            companyName,
            status: 'submitted',
            step: allowInputOnlyApproval ? 'ダッシュボードで手動送信完了を確認' : 'ダッシュボードで承認済み',
            latestScreenshot: approvalScreenshot,
          });
        } else if (normalizedDecision === 'skip') {
          const reason = feedback ? 'Skip reason: ' + feedback : 'Skipped from dashboard';
          const approvalScreenshot = approvalArtifacts
            ? (approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
            : null;
          logAction(companyNoNum, companyName, 'skipped', buildApprovalLogDetails({
            companyNo: companyNoNum,
            source: 'dashboard-approve',
            action: 'skipped',
            mode: 'manual',
            screenshot: approvalScreenshot,
            success: true,
            verified: true,
            detail: 'ダッシュボードでスキップ',
            reason,
            approvalRequired: true,
          }));
          if (feedback) {
            ensureDataDir();
            const fbFile = resolveDataPath('skip-feedback.json');
            ensureParentDir(fbFile);
            let fbData = [];
            try { fbData = JSON.parse(fs.readFileSync(fbFile, 'utf-8')); } catch {}
            fbData.push({ date: new Date().toISOString(), companyNo: companyNoNum, companyName, feedback });
            fs.writeFileSync(fbFile, JSON.stringify(fbData, null, 2), 'utf-8');
          }
          finishLiveMonitor(companyNoNum, {
            companyNo: companyNoNum,
            companyName,
            status: 'skipped',
            step: 'ダッシュボードでスキップ',
            latestScreenshot: approvalScreenshot,
          });
        } else {
          appendDiagnosticEvent('approve_invalid_decision', {
            companyNo: companyNoNum,
            companyName,
            decision: normalizedDecision,
          });
          console.warn(`[approve] invalid decision: companyNo=${companyNoNum} decision=${normalizedDecision}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: i18nT(lang, 'audit.invalidDecision') || 'decision must be "sent" or "skip"' }));
          return;
        }
        notifyClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        appendDiagnosticEvent('approve_internal_error', {
          error: e.message,
        });
        console.error(`[approve] internal error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AI Submit disabled — direct JS submission removed
  if (req.url === '/api/ai-submit' && req.method === 'POST') {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission has been removed. Submit manually from the preserved browser tab.',
    });
    return;
  }

  // AI Submit status disabled — direct JS submission removed
  if (req.url === '/api/ai-submit-status') {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission status has been removed.',
    });
    return;
  }

  // CLI log post
  if (req.url === '/api/cli-log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { message, type } = JSON.parse(body);
        sseClients.forEach(r => {
          r.write(`data: ${JSON.stringify({ type: 'cli-log', message, logType: type || 'info', time: new Date().toISOString() })}\n\n`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/ai/status — check managed PTY first, then system-wide
  if ((pathname === '/api/claude-status' || pathname === '/api/ai/status') && req.method === 'GET') {
    try {
      const requestedProvider = requestUrl.searchParams.get('provider') || getSelectedAiProvider();
      const status = await probeClaudeStatus(requestedProvider);
      jsonResponse(res, 200, status);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/install-ai-cli — attempt automatic global install
  if ((pathname === '/api/install-claude-cli' || pathname === '/api/install-ai-cli') && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const provider = getProvider(providerId);
      const installSpec = getInstallSpawnArgs(providerId);
      setProviderInstallState(providerId, 'installing', null);
      invalidateAiStatusCache(providerId);
      _aiExecutablePath[providerId] = null;

      const { spawn } = require('child_process');
      const child = spawn(installSpec.command, installSpec.args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      child.stdout && child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr && child.stderr.on('data', (data) => { stderr += data.toString(); });

      const result = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve({ code }));
      });

      if (result.code !== 0) {
        const installError = (stderr || stdout || `npm exited with code ${result.code}`).trim();
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          code: result.code,
          command: getInstallCommand(providerId),
        });
        return;
      }

      invalidateAiStatusCache(providerId);
      const status = await probeClaudeStatus(providerId);
      if (!status.installed) {
        const installError = `${provider.cliLabel} was not detected after installation.`;
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          command: getInstallCommand(providerId),
        });
        return;
      }

      setProviderInstallState(providerId, 'idle', null);
      jsonResponse(res, 200, {
        ok: true,
        provider: providerId,
        providerLabel: provider.displayName,
        installed: status.installed,
        version: status.version,
        command: getInstallCommand(providerId),
      });
    } catch (e) {
      const providerId = getSelectedAiProvider();
      setProviderInstallState(providerId, 'failed', e.message);
      jsonResponse(res, 500, { ok: false, provider: providerId, error: e.message, command: getInstallCommand(providerId) });
    }
    return;
  }

  // POST /api/launch-ai — spawn selected provider in a real PTY via node-pty
  if ((pathname === '/api/launch-claude' || pathname === '/api/launch-ai') && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const { mode = 'default', cols = 120, rows = 30 } = body;
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const provider = getProvider(providerId);

      // Stop existing PTY if any
      if (claudePty) {
        await stopManagedClaudePty();
        claudePty = null;
      }

      if (providerId === 'codex') {
        ensureCodexWorkspaceTrusted(PROJECT_ROOT);
      }
      const playwrightSetup = await ensureProviderPlaywrightMcp(providerId);
      if (!playwrightSetup.ok) {
        throw new Error(playwrightSetup.error);
      }

      const nodePty = require('node-pty');
      const executable = await resolveClaudeExecutable(providerId);
      const flags = buildLaunchArgs(providerId, mode, {
        model: getConfiguredAiModel(providerId),
        sessionId: providerId === 'claude' ? crypto.randomUUID() : null,
      });
      const spawnSpec = buildManagedSpawnSpec(providerId, executable, flags);
      const ptyProc = nodePty.spawn(spawnSpec.command, spawnSpec.args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd: PROJECT_ROOT,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });

      claudePty = ptyProc;
      claudeProcessMode = mode;
      activeAiProvider = providerId;
      invalidateAiStatusCache(providerId);

      ptyProc.onData((data) => {
        broadcastPty({ type: 'output', data, provider: providerId });
      });

      ptyProc.onExit(({ exitCode }) => {
        if (claudePty === ptyProc) {
          claudePty = null;
          invalidateAiStatusCache(providerId);
        }
        broadcastPty({ type: 'exit', code: exitCode, provider: providerId });
        notifyClients({ type: 'claude-exit', code: exitCode, provider: providerId, time: Date.now() });
      });

      jsonResponse(res, 200, { ok: true, mode, provider: providerId, providerLabel: provider.displayName });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/launch-ai-external — open selected provider in an interactive external terminal
  if ((pathname === '/api/launch-claude-external' || pathname === '/api/launch-ai-external') && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const { mode = 'default' } = body;
      if (providerId === 'codex') {
        ensureCodexWorkspaceTrusted(PROJECT_ROOT);
      }
      const playwrightSetup = await ensureProviderPlaywrightMcp(providerId);
      if (!playwrightSetup.ok) {
        throw new Error(playwrightSetup.error);
      }
      const result = await launchClaudeInExternalTerminal(mode, providerId);
      invalidateAiStatusCache(providerId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/ai-form-fill — queue work into the selected AI automation runtime
  if (req.url === '/api/ai-form-fill' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      const providerId = normalizeProviderId(data && data.provider ? data.provider : getSelectedAiProvider());
      if (companyNos.length === 0) {
        appendDiagnosticEvent('ai_form_fill_invalid_request', { companyNos, provider: providerId });
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }
      const found = findCompaniesByNos(companyNos);
      if (!found.ok) {
        appendDiagnosticEvent('ai_form_fill_target_lookup_failed', {
          companyNos,
          provider: providerId,
          error: found.error || 'Target companies not found.',
        });
        jsonResponse(res, 400, { ok: false, error: found.error || 'Target companies not found.' });
        return;
      }

      const ready = await ensureClaudeAutomationReady(providerId);
      if (!ready.ok) {
        appendDiagnosticEvent('ai_form_fill_not_ready', {
          companyNos,
          provider: ready.providerId || providerId,
          error: ready.error || 'AI automation is not ready.',
          statusCode: ready.statusCode || 409,
        });
        jsonResponse(res, ready.statusCode || 409, { ok: false, error: ready.error });
        return;
      }

      const result = await queueAiFormFill(found.companies, providerId);
      jsonResponse(res, 200, result);
    } catch (e) {
      appendDiagnosticEvent('ai_form_fill_internal_error', { error: e.message });
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/stop-ai — stop active AI runtime
  if ((pathname === '/api/stop-claude' || pathname === '/api/stop-ai') && req.method === 'POST') {
    const providerId = headlessAiRun ? headlessAiRun.provider : getSelectedAiProvider();
    const provider = getProvider(providerId);
    const stopped = getActiveHeadlessRun(providerId)
      ? await stopHeadlessAiRun(providerId)
      : await stopManagedClaudePty();
    if (!stopped.ok) {
      jsonResponse(res, 500, stopped);
      return;
    }
    if (claudeProcess && !claudeProcess.killed) {
      try { claudeProcess.kill(); } catch (_) {}
      claudeProcess = null;
    }
    invalidateAiStatusCache(providerId);
    jsonResponse(res, 200, { ...stopped, provider: providerId, providerLabel: provider.displayName });
    return;
  }

  // POST /api/ai-input — send text to managed AI PTY (fallback for non-WS clients)
  if ((pathname === '/api/claude-input' || pathname === '/api/ai-input') && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const { text } = body;
      if (claudePty) {
        claudePty.write(text || '');
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 409, { ok: false, error: `${getProviderDisplayName(getSelectedAiProvider())} is not running (managed mode)` });
      }
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/install-update — write flag file for electron-main to call quitAndInstall
  if (req.url === '/api/install-update' && req.method === 'POST') {
    try {
      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 409, {
          ok: false,
          error: APP_BUILD_SOURCE === 'development'
            ? 'Development build does not support auto-install updates.'
            : 'Auto-update is not available in this runtime.',
          buildSource: APP_BUILD_SOURCE,
          appVersion: APP_VERSION,
        });
        return;
      }
      ensureDataDir();
      const flagFile = resolveDataPath('install-update.flag');
      ensureParentDir(flagFile);
      fs.writeFileSync(flagFile, Date.now().toString());
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // GET /api/update-status — read update status written by electron-main.js
  if (req.url === '/api/update-status' && req.method === 'GET') {
    try {
      if (APP_BUILD_SOURCE === 'dashboard-only') {
        jsonResponse(res, 200, {
          ok: true,
          state: 'dashboard-only',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 200, {
          ok: true,
          state: APP_BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      const statusFile = resolveDataPath('update-status.json');
      if (fs.existsSync(statusFile)) {
        const raw = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        jsonResponse(res, 200, { ok: true, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED, ...raw, appVersion: APP_VERSION });
      } else {
        jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
      }
    } catch (e) {
      jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
    }
    return;
  }

  // Excel export
  if (req.url === '/api/export') {
    try {
      const data = loadData();
      const prefs = settings.getSection('preferences');
      const prefix = prefs.exportFilenamePrefix || 'outreach_progress';
      const wb = XLSX.utils.book_new();
      const rows = [['No.', 'Status', 'Company', 'Type', 'Progress', 'Form URL', 'CAPTCHA', 'Last Action', 'Last Action Time', 'Details']];
      data.companies.forEach(c => {
        rows.push([
          c.no, c.status, c.name, c.type,
          c.lastAction || c.progress || 'Pending',
          c.formUrl, c.captcha,
          c.lastLog ? c.lastLog.action : '',
          c.lastLog ? new Date(c.lastLog.timestamp).toLocaleString('ja-JP') : '',
          c.lastErrorDetail || (c.logs.length > 0 ? c.logs.map(l => `${l.action}: ${typeof l.details === 'object' ? JSON.stringify(l.details) : l.details}`).join(' | ') : ''),
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 5 }, { wch: 8 }, { wch: 25 }, { wch: 25 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 15 }, { wch: 18 }, { wch: 50 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Progress');

      const logRows = [['Time', 'No.', 'Company', 'Action', 'Details']];
      data.recentLogs.forEach(l => {
        logRows.push([new Date(l.timestamp).toLocaleString('ja-JP'), l.companyNo, l.companyName, l.action, typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '']);
      });
      const ws2 = XLSX.utils.aoa_to_sheet(logRows);
      ws2['!cols'] = [{ wch: 20 }, { wch: 5 }, { wch: 25 }, { wch: 15 }, { wch: 60 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Action Log');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${prefix}_${new Date().toISOString().slice(0,10)}.xlsx"`,
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Export error: ' + e.message);
    }
    return;
  }

  if (req.url === '/api/data') {
    try {
      jsonResponse(res, 200, loadData());
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // Dashboard HTML
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': buildDashboardSessionCookie(),
  });
  res.end(buildPage());
});

async function startDashboardServer() {
  if (dashboardRuntime && server.listening) return dashboardRuntime;
  if (serverStartPromise) return serverStartPromise;

  serverStartPromise = (async () => {
    const preferredPort = settings.getPort();
    const bindHost = settings.getHost();
    const listenPort = await findAvailablePort(preferredPort, bindHost);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    dashboardRuntime = writeRuntime({
      bindHost,
      host: bindHost,
      port: typeof address === 'object' && address ? address.port : preferredPort,
      preferredPort,
    });

    refreshWatchTargets();
    startHeartbeat();

    const _sl = settings.getSection('preferences').language || 'ja';
    console.log(`\n===================================`);
    console.log(`  ${i18nT(_sl, 'startup.title')}`);
    console.log(`  ${dashboardRuntime.url}`);
    console.log(`===================================\n`);
    console.log(`\n${i18nT(_sl, 'startup.noPolling')}`);
    console.log(`${i18nT(_sl, 'startup.stop')}\n`);

    return dashboardRuntime;
  })().catch((error) => {
    serverStartPromise = null;
    throw error;
  });

  return serverStartPromise;
}

// WebSocket upgrade for PTY terminal
server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/terminal') {
    const auth = isAuthorizedDashboardRequest(request);
    if (!auth.ok) {
      rejectUpgradeRequest(socket, auth.statusCode, auth.error);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.on('close', () => {
  closeWatchers();
  clearRuntime();
  releaseStandaloneDashboardLock();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  dashboardRuntime = null;
  serverStartPromise = null;
});

if (require.main === module) {
  process.on('exit', releaseStandaloneDashboardLock);
  process.on('SIGINT', () => {
    releaseStandaloneDashboardLock();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    releaseStandaloneDashboardLock();
    process.exit(0);
  });

  (async () => {
    const lock = await claimStandaloneDashboardLock();
    if (!lock.ok) {
      const runtimeUrl = lock.runtime && lock.runtime.url ? lock.runtime.url : 'http://127.0.0.1';
      console.log(`[Dashboard] 既存の dashboard-server が起動中です: ${runtimeUrl}`);
      return;
    }
    await startDashboardServer();
  })().catch((error) => {
    console.error('[Dashboard] 起動失敗:', error.message);
    releaseStandaloneDashboardLock();
    process.exitCode = 1;
  });
}

module.exports = {
  loadData,
  server,
  startDashboardServer,
};
