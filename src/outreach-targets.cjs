'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataPath } = require('./data-paths.cjs');

function getTargetsFile() {
  return resolveDataPath('outreach-targets.json');
}

function ensureDataDir() {
  const dir = path.dirname(getTargetsFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTargets() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(getTargetsFile(), 'utf8'));
    if (Array.isArray(raw)) return raw;
    return [];
  } catch {
    return [];
  }
}

function saveTargets(entries) {
  ensureDataDir();
  fs.writeFileSync(getTargetsFile(), JSON.stringify(entries, null, 2), 'utf8');
}

function getTargetMap() {
  const map = new Map();
  loadTargets().forEach((entry) => {
    map.set(String(entry.companyNo), entry);
  });
  return map;
}

function setTargets(companies, active = true) {
  const current = loadTargets();
  const map = new Map(current.map((entry) => [String(entry.companyNo), entry]));

  (companies || []).forEach((company) => {
    const key = String(company.companyNo);
    if (!active) {
      map.delete(key);
      return;
    }

    const now = new Date().toISOString();
    const existing = map.get(key);
    map.set(key, {
      companyNo: company.companyNo,
      companyName: company.companyName || (existing ? existing.companyName : ''),
      addedAt: existing ? existing.addedAt : now,
      updatedAt: now,
    });
  });

  const next = Array.from(map.values()).sort((a, b) => Number(a.companyNo) - Number(b.companyNo));
  saveTargets(next);
  return next;
}

module.exports = {
  getTargetsFile,
  getTargetMap,
  loadTargets,
  saveTargets,
  setTargets,
};
