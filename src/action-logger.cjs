// アクションログ管理
// 各企業に対する操作を記録・表示する

const fs = require('fs');
const path = require('path');
const { getRequestTarget } = require('./dashboard-runtime.cjs');

const LOG_FILE = path.join(__dirname, '../data', 'action-log.json');

function loadLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
}

function saveLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2), 'utf-8');
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
    const settings = require('./settings-manager.cjs');
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
  return loadLog().filter(e => e.companyNo === companyNo);
}

function getAllLogs() {
  return loadLog();
}

function getLatestActions() {
  const entries = loadLog();
  const latest = {};
  entries.forEach(e => {
    latest[e.companyNo] = e;
  });
  return Object.values(latest);
}

module.exports = { logAction, getCompanyLog, getAllLogs, getLatestActions };
