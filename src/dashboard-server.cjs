// Sales Claw Dashboard Server
// fs.watch でファイル変更をイベント検知 → SSE → フロントで差分DOM更新

let _formSessionManager = null; // injected by electron-main via startDashboardServer({ formSessionManager })

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const XLSX = require('xlsx');
const { getAllLogs, logAction, removeCompanyLogs } = require('./action-logger.cjs');
const { getAllHistorySummary, getHistory, recordContact, removeHistory } = require('./contact-history.cjs');
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
const { appendCompany, deleteCompany, findCompaniesByNos, getTargetPreview, importTargetList, readTargetList, repairImportedTargetListIfNeeded, updateCompany } = require('./target-list.cjs');
const { getTargetMap, setTargets } = require('./outreach-targets.cjs');
const { finishLiveMonitor, getLiveMonitorFile, getLiveMonitorSummary, readMonitorState, removeCompanyMonitor, updateLiveMonitor } = require('./live-monitor.cjs');
const { buildWorkbookBuffer: buildSettingsWorkbookBuffer, parseWorkbookBuffer: parseSettingsWorkbookBuffer } = require('./settings-excel.cjs');
const {
  buildLaunchArgs,
  buildHeadlessArgs,
  buildManagedSpawnSpec,
  getAuthFiles,
  getExecutableFallbackCandidates,
  getInstallCommand,
  getInstallSpawnArgs,
  getProvider,
  hasAnyAuthFile,
  listProviders,
  normalizeProviderId,
} = require('./ai-providers.cjs');
const { detectStalledCompanies, formatStallReason } = require('./batch-watchdog.cjs');
const { saveRecoverySnapshot, loadRecoverySnapshot, clearRecoverySnapshot } = require('./recovery-store.cjs');
// AI runtime 分離モジュール (Phase 3 の分割先)
const batchUtils = require('./ai-runtime/batch-utils.cjs');
const ptyLog = require('./ai-runtime/pty-log.cjs');
// UI テンプレート分離 (Phase 1)
const renderStyles = require('./ui/styles.cjs');
const renderDashboardScript = require('./ui/client-scripts/dashboard.cjs');
const renderAnalyticsScript = require('./ui/client-scripts/dashboard-analytics.cjs');
const renderColumnResizerScript = require('./ui/client-scripts/column-resizer.cjs');
const renderAwaitingCardRedesignScript = require('./ui/client-scripts/awaiting-card-redesign.cjs');

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
const CLI_LOG_SECRET = require('crypto').randomBytes(24).toString('hex');
let dashboardDataCacheKey = null;
let dashboardDataCacheValue = null;
let dashboardDataCacheBuiltAt = 0;
let standaloneDashboardLockHeld = false;
let standaloneDashboardLockHooksInstalled = false;

// Managed AI PTY process
let claudePty = null;
let claudeProcessMode = 'default';
let claudeProcess = null;
let headlessAiRun = null;
let activeAiProvider = normalizeProviderId(typeof settings.getAiProvider === 'function' ? settings.getAiProvider() : 'claude');
let managedAiAutoSendSafe = !!(typeof settings.getAutoSendEligibleForms === 'function' ? settings.getAutoSendEligibleForms() : false);
const aiInstallState = Object.fromEntries(listProviders().map((provider) => [provider.id, 'idle']));
const aiInstallError = Object.fromEntries(listProviders().map((provider) => [provider.id, null]));
let managedAiSessionState = null;
let managedAiBatchController = null;
let managedAiRecoveryState = null;
let managedAiRecoveryTimer = null;
let managedAiSuppressAutoRecovery = false;

const MANAGED_AI_FORM_BATCH_SIZE = 3;
const MANAGED_AI_BATCH_POLL_MS = 5000;
const MANAGED_AI_BATCH_STALL_MS = 5 * 60 * 1000;
const MANAGED_AI_PTY_LOG_MAX_BYTES = 1024 * 1024;
const MANAGED_AI_RECOVERY_RETRY_MS = 15000;
const MANAGED_AI_RECOVERY_MAX_RETRIES = 20;

const MANAGED_AI_READY_DELAY_MS = {
  claude: 1500,
  codex: 12000,
  gemini: 25000,
};

const MANAGED_AI_MIN_READY_AGE_MS = {
  claude: 0,
  codex: 24000,
  gemini: 25000,
};

const MANAGED_AI_ENTER_DELAY_MS = {
  claude: 250,
  codex: 900,
  gemini: 1000,
};

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
    autoSendSafe: getManagedAiAutoSendSafe(),
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

function ensureStandaloneDashboardLockHooks() {
  if (standaloneDashboardLockHooksInstalled) return;
  standaloneDashboardLockHooksInstalled = true;
  process.on('exit', releaseStandaloneDashboardLock);
  process.on('SIGINT', () => {
    releaseStandaloneDashboardLock();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    releaseStandaloneDashboardLock();
    process.exit(0);
  });
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

function getConfiguredAiAutoSendSafe() {
  try {
    return !!(typeof settings.getAutoSendEligibleForms === 'function' ? settings.getAutoSendEligibleForms() : false);
  } catch (_) {
    return false;
  }
}

function getManagedAiAutoSendSafe() {
  return !!managedAiAutoSendSafe;
}

function getAutoSendPolicyLabel(autoSendSafe, lang = 'ja') {
  if (autoSendSafe) {
    return lang === 'ja' ? '安全なフォームは自動送信' : 'Auto-send safe forms';
  }
  return lang === 'ja' ? '確認待ちで停止' : 'Stop for approval';
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
      auto: isJa ? 'no-prompt auto' : 'No-prompt auto',
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
      ? 'no-prompt auto（auto）または danger bypass（bypassPermissions）'
      : 'no-prompt auto (auto) or danger bypass (bypassPermissions)';
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

function getProviderApprovalCaveat(providerId, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  const isJa = lang === 'ja';
  if (provider === 'codex') {
    return {
      tone: 'warn',
      message: isJa
        ? "Codex は bypassPermissions でも起動フラグ自体は正しく付きますが、Playwright MCP の操作種別ごとに Codex 本体の許可ダイアログが一度だけ出る場合があります。これは Sales Claw 側の起動ミスではなく Codex 側の権限ルールです。表示されたら「Yes, and don't ask again」を選ぶと次回から抑制できます。"
        : 'Codex still receives the bypass flags correctly, but Codex itself may show a one-time permission dialog for Playwright MCP action types. This is a Codex-side permission rule, not a Sales Claw launch failure. Choose "Yes, and don\'t ask again" to suppress it next time.',
    };
  }
  if (provider === 'gemini') {
    return {
      tone: 'warn',
      message: isJa
        ? 'Gemini は yolo でも browser / MCP 系の確認が残る場合があります。Sales Claw 側では最強の approval-mode を渡していますが、Gemini 側の安全確認は完全には消せないことがあります。'
        : 'Gemini may still pause for browser / MCP confirmations even in yolo mode. Sales Claw passes the strongest approval mode available, but Gemini can still keep its own safety checks.',
    };
  }
  return {
    tone: 'ok',
    message: isJa
      ? 'Claude の bypassPermissions は通常、CLI 側の権限確認を大きく減らします。残る場合はログインや初期セットアップ由来の停止を疑ってください。'
      : 'Claude bypassPermissions usually removes most CLI-side permission prompts. If it still pauses, it is more likely a login or bootstrap issue.',
  };
}

function getProviderLaunchExamples(providerId) {
  return {
    auto: buildLaunchArgs(providerId, 'auto', {}).join(' '),
    bypassPermissions: buildLaunchArgs(providerId, 'bypassPermissions', {}).join(' '),
    default: buildLaunchArgs(providerId, 'default', {}).join(' '),
  };
}

function getManagedAiReadyDelay(providerId) {
  return MANAGED_AI_READY_DELAY_MS[normalizeProviderId(providerId)] || 2500;
}

function getManagedAiEnterDelay(providerId) {
  return MANAGED_AI_ENTER_DELAY_MS[normalizeProviderId(providerId)] || 300;
}

function getManagedAiMinReadyAge(providerId) {
  return MANAGED_AI_MIN_READY_AGE_MS[normalizeProviderId(providerId)] || 0;
}

function getManagedAiSubmitSequence(providerId) {
  switch (normalizeProviderId(providerId)) {
    case 'codex':
      return ['\t', '\r'];
    default:
      return ['\r'];
  }
}

// stripAnsiCodes は ./ai-runtime/batch-utils.cjs に分離済み。既存呼び出しのため wrap を残す
function stripAnsiCodes(value) {
  return batchUtils.stripAnsiCodes(value);
}

function clearManagedAiSessionStateTimers(state = managedAiSessionState) {
  if (!state) return;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
    state.readyTimer = null;
  }
  if (state.enterTimer) {
    clearTimeout(state.enterTimer);
    state.enterTimer = null;
  }
}

function clearManagedAiBatchControllerTimer(controller = managedAiBatchController) {
  if (!controller || !controller.pollTimer) return;
  clearInterval(controller.pollTimer);
  controller.pollTimer = null;
}

function clearManagedAiRecoveryTimer() {
  if (!managedAiRecoveryTimer) return;
  clearTimeout(managedAiRecoveryTimer);
  managedAiRecoveryTimer = null;
}

function resetManagedAiBatchController() {
  clearManagedAiBatchControllerTimer();
  managedAiBatchController = null;
}

function createManagedAiBatchController(providerId, autoSendSafe) {
  // 実体は ./ai-runtime/batch-utils.cjs。providerId 正規化だけ wrap。
  return batchUtils.createManagedAiBatchController(normalizeProviderId(providerId), autoSendSafe);
}

function ensureManagedAiBatchController(providerId, autoSendSafe) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!managedAiBatchController) {
    managedAiBatchController = createManagedAiBatchController(normalizedProviderId, autoSendSafe);
    return managedAiBatchController;
  }
  if (managedAiBatchController.providerId !== normalizedProviderId) {
    throw new Error(`現在の managed batch controller は ${getProviderDisplayName(managedAiBatchController.providerId)} 用です。${getProviderDisplayName(normalizedProviderId)} に切り替える前に現在のバッチを完了または停止してください。`);
  }
  managedAiBatchController.autoSendSafe = !!autoSendSafe;
  return managedAiBatchController;
}

function snapshotManagedAiBatchesForRecovery() {
  const controller = managedAiBatchController;
  if (!controller) return null;
  const snapshot = {
    providerId: controller.providerId,
    autoSendSafe: !!controller.autoSendSafe,
    mode: claudeProcessMode || getProvider(controller.providerId).defaultMode || 'auto',
    batches: [],
  };
  if (controller.activeBatch && Array.isArray(controller.activeBatch.companies) && controller.activeBatch.companies.length > 0) {
    const progress = getManagedAiBatchProgressSnapshot(controller.activeBatch.companyNos || []);
    const terminalNos = new Set((progress.statuses || [])
      .filter((status) => status && status.terminal)
      .map((status) => Number(status.companyNo)));
    const remainingCompanies = controller.activeBatch.companies
      .filter((company) => !terminalNos.has(Number(company.no)));
    if (remainingCompanies.length > 0) {
      snapshot.batches.push({
        id: controller.activeBatch.id,
        companies: remainingCompanies,
        options: { ...(controller.activeBatch.options || {}) },
      });
    }
  }
  (controller.pending || []).forEach((batch) => {
    if (!batch || !Array.isArray(batch.companies) || batch.companies.length === 0) return;
    snapshot.batches.push({
      id: batch.id,
      companies: batch.companies.slice(),
      options: { ...(batch.options || {}) },
    });
  });
  if (snapshot.batches.length > 0) {
    try { saveRecoverySnapshot(snapshot); } catch (_) {}
    return snapshot;
  }
  return null;
}

function restoreManagedAiBatchesFromRecovery(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.batches) || snapshot.batches.length === 0) return null;
  const controller = ensureManagedAiBatchController(snapshot.providerId, snapshot.autoSendSafe);
  controller.pending = snapshot.batches.map((batch) => ({
    id: batch.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    companies: Array.isArray(batch.companies) ? batch.companies.slice() : [],
    options: { ...(batch.options || {}) },
  })).filter((batch) => batch.companies.length > 0);
  controller.activeBatch = null;
  controller.batchCounter = Math.max(controller.batchCounter || 0, controller.pending.length);
  startManagedAiBatchPoller();
  if (!controller.activeBatch && controller.pending.length > 0) {
    setTimeout(() => {
      dispatchNextManagedAiFormFillBatch();
    }, 350);
  }
  try { clearRecoverySnapshot(); } catch (_) {}
  return controller;
}

// chunkManagedAiCompanies / buildManagedAiBatchOptionsSubset / parseEventTimestampMs は
// ./ai-runtime/batch-utils.cjs に分離済み (batchUtils.* として参照)
// getManagedAiPtyLogFile / appendManagedAiPtyLog は ./ai-runtime/pty-log.cjs に分離済み
function chunkManagedAiCompanies(companies, chunkSize = MANAGED_AI_FORM_BATCH_SIZE) {
  return batchUtils.chunkManagedAiCompanies(companies, chunkSize);
}
function buildManagedAiBatchOptionsSubset(baseOptions, companies) {
  return batchUtils.buildManagedAiBatchOptionsSubset(baseOptions, companies);
}
function parseEventTimestampMs(value) {
  return batchUtils.parseEventTimestampMs(value);
}
function getManagedAiPtyLogFile(providerId = getManagedAiProvider()) {
  return ptyLog.getManagedAiPtyLogFile(normalizeProviderId(providerId));
}
function appendManagedAiPtyLog(providerId, chunk, kind = 'output') {
  ptyLog.appendManagedAiPtyLog(providerId, chunk, kind, { maxBytes: MANAGED_AI_PTY_LOG_MAX_BYTES });
}

function getManagedAiBatchProgressSnapshot(companyNos = []) {
  const keySet = new Set((companyNos || []).map((value) => String(value)));
  const latestLogByCompany = new Map();
  const latestMonitorByCompany = new Map();
  const logs = getAllLogs();
  logs.forEach((entry) => {
    const key = String(entry.companyNo || entry.no || '');
    if (!keySet.has(key)) return;
    latestLogByCompany.set(key, entry);
  });
  const monitorState = readMonitorState();
  const monitorEvents = monitorState && Array.isArray(monitorState.events) ? monitorState.events : [];
  monitorEvents.forEach((entry) => {
    const key = String(entry.companyNo || '');
    if (!keySet.has(key)) return;
    latestMonitorByCompany.set(key, entry);
  });

  const terminalStates = new Set(['awaiting_approval', 'submitted', 'completed', 'skipped', 'error']);
  let terminalCount = 0;
  let latestActivityAt = 0;
  const statuses = [];

  keySet.forEach((key) => {
    const latestLog = latestLogByCompany.get(key) || null;
    const latestMonitor = latestMonitorByCompany.get(key) || null;
    const action = latestLog && latestLog.action ? String(latestLog.action) : '';
    const monitorStatus = latestMonitor && latestMonitor.status ? String(latestMonitor.status) : '';
    const terminal = terminalStates.has(action) || terminalStates.has(monitorStatus);
    if (terminal) terminalCount += 1;
    latestActivityAt = Math.max(
      latestActivityAt,
      parseEventTimestampMs(latestLog && (latestLog.timestamp || latestLog.date || latestLog.time)),
      parseEventTimestampMs(latestMonitor && (latestMonitor.updatedAt || latestMonitor.timestamp || latestMonitor.time)),
    );
    // latestTimestamp: watchdog の per-company 判定に使う。
    // action-log の timestamp を優先し、無ければ monitor の updatedAt をフォールバック
    const latestTimestamp = (latestLog && (latestLog.timestamp || latestLog.date || latestLog.time))
      || (latestMonitor && (latestMonitor.updatedAt || latestMonitor.timestamp || latestMonitor.time))
      || null;
    statuses.push({
      companyNo: Number(key),
      action,
      monitorStatus,
      terminal,
      latestTimestamp,
    });
  });

  return {
    terminalCount,
    totalCount: keySet.size,
    latestActivityAt,
    statuses,
  };
}

function getManagedAiReservedCompanyNos() {
  const reserved = new Set();
  const controller = managedAiBatchController;
  if (!controller) return reserved;
  if (controller.activeBatch && Array.isArray(controller.activeBatch.companyNos)) {
    controller.activeBatch.companyNos.forEach((companyNo) => {
      if (companyNo !== undefined && companyNo !== null) reserved.add(Number(companyNo));
    });
  }
  (controller.pending || []).forEach((batch) => {
    (batch && batch.companies || []).forEach((company) => {
      if (company && company.no !== undefined && company.no !== null) reserved.add(Number(company.no));
    });
  });
  return reserved;
}

function isAiRuntimeActivelyProcessing() {
  if (getActiveHeadlessRun()) return true;
  if (claudePty) return true;
  const controller = managedAiBatchController;
  return !!(controller && (controller.activeBatch || (controller.pending && controller.pending.length > 0)));
}

function touchManagedAiBatchActivity(reason = 'unknown') {
  const controller = managedAiBatchController;
  if (!controller || !controller.activeBatch) return;
  controller.activeBatch.lastProgressAt = Date.now();
  controller.activeBatch.lastProgressReason = reason;
}

function cleanupStaleManagedAiMonitorEvents(maxAgeMs = MANAGED_AI_BATCH_STALL_MS) {
  if (claudePty || getActiveHeadlessRun()) return 0;
  const summary = getLiveMonitorSummary();
  const terminalStates = new Set(['awaiting_approval', 'submitted', 'completed', 'skipped', 'error']);
  const now = Date.now();
  let cleaned = 0;
  (summary.events || []).forEach((event) => {
    if (!event || event.active === false) return;
    if (terminalStates.has(String(event.status || ''))) return;
    const updatedAtMs = parseEventTimestampMs(event.updatedAt || event.timestamp || event.time);
    if (!updatedAtMs || (now - updatedAtMs) < maxAgeMs) return;
    finishLiveMonitor(event.companyNo, {
      companyNo: event.companyNo,
      companyName: event.companyName || '',
      status: 'error',
      step: `前回セッションが停止したため自動終了 (${Math.round((now - updatedAtMs) / 60000)}分更新なし)`,
      latestScreenshot: event.latestScreenshot || null,
    });
    cleaned += 1;
  });
  if (cleaned > 0) {
    appendDiagnosticEvent('stale_managed_ai_sessions_cleaned', {
      cleanedCount: cleaned,
      maxAgeMs,
    });
  }
  return cleaned;
}

function createManagedAiSessionState(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  return {
    providerId: normalizedProviderId,
    launchedAt: Date.now(),
    recentOutput: '',
    ready: false,
    readyAt: 0,
    readyReason: null,
    queue: [],
    dispatching: false,
    readyTimer: null,
    enterTimer: null,
    contractVersionSent: 0,
    authFingerprint: getProviderAuthFingerprint(normalizedProviderId),
  };
}

function getProviderAuthFingerprint(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const authFiles = Array.from(new Set([
    ...(getAuthFiles(normalizedProviderId) || []),
    normalizedProviderId === 'claude' ? path.join(os.homedir(), '.claude.json') : null,
  ].filter(Boolean)));
  return authFiles.map((filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return `${String(filePath || '').toLowerCase()}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch (_) {
      return `${String(filePath || '').toLowerCase()}:missing`;
    }
  }).join('|');
}

function isManagedAiAuthFingerprintStale(providerId = getManagedAiProvider()) {
  const state = managedAiSessionState;
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!state || state.providerId !== normalizedProviderId) return false;
  return String(state.authFingerprint || '') !== String(getProviderAuthFingerprint(normalizedProviderId) || '');
}

function hasManagedAiStartupBlocker(providerId, outputText) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const tail = String(outputText || '').slice(-6000);
  const hasVisiblePrompt = hasManagedAiReadyMarker(normalizedProviderId, tail);
  if (/Do you trust the following folders/i.test(tail)) return true;
  if (/Action Required/i.test(tail) && !hasVisiblePrompt) return true;
  if (normalizedProviderId === 'codex'
    && /Starting MCP servers/i.test(tail)
    && !/MCP startup incomplete/i.test(tail)
    && !hasVisiblePrompt) {
    return true;
  }
  if (normalizedProviderId === 'gemini'
    && /Applying trust settings/i.test(tail)
    && !hasVisiblePrompt) {
    return true;
  }
  return false;
}

function scheduleManagedAiReadyTimer(providerId, delayMs = getManagedAiReadyDelay(providerId)) {
  const state = managedAiSessionState;
  if (!state) return;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
  }
  state.readyTimer = setTimeout(() => {
    const currentState = managedAiSessionState;
    if (!currentState || currentState !== state) return;
    const stateAge = Date.now() - currentState.launchedAt;
    const minReadyAge = getManagedAiMinReadyAge(providerId);
    if (stateAge < minReadyAge) {
      scheduleManagedAiReadyTimer(providerId, Math.max(1000, minReadyAge - stateAge));
      return;
    }
    if (hasManagedAiReadyMarker(providerId, currentState.recentOutput)) {
      markManagedAiSessionReady('startup-timer-prompt-visible');
      return;
    }
    if (hasManagedAiStartupBlocker(providerId, currentState.recentOutput)) {
      scheduleManagedAiReadyTimer(providerId, 3000);
      return;
    }
    markManagedAiSessionReady('startup-delay');
  }, delayMs);
  if (typeof state.readyTimer.unref === 'function') {
    state.readyTimer.unref();
  }
}

function resetManagedAiSessionState(providerId) {
  clearManagedAiSessionStateTimers();
  managedAiSessionState = createManagedAiSessionState(providerId);
  scheduleManagedAiReadyTimer(providerId);
  appendDiagnosticEvent('managed_ai_state_reset', {
    provider: normalizeProviderId(providerId),
    readyDelayMs: getManagedAiReadyDelay(providerId),
    minReadyAgeMs: getManagedAiMinReadyAge(providerId),
  });
  return managedAiSessionState;
}

function getManagedAiSessionState() {
  if (!managedAiSessionState || managedAiSessionState.providerId !== getManagedAiProvider()) {
    managedAiSessionState = createManagedAiSessionState(getManagedAiProvider());
  }
  return managedAiSessionState;
}

function getManagedAiReadyMarkers(providerId) {
  switch (normalizeProviderId(providerId)) {
    case 'codex':
      return [
        /›\s+/,
        /Type instructions and press Enter/i,
        /Write tests for @filename/i,
        /Explain this codebase/i,
        /Implement \{feature\}/i,
        /gpt-5\.[0-9]/i,
      ];
    case 'gemini':
      return [
        /Type your message or @path\/to\/file/i,
        /Type your message/i,
      ];
    case 'claude':
    default:
      return [
        /\? for shortcuts/i,
        />\s*$/m,
      ];
  }
}

function hasManagedAiReadyMarker(providerId, outputText) {
  const markers = getManagedAiReadyMarkers(providerId);
  return markers.some((pattern) => pattern.test(String(outputText || '')));
}

function markManagedAiSessionReady(reason = 'unknown') {
  const state = managedAiSessionState;
  if (!state || state.ready) return;
  state.ready = true;
  state.readyAt = Date.now();
  state.readyReason = reason;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
    state.readyTimer = null;
  }
  appendDiagnosticEvent('managed_ai_ready', {
    provider: state.providerId,
    reason,
    ageMs: state.readyAt - state.launchedAt,
    queueLength: state.queue.length,
  });
  flushManagedAiPromptQueue();
}

function updateManagedAiReadyFromOutput(providerId, chunk) {
  const state = managedAiSessionState;
  if (!state || state.providerId !== normalizeProviderId(providerId)) return;
  const normalized = stripAnsiCodes(`${state.recentOutput}${String(chunk || '')}`);
  state.recentOutput = normalized.slice(-16000);
  if (state.ready) return;
  if ((Date.now() - state.launchedAt) < getManagedAiMinReadyAge(providerId)) return;
  if (hasManagedAiReadyMarker(providerId, state.recentOutput)) {
    markManagedAiSessionReady('cli-prompt-visible');
    return;
  }
  if (hasManagedAiStartupBlocker(providerId, state.recentOutput)) return;
}

// CLI出力からエラー・承認要求・トークン制限等を検知して進行状況ログに転送
let _lastCliIssueTime = 0;
const CLI_ISSUE_PATTERNS = [
  // エラー系（行頭 or 明確なエラー形式のみ）
  { pattern: /^Error:|^TypeError:|^ReferenceError:|^SyntaxError:/m, type: 'error', label: 'CLIエラー' },
  { pattern: /\bfatal\b[:\s]/i, type: 'error', label: '致命的エラー' },
  { pattern: /\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bEPIPE\b/i, type: 'error', label: '接続エラー' },
  // トークン・レート制限
  { pattern: /rate.?limit|too many requests|\b429\b/i, type: 'warn', label: 'レート制限' },
  { pattern: /token.?limit|context.?limit|context.?window\b/i, type: 'warn', label: 'トークン制限' },
  { pattern: /\bquota\b.*\bexceeded\b|\bbilling\b.*\berror\b/i, type: 'warn', label: 'クォータ超過' },
  { pattern: /API.?key.?invalid|\bauth\w*\s+fail|\bunauthorized\b|\b401\b/i, type: 'error', label: '認証エラー' },
  // 承認・確認要求（明確なプロンプト形式のみ）
  { pattern: /\(y\/n\)|\(yes\/no\)/i, type: 'warn', label: '承認要求' },
  { pattern: /waiting for.*\bapproval\b|user.*input.*required/i, type: 'warn', label: 'ユーザー入力待ち' },
  // MCP関連
  { pattern: /MCP.*\berror\b|MCP.*\bfail/i, type: 'error', label: 'MCP接続エラー' },
  { pattern: /MCP.*\btimeout\b/i, type: 'warn', label: 'MCPタイムアウト' },
];

function detectCliIssuesFromOutput(rawData, providerId) {
  const now = Date.now();
  if (now - _lastCliIssueTime < 2000) return; // 2秒デバウンス（同じエラーの連打防止）
  const text = stripAnsiCodes(String(rawData || ''));
  if (text.length < 5) return;
  for (const rule of CLI_ISSUE_PATTERNS) {
    if (rule.pattern.test(text)) {
      _lastCliIssueTime = now;
      const provider = getProvider(normalizeProviderId(providerId));
      const cleanText = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
      const message = '[' + provider.displayName + '] ' + rule.label + ': ' + cleanText;
      // SSEで全クライアントに通知
      sseClients.forEach(function(r) {
        r.write('data: ' + JSON.stringify({ type: 'cli-log', message: message, logType: rule.type, time: new Date().toISOString() }) + '\n\n');
      });
      break; // 1チャンクにつき1件のみ通知
    }
  }
}

function flushManagedAiPromptQueue() {
  const state = managedAiSessionState;
  if (!state || !claudePty || state.dispatching || !state.ready || state.queue.length === 0) return;
  const next = state.queue.shift();
  state.dispatching = true;
  appendDiagnosticEvent('managed_ai_prompt_dispatch', {
    provider: state.providerId,
    queuedAt: next.queuedAt,
    ageMs: Date.now() - next.queuedAt,
    remainingQueueLength: state.queue.length,
  });
  const promptPayload = typeof next.promptText === 'string' && next.promptText.includes('\n')
    ? `\u001b[200~${next.promptText}\u001b[201~`
    : next.promptText;
  try {
    appendManagedAiPtyLog(state.providerId, `[dispatch] prompt queued (${String(next.promptText || '').length} chars)`, 'system');
    touchManagedAiBatchActivity('prompt-dispatch');
    claudePty.write(promptPayload);
  } catch (error) {
    state.dispatching = false;
    throw error;
  }
  const submitSequence = getManagedAiSubmitSequence(state.providerId);
  const sendSubmitKey = (index = 0) => {
    const submitKey = submitSequence[index];
    if (!submitKey) {
      state.dispatching = false;
      state.enterTimer = null;
      setTimeout(() => flushManagedAiPromptQueue(), 250);
      return;
    }
    state.enterTimer = setTimeout(() => {
      try {
        if (claudePty) {
          claudePty.write(submitKey);
          appendManagedAiPtyLog(state.providerId, `[dispatch] submit key sent (${JSON.stringify(submitKey)})`, 'system');
          touchManagedAiBatchActivity('submit-key');
        }
      } finally {
        sendSubmitKey(index + 1);
      }
    }, index === 0 ? getManagedAiEnterDelay(state.providerId) : 220);
    if (typeof state.enterTimer.unref === 'function') {
      state.enterTimer.unref();
    }
  };
  sendSubmitKey(0);
}

function queueManagedAiPrompt(promptText, providerId) {
  const state = getManagedAiSessionState();
  const normalizedProviderId = normalizeProviderId(providerId);
  if (state.providerId !== normalizedProviderId) {
    throw new Error(`${getProviderDisplayName(normalizedProviderId)} の管理セッションが一致していません。`);
  }
  state.queue.push({
    promptText: String(promptText || ''),
    queuedAt: Date.now(),
  });
  appendDiagnosticEvent('managed_ai_prompt_queued', {
    provider: normalizedProviderId,
    ready: state.ready,
    queueLength: state.queue.length,
    promptChars: String(promptText || '').length,
    estimatedTokens: estimateTextTokens(promptText),
  });
  flushManagedAiPromptQueue();
  return {
    queued: true,
    ready: state.ready,
    queueLength: state.queue.length,
  };
}

function startManagedAiBatchPoller() {
  const controller = managedAiBatchController;
  if (!controller || controller.pollTimer) return;
  controller.pollTimer = setInterval(() => {
    const activeController = managedAiBatchController;
    if (!activeController) {
      clearManagedAiBatchControllerTimer(controller);
      return;
    }

    if (!activeController.activeBatch) {
      if (activeController.pending.length === 0) {
        clearManagedAiBatchControllerTimer(activeController);
      }
      return;
    }

    const snapshot = getManagedAiBatchProgressSnapshot(activeController.activeBatch.companyNos);
    if (snapshot.latestActivityAt && snapshot.latestActivityAt > activeController.activeBatch.lastProgressAt) {
      activeController.activeBatch.lastProgressAt = snapshot.latestActivityAt;
      activeController.activeBatch.lastProgressReason = 'action-log';
    }

    if (snapshot.terminalCount >= snapshot.totalCount && snapshot.totalCount > 0) {
      appendDiagnosticEvent('managed_ai_batch_completed', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        companyCount: snapshot.totalCount,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        statuses: snapshot.statuses,
      });
      appendAiRunMetric('managed_ai_batch_completed', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        companyCount: snapshot.totalCount,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        statuses: snapshot.statuses,
      });
      activeController.activeBatch = null;
      if (activeController.pending.length === 0) {
        clearManagedAiBatchControllerTimer(activeController);
        try { clearRecoverySnapshot(); } catch (_) {}
      } else {
        setTimeout(() => {
          dispatchNextManagedAiFormFillBatch();
        }, 350);
      }
      return;
    }

    if (!activeController.activeBatch.stallNotified
      && (Date.now() - activeController.activeBatch.lastProgressAt) > MANAGED_AI_BATCH_STALL_MS) {
      activeController.activeBatch.stallNotified = true;
      appendDiagnosticEvent('managed_ai_batch_stalled', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        idleMs: Date.now() - activeController.activeBatch.lastProgressAt,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        companyNos: activeController.activeBatch.companyNos,
        statuses: snapshot.statuses,
      });
      emitClaudeAutomationLog(
        `[バッチ停滞検知] ${snapshot.totalCount}社の処理が ${Math.round((Date.now() - activeController.activeBatch.lastProgressAt) / 1000)} 秒更新されていません。CLIログとフォームタブを確認してください。\n`,
        'warn',
        activeController.providerId,
      );

      // stallNotified が立った直後、message_draft/site_analysis/form_fill で停滞中の企業を自動 error 化
      const stalledNos = detectStalledCompanies(
        activeController.activeBatch,
        snapshot.statuses,
        { stallMs: MANAGED_AI_BATCH_STALL_MS }
      );
      if (stalledNos.length > 0) {
        stalledNos.forEach((companyNo) => {
          const status = snapshot.statuses.find((s) => Number(s.companyNo) === Number(companyNo));
          const company = activeController.activeBatch.companies.find((c) => Number(c.no) === Number(companyNo));
          const tsRaw = status && (status.latestTimestamp || status.updatedAt || status.timestamp);
          const idleMs = tsRaw ? Date.now() - Date.parse(tsRaw) : Date.now() - activeController.activeBatch.lastProgressAt;
          const stalledAt = status ? (status.latestAction || status.action || 'unknown') : 'unknown';
          const reason = formatStallReason(stalledAt, idleMs);
          logAction(Number(companyNo), company ? company.companyName : '', 'error', {
            source: 'batch-watchdog',
            reason,
            idleMs,
            stalledAt,
          });
          finishLiveMonitor(Number(companyNo), {
            companyNo: Number(companyNo),
            companyName: company ? company.companyName : '',
            status: 'error',
            step: reason,
          });
        });
        appendDiagnosticEvent('managed_ai_batch_auto_failed', {
          provider: activeController.providerId,
          batchId: activeController.activeBatch.id,
          stalledCompanyNos: stalledNos,
        });
        emitClaudeAutomationLog(
          `[自動タイムアウト] ${stalledNos.length}社を error として記録しバッチを進めます: ${stalledNos.join(',')}\n`,
          'warn',
          activeController.providerId,
        );
      }
    }
  }, MANAGED_AI_BATCH_POLL_MS);
  if (typeof controller.pollTimer.unref === 'function') {
    controller.pollTimer.unref();
  }
}

function dispatchNextManagedAiFormFillBatch() {
  const controller = managedAiBatchController;
  if (!controller || controller.activeBatch || controller.pending.length === 0) return null;
  const next = controller.pending.shift();
  controller.activeBatch = {
    id: next.id,
    companyNos: next.companies.map((company) => Number(company.no)),
    companyNames: next.companies.map((company) => company.companyName || company.name || ''),
    companies: next.companies.slice(),
    options: { ...(next.options || {}) },
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgressReason: 'queued',
    stallNotified: false,
  };
  appendDiagnosticEvent('managed_ai_batch_dispatch', {
    provider: controller.providerId,
    batchId: next.id,
    companyCount: next.companies.length,
    remainingBatchCount: controller.pending.length,
    companyNos: controller.activeBatch.companyNos,
  });
  appendAiRunMetric('managed_ai_batch_dispatch', {
    provider: controller.providerId,
    batchId: next.id,
    companyCount: next.companies.length,
    remainingBatchCount: controller.pending.length,
    companyNos: controller.activeBatch.companyNos,
  });
  emitClaudeAutomationLog(
    `[分割バッチ開始] ${next.companies.length}社を ${getProviderDisplayName(controller.providerId)} CLI に投入します（残り ${controller.pending.length} バッチ）。\n`,
    'system',
    controller.providerId,
  );
  const result = queueClaudeFormFillInManagedSession(next.companies, controller.providerId, next.options);
  startManagedAiBatchPoller();
  return result;
}

async function tryRecoverManagedAiSession(reason = 'unknown') {
  const recovery = managedAiRecoveryState;
  if (!recovery || recovery.inFlight) return false;
  recovery.inFlight = true;
  clearManagedAiRecoveryTimer();
  try {
    const auth = await probeClaudeAuthStatus(recovery.providerId);
    if (!auth.installed || !auth.loggedIn) {
      recovery.retries = (recovery.retries || 0) + 1;
      appendDiagnosticEvent('managed_ai_recovery_waiting_auth', {
        provider: recovery.providerId,
        reason,
        retries: recovery.retries,
        installed: !!auth.installed,
        loggedIn: !!auth.loggedIn,
        error: auth.error || null,
      });
      if (recovery.retries >= MANAGED_AI_RECOVERY_MAX_RETRIES) {
        emitClaudeAutomationLog(
          `[AI自動復旧停止] ${getProviderDisplayName(recovery.providerId)} の再ログイン待ちが長引いたため、自動復旧を停止しました。再度「AIを起動」してください。\n`,
          'warn',
          recovery.providerId,
        );
        managedAiRecoveryState = null;
        return false;
      }
      managedAiRecoveryTimer = setTimeout(() => {
        tryRecoverManagedAiSession('retry-auth');
      }, MANAGED_AI_RECOVERY_RETRY_MS);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
      return false;
    }

    appendDiagnosticEvent('managed_ai_recovery_restart', {
      provider: recovery.providerId,
      reason,
      batchCount: recovery.batches.length,
      mode: recovery.mode,
      autoSendSafe: recovery.autoSendSafe,
    });
    await launchManagedAiPty(recovery.mode, recovery.providerId, {
      allowReuse: false,
      autoSendSafe: recovery.autoSendSafe,
    });
    restoreManagedAiBatchesFromRecovery(recovery);
    emitClaudeAutomationLog(
      `[AI自動復旧] ${getProviderDisplayName(recovery.providerId)} の再ログイン後に managed セッションを復旧し、残り ${recovery.batches.length} バッチを再開しました。\n`,
      'system',
      recovery.providerId,
    );
    managedAiRecoveryState = null;
    return true;
  } catch (error) {
    recovery.retries = (recovery.retries || 0) + 1;
    appendDiagnosticEvent('managed_ai_recovery_failed', {
      provider: recovery.providerId,
      reason,
      retries: recovery.retries,
      error: String(error && error.message || error),
    });
    if (recovery.retries < MANAGED_AI_RECOVERY_MAX_RETRIES) {
      managedAiRecoveryTimer = setTimeout(() => {
        tryRecoverManagedAiSession('retry-error');
      }, MANAGED_AI_RECOVERY_RETRY_MS);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
    } else {
      managedAiRecoveryState = null;
    }
    return false;
  } finally {
    if (managedAiRecoveryState) managedAiRecoveryState.inFlight = false;
  }
}

async function restartManagedAiSessionForAuthRefresh(providerId = getManagedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!claudePty || getManagedAiProvider() !== normalizedProviderId || !isManagedAiAuthFingerprintStale(normalizedProviderId)) {
    return { restarted: false };
  }
  const recovery = snapshotManagedAiBatchesForRecovery();
  appendDiagnosticEvent('managed_ai_auth_refresh_detected', {
    provider: normalizedProviderId,
    mode: claudeProcessMode,
    autoSendSafe: managedAiAutoSendSafe,
    hasRecoveryBatches: !!(recovery && recovery.batches && recovery.batches.length),
  });
  emitClaudeAutomationLog(
    `[認証状態更新検知] ${getProviderDisplayName(normalizedProviderId)} のログイン状態が変わったため、managed セッションを自動で張り直します。\n`,
    'system',
    normalizedProviderId,
  );
  managedAiRecoveryState = recovery
    ? {
      ...recovery,
      retries: 0,
      inFlight: false,
    }
    : null;
  await stopManagedClaudePty({ suppressAutoRecovery: true });
  if (managedAiRecoveryState) {
    await tryRecoverManagedAiSession('auth-refresh');
  } else {
    await launchManagedAiPty(claudeProcessMode || getProvider(normalizedProviderId).defaultMode || 'auto', normalizedProviderId, {
      allowReuse: false,
      autoSendSafe: managedAiAutoSendSafe,
    });
  }
  return { restarted: true };
}

function isHeadlessAutomationProvider(providerId) {
  return ['codex', 'gemini'].includes(normalizeProviderId(providerId));
}

function requiresManagedAiSessionForFormFill(providerId) {
  return ['claude', 'codex', 'gemini'].includes(normalizeProviderId(providerId));
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

function getGeminiTrustedFoldersPath() {
  return path.join(os.homedir(), '.gemini', 'trustedFolders.json');
}

function getGeminiProjectsPath() {
  return path.join(os.homedir(), '.gemini', 'projects.json');
}

function ensureGeminiWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const trustedFoldersPath = getGeminiTrustedFoldersPath();
  const projectsPath = getGeminiProjectsPath();
  let changed = false;

  try {
    ensureParentDir(trustedFoldersPath);
    const trustedFolders = readJsonFileSafe(trustedFoldersPath, {}) || {};
    if (trustedFolders[resolvedProjectRoot] !== 'TRUST_FOLDER') {
      trustedFolders[resolvedProjectRoot] = 'TRUST_FOLDER';
      fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), 'utf8');
      changed = true;
    }
  } catch (_) {
    return false;
  }

  try {
    ensureParentDir(projectsPath);
    const projectName = path.basename(resolvedProjectRoot) || 'project';
    const projectsState = readJsonFileSafe(projectsPath, { projects: {} }) || { projects: {} };
    projectsState.projects = projectsState.projects || {};
    const lowerKey = resolvedProjectRoot.toLowerCase();
    if (!projectsState.projects[lowerKey]) {
      projectsState.projects[lowerKey] = projectName;
      fs.writeFileSync(projectsPath, JSON.stringify(projectsState, null, 2), 'utf8');
      changed = true;
    }
  } catch (_) {
    return changed;
  }

  return changed;
}

function isCodexWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return getCodexTrustProjectKeys(projectRoot).some((key) => content.includes(`[projects.'${key.replace(/'/g, "''")}']`));
  } catch (_) {
    return false;
  }
}

function isGeminiWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  try {
    const trustedFolders = readJsonFileSafe(getGeminiTrustedFoldersPath(), {}) || {};
    const projectsState = readJsonFileSafe(getGeminiProjectsPath(), { projects: {} }) || { projects: {} };
    const projectKeys = Object.keys(projectsState.projects || {});
    return trustedFolders[resolvedProjectRoot] === 'TRUST_FOLDER'
      && projectKeys.includes(resolvedProjectRoot.toLowerCase());
  } catch (_) {
    return false;
  }
}

function copyFileIfExists(sourcePath, targetPath) {
  if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) return false;
  ensureParentDir(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function getManagedProviderHome(providerId) {
  return resolveDataPath(path.join('provider-homes', normalizeProviderId(providerId)));
}

function normalizeProjectConfigKey(projectRoot = PROJECT_ROOT) {
  return path.resolve(projectRoot).replace(/\\/g, '/');
}

function buildManagedClaudeMcpServers(realState = {}) {
  const globalMcpServers = (realState && typeof realState === 'object' && realState.mcpServers) || {};
  if (globalMcpServers.playwright && typeof globalMcpServers.playwright === 'object') {
    return { playwright: globalMcpServers.playwright };
  }
  return {
    playwright: {
      type: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@playwright/mcp', '--browser', 'chrome'],
      env: {},
    },
  };
}

function buildManagedClaudeProjectState() {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

function extractManagedClaudeProjectState(realState = {}, projectKey) {
  const projects = (realState && typeof realState === 'object' && realState.projects) || {};
  const current = (projectKey && projects[projectKey]) || {};
  return {
    ...current,
    ...buildManagedClaudeProjectState(),
  };
}

function prepareClaudeManagedHome(projectRoot = PROJECT_ROOT) {
  const realHome = os.homedir();
  const managedHome = getManagedProviderHome('claude');
  const managedClaudeDir = path.join(managedHome, '.claude');
  const managedAppDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const managedAppDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  fs.mkdirSync(managedClaudeDir, { recursive: true });
  fs.mkdirSync(managedAppDataRoaming, { recursive: true });
  fs.mkdirSync(managedAppDataLocal, { recursive: true });
  fs.mkdirSync(managedTempDir, { recursive: true });

  copyFileIfExists(path.join(realHome, '.claude', '.credentials.json'), path.join(managedClaudeDir, '.credentials.json'));
  copyFileIfExists(path.join(realHome, '.claude', '.omc-config.json'), path.join(managedClaudeDir, '.omc-config.json'));

  const realSettings = readJsonFileSafe(path.join(realHome, '.claude', 'settings.json'), {}) || {};
  const managedSettings = {
    ...(realSettings || {}),
    hooks: {},
    mcpServers: {},
  };
  fs.writeFileSync(path.join(managedClaudeDir, 'settings.json'), JSON.stringify(managedSettings, null, 2), 'utf8');

  const realState = readJsonFileSafe(path.join(realHome, '.claude.json'), {}) || {};
  const projectKey = normalizeProjectConfigKey(projectRoot);
  const managedState = {
    ...(realState || {}),
    autoUpdates: false,
    mcpServers: buildManagedClaudeMcpServers(realState),
    projects: {
      [projectKey]: extractManagedClaudeProjectState(realState, projectKey),
    },
    plugins: [],
  };
  delete managedState.prompt;
  fs.writeFileSync(path.join(managedHome, '.claude.json'), JSON.stringify(managedState, null, 2), 'utf8');

  return managedHome;
}

function prepareGeminiManagedHome(projectRoot = PROJECT_ROOT) {
  const realHome = os.homedir();
  const managedHome = getManagedProviderHome('gemini');
  const managedGeminiDir = path.join(managedHome, '.gemini');
  const managedAppDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const managedAppDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  fs.mkdirSync(managedGeminiDir, { recursive: true });
  fs.mkdirSync(managedAppDataRoaming, { recursive: true });
  fs.mkdirSync(managedAppDataLocal, { recursive: true });
  fs.mkdirSync(managedTempDir, { recursive: true });

  copyFileIfExists(path.join(realHome, '.gemini', 'oauth_creds.json'), path.join(managedGeminiDir, 'oauth_creds.json'));
  copyFileIfExists(path.join(realHome, '.gemini', 'google_accounts.json'), path.join(managedGeminiDir, 'google_accounts.json'));
  copyFileIfExists(path.join(realHome, '.gemini', 'GEMINI.md'), path.join(managedGeminiDir, 'GEMINI.md'));
  const realSettings = readJsonFileSafe(path.join(realHome, '.gemini', 'settings.json'), {}) || {};
  const managedSettings = {
    ...realSettings,
    security: {
      ...(realSettings.security || {}),
      folderTrust: {
        ...((realSettings.security && realSettings.security.folderTrust) || {}),
        enabled: false,
      },
    },
    general: {
      ...(realSettings.general || {}),
      sessionRetention: {
        ...((realSettings.general && realSettings.general.sessionRetention) || {}),
        enabled: false,
      },
    },
  };
  fs.writeFileSync(path.join(managedGeminiDir, 'settings.json'), JSON.stringify(managedSettings, null, 2), 'utf8');

  const resolvedProjectRoot = path.resolve(projectRoot);
  const projectName = path.basename(resolvedProjectRoot) || 'project';
  fs.writeFileSync(path.join(managedGeminiDir, 'projects.json'), JSON.stringify({
    projects: {
      [resolvedProjectRoot.toLowerCase()]: projectName,
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(managedGeminiDir, 'trustedFolders.json'), JSON.stringify({
    [resolvedProjectRoot]: 'TRUST_FOLDER',
  }, null, 2), 'utf8');

  return managedHome;
}

function buildManagedProviderEnv(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const baseEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (normalizedProviderId === 'claude') {
    const managedHome = prepareClaudeManagedHome(PROJECT_ROOT);
    const parsed = path.parse(managedHome);
    const appDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
    const appDataLocal = path.join(managedHome, 'AppData', 'Local');
    const managedTempDir = path.join(managedHome, 'tmp');
    return {
      ...baseEnv,
      HOME: managedHome,
      USERPROFILE: managedHome,
      HOMEDRIVE: parsed.root.replace(/\\$/, ''),
      HOMEPATH: managedHome.slice(parsed.root.length - 1),
      APPDATA: appDataRoaming,
      LOCALAPPDATA: appDataLocal,
      TEMP: managedTempDir,
      TMP: managedTempDir,
      XDG_CONFIG_HOME: managedHome,
      XDG_CACHE_HOME: path.join(managedHome, '.cache'),
      XDG_STATE_HOME: path.join(managedHome, '.state'),
      CLAUDE_CONFIG_DIR: path.join(managedHome, '.claude'),
    };
  }
  if (normalizedProviderId !== 'gemini') {
    return baseEnv;
  }

  const managedHome = prepareGeminiManagedHome(PROJECT_ROOT);
  const parsed = path.parse(managedHome);
  const appDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const appDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  return {
    ...baseEnv,
    HOME: managedHome,
    USERPROFILE: managedHome,
    HOMEDRIVE: parsed.root.replace(/\\$/, ''),
    HOMEPATH: managedHome.slice(parsed.root.length - 1),
    APPDATA: appDataRoaming,
    LOCALAPPDATA: appDataLocal,
    TEMP: managedTempDir,
    TMP: managedTempDir,
    XDG_CONFIG_HOME: managedHome,
    XDG_CACHE_HOME: path.join(managedHome, '.cache'),
    XDG_STATE_HOME: path.join(managedHome, '.state'),
    GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(managedHome, '.gemini', 'trustedFolders.json'),
  };
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
    env: options.env || process.env,
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

async function ensureProviderPlaywrightMcp(providerId, options = {}) {
  const normalized = normalizeProviderId(providerId);
  if (!['codex', 'gemini'].includes(normalized)) {
    return { ok: true, required: false };
  }

  const cliOptions = { timeout: 20000, env: options.env || process.env };
  const check = await runProviderCliCommand(normalized, ['mcp', 'list'], cliOptions);
  const combined = `${check.stdout}\n${check.stderr}`;
  if (check.ok && /playwright/i.test(combined)) {
    return { ok: true, required: true, configured: true };
  }

  const addArgs = normalized === 'codex'
    ? ['mcp', 'add', 'playwright', '--', 'npm', 'exec', '@playwright/mcp', '--browser', 'chrome']
    : ['mcp', 'add', 'playwright', 'npm', 'exec', '@playwright/mcp', '--browser', 'chrome'];
  const add = await runProviderCliCommand(normalized, addArgs, { timeout: 30000, env: cliOptions.env });
  if (!add.ok) {
    const message = `${getProviderDisplayName(normalized)} で MCP Playwright の設定に失敗しました。${String(add.stderr || add.stdout || '').trim()}`;
    return { ok: false, required: true, configured: false, error: message };
  }

  const verify = await runProviderCliCommand(normalized, ['mcp', 'list'], cliOptions);
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

// レガシー: basename のみ (e.g. favicon.png)
// 新規: subpath 対応 (e.g. vendor/fonts/inter.woff2)
function getAssetCandidates(relativePath) {
  // パストラバーサル防止: `..` を含むパスは拒否
  const safe = String(relativePath || '').replace(/\\/g, '/');
  if (safe.includes('..') || safe.startsWith('/') || safe.includes('\0')) return [];
  const normalized = path.posix.normalize(safe);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return [];
  const candidates = [
    // dev モード: worktree/assets 配下
    path.join(__dirname, '..', 'assets', normalized),
  ];
  if (process.resourcesPath) {
    // packaged モード: extraResources の resources/assets 配下
    candidates.push(path.join(process.resourcesPath, 'assets', normalized));
  }
  return Array.from(new Set(candidates.map((entry) => path.resolve(entry))));
}

const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
function assetMimeFor(ext) {
  return ASSET_MIME_TYPES[ext] || 'application/octet-stream';
}

function ensureDashboardSessionToken() {
  if (!dashboardSessionToken) {
    dashboardSessionToken = readPersistedDashboardSessionToken();
    if (!dashboardSessionToken) {
      dashboardSessionToken = crypto.randomBytes(24).toString('hex');
      persistDashboardSessionToken(dashboardSessionToken);
    }
  }
  return dashboardSessionToken;
}

const DASHBOARD_SESSION_COOKIE = 'sales_claw_session';
const DASHBOARD_SESSION_FILE = resolveDataPath('dashboard-session.json');

function readPersistedDashboardSessionToken() {
  try {
    if (!fs.existsSync(DASHBOARD_SESSION_FILE)) return '';
    const raw = JSON.parse(fs.readFileSync(DASHBOARD_SESSION_FILE, 'utf8'));
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    return /^[a-f0-9]{48,}$/i.test(token) ? token : '';
  } catch (_) {
    return '';
  }
}

function persistDashboardSessionToken(token) {
  try {
    const dir = path.dirname(DASHBOARD_SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DASHBOARD_SESSION_FILE, JSON.stringify({
      token,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {
    // noop
  }
}

function getDashboardSessionCookieName() {
  const runtimePort = dashboardRuntime && dashboardRuntime.port ? dashboardRuntime.port : null;
  const serverAddress = server && typeof server.address === 'function' ? server.address() : null;
  const port = runtimePort
    || (serverAddress && serverAddress.port ? serverAddress.port : null)
    || settings.getPort()
    || 'default';
  const scope = String(port).replace(/[^0-9A-Za-z_-]/g, '') || 'default';
  return `${DASHBOARD_SESSION_COOKIE}_p${scope}`;
}

function buildExpiredDashboardSessionCookie(cookieName) {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function buildDashboardSessionCookieHeaders() {
  const currentCookieName = getDashboardSessionCookieName();
  const headers = [buildDashboardSessionCookie()];
  if (currentCookieName !== DASHBOARD_SESSION_COOKIE) {
    headers.push(buildExpiredDashboardSessionCookie(DASHBOARD_SESSION_COOKIE));
  }
  return headers;
}

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
  return `${getDashboardSessionCookieName()}=${encodeURIComponent(ensureDashboardSessionToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 60 * 60}`;
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
  return cookies[getDashboardSessionCookieName()] || '';
}

function isAuthorizedDashboardRequest(req, options = {}) {
  const expectedToken = ensureDashboardSessionToken();
  const providedToken = getRequestSessionToken(req);
  const tokenMatches = !!providedToken && providedToken === expectedToken;
  const allowTokenWithoutOrigin = !!options.allowTokenWithoutOrigin;
  const hasExplicitBrowserOrigin = !!(req && (req.headers.origin || req.headers.referer));

  if (!isAllowedOrigin(req)) {
    if (!(allowTokenWithoutOrigin && tokenMatches && !hasExplicitBrowserOrigin)) {
      return { ok: false, statusCode: 403, error: 'Blocked cross-origin dashboard request.' };
    }
  }

  if (!tokenMatches) {
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

function getAiRunMetricsFile() {
  return resolveDataPath('ai-run-metrics.jsonl');
}

function appendAiRunMetric(type, payload = {}) {
  try {
    ensureDataDir();
    const filePath = getAiRunMetricsFile();
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload,
    });
    fs.appendFileSync(filePath, entry + '\n', 'utf8');
  } catch (_) {}
}

function estimateTextTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

const MANAGED_AI_CONTRACT_VERSION = 1;

function trimOneLineText(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function trimMultilineText(value, maxLength = 1200) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactMessageForPrompt(message, sender = {}) {
  const lines = String(message || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd());
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  if (lines.length > 0 && /^お世話になります/.test(lines[0].trim())) {
    lines.shift();
  }
  if (lines.length > 0) {
    const introLine = lines[0].trim();
    const senderName = String(sender.name || '').trim();
    const senderCompany = String(sender.companyName || '').trim();
    if (
      (senderName && introLine.includes(senderName))
      || (senderCompany && introLine.includes(senderCompany))
      || /と申します。?$/.test(introLine)
    ) {
      lines.shift();
    }
  }
  while (lines.length > 0 && !lines[0].trim()) lines.shift();

  let signatureIndex = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (
      /^何卒よろしくお願いいたします/.test(line)
      || /^よろしくお願いいたします/.test(line)
      || /^TEL[:：]/i.test(line)
      || /^MAIL[:：]/i.test(line)
      || (sender.companyName && line.includes(String(sender.companyName).trim()))
      || (sender.name && line.includes(String(sender.name).trim()))
    ) {
      signatureIndex = i;
      break;
    }
  }

  const core = lines.slice(0, signatureIndex).join('\n');
  return trimMultilineText(core, 900);
}

function compactMessagePromptForPrompt(promptText) {
  return trimMultilineText(promptText, 2600);
}

function buildCompactSenderPayload(sender = {}) {
  const payload = {};
  [
    ['companyName', sender.companyName],
    ['name', sender.name],
    ['nameKana', sender.nameKana],
    ['email', sender.email],
    ['phone', sender.phone],
    ['mobile', sender.mobile],
    ['fax', sender.fax],
    ['title', sender.title],
    ['department', sender.department],
    ['postalCode', sender.postalCode],
    ['address', sender.address],
    ['website', sender.website],
    ['partnerPage', sender.partnerPage],
  ].forEach(([key, value]) => {
    const normalized = String(value || '').trim();
    if (normalized) payload[key] = normalized;
  });
  return payload;
}

function buildCompactApproachPayload(objective = '', guardrails = '') {
  const payload = {};
  if (objective) payload.objective = trimOneLineText(objective, 220);
  if (guardrails) payload.guardrails = trimOneLineText(guardrails, 220);
  return payload;
}

function buildManagedAiSessionContract(providerId = getManagedAiProvider(), options = {}) {
  const provider = getProvider(providerId);
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  return [
    `SALES_CLAW_SESSION_CONTRACT v${MANAGED_AI_CONTRACT_VERSION}`,
    `provider=${provider.id}`,
    `cli=${provider.cliLabel}`,
    `sendPolicy=${autoSendSafe ? 'safe-auto-send' : 'approval-stop'}`,
    'rules:',
    '- direct Playwright worker / JS automation は使わない',
    '- MCP は Playwright のみ使用。別の Web 取得 MCP は使わない',
    '- 1社目のみ browser_navigate 可。2社目以降は browser_evaluate(window.open) + browser_tabs',
    '- 既存タブを navigate で上書きしない',
    '- CAPTCHA / reCAPTCHA / hCaptcha / Turnstile / ロボチェッカーは回避しない',
    '- 営業NG / 対象外は skipped',
    '- form_fill / confirm_reached / awaiting_approval / submitted を正しく記録',
    '- 入力項目は設定にある値だけ使う。推測しない',
    autoSendSafe
      ? '- CAPTCHA / ロボチェッカー / 手動必須項目 / 営業NG / 不確実ケースを除き、確認画面到達後はできるだけ submitted まで進める'
      : '- 送信は行わず awaiting_approval で止める',
    '- submitted まで進めたら必ず ss-{No}-sent.png を残す。awaiting_approval / error / skipped は入力済みタブを残す',
    '- submitted が明確に完了したタブは閉じる。送れなかったタブは残す',
    '- 同じセッションではこの契約を再説明しない。以後の batch payload だけ実行する',
  ].join('\n');
}

function extractPromptJsonLine(outputText) {
  const lines = String(outputText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch (_) {}
  }
  return null;
}

function summarizePhaseAAnalysisForPrompt(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const lines = [];
  const businessAreas = Array.isArray(analysis.businessAreas)
    ? analysis.businessAreas.map((entry) => trimOneLineText(entry && entry.label)).filter(Boolean).slice(0, 2)
    : [];
  const focusAreas = Array.isArray(analysis.focusAreas)
    ? analysis.focusAreas.map((entry) => trimOneLineText(entry)).filter(Boolean).slice(0, 2)
    : [];
  const gaps = Array.isArray(analysis.gaps)
    ? analysis.gaps.map((entry) => trimOneLineText(entry && entry.strength && entry.strength.label)).filter(Boolean).slice(0, 2)
    : [];
  const patterns = Array.isArray(analysis.relevantPatterns)
    ? analysis.relevantPatterns.map((entry) => trimOneLineText(entry && (entry.partner || entry.type || entry.proof))).filter(Boolean).slice(0, 1)
    : [];

  if (businessAreas.length > 0) lines.push(`- 事業領域: ${businessAreas.join(' / ')}`);
  if (focusAreas.length > 0) lines.push(`- 注力/状況: ${focusAreas.join(' / ')}`);
  if (gaps.length > 0) lines.push(`- 提案軸: ${gaps.join(' / ')}`);
  if (patterns.length > 0) lines.push(`- 近い支援実績: ${patterns.join(' / ')}`);
  if (analysis.analysisMode) lines.push(`- 分析モード: ${trimOneLineText(analysis.analysisMode, 40)}`);
  return lines;
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

async function stopManagedClaudePty(options = {}) {
  const targetPty = claudePty;
  if (!targetPty) {
    return { ok: true, stopped: false, method: 'noop' };
  }
  managedAiSuppressAutoRecovery = !!options.suppressAutoRecovery;

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
    sent: status.exists.sent ? (actual.sent || status.screenshots.sent) : null,
    hasInput: status.exists.input,
    hasConfirm: status.exists.confirm,
    hasSent: status.exists.sent,
    hasAny: status.exists.input || status.exists.confirm || status.exists.sent,
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

function mapLogToMonitorStatus(action) {
  switch (String(action || '').trim()) {
    case 'site_analysis': return 'site_analysis';
    case 'message_draft': return 'draft_ready';
    case 'form_fill': return 'form_filling';
    case 'confirm_reached': return 'confirm_reached';
    case 'awaiting_approval': return 'awaiting_approval';
    case 'submitted': return 'submitted';
    case 'skipped': return 'skipped';
    case 'error': return 'error';
    default: return String(action || '').trim() || 'update';
  }
}

function mapLogToMonitorStep(log) {
  const action = String(log && log.action || '').trim();
  switch (action) {
    case 'site_analysis': return '企業サイト分析';
    case 'message_draft': return '文面作成';
    case 'form_fill': return 'フォーム入力中';
    case 'confirm_reached': return '確認画面到達';
    case 'awaiting_approval': return '確認待ち';
    case 'submitted': return '送信済み';
    case 'skipped': return '対象外/スキップ';
    case 'error': return 'エラー';
    default: return action || '';
  }
}

function buildFallbackMonitorEventsFromLogs(sourceLogs = []) {
  const relevantActions = new Set(['site_analysis', 'message_draft', 'form_fill', 'confirm_reached', 'awaiting_approval', 'submitted', 'skipped', 'error']);
  const seen = new Set();
  const events = [];
  sourceLogs
    .filter((log) => log && log.companyNo != null && relevantActions.has(String(log.action || '').trim()))
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .forEach((log) => {
      const key = `${log.companyNo}:${log.action}:${log.timestamp}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push({
        companyNo: Number(log.companyNo),
        companyName: log.companyName || '',
        status: mapLogToMonitorStatus(log.action),
        step: mapLogToMonitorStep(log),
        currentUrl: extractFormUrlFromLog(log),
        updatedAt: log.timestamp || null,
        active: false,
        source: 'action-log',
      });
    });
  return events;
}

function buildMonitorPayload(sourceLogs = []) {
  const summary = getLiveMonitorSummary();
  const monitor = summary && summary.primary ? summary.primary : readMonitorState();
  const liveEvents = summary && Array.isArray(summary.events)
    ? summary.events.map((entry) => ({
        ...entry,
        currentUrl: entry && (entry.currentUrl || entry.formUrl) ? (entry.currentUrl || entry.formUrl) : '',
        latestScreenshotName: getMonitorScreenshotFile(entry),
      }))
    : [];
  const fallbackEvents = buildFallbackMonitorEventsFromLogs(sourceLogs);
  const eventMap = new Map();
  [...liveEvents, ...fallbackEvents].forEach((entry) => {
    if (!entry) return;
    const key = `${entry.companyNo || ''}:${entry.status || ''}:${entry.updatedAt || ''}:${entry.step || ''}`;
    if (!eventMap.has(key)) eventMap.set(key, entry);
  });
  const events = [...eventMap.values()]
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 200);
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

function extractUrlFromText(value = '') {
  const match = String(value || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return '';
  return match[0].replace(/[),.;]+$/g, '');
}

function extractFormUrlFromLog(log) {
  if (!log) return '';
  const details = log.details;
  if (details && typeof details === 'object') {
    const directCandidates = [details.formUrl, details.currentUrl, details.url, details.targetUrl];
    for (const candidate of directCandidates) {
      const normalized = String(candidate || '').trim();
      if (/^https?:\/\//i.test(normalized)) return normalized;
    }
  }
  return extractUrlFromText(stringifyLogDetails(details || ''));
}

function ensureSubmittedContactHistory(companyNo, companyName, submittedLog, formUrl, message, existingHistory = null, options = {}) {
  if (!submittedLog) return existingHistory;
  const normalizedMessage = String(message || '').trim();
  const normalizedFormUrl = String(formUrl || '').trim();
  const submittedAt = submittedLog && submittedLog.timestamp ? new Date(submittedLog.timestamp).toISOString() : '';
  const history = existingHistory || getHistory(companyNo);
  const contacts = history && Array.isArray(history.contacts) ? history.contacts : [];
  const alreadyRecorded = contacts.some((contact) => {
    const sameDate = submittedAt && (
      String(contact && contact.date || '') === submittedAt
      || String(contact && contact.sourceActionAt || '') === submittedAt
    );
    const sameMessage = normalizedMessage && String(contact && contact.message || '').trim() === normalizedMessage;
    const sameUrl = normalizedFormUrl && String(contact && contact.formUrl || '').trim() === normalizedFormUrl;
    return sameDate || (sameMessage && (!normalizedFormUrl || sameUrl));
  });
  if (alreadyRecorded || (!normalizedMessage && !normalizedFormUrl)) return history;
  recordContact(companyNo, companyName, {
    message: normalizedMessage,
    formUrl: normalizedFormUrl,
    method: 'web_form',
    sentAt: submittedAt,
    screenshot: options.screenshot || '',
    sourceAction: options.sourceAction || 'submitted',
    sourceActionAt: options.sourceActionAt || submittedAt,
    status: options.status || 'submitted',
    notes: options.notes || 'submitted log sync',
  });
  return getHistory(companyNo);
}

function getKnownFormUrl(companyNo, preferredUrl = '', logs = []) {
  const direct = String(preferredUrl || '').trim();
  if (direct) return direct;

  const monitorUrl = getLatestMonitorUrl(companyNo);
  if (monitorUrl) return monitorUrl;

  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const logUrl = extractFormUrlFromLog(logs[i]);
    if (logUrl) return logUrl;
  }

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
    // 送信済み・スキップ済み以外はどの中間状態からでもスキップ可（バッチ中断時の救済含む）
    const alreadyFinal = new Set(['submitted', 'skipped']);
    return !alreadyFinal.has(lastAction);
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
      // .local/bin は claude self-update がインストールする場所 — npm .cmd ラッパーより優先
      if (normalized.includes('\\.local\\bin\\')) value += 50;
      if (normalized.includes('\\windowsapps\\')) value -= 40;
      // node_modules 内の直接バイナリは npm ラッパーが壊れたとき不安定なため低く評価
      if (normalized.includes('\\node_modules\\')) value -= 10;
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

async function resolveNodeExecutable() {
  if (/node(?:\.exe)?$/i.test(path.basename(process.execPath || ''))) {
    return process.execPath;
  }
  if (process.platform === 'win32') {
    const result = await execCommand('where node', { timeout: 3000 });
    const candidates = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && fs.existsSync(line));
    return candidates[0] || null;
  }
  const result = await execCommand('which node', { timeout: 3000 });
  const candidate = String(result.stdout || '').trim();
  return candidate && fs.existsSync(candidate) ? candidate : null;
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

async function probeNpmStatus() {
  const result = await execCommand('npm --version', { timeout: 5000 });
  if (result.error) {
    return {
      available: false,
      version: null,
      error: String(result.stderr || result.stdout || result.error.message || 'npm is not available.').trim(),
    };
  }
  const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].trim();
  return {
    available: !!version,
    version: version || null,
    error: version ? null : 'npm version could not be determined.',
  };
}

async function probePlaywrightPackageStatus(npmStatus = null) {
  const npm = npmStatus || await probeNpmStatus();
  if (!npm.available) {
    return {
      available: false,
      error: 'npm is required to bootstrap Playwright MCP.',
      command: 'npm exec @playwright/mcp -- --help',
    };
  }
  const result = await execCommand('npm exec @playwright/mcp -- --help', { timeout: 12000, maxBuffer: 1024 * 1024 });
  const output = String(result.stdout || result.stderr || '').trim();
  const available = !result.error && /Usage: Playwright MCP/i.test(output);
  return {
    available,
    error: available ? null : (output || String(result.error && result.error.message || 'Playwright MCP bootstrap check failed.').trim()),
    command: 'npm exec @playwright/mcp -- --help',
  };
}

async function probeProviderPlaywrightSetup(providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!['codex', 'gemini'].includes(normalizedProviderId)) {
    return {
      configured: null,
      error: null,
      note: 'Claude validates Playwright access at launch/runtime. Codex and Gemini additionally require MCP registration.',
    };
  }
  const result = await runProviderCliCommand(normalizedProviderId, ['mcp', 'list'], { timeout: 20000 });
  const output = `${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim();
  const configured = !!(result.ok && /playwright/i.test(output));
  return {
    configured,
    error: configured ? null : (output || `${getProviderDisplayName(normalizedProviderId)} MCP list did not report Playwright.`),
    note: configured ? 'Playwright MCP is registered.' : 'Playwright MCP is not registered yet.',
  };
}

async function probeAiSetupDiagnostics(providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const auth = await probeClaudeAuthStatus(normalizedProviderId);
  const npm = await probeNpmStatus();
  const playwrightPackage = await probePlaywrightPackageStatus(npm);
  const providerPlaywright = await probeProviderPlaywrightSetup(normalizedProviderId);
  const workspaceTrusted = normalizedProviderId === 'codex'
    ? {
      configured: isCodexWorkspaceTrusted(PROJECT_ROOT),
      note: 'Codex では trusted workspace 設定が必要です。',
    }
    : normalizedProviderId === 'gemini'
      ? {
        configured: isGeminiWorkspaceTrusted(PROJECT_ROOT),
        note: 'Gemini では trustedFolders / projects 登録が必要です。',
      }
      : {
        configured: true,
        note: 'Claude は workspace trust の事前設定を必要としません。',
      };
  return {
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    cliInstalled: !!auth.installed,
    cliLoggedIn: !!auth.loggedIn,
    cliAuthError: auth.error || null,
    npm,
    playwrightPackage,
    providerPlaywright,
    workspaceTrusted,
    installCommand: getInstallCommand(normalizedProviderId),
    autoInstallSupported: !!npm.available,
    managedSessionRequired: requiresManagedAiSessionForFormFill(normalizedProviderId),
    tabRetentionNote: `${provider.displayName} の確認待ちでフォームタブを残すには、ダッシュボードの「AI を起動」で ${provider.displayName} を managed セッションとして起動してから実行する必要があります。`,
    launchExamples: getProviderLaunchExamples(normalizedProviderId),
    approvalCaveat: {
      ...getProviderApprovalCaveat(normalizedProviderId, 'ja'),
      en: getProviderApprovalCaveat(normalizedProviderId, 'en').message,
      ja: getProviderApprovalCaveat(normalizedProviderId, 'ja').message,
    },
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
  if (selectedProviderId === 'codex') {
    ensureCodexWorkspaceTrusted(PROJECT_ROOT);
  }
  if (selectedProviderId === 'gemini') {
    ensureGeminiWorkspaceTrusted(PROJECT_ROOT);
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && claudePty && managedProviderId === selectedProviderId) {
    await restartManagedAiSessionForAuthRefresh(selectedProviderId);
  }
  if (['codex', 'gemini'].includes(selectedProviderId)) {
    const playwrightSetup = await ensureProviderPlaywrightMcp(selectedProviderId, {
      env: selectedProviderId === 'gemini' ? buildManagedProviderEnv(selectedProviderId) : process.env,
    });
    if (!playwrightSetup.ok) {
      return {
        ok: false,
        statusCode: 409,
        error: playwrightSetup.error || `${provider.displayName} の MCP Playwright 設定に失敗しました。`,
      };
    }
  }
  const activeRun = getActiveHeadlessRun();
  if (activeRun) {
    return {
      ok: false,
      statusCode: 409,
      error: `現在は ${getProviderDisplayName(activeRun.provider)} の headless automation が実行中です。確認待ちタブを残すため、完了を待つか停止してから managed セッションで実行してください。`,
    };
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && !claudePty) {
    return {
      ok: false,
      statusCode: 409,
      error: `${provider.displayName} が未起動です。確認待ちでフォームタブを残すには、先に「AI を起動」で ${provider.displayName} の管理セッションを開始してください。外部ターミナルや headless 実行だけではタブ保持できません。`,
    };
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && managedProviderId !== selectedProviderId) {
    return {
      ok: false,
      statusCode: 409,
      error: `現在の管理セッションは ${getProviderDisplayName(managedProviderId)} です。${provider.displayName} でタブ保持したい場合は、${provider.displayName} を選んで起動し直してください。`,
    };
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && !['auto', 'bypassPermissions'].includes(claudeProcessMode)) {
    return {
      ok: false,
      statusCode: 409,
      error: `現在の ${provider.displayName} 起動モードは ${getProviderModeLabel(provider.id, claudeProcessMode, 'ja')}（${claudeProcessMode}）です。このモードでは権限確認で停止しやすいため、AIフォーム入力は ${getProviderRecommendedModesText(provider.id, 'ja')} で起動してください。`,
    };
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
    execution: 'managed',
  };
}

async function runParallelAnalysisWorker(company, nodeExecutable) {
  const { spawn } = require('child_process');
  const startedAtMs = Date.now();
  const payload = JSON.stringify({
    no: company.no,
    companyName: company.companyName || company.name || '',
    url: company.url || '',
    type: company.type || '',
    formUrl: company.formUrl || '',
  });

  return await new Promise((resolve) => {
    const child = spawn(nodeExecutable, ['src/parallel-analysis.cjs', payload], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, SALES_CLAW_CLI_TOKEN: process.env.SALES_CLAW_CLI_TOKEN || CLI_LOG_SECRET },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        companyNo: company.no,
        companyName: company.companyName || company.name || '',
        elapsedMs: Date.now() - startedAtMs,
        error: error.message || 'parallel-analysis spawn failed',
        stdout,
        stderr,
      });
    });
    child.on('close', (exitCode) => {
      const parsed = extractPromptJsonLine(stdout);
      if (parsed && parsed.ok) {
        resolve({
          ok: true,
          companyNo: company.no,
          companyName: company.companyName || company.name || '',
          elapsedMs: Date.now() - startedAtMs,
          analysis: parsed.analysis || null,
          message: typeof parsed.message === 'string' ? parsed.message : '',
          messagePrompt: typeof parsed.messagePrompt === 'string' ? parsed.messagePrompt : '',
          formUrl: parsed.formUrl || company.formUrl || '',
          formResolutionMethod: parsed.formResolutionMethod || null,
          stdout,
          stderr,
        });
        return;
      }
      const parsedError = parsed && typeof parsed.error === 'string' ? parsed.error : '';
      const errorText = parsedError
        || trimOneLineText(stderr || stdout || `parallel-analysis exited with code ${exitCode || 0}`, 240)
        || 'parallel-analysis failed';
      resolve({
        ok: false,
        companyNo: company.no,
        companyName: company.companyName || company.name || '',
        elapsedMs: Date.now() - startedAtMs,
        error: errorText,
        stdout,
        stderr,
      });
    });
  });
}

async function executeBackendPhaseABatch(companies, providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const nodeExecutable = await resolveNodeExecutable();
  if (!nodeExecutable || !fs.existsSync(nodeExecutable)) {
    throw new Error('Node.js executable was not found for Phase A analysis.');
  }

  const batchStartedAtMs = Date.now();
  appendDiagnosticEvent('phase_a_batch_started', {
    provider: normalizedProviderId,
    companyCount: companies.length,
  });
  appendAiRunMetric('phase_a_batch_started', {
    provider: normalizedProviderId,
    companyCount: companies.length,
  });

  const results = await Promise.all(companies.map((company) => runParallelAnalysisWorker(company, nodeExecutable)));
  const successes = [];
  const failures = [];

  results.forEach((result) => {
    if (result && result.ok) successes.push(result);
    else failures.push(result);
  });

  const elapsedMs = Date.now() - batchStartedAtMs;
  appendDiagnosticEvent('phase_a_batch_completed', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    successCount: successes.length,
    failureCount: failures.length,
    elapsedMs,
  });
  appendAiRunMetric('phase_a_batch_completed', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    successCount: successes.length,
    failureCount: failures.length,
    elapsedMs,
      companies: results.map((result) => ({
        companyNo: result.companyNo,
        companyName: result.companyName,
        ok: !!result.ok,
        elapsedMs: result.elapsedMs,
        error: result.ok ? null : result.error,
        messageChars: result.ok ? String(result.message || '').length : 0,
        analysisMode: result.ok && result.analysis ? result.analysis.analysisMode || null : null,
        hasFormUrl: !!(result.ok && result.formUrl),
        formResolutionMethod: result.ok ? result.formResolutionMethod || null : null,
      })),
    });

  return {
    provider: normalizedProviderId,
    nodeExecutable,
    elapsedMs,
    successes,
    failures,
  };
}

function buildClaudeFormFillPrompt(companies, sender, providerId = getManagedAiProvider(), options = {}) {
  const configuredScreenshotDir = settings.getScreenshotDir();
  const promptScreenshotDir = configuredScreenshotDir;
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const phaseAByCompany = options.phaseAByCompany instanceof Map ? options.phaseAByCompany : new Map();
  const phaseACompleted = phaseAByCompany.size > 0;
  const messageTemplates = settings.getSection('messageTemplates') || {};
  const approachObjective = typeof messageTemplates.approachObjective === 'string' ? messageTemplates.approachObjective.trim() : '';
  const approachGuardrails = typeof messageTemplates.approachGuardrails === 'string' ? messageTemplates.approachGuardrails.trim() : '';
  const missingFormUrlCount = (companies || []).filter((company) => !String(company.formUrl || '').trim()).length;
  const allFormUrlsResolved = missingFormUrlCount === 0;
  const companyPayloadLines = (companies || []).map((company, index) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    const compactPayload = {
      index: index + 1,
      no: company.no,
      name: company.companyName || '(不明)',
      type: String(company.type || '').trim() || undefined,
      site: String(company.url || '').trim() || undefined,
      form: String(company.formUrl || '').trim() || undefined,
      note: company.notes ? trimOneLineText(company.notes, 120) : undefined,
      attempt: company.contactNo && company.contactNo > 1 ? company.contactNo : undefined,
      screenshots: {
        input: path.join(promptScreenshotDir, `ss-${company.no}-input.png`),
        confirm: path.join(promptScreenshotDir, `ss-${company.no}-confirm.png`),
        ...(autoSendSafe ? { sent: path.join(promptScreenshotDir, `ss-${company.no}-sent.png`) } : {}),
      },
      messageDraft: trimMultilineText(phaseA && phaseA.message, 1500) || undefined,
      messageCore: compactMessageForPrompt(phaseA && phaseA.message, sender) || undefined,
      messagePrompt: compactMessagePromptForPrompt(phaseA && phaseA.messagePrompt) || undefined,
      analysisHints: summarizePhaseAAnalysisForPrompt(phaseA && phaseA.analysis)
        .map((line) => trimOneLineText(String(line || '').replace(/^- /, ''), 160))
        .filter(Boolean)
        .slice(0, 4),
      siteExcerpt: trimOneLineText(phaseA && phaseA.analysis && phaseA.analysis.siteTextExcerpt, 220) || undefined,
      automationHints: buildCompanyAutomationHints(company)
        .map((hint) => trimOneLineText(hint, 160))
        .filter(Boolean)
        .slice(0, 3),
      formResolution: phaseA && phaseA.formResolutionMethod && company.formUrl
        ? phaseA.formResolutionMethod
        : undefined,
    };
    return JSON.stringify(compactPayload);
  }).join('\n');

  const senderPayload = JSON.stringify(buildCompactSenderPayload(sender));
  const approachPayload = JSON.stringify(buildCompactApproachPayload(approachObjective, approachGuardrails));

  return [
    'SALES_CLAW_BATCH_PAYLOAD',
    JSON.stringify({
      companyCount: companies.length,
      phaseACompleted,
      autoSendSafe,
      knownFormUrlCount: (companies || []).filter((company) => String(company.formUrl || '').trim()).length,
      missingFormUrlCount,
      screenshotDir: promptScreenshotDir,
      configuredScreenshotDir,
    }),
    '',
    'sender_json:',
    senderPayload,
    '',
    'approach_json:',
    approachPayload,
    '',
    'batch_rules:',
    '- Phase A は backend 完了済み。form 未解決時を除き、対象サイトを再分析しない',
    '- messagePrompt がある場合は、それを使ってこの会社向けの本文を最終化してからフォーム入力する',
    '- messageDraft は Phase A の草案、messageCore は要点、messagePrompt は本文生成コンテキスト。messagePrompt を優先し、messageDraft はフォールバックとして扱う',
    '- 本文を書き換える場合でも、messagePrompt / analysisHints / siteExcerpt にない事実は足さない',
    '- sender_json にない送信者情報は追加しない',
    '- unresolved form は site から Contact/お問い合わせ または common path を浅く確認する',
    '- 1社ずつ処理し、結果報告は簡潔にする',
    autoSendSafe
      ? '- CAPTCHA / ロボチェッカー / 手動必須項目 / 営業NG / 不確実ケースを除き、確認画面が取れたら最終送信まで進めて submitted にする'
      : '- 送信は行わず awaiting_approval で止める',
    '- 送信完了時は sent スクリーンショットを残し、送信済みタブは閉じる',
    '- 送れない場合はタブを残して awaiting_approval / error にする',
    '',
    'companies_jsonl:',
    companyPayloadLines,
  ].join('\n');
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
  const promptFile = resolveDataPath('.sales-claw-work', 'ai-prompts', `${providerId}-form-fill-${Date.now()}.md`);
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

function queueClaudeFormFillInManagedSession(companies, providerId = getManagedAiProvider(), options = {}) {
  if (!claudePty) {
    throw new Error('Managed AI session is not running.');
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const state = getManagedAiSessionState();
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const sender = settings.getSender();
  const phaseAByCompany = options.phaseAByCompany instanceof Map ? options.phaseAByCompany : new Map();
  const needsSessionContract = state.contractVersionSent !== MANAGED_AI_CONTRACT_VERSION;
  const sessionContractText = needsSessionContract
    ? buildManagedAiSessionContract(normalizedProviderId, { autoSendSafe })
    : '';
  const fullMessageChars = companies.reduce((total, company) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    return total + String(phaseA && phaseA.message ? phaseA.message : '').length;
  }, 0);
  const compactMessageChars = companies.reduce((total, company) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    return total + compactMessageForPrompt(phaseA && phaseA.message, sender).length;
  }, 0);
  const promptText = buildClaudeFormFillPrompt(companies, sender, normalizedProviderId, options);
  const promptFile = writeClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const workspacePromptFile = writeWorkspaceClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const model = getClaudeAutomationModel(normalizedProviderId);
  const messageLines = [
    `Sales Claw の batch payload を送ります。必ず ${provider.cliLabel} と MCP Playwright で実行してください。前回までの会話や未完了タスクは引き継がず、この batch だけを正として扱ってください。`,
    'Phase A は backend 完了済みです。再分析・再生成・settings 更新はしないでください。',
    autoSendSafe
      ? 'CAPTCHA / ロボチェッカー / 手動必須項目 / 営業NG / 不確実ケース以外は、できるだけ自動送信してください。送信できたら sent スクショを残してタブを閉じ、送信できない場合だけタブを残して awaiting_approval にしてください。'
      : '送信は行わず、awaiting_approval で止めてください。',
    '本文は companies_jsonl の messageCore を基準に使い、必要なら sender_json の署名だけ補ってください。',
    '送信完了時は ss-{No}-sent.png を残し、submitted が明確なタブは閉じてください。',
    '進行報告は簡潔にしてください。',
    '--- BEGIN SALES CLAW BATCH ---',
    promptText,
    '--- END SALES CLAW BATCH ---',
  ];
  if (model && normalizedProviderId === 'claude') {
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
      step: `${provider.displayName} CLI にキュー投入（2フェーズ並列処理）`,
      currentUrl: company.formUrl || company.url || '',
    });
  });

  emitClaudeAutomationLog(`[AIフォーム入力開始] ${companies.length}社の2フェーズ並列処理を ${provider.displayName} CLI に依頼しました。\n  フェーズA: 企業分析+メッセージ生成（並列）\n  フェーズB: フォーム入力（順次）\n  送信ポリシー: ${autoSendSafe ? '安全なフォームは自動送信' : '確認待ちで停止'}\n`, 'system', providerId);
  // 全プロバイダーで直接テキスト送信に統一（@file参照はGemini PTYで動作しないため）
  const queuedPrompt = [
    ...(needsSessionContract ? [sessionContractText, ''] : []),
    ...messageLines,
  ].join('\n');
  appendAiRunMetric('phase_b_prompt_compiled', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    knownFormUrlCount: companies.filter((company) => String(company.formUrl || '').trim()).length,
    missingFormUrlCount: companies.filter((company) => !String(company.formUrl || '').trim()).length,
    promptChars: promptText.length,
    promptLines: promptText.split(/\r?\n/).length,
    queuedPromptChars: queuedPrompt.length,
    queuedPromptLines: queuedPrompt.split(/\r?\n/).length,
    estimatedPromptTokens: estimateTextTokens(queuedPrompt),
    sessionContractInjected: needsSessionContract,
    sessionContractChars: sessionContractText.length,
    messageFullChars: fullMessageChars,
    messageCoreChars: compactMessageChars,
    messageTrimmedChars: Math.max(0, fullMessageChars - compactMessageChars),
    autoSendSafe,
    phaseASuccessCount: Array.isArray(options.phaseASuccesses) ? options.phaseASuccesses.length : null,
    phaseAFailureCount: Array.isArray(options.phaseAFailures) ? options.phaseAFailures.length : null,
  });
  const queueState = queueManagedAiPrompt(queuedPrompt, normalizedProviderId);
  if (needsSessionContract) {
    state.contractVersionSent = MANAGED_AI_CONTRACT_VERSION;
  }
  notifyClients({ type: 'update', reason: 'claude-automation-queued', time: Date.now() });
  invalidateAiStatusCache(normalizedProviderId);
  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: `${provider.id}-cli-managed`,
    autoSendSafe,
    promptFile,
    workspacePromptFile,
    queued: queueState.queued,
    ready: queueState.ready,
    phaseASuccessCount: Array.isArray(options.phaseASuccesses) ? options.phaseASuccesses.length : undefined,
    phaseAFailureCount: Array.isArray(options.phaseAFailures) ? options.phaseAFailures.length : undefined,
    };
}

async function queueAiFormFill(companies, providerId = getSelectedAiProvider(), options = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const provider = getProvider(normalizedProviderId);
  const controller = ensureManagedAiBatchController(normalizedProviderId, autoSendSafe);
  const batches = chunkManagedAiCompanies(companies, MANAGED_AI_FORM_BATCH_SIZE);
  const batchItems = batches.map((batchCompanies) => ({
    id: `${Date.now()}-${++controller.batchCounter}`,
    companies: batchCompanies,
    options: buildManagedAiBatchOptionsSubset({
      ...options,
      autoSendSafe,
    }, batchCompanies),
  }));

  controller.pending.push(...batchItems);
  appendDiagnosticEvent('managed_ai_batches_enqueued', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    batchCount: batchItems.length,
    batchSize: MANAGED_AI_FORM_BATCH_SIZE,
    activeBatchId: controller.activeBatch ? controller.activeBatch.id : null,
    pendingBatchCount: controller.pending.length,
  });
  appendAiRunMetric('managed_ai_batches_enqueued', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    batchCount: batchItems.length,
    batchSize: MANAGED_AI_FORM_BATCH_SIZE,
    pendingBatchCount: controller.pending.length,
  });

  let dispatchResult = null;
  if (!controller.activeBatch) {
    dispatchResult = dispatchNextManagedAiFormFillBatch();
  } else {
    startManagedAiBatchPoller();
  }

  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: `${provider.id}-cli-managed`,
    autoSendSafe,
    batchCount: batchItems.length,
    batchSize: MANAGED_AI_FORM_BATCH_SIZE,
    activeBatchId: controller.activeBatch ? controller.activeBatch.id : null,
    pendingBatchCount: controller.pending.length + (controller.activeBatch ? 1 : 0),
    ...(dispatchResult || {}),
  };
}

async function startManagedAiSession(mode = 'default', providerId = getSelectedAiProvider(), options = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const cols = Math.max(2, Number(options.cols) || 120);
  const rows = Math.max(1, Number(options.rows) || 30);
  const allowReuse = options.allowReuse !== false;
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getConfiguredAiAutoSendSafe();

  if (claudePty
    && allowReuse
    && getManagedAiProvider() === normalizedProviderId
    && String(claudeProcessMode || '') === String(mode || '')
    && getManagedAiAutoSendSafe() === autoSendSafe) {
    return {
      ok: true,
      mode,
      provider: normalizedProviderId,
      providerLabel: provider.displayName,
      reused: true,
      autoSendSafe,
    };
  }

  if (claudePty) {
    await stopManagedClaudePty({ suppressAutoRecovery: true });
    claudePty = null;
  }

  if (normalizedProviderId === 'codex') {
    ensureCodexWorkspaceTrusted(PROJECT_ROOT);
  }
  if (normalizedProviderId === 'gemini') {
    ensureGeminiWorkspaceTrusted(PROJECT_ROOT);
  }
  const launchEnv = buildManagedProviderEnv(normalizedProviderId);
  const playwrightSetup = await ensureProviderPlaywrightMcp(normalizedProviderId, { env: launchEnv });
  if (!playwrightSetup.ok) {
    throw new Error(playwrightSetup.error);
  }

  const nodePty = require('node-pty');
  const executable = await resolveClaudeExecutable(normalizedProviderId);
  const flags = buildLaunchArgs(normalizedProviderId, mode, {
    model: getConfiguredAiModel(normalizedProviderId),
    sessionId: normalizedProviderId === 'claude' ? crypto.randomUUID() : null,
  });
  const spawnSpec = buildManagedSpawnSpec(normalizedProviderId, executable, flags);
  const ptyProc = nodePty.spawn(spawnSpec.command, spawnSpec.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: PROJECT_ROOT,
    env: launchEnv,
  });

  claudePty = ptyProc;
  claudeProcessMode = mode;
  activeAiProvider = normalizedProviderId;
  managedAiAutoSendSafe = autoSendSafe;
  clearManagedAiRecoveryTimer();
  resetManagedAiSessionState(normalizedProviderId);
  resetManagedAiBatchController();
  invalidateAiStatusCache(normalizedProviderId);

  ptyProc.onData((data) => {
    updateManagedAiReadyFromOutput(normalizedProviderId, data);
    appendManagedAiPtyLog(normalizedProviderId, data, 'output');
    broadcastPty({ type: 'output', data, provider: normalizedProviderId });
    detectCliIssuesFromOutput(data, normalizedProviderId);
  });

  ptyProc.onExit(({ exitCode }) => {
    const recoverySnapshot = snapshotManagedAiBatchesForRecovery();
    const suppressRecovery = managedAiSuppressAutoRecovery;
    managedAiSuppressAutoRecovery = false;
    if (claudePty === ptyProc) {
      claudePty = null;
      clearManagedAiSessionStateTimers();
      managedAiSessionState = null;
      invalidateAiStatusCache(normalizedProviderId);
    }
    clearManagedAiRecoveryTimer();
    if (!suppressRecovery && recoverySnapshot && recoverySnapshot.providerId === normalizedProviderId) {
      managedAiRecoveryState = {
        ...recoverySnapshot,
        retries: 0,
        inFlight: false,
      };
      appendDiagnosticEvent('managed_ai_recovery_queued', {
        provider: normalizedProviderId,
        exitCode,
        batchCount: recoverySnapshot.batches.length,
      });
      managedAiRecoveryTimer = setTimeout(() => {
        tryRecoverManagedAiSession('pty-exit');
      }, 2500);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
    } else {
      resetManagedAiBatchController();
      if (!managedAiRecoveryState || suppressRecovery) {
        // suppressRecovery=true の場合は呼び出し元が再起動/復旧を制御する
      } else {
        managedAiRecoveryState = null;
      }
    }
    if (!suppressRecovery && !recoverySnapshot) {
      try {
        const { getLiveMonitorSummary, finishLiveMonitor: finishMon } = require('./live-monitor.cjs');
        const summary = getLiveMonitorSummary();
        const stuckSessions = (summary.events || []).filter(ev =>
          ev && ev.active !== false && !['awaiting_approval', 'submitted', 'completed', 'skipped', 'error'].includes(ev.status)
        );
        stuckSessions.forEach(ev => {
          try {
            finishMon(ev.companyNo, {
              status: 'error',
              step: 'AIセッション終了 (exit code: ' + exitCode + ')',
              companyName: ev.companyName || '',
            });
          } catch (_) {}
        });
        if (stuckSessions.length > 0) {
          console.warn('[ai-exit] ' + stuckSessions.length + '社の未完了セッションをerrorに変更しました');
        }
      } catch (_) {}
    }
    appendManagedAiPtyLog(normalizedProviderId, `process exited with code ${exitCode}`, 'system');
    broadcastPty({ type: 'exit', code: exitCode, provider: normalizedProviderId });
    notifyClients({ type: 'claude-exit', code: exitCode, provider: normalizedProviderId, time: Date.now() });
  });

  return {
    ok: true,
    mode,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    reused: false,
    autoSendSafe,
  };
}

function buildManagedTerminalViewerUrl() {
  const runtime = dashboardRuntime || readRuntime();
  let baseUrl = runtime && runtime.url ? runtime.url : '';
  if (!baseUrl && server.listening) {
    const address = server.address();
    if (address && typeof address === 'object') {
      const host = !address.address || address.address === '::' ? '127.0.0.1' : address.address;
      baseUrl = `http://${host}:${address.port}`;
    }
  }
  if (!baseUrl) {
    throw new Error('Dashboard runtime URL could not be resolved.');
  }
  const runtimeUrl = new URL(baseUrl);
  const terminalUrl = new URL('/terminal', `${runtimeUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${runtimeUrl.host}`);
  terminalUrl.searchParams.set('session', ensureDashboardSessionToken());
  return terminalUrl.toString();
}

async function openManagedAiViewerInExternalTerminal(providerId = getManagedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const nodeExecutable = await resolveNodeExecutable();
  if (!nodeExecutable || !fs.existsSync(nodeExecutable)) {
    throw new Error('Node.js executable was not found for the external viewer.');
  }

  const viewerScript = path.join(PROJECT_ROOT, 'scripts', 'managed-pty-viewer.cjs');
  if (!fs.existsSync(viewerScript)) {
    throw new Error('Managed PTY viewer script was not found.');
  }

  const viewerUrl = buildManagedTerminalViewerUrl();
  const { spawn } = require('child_process');
  const viewerArgs = [
    escapePowerShellArg(nodeExecutable),
    escapePowerShellArg(viewerScript),
    '--url',
    escapePowerShellArg(viewerUrl),
    '--provider',
    escapePowerShellArg(provider.displayName),
  ];

  if (process.platform === 'win32') {
    const windowTitle = `Sales Claw - ${provider.displayName} Live Viewer`;
    const command = [
      `$Host.UI.RawUI.WindowTitle = ${escapePowerShellArg(windowTitle)}`,
      `Set-Location -LiteralPath ${escapePowerShellArg(PROJECT_ROOT)}`,
      ['&', ...viewerArgs].join(' '),
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
    return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
  }

  if (process.platform === 'darwin') {
    const terminalCommand = `cd ${escapePowerShellArg(PROJECT_ROOT)}; ${[...viewerArgs].join(' ')}`;
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
    return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
  }

  const terminalPrograms = [
    ['x-terminal-emulator', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['gnome-terminal', ['--', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['konsole', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['xterm', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
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
      return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
    } catch (_) {
      // try next terminal
    }
  }

  throw new Error('No supported external terminal launcher was found.');
}

async function launchClaudeInExternalTerminal(mode = 'default', providerId = getSelectedAiProvider(), autoSendSafe = getConfiguredAiAutoSendSafe()) {
  if (claudePty) {
    const activeProviderId = getManagedAiProvider();
    const viewer = await openManagedAiViewerInExternalTerminal(activeProviderId);
    return {
      ok: true,
      mode: claudeProcessMode || mode,
      provider: activeProviderId,
      providerLabel: getProviderDisplayName(activeProviderId),
      reused: true,
      viewer: true,
      viewerUrl: viewer.viewerUrl,
      autoSendSafe: getManagedAiAutoSendSafe(),
    };
  }

  const session = await startManagedAiSession(mode, providerId, {
    allowReuse: true,
    autoSendSafe,
  });
  const viewer = await openManagedAiViewerInExternalTerminal(session.provider);
  return {
    ok: true,
    mode: session.mode,
    provider: session.provider,
    providerLabel: session.providerLabel,
    reused: session.reused,
    viewer: true,
    viewerUrl: viewer.viewerUrl,
    autoSendSafe: !!session.autoSendSafe,
  };
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
      autoSendSafe: getManagedAiAutoSendSafe(),
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
      autoSendSafe: getManagedAiAutoSendSafe(),
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
      autoSendSafe: getConfiguredAiAutoSendSafe(),
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
      autoSendSafe: getConfiguredAiAutoSendSafe(),
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
    autoSendSafe: getConfiguredAiAutoSendSafe(),
    installState: getProviderInstallState(runtimeProviderId),
    installError: getProviderInstallError(runtimeProviderId),
    installCommand,
  };
}

// データ読み込み → JSON API 用
function syncSubmittedContactsToHistory({ orderedNos, rowMap, logsByCompany, historyMap, latestMonitorUrlByCompany }) {
  let mutated = false;
  (orderedNos || []).forEach((key) => {
    const row = rowMap.get(key) || {};
    const companyNo = row.no;
    if (companyNo === undefined || companyNo === null || companyNo === '') return;

    const logs = logsByCompany[key] || [];
    const submittedLog = getLatestLog(logs, 'submitted');
    if (!submittedLog) return;

    const existingHistory = historyMap.get(String(companyNo)) || getHistory(companyNo) || null;
    const contacts = existingHistory && Array.isArray(existingHistory.contacts) ? existingHistory.contacts : [];
    const draftLog = getLatestLog(logs, 'message_draft');
    const message = draftLog ? stringifyLogDetails(draftLog.details) : '';
    const fallbackFormUrl = contacts.length > 0 ? String(contacts[contacts.length - 1].formUrl || '').trim() : '';
    const formUrl = String(
      getKnownFormUrl(companyNo, '', logs)
      || latestMonitorUrlByCompany.get(String(companyNo))
      || row.formUrl
      || fallbackFormUrl
      || ''
    ).trim();
    const submittedAt = String(submittedLog.timestamp || '').trim();

    const alreadyRecorded = contacts.some((contact) => {
      const recordedAt = String(contact.date || contact.timestamp || '').trim();
      if (submittedAt && recordedAt === submittedAt) return true;
      return !!message
        && String(contact.message || '') === message
        && String(contact.formUrl || '').trim() === formUrl;
    });
    if (alreadyRecorded) return;
    const approvalArtifacts = getExpectedApprovalArtifacts(companyNo, {
      logs,
      formFillLog: getLatestLog(logs, 'form_fill'),
      awaitingLog: getLatestLog(logs, 'awaiting_approval'),
      confirmLog: getLatestLog(logs, 'confirm_reached'),
      submittedLog,
    });
    const approvalScreenshot = approvalArtifacts
      ? (approvalArtifacts.actual.sent || approvalArtifacts.screenshots.sent || approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
      : null;
    const nextHistory = ensureSubmittedContactHistory(
      companyNo,
      row.companyName || row.name || '',
      submittedLog,
      formUrl,
      message,
      existingHistory,
      {
        screenshot: approvalScreenshot || '',
        sourceAction: 'submitted',
        sourceActionAt: submittedAt || '',
        status: 'submitted',
        notes: 'submitted-sync',
      },
    );
    if (nextHistory !== existingHistory) {
      historyMap.set(String(companyNo), nextHistory);
      mutated = true;
    }
  });
  return mutated;
}

function getLatestContactEntry(contactHist) {
  if (!contactHist || !Array.isArray(contactHist.contacts) || contactHist.contacts.length === 0) return null;
  return contactHist.contacts[contactHist.contacts.length - 1] || null;
}

function getHistoryContactTimestamp(contact) {
  return parseEventTimestampMs(contact && (contact.sourceActionAt || contact.date || contact.timestamp));
}

function doesHistoryContactRepresentSubmission(contact) {
  if (!contact) return false;
  const normalizedStatus = String(contact.status || contact.sourceAction || '').trim().toLowerCase();
  if (!normalizedStatus) return true;
  return ['submitted', 'sent', 'completed', 'dashboard-approve'].some((marker) => normalizedStatus.includes(marker));
}

function buildHistorySubmittedLog(companyNo, companyName, latestContact, fallbackLog = null) {
  if (!doesHistoryContactRepresentSubmission(latestContact)) return fallbackLog;
  const timestamp = String(latestContact.sourceActionAt || latestContact.date || latestContact.timestamp || '').trim();
  return {
    ...(fallbackLog || {}),
    companyNo,
    companyName,
    action: 'submitted',
    timestamp,
    details: latestContact.notes || latestContact.response || 'contact-history',
    source: 'contact-history',
  };
}

function buildDashboardDataFromSources() {
  const targetRepair = repairImportedTargetListIfNeeded();
  if (targetRepair && targetRepair.repaired) {
    appendDiagnosticEvent('target_list_repaired_from_import_source', targetRepair);
  }
  const targetData = readTargetList();
  const targetRows = targetData.ok ? targetData.companies : [];
  const allLogs = getAllLogs();
  let historySummary = getAllHistorySummary();
  const _lang = settings.getSection('preferences').language || 'ja';
  let historyMap = new Map(historySummary.map((entry) => [String(entry.companyNo), getHistory(entry.companyNo)]));
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

  if (syncSubmittedContactsToHistory({ orderedNos, rowMap, logsByCompany, historyMap, latestMonitorUrlByCompany })) {
    historySummary = getAllHistorySummary();
    historyMap = new Map(historySummary.map((entry) => [String(entry.companyNo), getHistory(entry.companyNo)]));
  }

  const companies = orderedNos.map((key) => {
    const row = rowMap.get(key) || {};
    const no = row.no;
    const isDetachedFromTargetList = !targetNoSet.has(String(no));
    const status = row.status || '';
    const isExcluded = !isDetachedFromTargetList && statusExclude.includes(status);
    const isApproachable = !isExcluded;
    const logs = logsByCompany[key] || [];
    const rawLastLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const contactHist = historyMap.get(String(no)) || null;
    const latestContact = getLatestContactEntry(contactHist);
    const effectiveName = row.companyName || (contactHist ? contactHist.companyName : '') || ((typeof no === 'number' || typeof no === 'string') ? String(no) : '');
    const effectiveFormUrl = getKnownFormUrl(
      no,
      latestMonitorUrlByCompany.get(String(no)) || (latestContact && latestContact.formUrl) || row.formUrl || '',
      logs,
    );
    const submittedLogFromLogs = getLatestLog(logs, 'submitted');
    const latestContactImpliesSubmitted = doesHistoryContactRepresentSubmission(latestContact);
    const latestContactSubmittedAtText = latestContactImpliesSubmitted
      ? String(latestContact.sourceActionAt || latestContact.date || latestContact.timestamp || '').trim()
      : '';
    const latestContactSubmittedAtMs = getHistoryContactTimestamp(latestContact);
    const rawLastLogAtMs = parseEventTimestampMs(rawLastLog && rawLastLog.timestamp);
    const effectiveSubmittedLog = submittedLogFromLogs
      || buildHistorySubmittedLog(no, effectiveName, latestContact);
    const lastLog = latestContactSubmittedAtMs > rawLastLogAtMs
      ? buildHistorySubmittedLog(no, effectiveName, latestContact, rawLastLog)
      : rawLastLog;
    const effectiveLastAction = lastLog ? lastLog.action : null;
    const effectiveSubmittedAt = effectiveSubmittedLog
      ? String(effectiveSubmittedLog.timestamp || '').trim()
      : latestContactSubmittedAtText;

    stats.total++;
    if (!isDetachedFromTargetList && isExcluded) stats.excluded++;
    if (!isDetachedFromTargetList && isApproachable) {
      stats.approachable++;
      if (effectiveFormUrl) stats.hasFormUrl++; else stats.noFormUrl++;
    }
    if (lastLog) {
      if (effectiveLastAction === 'form_fill') stats.formFill++;
      if (effectiveLastAction === 'confirm_reached') stats.confirmReached++;
      if (effectiveLastAction === 'awaiting_approval') stats.awaitingApproval++;
      if (effectiveLastAction === 'submitted') stats.submitted++;
      if (effectiveLastAction === 'error') stats.error++;
    }

    const formFillLog = getLatestLog(logs, 'form_fill');
    const submittedLog = effectiveSubmittedLog;
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

    if (effectiveLastAction && ['form_fill', 'confirm_reached', 'awaiting_approval'].includes(effectiveLastAction)) {
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
      lastAction: effectiveLastAction,
      lastActionAt: lastLog ? lastLog.timestamp : null,
      lastLog,
      logs: logs.slice(-3).map(l => ({
        time: l.timestamp, action: l.action,
        details: typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '',
      })),
      hasInputScreenshot: screenshot.hasInput,
      hasConfirmScreenshot: screenshot.hasConfirm,
      hasSentScreenshot: screenshot.hasSent,
      hasAnyScreenshot: screenshot.hasAny,
      screenshotAuditState: screenshot.auditState,
      inputScreenshotName: screenshot.input ? path.basename(screenshot.input) : null,
      confirmScreenshotName: screenshot.confirm ? path.basename(screenshot.confirm) : null,
      sentScreenshotName: screenshot.sent ? path.basename(screenshot.sent) : null,
      readyForApproval: screenshot.readyForApproval,
      readyForManualApproval: requiresManualReview,
      manualReviewReason: screenshot.manualReviewReason || '',
      manualReviewDetail: screenshot.manualReviewDetail || '',
      captchaDetected: screenshot.captchaDetected,
      directSubmitDetected: screenshot.directSubmitDetected,
      sentMessage: displayDraftMessage,
      hasDraftMessage: !!displayDraftMessage,
      sentAt: effectiveSubmittedAt || null,
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
    trendLabels.push(i === 0 ? (_lang === 'ja' ? '今日' : 'Today') : i === 1 ? (_lang === 'ja' ? '昨日' : 'Yesterday') : (_lang === 'ja' ? `${i}日前` : `${i}d ago`));
    trendIndexByDay.set(d.toISOString().slice(0, 10), trendDays - 1 - i);
  }
  allLogs.forEach((log) => {
    if (!log.timestamp || log.companyNo == null) return;
    const timestamp = log.timestamp instanceof Date ? log.timestamp.toISOString() : String(log.timestamp || '');
    const idx = trendIndexByDay.get(timestamp.slice(0, 10));
    if (idx === undefined) return;
    if (log.action === 'form_fill' || log.action === 'confirm_reached' || log.action === 'awaiting_approval') trendActionNeededSets[idx].add(log.companyNo);
    if (log.action === 'submitted') trendSentSets[idx].add(log.companyNo);
    if (log.action === 'error') trendErrorSets[idx].add(log.companyNo);
  });
  historyMap.forEach((history, companyNo) => {
    const contacts = history && Array.isArray(history.contacts) ? history.contacts : [];
    contacts.forEach((contact) => {
      if (String(contact && contact.status || '').trim() !== 'submitted') return;
      const dateValue = contact.sourceActionAt || contact.date || contact.sentAt || '';
      const isoDay = (() => {
        const parsed = Date.parse(String(dateValue || ''));
        return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
      })();
      if (!isoDay) return;
      const idx = trendIndexByDay.get(isoDay);
      if (idx === undefined) return;
      trendSentSets[idx].add(Number(companyNo));
    });
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
    liveMonitor: buildMonitorPayload(allLogs),
    runtime,
    trendData: { labels: trendLabels, actionNeeded: trendActionNeeded, sent: trendSent, error: trendError },
  };
}

function loadData(options = {}) {
  const force = !!options.force;
  const cacheKey = getDashboardDataCacheKey();
  if (!force && dashboardDataCacheValue && dashboardDataCacheKey === cacheKey) {
    dashboardDataCacheValue.cacheKey = cacheKey;
    return dashboardDataCacheValue;
  }
  const data = buildDashboardDataFromSources();
  data.cacheKey = cacheKey;
  dashboardDataCacheKey = cacheKey;
  dashboardDataCacheValue = data;
  dashboardDataCacheBuiltAt = Date.now();
  return data;
}

// JSON body parser helper
// デフォルトのリクエストボディ最大サイズ (2 MiB)
// マッピング JSON / 設定 JSON を許容しつつ、意図的な memory 圧迫を防ぐ。
const PARSE_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

function parseJsonBody(req, maxBytes = PARSE_JSON_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > maxBytes) {
        aborted = true;
        const err = new Error('Request body too large');
        err.code = 'BODY_TOO_LARGE';
        err.maxBytes = maxBytes;
        try { req.destroy(); } catch (_) {}
        reject(err);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

// JSON response helper
function jsonResponse(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

// HTML テンプレート
function buildPage() {
  const _lang = settings.getSection('preferences').language || 'ja';
  const _tz = settings.getSection('preferences').timezone || 'Asia/Tokyo';
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
<!-- ローカルバンドル: フォント・Material Symbols・Phosphor・Tailwind (全てオフライン動作) -->
<link rel="stylesheet" href="/assets/vendor/fonts.css">
<link rel="stylesheet" href="/assets/vendor/material-symbols.css">
<link rel="stylesheet" href="/assets/vendor/phosphor.css">
<link rel="stylesheet" href="/assets/vendor/tailwind.css">
<style>
${renderStyles()}
</style>
<script>
// Early theme init (FOUC prevention) — runs before body renders.
(function(){
  try{
    var saved=localStorage.getItem('dashboardTheme');
    var prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme=saved||(prefersDark?'dark':'light');
    document.documentElement.setAttribute('data-theme',theme);
  }catch(_){ document.documentElement.setAttribute('data-theme','light'); }
})();
</script>
</head>
<body class="${APP_BUILD_SOURCE === 'installed' ? 'desktop-build perf-mode' : ''}">
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
  <!-- Icon-only action buttons -->
  <div style="display:flex;align-items:center;gap:2px">
    <button class="theme-toggle" onclick="toggleTheme()" title="${_lang === 'ja' ? 'テーマ切替' : 'Toggle theme'}" aria-label="Toggle theme">
      <span class="ti sun"><span class="material-symbols-outlined" style="font-size:18px">light_mode</span></span>
      <span class="ti moon"><span class="material-symbols-outlined" style="font-size:18px">dark_mode</span></span>
    </button>
    <button onclick="showDocsModal()" title="${_t['app.docsTitle'] || 'Guide'}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .15s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)';this.style.borderColor='var(--border-default)'" onmouseout="this.style.background='none';this.style.color='var(--text-3)';this.style.borderColor='transparent'">
      <span class="material-symbols-outlined" style="font-size:18px">menu_book</span>
    </button>
    <button onclick="location.href='/api/export'" title="${_t['app.export'] || 'Export'}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .15s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)';this.style.borderColor='var(--border-default)'" onmouseout="this.style.background='none';this.style.color='var(--text-3)';this.style.borderColor='transparent'">
      <span class="material-symbols-outlined" style="font-size:18px">download</span>
    </button>
    <button id="memoBtn" onclick="toggleMemoPanel()" title="${_lang === 'ja' ? '運用メモ' : 'Notes'}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .15s;border-radius:var(--radius-sm);position:relative" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)';this.style.borderColor='var(--border-default)'" onmouseout="this.style.background='none';this.style.color='var(--text-3)';this.style.borderColor='transparent'">
      <span class="material-symbols-outlined" style="font-size:18px">sticky_note_2</span>
      <span id="memoBadge" style="position:absolute;top:2px;right:2px;min-width:14px;height:14px;background:var(--error);color:#fff;font-size:.5rem;font-weight:800;border-radius:7px;line-height:14px;text-align:center;display:none">0</span>
    </button>
  </div>
</header>

<!-- 運用メモパネル (dropdown) -->
<div id="memoPanel"></div>

<!-- sidebarLastUpdate hidden element (kept for JS compat) -->
<span id="sidebarLastUpdate" style="display:none"></span>
<span id="headerLastUpdate" style="display:none"></span>

<!-- Auto-update banner (shown by pollUpdateStatus) -->
<div id="updateBanner" style="display:none;position:fixed;top:48px;left:0;right:0;z-index:49;background:#2563eb;color:#fff;padding:6px 16px;font-size:.75rem;font-weight:600;align-items:center;gap:8px;justify-content:center"></div>

<!-- Docs Modal -->
<!-- AI 起動モード選択モーダル -->
<div id="launchModal" class="launch-modal-shell" onclick="if(event.target===this)closeLaunchModal()">
  <div class="launch-modal-panel">
    <!-- HEAD -->
    <div class="launch-head">
      <div id="launchModalHeaderIcon" class="launch-head-icon">
        <img src="/assets/vendor/ai-icons/claude-code.svg" width="26" height="26" alt="Claude Code">
      </div>
      <div class="launch-head-copy">
        <div id="launchProviderTitle" class="launch-head-title">${_lang === 'ja' ? 'AI を起動' : 'Launch AI'}</div>
        <div id="launchProviderSubtitle" class="launch-head-sub">${_lang === 'ja' ? 'CLI 環境で AI を起動します' : 'Launch AI in CLI environment'}</div>
      </div>
      <button class="launch-close" onclick="closeLaunchModal()" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
      <div id="launchModalHeader" style="display:none"></div>
    </div>
    <div class="launch-divider"></div>

    <!-- BODY -->
    <div class="launch-body">
      <!-- AI モデル -->
      <section class="launch-section">
        <div class="launch-section-label">${_lang === 'ja' ? 'AI モデル' : 'AI model'}</div>
        <div class="launch-providers">
          <div id="launchProviderCard_claude" class="launch-provider-card claude" onclick="selectLaunchProvider('claude')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="claude">
              <img src="/assets/vendor/ai-icons/claude-code.svg" width="26" height="26" alt="Claude Code">
            </div>
            <div class="lp-name">Claude</div>
            <div class="lp-sub">Anthropic</div>
          </div>
          <div id="launchProviderCard_codex" class="launch-provider-card codex" onclick="selectLaunchProvider('codex')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="codex">
              <img src="/assets/vendor/ai-icons/codex-openai.svg" width="26" height="26" alt="Codex">
            </div>
            <div class="lp-name">CodeX</div>
            <div class="lp-sub">OpenAI</div>
          </div>
          <div id="launchProviderCard_gemini" class="launch-provider-card gemini" onclick="selectLaunchProvider('gemini')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="gemini">
              <img src="/assets/vendor/ai-icons/gemini-cli.svg" width="26" height="26" alt="Gemini CLI">
            </div>
            <div class="lp-name">Gemini</div>
            <div class="lp-sub">Google</div>
          </div>
        </div>
        <select id="launchProviderSelect" style="display:none">${providerSelectHtml}</select>
        <div id="launchProviderBadge" style="display:none"></div>
      </section>

      <!-- 起動モード -->
      <section class="launch-section">
        <div class="launch-section-label">${_lang === 'ja' ? '起動モード' : 'Launch mode'}</div>
        <div class="launch-modes">
          <div id="launchOpt_auto" class="launch-mode-card recommended" onclick="selectLaunchMode('auto')">
            <input type="radio" name="launchMode" value="auto" style="display:none">
            <div id="launchOptTag_auto" class="launch-mode-tag">${_lang === 'ja' ? '推奨' : 'Recommended'}</div>
            <div class="launch-mode-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 L3 14 H12 L11 22 L21 10 H12 Z"/></svg>
            </div>
            <div id="launchOptTitle_auto" class="launch-mode-title">${_lang === 'ja' ? '推奨: 完全自動' : 'Recommended: Auto'}</div>
            <div id="launchOptDesc_auto" class="launch-mode-desc">${_lang === 'ja' ? '最もスムーズに開始' : 'Start with smoothest flow'}</div>
            <div id="launchCheck_auto" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
          </div>
          <div id="launchOpt_bypassPermissions" class="launch-mode-card danger" onclick="selectLaunchMode('bypassPermissions')">
            <input type="radio" name="launchMode" value="bypassPermissions" style="display:none">
            <div id="launchOptTag_bypassPermissions" class="launch-mode-tag">${_lang === 'ja' ? '危険' : 'Danger'}</div>
            <div class="launch-mode-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="13" y1="15" x2="17" y2="15"/></svg>
            </div>
            <div id="launchOptTitle_bypassPermissions" class="launch-mode-title">${_lang === 'ja' ? '権限スキップ（危険）' : 'Skip permissions (danger)'}</div>
            <div id="launchOptDesc_bypassPermissions" class="launch-mode-desc">${_lang === 'ja' ? '確認をスキップして起動' : 'Skip approvals on launch'}</div>
            <div id="launchCheck_bypassPermissions" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
          </div>
        </div>
      </section>

      <!-- 送信ポリシー -->
      <section class="launch-section">
        <div class="launch-section-label">${_t['launch.submitPolicy.title'] || (_lang === 'ja' ? '送信ポリシー' : 'Submission policy')}</div>
        <div class="launch-policy-select">
          <select id="launchAutoSendSafeSelect" onchange="setLaunchAutoSendSafe(this.value === 'true')">
            <option value="false">${_t['launch.submitPolicy.approval'] || (_lang === 'ja' ? '確認待ちで止める（推奨）' : 'Stop for approval (recommended)')}</option>
            <option value="true">${_t['launch.submitPolicy.autoSendSafe'] || (_lang === 'ja' ? '安全なフォームは自動送信する' : 'Auto-send safe forms')}</option>
          </select>
          <span class="material-symbols-outlined launch-policy-arrow">expand_more</span>
        </div>
        <div class="launch-policy-note">
          <span class="material-symbols-outlined">verified_user</span>
          <span id="launchAutoSendSafeHelp">${_t['launch.submitPolicy.help'] || (_lang === 'ja' ? '機密情報や個人情報を保護するための安全な設定です。' : 'Safe defaults to protect confidential and personal data.')}</span>
        </div>
      </section>

      <!-- Advanced area -->
      <div id="launchAdvancedModes" style="display:none">
        <section class="launch-section">
          <div class="launch-section-label">${_lang === 'ja' ? '開発者向けモード' : 'Developer modes'}</div>
          <div class="launch-modes">
            <div id="launchOpt_default" class="launch-mode-card dev" onclick="selectLaunchMode('default')">
              <input type="radio" name="launchMode" value="default" style="display:none">
              <div id="launchOptTag_default" class="launch-mode-tag">${_lang === 'ja' ? '開発' : 'Dev'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
              </div>
              <div id="launchOptTitle_default" class="launch-mode-title">default</div>
              <div id="launchOptDesc_default" class="launch-mode-desc">${_lang === 'ja' ? '標準。CLIの許可プロンプトで止まることがあります' : 'Default. May stop on CLI permission prompts.'}</div>
              <div id="launchCheck_default" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
            <div id="launchOpt_acceptEdits" class="launch-mode-card dev" onclick="selectLaunchMode('acceptEdits')">
              <input type="radio" name="launchMode" value="acceptEdits" style="display:none">
              <div id="launchOptTag_acceptEdits" class="launch-mode-tag">${_lang === 'ja' ? '開発' : 'Dev'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div id="launchOptTitle_acceptEdits" class="launch-mode-title">acceptEdits</div>
              <div id="launchOptDesc_acceptEdits" class="launch-mode-desc">${_lang === 'ja' ? '編集は通り、コマンドやブラウザは確認待ちで止まることがあります' : 'Edits flow; commands/browser may still pause.'}</div>
              <div id="launchCheck_acceptEdits" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
          </div>
        </section>
        <section class="launch-section">
          <div id="launchSetupDiagnostics" class="launch-diag">
            <div class="launch-diag-head" onclick="toggleDiagPanel()">
              <div class="launch-diag-head-left">
                <div class="launch-section-label" style="margin:0">${_lang === 'ja' ? 'セットアップ診断' : 'Setup diagnostics'}</div>
                <div id="launchDiagBadge" class="launch-diag-badge"></div>
              </div>
              <span id="launchDiagArrow" class="launch-diag-arrow">▼</span>
            </div>
            <div id="launchSetupDiagnosticsBody" class="launch-diag-body">${_lang === 'ja' ? '診断を読み込み中...' : 'Loading diagnostics...'}</div>
          </div>
        </section>
      </div>
    </div>

    <!-- FOOT -->
    <div class="launch-foot">
      <button id="launchAdvancedToggle" class="launch-advanced-link" type="button" onclick="toggleLaunchAdvancedModes()">
        <span class="material-symbols-outlined">settings</span>
        ${_lang === 'ja' ? '詳細設定' : 'Advanced'}
      </button>
      <div class="launch-foot-actions">
        <button class="launch-cancel" onclick="closeLaunchModal()">${_lang === 'ja' ? 'キャンセル' : 'Cancel'}</button>
        <button id="launchExternalBtn" class="launch-external" onclick="confirmExternalLaunch()" style="display:none">${_lang === 'ja' ? '外部で開く' : 'Open External'}</button>
        <button id="launchConfirmBtn" class="launch-confirm-btn" onclick="confirmLaunch()">
          <span class="material-symbols-outlined">play_arrow</span>
          ${_lang === 'ja' ? 'AI を起動' : 'Launch AI'}
        </button>
      </div>
      <div id="launchSelectedLabel" style="display:none"></div>
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
  <div class="modal-panel hud-modal">
    <span class="hud-corner hud-corner-tl"></span>
    <span class="hud-corner hud-corner-tr"></span>
    <span class="hud-corner hud-corner-bl"></span>
    <span class="hud-corner hud-corner-br"></span>

    <div class="modal-head hud-head">
      <div class="hud-head-icon">
        <svg viewBox="0 0 52 58" fill="none" aria-hidden="true">
          <path d="M26 2 L48 14.5 V43.5 L26 56 L4 43.5 V14.5 Z" stroke="currentColor" stroke-width="1.3" fill="color-mix(in srgb, currentColor 6%, transparent)"/>
        </svg>
        <span class="material-symbols-outlined hud-head-sym">apartment</span>
      </div>
      <div class="hud-head-copy">
        <h3 id="companyFormTitle">${_t['companyModal.title'] || 'Add Company'}</h3>
        <span class="hud-head-sub" id="companyFormSub">ADD COMPANY</span>
      </div>
      <button class="hud-close" onclick="closeCompanyFormModal()" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="hud-scanline"></div>

    <div class="modal-body hud-body">
      <input type="hidden" id="companyFormMode" value="create">
      <input type="hidden" id="companyFormCompanyNo" value="">
      <div class="modal-grid">
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">apartment</span>${_t['field.companyName']}</label>
          <input type="text" id="new-companyName" placeholder="${_t['ph.companyName']}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">category</span>${_t['field.type'] || (_lang === 'ja' ? '種別' : 'Type')}</label>
          <input type="text" id="new-type" placeholder="${_lang === 'ja' ? '例: SIer / SaaS / 製造' : 'e.g. SIer / SaaS / Manufacturing'}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">language</span>${_t['field.website']}</label>
          <input type="text" id="new-url" placeholder="https://example.com">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">link</span>${_t['field.colFormUrl']}</label>
          <input type="text" id="new-formUrl" placeholder="https://example.com/contact">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">radio_button_unchecked</span>${_t['field.colStatus']}</label>
          <input type="text" id="new-status" placeholder="${_lang === 'ja' ? '例: ○ / 空欄' : 'e.g. target'}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">trending_up</span>${_t['field.colProgress']}</label>
          <input type="text" id="new-progress" placeholder="${_lang === 'ja' ? '任意' : 'Optional'}">
        </div>
        <div class="settings-group hud-field modal-grid-full">
          <label><span class="material-symbols-outlined">description</span>${_t['field.colNotes']}</label>
          <textarea id="new-notes" placeholder="${_lang === 'ja' ? '社内メモや補足' : 'Internal note'}"></textarea>
        </div>
      </div>
      <label class="hud-check">
        <input type="checkbox" id="new-addTarget" checked>
        <span class="hud-check-box"></span>
        <span class="hud-check-text">${_t['companyModal.addToTarget'] || 'Add this company to outreach targets'}</span>
      </label>
    </div>
    <div class="hud-scanline hud-scanline-bottom"></div>
    <div class="modal-actions hud-actions">
      <button class="btn btn-outline-secondary" onclick="closeCompanyFormModal()">${_t['companyModal.cancel'] || 'Cancel'}</button>
      <button class="btn btn-primary hud-btn-primary" id="companyFormSubmitBtn" onclick="submitCompanyForm()">${_t['companyModal.submit'] || 'Add Company'}</button>
    </div>
  </div>
</div>

<!-- Main content area -->
<main style="margin-top:48px;padding:0;min-height:calc(100vh - 48px);background:var(--surface)">

<!-- Horizontal tab nav -->
<div id="mainTabNav">
  <button class="tab-btn active" data-tab="dashboard">
    <span class="material-symbols-outlined tab-icon">dashboard</span>
    ${_lang === 'ja' ? 'ダッシュボード' : 'Dashboard'}
  </button>
  <button class="tab-btn" data-tab="companies">
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

<div style="padding:16px;display:flex;gap:16px;align-items:flex-start">
  <!-- Main content column -->
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">

  <!-- Dashboard tab: analytics-only view -->
  <div class="tab-content active" id="tab-dashboard">
  <div id="analyticsRow" class="chart-panel" style="padding:20px 22px;display:flex;flex-direction:column;margin-bottom:0;gap:0">
    <!-- HERO: donut + ratio + live badge -->
    <div class="analytics-hero">
      <div class="analytics-donut">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="donutGradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#3b82f6"/>
              <stop offset="100%" stop-color="#818cf8"/>
            </linearGradient>
          </defs>
          <circle class="donut-track" cx="60" cy="60" r="52"/>
          <circle class="donut-fill" id="analyticsDonutFill" cx="60" cy="60" r="52" stroke-dasharray="326.7" stroke-dashoffset="326.7"/>
        </svg>
        <div class="analytics-donut-center">
          <span class="analytics-donut-num" id="analyticsPercent">0</span>
          <span class="analytics-donut-suffix">%</span>
          <span class="analytics-donut-label">${_lang === 'ja' ? '完了率' : 'Complete'}</span>
        </div>
      </div>
      <div class="analytics-hero-main">
        <div class="analytics-hero-title">
          <span class="num" id="analyticsSubmittedNum">0</span>
          <span class="ratio" id="analyticsRatio">/ 0</span>
          <span class="lab">${_lang === 'ja' ? '送信済み' : 'Sent'}</span>
        </div>
        <div class="analytics-pipeline-bar" id="analyticsPipeline">
          <span id="analyticsProgressBar" style="background:linear-gradient(90deg,#3b82f6,#6366f1);width:0%"></span>
        </div>
      </div>
      <div class="analytics-meta">
        <div class="analytics-live"><span class="analytics-live-dot"></span>Live</div>
        <div class="analytics-meta-sum" id="analyticsMetaSum">0 / 0 ${_lang === 'ja' ? '完了' : 'done'} (0%)</div>
      </div>
    </div>

    <!-- STAT CARDS (7 icons + numbers) -->
    <div class="stat-cards-row">
      <div class="stat-card-v2" style="--_c:#6366f1">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">adjust</span></div>
          <div class="stat-card-v2-label">${_t['stats.target'] || (_lang==='ja'?'対象':'Target')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-approachable">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'全体の件数':'Total'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#94a3b8">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">contact_page</span></div>
          <div class="stat-card-v2-label">${_t['stats.hasForm'] || (_lang==='ja'?'フォーム有':'Has form')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-hasFormUrl">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'フォーム送信あり':'Submittable'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#10b981">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">mark_email_read</span></div>
          <div class="stat-card-v2-label">${_t['stats.sent'] || (_lang==='ja'?'送信済み':'Sent')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-submitted">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'送信が完了した件数':'Completed'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#3b82f6">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">task_alt</span></div>
          <div class="stat-card-v2-label">${_t['stats.filled'] || (_lang==='ja'?'要対応':'Action')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-formFill">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'対応が必要な件数':'Needs action'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#f59e0b">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">hourglass_empty</span></div>
          <div class="stat-card-v2-label">${_t['stats.awaiting'] || (_lang==='ja'?'確認待ち':'Awaiting')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-awaitingApproval">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'確認待ちの件数':'Awaiting approval'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#ef4444">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">error_outline</span></div>
          <div class="stat-card-v2-label">${_t['stats.error'] || (_lang==='ja'?'エラー':'Errors')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-error">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'エラーの件数':'Error count'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#64748b">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">block</span></div>
          <div class="stat-card-v2-label">${_t['stats.excluded'] || (_lang==='ja'?'除外':'Excluded')}</div>
        </div>
        <div class="stat-card-v2-num" id="s-excluded">0</div>
        <div class="stat-card-v2-note">${_lang==='ja'?'対象外の件数':'Excluded'}</div>
      </div>
    </div>

    <!-- TREND CHART -->
    <div class="analytics-trend-panel">
      <div class="analytics-trend-head">
        <div class="analytics-trend-title">${_lang === 'ja' ? '処理推移' : 'Processing trend'}</div>
        <div class="analytics-trend-legend">
          <span class="lg"><span class="dot" style="background:#10b981"></span>${_lang === 'ja' ? '送信済み' : 'Sent'}</span>
          <span class="lg"><span class="dot" style="background:#3b82f6"></span>${_lang === 'ja' ? '要対応' : 'Action'}</span>
          <span class="lg" style="color:#ef4444"><span class="dash"></span>${_lang === 'ja' ? 'エラー' : 'Error'}</span>
        </div>
        <div class="analytics-trend-range"><span class="material-symbols-outlined">calendar_month</span>${_lang === 'ja' ? '7日間' : '7 days'}</div>
      </div>
      <div class="analytics-trend-body"><canvas id="trendAreaChart"></canvas></div>
    </div>

    <!-- 3-COLUMN GRID: breakdown donut + daily bars + recent errors -->
    <div class="analytics-grid">
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">${_lang === 'ja' ? 'ステータス内訳' : 'Status breakdown'}</div>
        <div class="breakdown-row">
          <div class="breakdown-donut-wrap">
            <svg viewBox="0 0 120 120" id="breakdownDonutSvg" aria-hidden="true">
              <circle cx="60" cy="60" r="46" fill="none" stroke="var(--bg-raised)" stroke-width="14"/>
            </svg>
            <div class="breakdown-donut-center">
              <div class="breakdown-donut-total" id="breakdownTotal">0</div>
              <div class="breakdown-donut-total-lab">${_lang === 'ja' ? '対象件数' : 'Total'}</div>
            </div>
          </div>
          <div class="breakdown-legend" id="breakdownLegend"></div>
        </div>
      </div>
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">${_lang === 'ja' ? '日別送信数' : 'Daily sent'}</div>
        <div class="daily-bars"><canvas id="dailyBarsChart"></canvas></div>
      </div>
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">
          <span>${_lang === 'ja' ? '最近のエラー' : 'Recent errors'}</span>
          <button class="analytics-sub-action" onclick="showAllErrors()">${_lang === 'ja' ? 'すべて表示' : 'View all'}</button>
        </div>
        <div class="recent-errors" id="recentErrorsList">
          <div class="recent-errors-empty">${_lang === 'ja' ? 'エラーはありません' : 'No errors'}</div>
        </div>
      </div>
    </div>

    <!-- INSIGHT CARD with wave deco -->
    <div class="insight-card">
      <div class="insight-icon"><span class="material-symbols-outlined">lightbulb</span></div>
      <div class="insight-body">
        <div class="insight-title">${_lang === 'ja' ? 'インサイト' : 'Insight'}</div>
        <div class="insight-desc" id="insightDesc">${_lang === 'ja' ? '送信データを集計中...' : 'Aggregating data...'}</div>
      </div>
      <svg class="insight-wave" viewBox="0 0 500 120" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="waveGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#10b981" stop-opacity=".55"/>
            <stop offset="50%" stop-color="#3b82f6" stop-opacity=".55"/>
            <stop offset="100%" stop-color="#a78bfa" stop-opacity=".45"/>
          </linearGradient>
        </defs>
        <path d="M0,60 Q100,20 200,60 T400,60 L500,60" fill="none" stroke="url(#waveGradient)" stroke-width="1.8"/>
        <path d="M0,80 Q125,40 250,80 T500,80" fill="none" stroke="url(#waveGradient)" stroke-width="1.3" opacity=".75"/>
        <path d="M0,40 Q75,90 150,40 T300,40 T450,40 L500,40" fill="none" stroke="url(#waveGradient)" stroke-width="1" opacity=".55"/>
      </svg>
    </div>

    <!-- Legacy hidden refs (kept for backward JS compat) -->
    <div style="display:none">
      <canvas id="statusDonutChart"></canvas>
      <span id="progressLabel"></span>
      <div id="pipeline" class="progress-pipeline"></div>
    </div>
  </div>
  </div>

  <!-- Companies tab (inside main column) -->
  <div class="tab-content" id="tab-companies">
    <div class="company-toolbar" style="flex-direction:column;gap:0">
      <!-- Row 1: Bulk action buttons -->
      <div class="bulk-toolbar" style="justify-content:flex-end">
        <button class="btn btn-outline-primary btn-sm" onclick="triggerCompanyImport()">${_t['action.importTargets'] || 'Import Excel/CSV'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="openCompanyFormModal()">${_t['action.addCompany'] || 'Add Company'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="toggleAllCompanies()">${_t['action.selectAll']}</button>
        <button class="btn btn-outline-danger btn-sm" onclick="bulkDeleteCompanies()">${_t['action.bulkDeleteCompanies'] || 'Delete Selected'}</button>
        <button class="btn btn-outline-primary btn-sm" onclick="markSelectedTargets(true)">${_t['action.markTarget'] || 'Mark Target'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="markSelectedTargets(false)">${_t['action.unmarkTarget'] || 'Unmark Target'}</button>
        <button class="btn btn-primary btn-sm" onclick="prepareSelectedOutreach()">${_t['action.prepareOutreach'] || 'Prepare Outreach'}</button>
      </div>
      <!-- Row 2: Unified filter bar (pills + filter fields + search) -->
      <div class="filter-bar filter-bar-unified">
        <div class="filter-pills">
          <button class="fb active" data-f="all">${_t['filter.all']}</button>
          <button class="fb" data-f="approachable">${_t['filter.target']}</button>
          <button class="fb" data-f="targeted">${_t['filter.targeted'] || '営業対象'}</button>
          <button class="fb" data-f="has-form">${_t['filter.hasForm']}</button>
          <button class="fb" data-f="no-form">${_t['filter.noForm']}</button>
          <button class="fb" data-f="submitted">${_t['filter.sent']}</button>
          <button class="fb" data-f="error">${_t['filter.error']}</button>
          <button class="fb" data-f="excluded">${_t['filter.excluded']}</button>
        </div>
        <span class="filter-bar-divider" aria-hidden="true"></span>
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
    <div class="table-shell table-shell-scroll">
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
    <div style="background:#fff;border:1px solid var(--outline-variant);border-bottom:2px solid #059669;padding:12px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        <span class="material-symbols-outlined" style="font-size:16px;color:#059669">mark_email_read</span>
        <div style="display:flex;flex-direction:column;gap:2px">
          <strong style="font-size:.76rem;color:var(--on-surface)">${_t['sent.panelTitle'] || (_lang === 'ja' ? '送信済みログ' : 'Sent log')}</strong>
          <span style="font-size:.66rem;color:var(--outline)">${_t['sent.panelHint'] || (_lang === 'ja' ? '企業名・種別・本文・フォームURLで絞り込みできます' : 'Filter by company, type, message body, or form URL.')}</span>
        </div>
      </div>
      <input type="text" id="sentSearch" class="form-control-sm" style="width:280px;max-width:100%" placeholder="${_t['sent.search'] || (_lang === 'ja' ? '企業名・種別・本文・フォームURLで検索...' : 'Search company, type, message, or URL...')}">
      <select id="sentTypeFilter" class="form-control-sm" style="width:180px;max-width:100%">
        <option value="">${_lang === 'ja' ? '種別: すべて' : 'Type: All'}</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button class="fb-sent fb active" data-sf="all">${_t['sent.all']}</button>
        <button class="fb-sent fb" data-sf="1">${_t['sent.firstOnly']}</button>
        <button class="fb-sent fb" data-sf="2+">${_t['sent.multipleOnly']}</button>
      </div>
      <small style="margin-left:auto;font-family:var(--font-mono);font-size:.68rem;color:var(--outline)" id="sentCount">0 items</small>
    </div>
    <div id="sentList" style="padding:16px;background:var(--bg-base)"></div>
  </div>

  <!-- CLI Activity tab -->
  <div class="tab-content" id="tab-logs">
    <div style="background:#fff;border:1px solid var(--outline-variant);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--on-surface)">${_lang==='ja' ? 'リアルタイムCLI' : 'Live CLI'}</span>
          <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="cliStreamLastEvent">—</span>
        </div>
      </div>
      <div id="cliThinkingRow" style="display:none;align-items:center;gap:8px;padding:10px 16px;background:rgba(99,102,241,.08);border-bottom:1px solid rgba(99,102,241,.16)">
        <span class="think-spin"></span>
        <span id="cliThinkingText" style="font-size:.76rem;color:#6366f1;font-style:italic;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_lang==='ja' ? '思考中...' : 'Thinking...'}</span>
      </div>
      <div id="cliStream" style="max-height:180px;overflow:auto;padding:10px 16px;background:var(--bg-card)"></div>
    </div>
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
            <label>${_t['field.autoSendEligibleForms']}</label>
            <select id="pf-autoSendEligibleForms">
              <option value="false">${_t['field.yesNo.no']}</option>
              <option value="true">${_t['field.yesNo.yes']}</option>
            </select>
            <div class="help-text">${_t['help.autoSendEligibleForms']}</div>
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
  </div><!-- /main-column -->
</div><!-- /padding:16px flex container -->

<!-- Floating Chat-style Live Monitor -->
<!-- Toast notification (shows when panel is closed) -->
<div id="monitorToast" style="position:fixed;bottom:80px;right:24px;z-index:9990;max-width:320px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-md);box-shadow:var(--shadow-modal);padding:10px 14px;display:none;animation:monitorToastIn .3s var(--ease-spring);cursor:pointer" onclick="toggleMonitorPanel()">
  <div style="display:flex;align-items:flex-start;gap:8px">
    <span id="monitorToastDot" style="width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0;margin-top:3px"></span>
    <div style="min-width:0;flex:1">
      <div id="monitorToastCompany" style="font-size:.75rem;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
      <div id="monitorToastStep" style="font-size:.68rem;color:var(--text-2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
    </div>
    <span style="font-size:.6rem;color:var(--text-3);font-family:var(--font-mono);flex-shrink:0" id="monitorToastTime">--:--</span>
  </div>
</div>

<!-- Floating toggle button -->
<button id="monitorFab" onclick="toggleMonitorPanel()" style="position:fixed;bottom:24px;right:24px;z-index:9991;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#1a1a1a,#1e293b);color:#eeefeb;border:none;cursor:pointer;box-shadow:var(--shadow-modal);display:flex;align-items:center;justify-content:center;transition:all .25s var(--ease-out-expo)" onmouseover="this.style.transform='scale(1.08)'" onmouseout="this.style.transform='scale(1)'">
  <span id="monitorDot" style="position:absolute;top:10px;right:10px;width:10px;height:10px;border-radius:50%;background:#9a9a96;transition:background .3s;border:2px solid #1a1a1a"></span>
  <span id="monitorFabBadge" style="display:none;position:absolute;top:0;right:0;min-width:18px;height:18px;background:var(--error);color:#fff;font-size:.6rem;font-weight:800;border-radius:9px;padding:0 5px;line-height:18px;text-align:center;border:2px solid #fff;font-family:var(--font-mono)">0</span>
  <span class="material-symbols-outlined" style="font-size:22px">chat</span>
</button>

<!-- Floating panel -->
<div id="liveMonitorCard" style="position:fixed;bottom:84px;right:24px;z-index:9989;width:420px;max-height:min(600px,calc(100vh - 120px));background:var(--bg-card);border:1px solid var(--border-default);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.08);display:none;flex-direction:column;animation:monitorPanelIn .25s var(--ease-out-expo)">
  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(135deg,#1a1a1a 0%,#1e293b 100%);user-select:none;flex-shrink:0">
    <span class="material-symbols-outlined" style="font-size:16px;color:#eeefeb">monitoring</span>
    <span style="font-size:.72rem;font-weight:700;color:#eeefeb;flex:1">Live Activity</span>
    <div id="monitorStatusChip" style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);color:#9a9a96;font-size:.56rem;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.04em">${_lang === 'ja' ? '待機中' : 'Idle'}</div>
    <button id="liveMonitorToggleBtn" onclick="toggleMonitorPanel()" style="display:inline-flex;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#eeefeb;font-size:14px;padding:3px;border-radius:6px;cursor:pointer;transition:all .15s;line-height:1" onmouseover="this.style.background='rgba(255,255,255,.2)'" onmouseout="this.style.background='rgba(255,255,255,.08)'">✕</button>
  </div>

  <!-- Body -->
  <div id="liveMonitorBody" style="display:flex;flex-direction:column;flex:1;overflow:hidden">
    <!-- Compact Latest Activity -->
    <div style="padding:8px 14px;border-bottom:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="min-width:0;flex:1">
          <div id="monitorCompany" style="font-size:.78rem;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
          <div id="monitorStep" style="font-size:.68rem;color:var(--text-2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
        </div>
        <div id="monitorUpdatedAt" style="font-size:.58rem;font-family:var(--font-mono);color:var(--text-3);white-space:nowrap;flex-shrink:0">-</div>
      </div>
    </div>

    <!-- Thinking indicator -->
    <div id="monitorThinkingRow" style="display:none;align-items:center;gap:8px;padding:6px 14px;background:linear-gradient(90deg,rgba(99,102,241,.06),transparent);border-bottom:1px solid rgba(99,102,241,.1);flex-shrink:0">
      <span class="think-spin"></span>
      <span id="monitorThinkingText" style="font-size:.68rem;color:#6366f1;font-style:italic;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">思考中...</span>
    </div>
    <div id="monitorActiveSummary" style="display:none">-</div>

    <!-- Event List (scrollable, chat-style) -->
    <div id="monitorEventList" style="display:flex;flex-direction:column;flex:1;overflow-y:auto;background:var(--bg-card);overscroll-behavior:contain;padding:4px 0"></div>

    <!-- Collapsible footer: URL + Screenshot -->
    <div id="monitorFooter" style="border-top:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0">
      <div style="display:flex;align-items:center;gap:6px;padding:6px 14px">
        <a id="monitorCurrentUrl" href="#" target="_blank" style="flex:1;font-size:.62rem;color:var(--primary);font-family:var(--font-mono);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</a>
        <a id="monitorScreenshotLink" href="#" target="_blank" style="display:none;font-size:.58rem;color:var(--primary);text-decoration:none;font-weight:700;white-space:nowrap">${_lang === 'ja' ? 'スクショ ↗' : 'SS ↗'}</a>
      </div>
      <div id="monitorScreenshotWrap" style="display:none;margin:0 14px 8px;max-height:100px;overflow:auto;overscroll-behavior:contain;border:1px dashed var(--border-default);border-radius:var(--radius-sm);background:var(--bg-deep)"></div>
    </div>
  </div>
</div>
</main>

<script>
const LANG = ${serializeForInlineScript(_lang)};
const PREF_TZ = ${serializeForInlineScript(_tz)};
const I18N = ${serializeForInlineScript(_t)};
const AVAILABLE_AI_PROVIDERS = ${serializeForInlineScript(providerOptions)};
const DASHBOARD_SESSION_TOKEN = ${serializeForInlineScript(ensureDashboardSessionToken())};
const DASHBOARD_SESSION_COOKIE_NAME = ${serializeForInlineScript(getDashboardSessionCookieName())};
const NATIVE_DIRECTORY_PICKER_AVAILABLE = ${process.versions.electron ? 'true' : 'false'};
const BUILD_SOURCE = ${serializeForInlineScript(APP_BUILD_SOURCE)};
${renderAwaitingCardRedesignScript()}
${renderDashboardScript()}
${renderAnalyticsScript()}
${renderColumnResizerScript()}
</script>

</body>
</html>`;
}

// Settings API dispatcher (src/routes/settings-api.cjs に分離済み)
// lazy-init: 初回リクエストで factory を呼んで dispatcher を取得する。
// ctx に渡す関数群はすべて function 宣言で hoisting 済み。
let _settingsApiDispatch = null;
function getSettingsApiDispatch() {
  if (!_settingsApiDispatch) {
    _settingsApiDispatch = require('./routes/settings-api.cjs')({
      jsonResponse,
      parseJsonBody,
      notifyClients,
      refreshWatchTargets,
      openDirectoryPicker,
      toStoredProjectPath,
      loadData,
      purgeHistoryOnlyCompany,
      findRuntimeCompanyRecord,
    });
  }
  return _settingsApiDispatch;
}

// Simple API dispatcher (src/routes/simple-api.cjs)
// /api/cli-log, /api/install-update, /api/update-status, /api/export, /api/data,
// /api/claude-status, /api/ai/status, /api/ai/setup-diagnostics, /api/ai-submit*
let _simpleApiDispatch = null;
function getSimpleApiDispatch() {
  if (!_simpleApiDispatch) {
    _simpleApiDispatch = require('./routes/simple-api.cjs')({
      jsonResponse,
      parseJsonBody,
      loadData,
      sseClients,
      probeClaudeStatus,
      probeAiSetupDiagnostics,
      getSelectedAiProvider,
      ensureParentDir,
      AUTO_UPDATE_ENABLED,
      APP_BUILD_SOURCE,
      APP_VERSION,
    });
  }
  return _simpleApiDispatch;
}

// AI Runtime API dispatcher (src/routes/ai-runtime-api.cjs)
// /api/install-ai-cli, /api/launch-ai, /api/launch-ai-external, /api/stop-ai, /api/ai-input
let _aiRuntimeApiDispatch = null;
function getAiRuntimeApiDispatch() {
  if (!_aiRuntimeApiDispatch) {
    _aiRuntimeApiDispatch = require('./routes/ai-runtime-api.cjs')({
      jsonResponse,
      parseJsonBody,
      PROJECT_ROOT,
      normalizeProviderId,
      getSelectedAiProvider,
      getProvider,
      getProviderDisplayName,
      probeNpmStatus,
      probeClaudeStatus,
      setProviderInstallState,
      invalidateAiStatusCache,
      clearAiExecutablePath: (providerId) => { _aiExecutablePath[providerId] = null; },
      startManagedAiSession,
      launchClaudeInExternalTerminal,
      stopManagedClaudePty,
      stopHeadlessAiRun,
      getActiveHeadlessRun,
      getHeadlessAiRun: () => headlessAiRun,
      getClaudePty: () => claudePty,
      getClaudeProcess: () => claudeProcess,
      clearClaudeProcess: () => {
        if (claudeProcess && !claudeProcess.killed) {
          try { claudeProcess.kill(); } catch (_) {}
        }
        claudeProcess = null;
      },
      appendDiagnosticEvent,
    });
  }
  return _aiRuntimeApiDispatch;
}

// Form Session API dispatcher (src/routes/form-session-api.cjs)
// /api/form-session/* 全 10 エンドポイント
let _formSessionApiDispatch = null;
function getFormSessionApiDispatch() {
  if (!_formSessionApiDispatch) {
    _formSessionApiDispatch = require('./routes/form-session-api.cjs')({
      jsonResponse,
      parseJsonBody,
      getFormSessionManager: () => _formSessionManager,
      settings,
    });
  }
  return _formSessionApiDispatch;
}

// Approve API dispatcher (src/routes/approve-api.cjs)
// /api/approve (確認待ち → 送信済み / スキップ)
let _approveApiDispatch = null;
function getApproveApiDispatch() {
  if (!_approveApiDispatch) {
    _approveApiDispatch = require('./routes/approve-api.cjs')({
      getUiLang,
      i18nT,
      appendDiagnosticEvent,
      getCompanyLogContext,
      isAwaitingTransitionAllowed,
      findRuntimeCompanyRecord,
      getKnownFormUrl,
      ensureSubmittedContactHistory,
      stringifyLogDetails,
      getLatestLog,
      updateCompany,
      notifyClients,
      ensureParentDir,
    });
  }
  return _approveApiDispatch;
}

// AI Form Fill API dispatcher (src/routes/ai-form-fill-api.cjs)
// /api/ai-form-fill (AI バッチキュー投入のメインエンドポイント)
let _aiFormFillApiDispatch = null;
function getAiFormFillApiDispatch() {
  if (!_aiFormFillApiDispatch) {
    _aiFormFillApiDispatch = require('./routes/ai-form-fill-api.cjs')({
      jsonResponse,
      parseJsonBody,
      normalizeProviderId,
      getSelectedAiProvider,
      isAiRuntimeActivelyProcessing,
      findCompaniesByNos,
      appendDiagnosticEvent,
      executeBackendPhaseABatch,
      ensureClaudeAutomationReady,
      queueAiFormFill,
      getManagedAiAutoSendSafe,
      getManagedAiReservedCompanyNos,
      cleanupStaleManagedAiMonitorEvents,
      getActiveHeadlessRun,
      getClaudePty: () => claudePty,
      getManagedAiBatchController: () => managedAiBatchController,
      setManagedAiBatchActive: (value) => {
        if (managedAiBatchController) managedAiBatchController.activeBatch = value;
      },
      getManagedAiRecoveryTimer: () => managedAiRecoveryTimer,
    });
  }
  return _aiFormFillApiDispatch;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = requestUrl.pathname;

  if (pathname === '/events' || pathname.startsWith('/screenshots/') || pathname.startsWith('/api/')) {
    // Internal CLI log endpoint: verify shared secret (X-CLI-Token header required)
    const isInternalCliLog = pathname === '/api/cli-log' && req.headers['x-cli-token'] === CLI_LOG_SECRET;
    const auth = isInternalCliLog ? { ok: true } : isAuthorizedDashboardRequest(req);
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
      jsonResponse(res, auth.statusCode, { ok: false, error: auth.error }, {
        'Set-Cookie': buildDashboardSessionCookieHeaders(),
      });
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

  // Assets serving (favicon, icons, vendor fonts/css)
  // /assets/foo.png         → assets/foo.png (レガシー)
  // /assets/vendor/x.woff2  → assets/vendor/x.woff2 (新規・ローカルバンドル)
  if (pathname.startsWith('/assets/')) {
    const relative = decodeURIComponent(pathname.slice('/assets/'.length));
    const ext = path.extname(relative).toLowerCase();
    const mime = assetMimeFor(ext);
    for (const filepath of getAssetCandidates(relative)) {
      try {
        const data = fs.readFileSync(filepath);
        // フォント・CSS・画像は長期キャッシュ（ファイル名が変わらない前提）
        const cache = ['.woff2', '.woff', '.ttf', '.otf', '.css', '.js', '.png', '.ico', '.svg']
          .includes(ext) ? 'public, max-age=604800, immutable' : 'public, max-age=86400';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
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

  // --- Settings API endpoints (src/routes/settings-api.cjs に分離済み) ---
  // /api/settings/*, /api/companies/*, /api/outreach-targets, /api/outreach/prepare,
  // /api/target-list/import を 1 箇所の dispatcher で処理する。
  if (await getSettingsApiDispatch()(req, res, pathname)) return;

  // --- Simple API endpoints (src/routes/simple-api.cjs) ---
  // /api/cli-log, /api/install-update, /api/update-status, /api/export, /api/data,
  // /api/claude-status, /api/ai/status, /api/ai/setup-diagnostics, /api/ai-submit*
  if (await getSimpleApiDispatch()(req, res, pathname, requestUrl)) return;

  // --- AI Runtime API endpoints (src/routes/ai-runtime-api.cjs) ---
  // /api/install-ai-cli, /api/launch-ai, /api/launch-ai-external, /api/stop-ai, /api/ai-input
  if (await getAiRuntimeApiDispatch()(req, res, pathname)) return;

  // --- Form Session API endpoints (src/routes/form-session-api.cjs) ---
  // /api/form-session/* 全 10 エンドポイント
  if (await getFormSessionApiDispatch()(req, res, pathname)) return;

  // --- Approve API endpoint (src/routes/approve-api.cjs) ---
  // POST /api/approve
  if (await getApproveApiDispatch()(req, res, pathname)) return;

  // --- AI Form Fill API endpoint (src/routes/ai-form-fill-api.cjs) ---
  // POST /api/ai-form-fill
  if (await getAiFormFillApiDispatch()(req, res, pathname)) return;

  // --- Existing API endpoints ---


  // ── Form Session API (/api/form-session/*) ────────────────────────
  // form-session routes は src/routes/form-session-api.cjs に分離済み (dispatcher で処理)

  // Dashboard HTML
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': buildDashboardSessionCookieHeaders(),
    'Content-Security-Policy': [
      // 全アセット (フォント・Tailwind・Phosphor・Material Symbols) はローカルバンドル済み
      // 外部CDN依存ゼロ → 厳格な 'self' のみで運用
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; ') + ';',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(buildPage());
});

async function startDashboardServer(opts = {}) {
  if (opts.formSessionManager) _formSessionManager = opts.formSessionManager;
  if (dashboardRuntime && server.listening) return dashboardRuntime;
  if (serverStartPromise) return serverStartPromise;

  ensureStandaloneDashboardLockHooks();
  if (!standaloneDashboardLockHeld) {
    const lock = await claimStandaloneDashboardLock();
    if (!lock.ok) {
      dashboardRuntime = lock.runtime || readRuntime();
      return dashboardRuntime;
    }
  }

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

    // CLI log shared secret を環境変数に公開（子プロセスが継承）
    process.env.SALES_CLAW_CLI_TOKEN = CLI_LOG_SECRET;

    refreshWatchTargets();
    startHeartbeat();
    cleanupStaleManagedAiMonitorEvents();

    // 起動時 recovery snapshot 検出（永続化された managed batch 残りがあれば診断イベントとして記録）
    try {
      const snap = loadRecoverySnapshot();
      if (snap && Array.isArray(snap.batches) && snap.batches.length > 0) {
        console.log(`[startup] recovery snapshot detected: ${snap.batches.length} batches`);
        appendDiagnosticEvent('managed_ai_recovery_snapshot_detected_on_startup', {
          batchCount: snap.batches.length,
          providerId: snap.providerId,
        });
      }
    } catch (_) {}

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
    const auth = isAuthorizedDashboardRequest(request, { allowTokenWithoutOrigin: true });
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
  (async () => {
    const runtime = await startDashboardServer();
    if (!server.listening) {
      const runtimeUrl = runtime && runtime.url ? runtime.url : 'http://127.0.0.1';
      console.log(`[Dashboard] 既存の dashboard-server が起動中です: ${runtimeUrl}`);
      return;
    }
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
