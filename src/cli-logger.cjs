// ダッシュボードのCLI Activityストリームにログを送信するヘルパー

const http = require('http');
const { getRequestTarget } = require('./dashboard-runtime.cjs');

function toLogRank(type) {
  const key = String(type || 'info').toLowerCase();
  if (key === 'debug') return 10;
  if (key === 'info' || key === 'step' || key === 'action') return 20;
  if (key === 'warn' || key === 'warning') return 30;
  if (key === 'error') return 40;
  return 20;
}

function log(message, type) {
  type = type || 'info';

  let target = { hostname: '127.0.0.1', port: 3765 };
  let enabled = true;
  try {
    const settings = require('./settings-manager.cjs');
    target = getRequestTarget(settings.getHost(), settings.getPort());
    const configured = settings.getSection('preferences').logLevel || 'info';
    enabled = toLogRank(type) >= toLogRank(configured);
  } catch (e) {}

  if (!enabled) return;

  const payload = JSON.stringify({ message, type });
  try {
    const req = http.request({
      hostname: target.hostname, port: target.port, path: '/api/cli-log', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-CLI-Token': process.env.SALES_CLAW_CLI_TOKEN || '' }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (e) {}
  console.log(`[${type.toUpperCase()}] ${message}`);
}

function thinking(message) {
  log(message, 'thinking');
}

module.exports = { log, thinking };
