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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  logCache.filePath = filePath;
  logCache.signature = getFileSignature(filePath);
  logCache.data = data;
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
  const entries = loadLog();
  entries.push({
    timestamp: new Date().toISOString(),
    companyNo,
    companyName,
    action,
    details,
  });
  saveLog(entries);

  // ダッシュボードにリアルタイム通知（非同期、失敗しても無視）
  try {
    const http = require('http');
    const target = getRequestTarget(settings.getHost(), settings.getPort());
    const msg = `[No.${companyNo}] ${companyName} → ${action}`;
    const payload = JSON.stringify({ message: msg, type: 'action' });
    const req = http.request({ hostname: target.hostname, port: target.port, path: '/api/cli-log', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (e) {}

  return entries.length;
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
  const key = String(companyNo);
  const entries = loadLog();
  const remaining = entries.filter((entry) => String(entry.companyNo) !== key);
  const removedCount = entries.length - remaining.length;
  if (removedCount > 0) {
    saveLog(remaining);
  }
  return removedCount;
}

module.exports = { logAction, getCompanyLog, getAllLogs, getLatestActions, removeCompanyLogs };
