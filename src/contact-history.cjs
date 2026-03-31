// 企業ごとの連絡履歴管理
// 何回目の連絡で何を送ったかを記録し、2回目以降のメッセージ作成に活用する

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '../data', 'contact-history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
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

  history[key].contacts.push({
    contactNo,
    date: new Date().toISOString(),
    message: record.message,
    formUrl: record.formUrl || '',
    method: record.method || 'web_form',
    response: record.response || null,
    notes: record.notes || '',
  });

  saveHistory(history);
  return contactNo;
}

/**
 * 企業の連絡履歴を取得する
 * @param {number} companyNo - 企業番号
 * @returns {Object|null} { companyNo, companyName, contacts: [...] }
 */
function getHistory(companyNo) {
  const history = loadHistory();
  return history[String(companyNo)] || null;
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
}

module.exports = {
  recordContact,
  getHistory,
  getContactCount,
  getLastMessage,
  getAllHistorySummary,
  recordResponse,
};
