'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDataPath } = require('./data-paths.cjs');

function getRuntimeFile() {
  return resolveDataPath('dashboard-runtime.json');
}

function getAlternateRuntimeFiles() {
  const files = [];
  const appData = typeof process.env.APPDATA === 'string' ? process.env.APPDATA.trim() : '';
  if (appData) {
    files.push(path.join(appData, 'sales-claw', 'runtime', 'data', 'dashboard-runtime.json'));
  }
  files.push(path.join(os.homedir(), '.sales-claw', 'data', 'dashboard-runtime.json'));
  return files;
}

function getRuntimeFiles() {
  const seen = new Set();
  const files = [getRuntimeFile(), ...getAlternateRuntimeFiles()];
  return files.filter(file => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
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

function normalizeRuntime(raw) {
  if (!raw || !raw.port) return null;
  return {
    ...raw,
    host: toClientHost(raw.host || raw.bindHost || '127.0.0.1'),
    url: raw.url || buildRuntimeUrl(raw.host || raw.bindHost || '127.0.0.1', raw.port),
  };
}

function getRuntimeScore(runtime, stat) {
  const startedAt = Date.parse(runtime.startedAt || '') || 0;
  const mtime = stat && typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0;
  return Math.max(startedAt, mtime);
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
  const runtimes = [];
  for (const file of getRuntimeFiles()) {
    try {
      const stat = fs.statSync(file);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const normalized = normalizeRuntime(raw);
      if (!normalized) continue;
      runtimes.push({ runtime: normalized, score: getRuntimeScore(normalized, stat) });
    } catch {
      // noop
    }
  }
  if (!runtimes.length) return null;
  runtimes.sort((a, b) => b.score - a.score);
  return runtimes[0].runtime;
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
  getRuntimeFiles,
  readRuntime,
  toClientHost,
  writeRuntime,
};
