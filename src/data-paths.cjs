'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('./settings-manager.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');

function getDataDir() {
  let configured = 'data';
  try {
    configured = (settings.getSection('preferences').dataDir || 'data').trim() || 'data';
  } catch (_) {}
  const runtimeRoot = typeof settings.getRuntimeRoot === 'function'
    ? settings.getRuntimeRoot()
    : PROJECT_ROOT;
  return path.isAbsolute(configured) ? configured : path.join(runtimeRoot, configured);
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveDataPath(...segments) {
  return path.join(getDataDir(), ...segments);
}

module.exports = {
  PROJECT_ROOT,
  ensureDataDir,
  getDataDir,
  resolveDataPath,
};
