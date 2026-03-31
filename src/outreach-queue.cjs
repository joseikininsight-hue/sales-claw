'use strict';

const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '../data', 'outreach-queue.json');
const RUNNER_LOCK_FILE = path.join(__dirname, '../data', 'outreach-runner.lock');

function ensureDataDir() {
  const dir = path.dirname(FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadQueue() {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    if (Array.isArray(raw)) return raw;
    return [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  ensureDataDir();
  fs.writeFileSync(FILE_PATH, JSON.stringify(queue, null, 2), 'utf8');
}

function getQueueMap() {
  const map = new Map();
  loadQueue().forEach((entry) => {
    map.set(String(entry.companyNo), entry);
  });
  return map;
}

function enqueueCompanies(companies) {
  const queue = loadQueue();
  const map = new Map(queue.map((entry) => [String(entry.companyNo), entry]));
  const queued = [];

  (companies || []).forEach((company) => {
    const key = String(company.companyNo);
    const existing = map.get(key);
    if (existing && ['pending', 'processing'].includes(existing.status)) return;

    const now = new Date().toISOString();
    const nextEntry = {
      companyNo: company.companyNo,
      companyName: company.companyName || (existing ? existing.companyName : ''),
      status: 'pending',
      detail: 'Queued',
      requestedAt: now,
      updatedAt: now,
    };
    map.set(key, nextEntry);
    queued.push(nextEntry);
  });

  const nextQueue = Array.from(map.values()).sort((a, b) => Number(a.companyNo) - Number(b.companyNo));
  saveQueue(nextQueue);
  return queued;
}

function updateQueueStatus(companyNo, status, detail) {
  const queue = loadQueue();
  const key = String(companyNo);
  const entry = queue.find((item) => String(item.companyNo) === key);
  if (!entry) return null;
  entry.status = status;
  entry.detail = detail || '';
  entry.updatedAt = new Date().toISOString();
  saveQueue(queue);
  return entry;
}

module.exports = {
  FILE_PATH,
  RUNNER_LOCK_FILE,
  enqueueCompanies,
  getQueueMap,
  loadQueue,
  saveQueue,
  updateQueueStatus,
};
