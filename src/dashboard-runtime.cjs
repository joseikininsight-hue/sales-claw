'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataPath } = require('./data-paths.cjs');

function getRuntimeFile() {
  return resolveDataPath('dashboard-runtime.json');
}

function ensureDataDir() {
  const dir = path.dirname(getRuntimeFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toClientHost(host) {
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  return host;
}

function buildRuntimeUrl(host, port) {
  return `http://${toClientHost(host)}:${port}`;
}

function writeRuntime(runtime) {
  ensureDataDir();
  const normalized = {
    bindHost: runtime.bindHost || runtime.host || '127.0.0.1',
    host: toClientHost(runtime.host || runtime.bindHost || '127.0.0.1'),
    port: runtime.port,
    preferredPort: runtime.preferredPort || runtime.port,
    startedAt: runtime.startedAt || new Date().toISOString(),
  };
  normalized.url = buildRuntimeUrl(normalized.host, normalized.port);
  fs.writeFileSync(getRuntimeFile(), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function readRuntime() {
  try {
    const raw = JSON.parse(fs.readFileSync(getRuntimeFile(), 'utf8'));
    if (!raw || !raw.port) return null;
    return {
      ...raw,
      host: toClientHost(raw.host || raw.bindHost || '127.0.0.1'),
      url: raw.url || buildRuntimeUrl(raw.host || raw.bindHost || '127.0.0.1', raw.port),
    };
  } catch {
    return null;
  }
}

function clearRuntime() {
  try {
    const runtimeFile = getRuntimeFile();
    if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);
  } catch {
    // noop
  }
}

function getRequestTarget(fallbackHost, fallbackPort) {
  const runtime = readRuntime();
  if (runtime) {
    return {
      hostname: runtime.host,
      port: runtime.port,
      url: runtime.url,
    };
  }
  return {
    hostname: toClientHost(fallbackHost || '127.0.0.1'),
    port: fallbackPort,
    url: buildRuntimeUrl(fallbackHost || '127.0.0.1', fallbackPort),
  };
}

module.exports = {
  buildRuntimeUrl,
  clearRuntime,
  getRequestTarget,
  getRuntimeFile,
  readRuntime,
  toClientHost,
  writeRuntime,
};
