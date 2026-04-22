// 企業ごとの連絡履歴管理
// 何回目の連絡で何を送ったかを記録し、2回目以降のメッセージ作成に活用する

const fs = require('fs');
const { ensureDataDir, resolveDataPath } = require('./data-paths.cjs');

const historyCache = {
  filePath: null,
  signature: null,
  data: {},
};

function getHistoryFile() {
  return resolveDataPath('contact-history.json');
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
  if (historyCache.filePath === filePath && historyCache.signature === signature) {
    return historyCache.data;
  }

  if (signature === null) {
    historyCache.filePath = filePath;
    historyCache.signature = null;
    historyCache.data = fallbackValue;
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    historyCache.filePath = filePath;
    historyCache.signature = signature;
    historyCache.data = parsed;
    return parsed;
  } catch {
    historyCache.filePath = filePath;
    historyCache.signature = signature;
    historyCache.data = fallbackValue;
    return fallbackValue;
  }
}

function acquireFileLock(filePath) {
  const lockFile = filePath + '.lock';
  const maxWait = 3000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return lockFile;
    } catch (_) {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > 5000) { fs.unlinkSync(lockFile); continue; }
      } catch (__) { continue; }
      const waitEnd = Date.now() + 50;
      while (Date.now() < waitEnd) { /* busy wait */ }
    }
  }
  console.warn('[contact-history] File lock timeout, force-acquiring: ' + filePath);
  try { fs.unlinkSync(filePath + '.lock'); } catch (_) {}
  try { fs.writeFileSync(filePath + '.lock', String(process.pid), { flag: 'wx' }); } catch (_) {}
  return filePath + '.lock';
}

function releaseFileLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (_) {}
}

function writeJsonCached(filePath, data) {
  ensureDataDir();
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
  historyCache.filePath = filePath;
  historyCache.signature = getFileSignature(filePath);
  historyCache.data = data;
}

function loadHistory() {
  return readJsonCached(getHistoryFile(), {});
}

function saveHistory(data) {
  writeJsonCached(getHistoryFile(), data);
}

/**
 * 送信記録を追加する
 * @param {number} companyNo - 企業番号
 * @param {string} companyName - 企業名
 * @param {Object} record - 送信内容
 *   { message, formUrl, method, response?, notes? }
 * @returns {number} 何回目の連絡か（1, 2, 3...）
 */
function recordContact(companyNo, companyName, record) {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);

    if (!history[key]) {
      history[key] = {
        companyNo,
        companyName,
        contacts: [],
      };
    }

    const contactNo = history[key].contacts.length + 1;
    const recordedAt = record.timestamp || record.sentAt || new Date().toISOString();

    history[key].contacts.push({
      contactNo,
      date: recordedAt,
      message: record.message,
      formUrl: record.formUrl || '',
      method: record.method || 'web_form',
      response: record.response || null,
      notes: record.notes || '',
      screenshot: record.screenshot || '',
      sourceAction: record.sourceAction || '',
      sourceActionAt: record.sourceActionAt || '',
      status: record.status || '',
    });

    saveHistory(history);
    return contactNo;
  } finally {
    releaseFileLock(lockFile);
  }
}

/**
 * 企業の連絡履歴を取得する
 * @param {number} companyNo - 企業番号
 * @returns {Object|null} { companyNo, companyName, contacts: [...] }
 */
function getHistory(companyNo) {
  const history = loadHistory();
  return cloneValue(history[String(companyNo)] || null);
}

/**
 * 企業の連絡回数を取得する
 * @param {number} companyNo - 企業番号
 * @returns {number} 連絡回数（0 = 未連絡）
 */
function getContactCount(companyNo) {
  const h = getHistory(companyNo);
  return h ? h.contacts.length : 0;
}

/**
 * 企業の前回送信メッセージを取得する
 * @param {number} companyNo - 企業番号
 * @returns {string|null} 前回のメッセージ本文
 */
function getLastMessage(companyNo) {
  const h = getHistory(companyNo);
  if (!h || h.contacts.length === 0) return null;
  return h.contacts[h.contacts.length - 1].message;
}

/**
 * 全企業の連絡履歴サマリーを取得する
 * @returns {Array} [{ companyNo, companyName, contactCount, lastDate, lastContactNo }]
 */
function getAllHistorySummary() {
  const history = loadHistory();
  return Object.values(history).map(h => ({
    companyNo: h.companyNo,
    companyName: h.companyName,
    contactCount: h.contacts.length,
    lastDate: h.contacts.length > 0 ? h.contacts[h.contacts.length - 1].date : null,
    lastContactNo: h.contacts.length,
  }));
}

/**
 * 連絡に対するレスポンス（返信有無等）を記録する
 * @param {number} companyNo - 企業番号
 * @param {number} contactNo - 連絡番号（1, 2, 3...）
 * @param {string} response - レスポンス内容（'返信あり', '返信なし', '商談設定' 等）
 * @param {string} notes - メモ
 */
function recordResponse(companyNo, contactNo, response, notes) {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);
    if (!history[key]) return false;

    const contact = history[key].contacts.find(c => c.contactNo === contactNo);
    if (!contact) return false;

    contact.response = response;
    contact.notes = notes || contact.notes;
    contact.responseDate = new Date().toISOString();

    saveHistory(history);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

function removeHistory(companyNo) {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);
    if (!Object.prototype.hasOwnProperty.call(history, key)) return false;
    delete history[key];
    saveHistory(history);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

module.exports = {
  recordContact,
  getHistory,
  getContactCount,
  getLastMessage,
  getAllHistorySummary,
  recordResponse,
  removeHistory,
};
