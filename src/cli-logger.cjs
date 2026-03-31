// ダッシュボードのCLI Activityストリームにログを送信するヘルパー

const http = require('http');
const { getRequestTarget } = require('./dashboard-runtime.cjs');

function log(message, type) {
  type = type || 'info';

  let target = { hostname: '127.0.0.1', port: 3765 };
  try {
    const settings = require('./settings-manager.cjs');
    target = getRequestTarget(settings.getHost(), settings.getPort());
  } catch (e) {}

  const payload = JSON.stringify({ message, type });
  try {
    const req = http.request({
      hostname: target.hostname, port: target.port, path: '/api/cli-log', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (e) {}
  console.log(`[${type.toUpperCase()}] ${message}`);
}

module.exports = { log };
