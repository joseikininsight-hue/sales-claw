'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDataDir, resolveDataPath } = require('./data-paths.cjs');

function getLiveMonitorFile() {
  return resolveDataPath('live-monitor.json');
}

function defaultState() {
  return {
    updatedAt: null,
    sessions: {},
    lastEvent: null,
    events: [],
  };
}

const FINAL_STATUSES = new Set([
  'awaiting_approval',
  'submitted',
  'completed',
  'skipped',
  'error',
  'user_required',
]);
const STALE_SESSION_TTL_MS = 45 * 60 * 1000;
const monitorCache = {
  filePath: null,
  signature: null,
  data: null,
};

function isFinalStatus(entry) {
  const status = entry && typeof entry.status === 'string' ? entry.status.trim() : '';
  return FINAL_STATUSES.has(status);
}

function parseUpdatedAtMs(entry) {
  const ms = Date.parse(entry && entry.updatedAt ? entry.updatedAt : '');
  return Number.isFinite(ms) ? ms : null;
}

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function shouldDropSession(state, key, entry) {
  if (!entry) return true;
  if (isFinalStatus(entry)) return true;

  const updatedAtMs = parseUpdatedAtMs(entry);
  if (updatedAtMs !== null && (Date.now() - updatedAtMs) > STALE_SESSION_TTL_MS) {
    return true;
  }

  const events = Array.isArray(state.events) ? state.events : [];
  return events.some((event) => {
    if (!event || String(event.companyNo) !== String(entry.companyNo)) return false;
    if (event.active !== false && !isFinalStatus(event)) return false;
    const eventUpdatedAtMs = parseUpdatedAtMs(event);
    return eventUpdatedAtMs !== null && updatedAtMs !== null && eventUpdatedAtMs >= updatedAtMs;
  });
}

function pruneState(state) {
  let changed = false;
  Object.entries(state.sessions || {}).forEach(([key, entry]) => {
    if (!shouldDropSession(state, key, entry)) return;
    delete state.sessions[key];
    changed = true;
  });
  return changed;
}

function readState() {
  const filePath = getLiveMonitorFile();
  const signature = getFileSignature(filePath);
  if (monitorCache.filePath === filePath && monitorCache.signature === signature && monitorCache.data) {
    return monitorCache.data;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = {
      updatedAt: raw && raw.updatedAt ? raw.updatedAt : null,
      sessions: raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      lastEvent: raw && raw.lastEvent ? raw.lastEvent : null,
      events: Array.isArray(raw && raw.events) ? raw.events : [],
    };
    monitorCache.filePath = filePath;
    monitorCache.signature = signature;
    monitorCache.data = state;
    if (pruneState(state)) writeState(state);
    return state;
  } catch {
    const state = defaultState();
    monitorCache.filePath = filePath;
    monitorCache.signature = signature;
    monitorCache.data = state;
    return state;
  }
}

function writeState(state) {
  ensureDataDir();
  const filePath = getLiveMonitorFile();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  monitorCache.filePath = filePath;
  monitorCache.signature = getFileSignature(filePath);
  monitorCache.data = state;
}

function normalizeEntry(companyNo, patch) {
  const next = { ...(patch || {}) };
  next.companyNo = Number(companyNo);
  next.updatedAt = next.updatedAt || new Date().toISOString();
  if (next.latestScreenshot) next.latestScreenshot = path.resolve(next.latestScreenshot);
  return next;
}

function serializeEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    latestScreenshotName: entry.latestScreenshot ? path.basename(entry.latestScreenshot) : null,
  };
}

function toComparableSnapshot(entry) {
  if (!entry) return null;
  return JSON.stringify({
    companyNo: entry.companyNo != null ? Number(entry.companyNo) : null,
    companyName: entry.companyName || '',
    status: entry.status || '',
    step: entry.step || '',
    currentUrl: entry.currentUrl || entry.formUrl || '',
    latestScreenshot: entry.latestScreenshot ? path.resolve(entry.latestScreenshot) : '',
    active: entry.active !== false,
  });
}

function appendEvent(state, previous, next, kind) {
  if (toComparableSnapshot(previous) === toComparableSnapshot(next)) return;
  const event = {
    ...next,
    kind: kind || 'update',
    currentUrl: next.currentUrl || next.formUrl || '',
  };
  state.events = [event, ...(Array.isArray(state.events) ? state.events : [])].slice(0, 40);
}

function updateLiveMonitor(companyNo, patch = {}) {
  const key = String(companyNo);
  const state = readState();
  const previous = state.sessions[key] || null;
  const next = {
    ...(previous || {}),
    ...normalizeEntry(companyNo, patch),
    active: patch.active !== undefined ? patch.active : true,
  };
  const shouldCloseSession = next.active === false || isFinalStatus(next);
  if (shouldCloseSession) {
    next.active = false;
    next.finishedAt = patch.finishedAt || next.finishedAt || new Date().toISOString();
    delete state.sessions[key];
    state.lastEvent = next;
  } else {
    state.sessions[key] = next;
  }
  state.updatedAt = next.updatedAt;
  appendEvent(state, previous, next, patch.kind || (shouldCloseSession ? 'finish' : 'update'));
  writeState(state);
  return serializeEntry(next);
}

function finishLiveMonitor(companyNo, patch = {}) {
  const key = String(companyNo);
  const state = readState();
  const previous = state.sessions[key] || null;
  const next = {
    ...(previous || { companyNo: Number(companyNo) }),
    ...normalizeEntry(companyNo, patch),
    active: false,
    finishedAt: patch.finishedAt || new Date().toISOString(),
  };
  delete state.sessions[key];
  state.lastEvent = next;
  state.updatedAt = next.updatedAt;
  appendEvent(state, previous, next, patch.kind || 'finish');
  writeState(state);
  return serializeEntry(next);
}

function clearLiveMonitor(companyNo) {
  const key = String(companyNo);
  const state = readState();
  if (!state.sessions[key]) return false;
  delete state.sessions[key];
  state.updatedAt = new Date().toISOString();
  writeState(state);
  return true;
}

function removeCompanyMonitor(companyNo) {
  const key = String(companyNo);
  const state = readState();
  let changed = false;

  if (state.sessions && state.sessions[key]) {
    delete state.sessions[key];
    changed = true;
  }

  if (Array.isArray(state.events)) {
    const nextEvents = state.events.filter((entry) => String(entry && entry.companyNo) !== key);
    if (nextEvents.length !== state.events.length) {
      state.events = nextEvents;
      changed = true;
    }
  }

  if (state.lastEvent && String(state.lastEvent.companyNo) === key) {
    state.lastEvent = null;
    changed = true;
  }

  if (!changed) return false;
  state.updatedAt = new Date().toISOString();
  writeState(state);
  return true;
}

function getLiveMonitorSummary() {
  const state = readState();
  const sessions = Object.values(state.sessions || {})
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  const candidates = [...sessions];
  if (state.lastEvent) candidates.push(state.lastEvent);
  const primary = candidates
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())[0] || null;
  const activeSessions = sessions.filter((entry) => entry && entry.active !== false && !isFinalStatus(entry));
  const history = Array.isArray(state.events) ? [...state.events] : [];
  const fallbackEvents = [...sessions];
  if (state.lastEvent) fallbackEvents.push(state.lastEvent);
  fallbackEvents.forEach((entry) => {
    const snapshot = toComparableSnapshot(entry);
    const exists = history.some((event) => toComparableSnapshot(event) === snapshot);
    if (!exists) history.push(entry);
  });
  return {
    activeCount: activeSessions.length,
    primary: serializeEntry(primary),
    events: history.map(serializeEntry).slice(0, 40),
    updatedAt: state.updatedAt,
  };
}

function getMonitorFile() {
  return getLiveMonitorFile();
}

function readLiveMonitor() {
  return getLiveMonitorSummary().primary;
}

function readMonitorState() {
  return readLiveMonitor();
}

module.exports = {
  clearLiveMonitor,
  finishLiveMonitor,
  getLiveMonitorFile,
  getMonitorFile,
  getLiveMonitorSummary,
  readLiveMonitor,
  readMonitorState,
  removeCompanyMonitor,
  updateLiveMonitor,
};
