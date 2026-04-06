// アクションログ管理
// 各企業に対する操作を記録・表示する

const fs = require('fs');
const { getRequestTarget } = require('./dashboard-runtime.cjs');
const settings = require('./settings-manager.cjs');
const { ensureDataDir, resolveDataPath } = require('./data-paths.cjs');

const logCache = {
  filePath: null,
  signature: null,
  data: [],
};

function getLogFile() {
  return resolveDataPath('action-log.json');
}

function cloneValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readJsonCached(filePath, fallbackValue) {
  const signature = getFileSignature(filePath);
  if (logCache.filePath === filePath && logCache.signature === signature) {
    return logCache.data;
  }

  if (signature === null) {
    logCache.filePath = filePath;
    logCache.signature = null;
    logCache.data = fallbackValue;
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = parsed;
    return parsed;
  } catch {
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = fallbackValue;
    return fallbackValue;
  }
}

function writeJsonCached(filePath, data) {
  ensureDataDir();
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
  logCache.filePath = filePath;
  logCache.signature = getFileSignature(filePath);
  logCache.data = data;
}

// ファイルロック取得（並列プロセス間の競合防止）
function acquireFileLock(filePath) {
  const lockFile = filePath + '.lock';
  const maxWait = 3000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return lockFile;
    } catch (_) {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 5000) { fs.unlinkSync(lockFile); continue; }
      } catch (__) { continue; }
      const waitEnd = Date.now() + 50;
      while (Date.now() < waitEnd) { /* busy wait */ }
    }
  }
  // ロック取得失敗 — 強制取得して警告
  console.warn('[action-logger] File lock timeout after ' + maxWait + 'ms, force-acquiring: ' + lockFile);
  try { fs.unlinkSync(lockFile); } catch (_) {}
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); } catch (_) {}
  return lockFile;
}

function releaseFileLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (_) {}
}

function loadLog() {
  return readJsonCached(getLogFile(), []);
}

function saveLog(entries) {
  const prefs = settings.getSection('preferences');
  const maxEntries = Math.max(100, Number(prefs.maxLogEntries) || 10000);
  const trimmed = entries.slice(-maxEntries);
  writeJsonCached(getLogFile(), trimmed);
}

function logAction(companyNo, companyName, action, details) {
  // ロック内でread→append→writeを一体化（並列プロセス対応）
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  let entryCount = 0;
  try {
    logCache.signature = null;
    const entries = loadLog();
    entries.push({
      timestamp: new Date().toISOString(),
      companyNo,
      companyName,
      action,
      details,
    });
    saveLog(entries);
    entryCount = entries.length;
  } finally {
    releaseFileLock(lockFile);
  }

  // ダッシュボードにリアルタイム通知（非同期、失敗しても無視）
  try {
    const http = require('http');
    const target = getRequestTarget(settings.getHost(), settings.getPort());
    const msg = `[No.${companyNo}] ${companyName} → ${action}`;
    const payload = JSON.stringify({ message: msg, type: 'action' });
    const req = http.request({ hostname: target.hostname, port: target.port, path: '/api/cli-log', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-CLI-Token': process.env.SALES_CLAW_CLI_TOKEN || '' }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (e) {}

  return entryCount;
}

function getCompanyLog(companyNo) {
  return cloneValue(loadLog().filter(e => e.companyNo === companyNo));
}

function getAllLogs() {
  return cloneValue(loadLog());
}

function getLatestActions() {
  const entries = loadLog();
  const latest = {};
  entries.forEach(e => {
    latest[e.companyNo] = e;
  });
  return Object.values(latest).map((entry) => ({ ...entry }));
}

function removeCompanyLogs(companyNo) {
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    logCache.signature = null;
    const entries = loadLog();
    const remaining = entries.filter((entry) => String(entry.companyNo) !== key);
    const removedCount = entries.length - remaining.length;
    if (removedCount > 0) {
      saveLog(remaining);
    }
    return removedCount;
  } finally {
    releaseFileLock(lockFile);
  }
}

module.exports = { logAction, getCompanyLog, getAllLogs, getLatestActions, removeCompanyLogs };
