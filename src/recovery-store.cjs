'use strict';

// Recovery snapshot のディスク永続化
// サーバー / Electron 再起動で managed AI batch の残バッチを失わないようにするため、
// snapshotManagedAiBatchesForRecovery の出力を data/recovery/managed-ai-batches.json に書く。
//
// ファイルロックは使わず atomic rename のみで済ませる（呼び出し元で timing 制御する前提）。

const fs = require('fs');
const path = require('path');
const { resolveDataPath } = require('./data-paths.cjs');

/**
 * 保存先ファイルパスを取得
 * @returns {string}
 */
function getRecoveryFilePath() {
  return resolveDataPath('recovery', 'managed-ai-batches.json');
}

/**
 * 保存先ディレクトリを作成（既に存在する場合は no-op）
 * @param {string} filePath
 */
function ensureDir(filePath) {
  // mkdirSync({recursive:true}) は既存ディレクトリで no-op のため事前 existsSync は不要
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * snapshot のスキーマを最低限バリデートする。
 * 破損や外部改ざんを想定し、既知の許容範囲のみ通す。
 * @param {unknown} snapshot
 * @returns {object|null}  valid なら正規化した object、さもなくば null
 */
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const providerId = typeof snapshot.providerId === 'string' ? snapshot.providerId : '';
  // providerId はファイルパス生成や外部プロセス呼び出しに使われる可能性があるため
  // 英数字・ハイフン・アンダースコアのみ許可
  if (providerId && !/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) return null;
  const batches = Array.isArray(snapshot.batches) ? snapshot.batches.filter((b) => b && typeof b === 'object') : [];
  return {
    providerId,
    autoSendSafe: !!snapshot.autoSendSafe,
    mode: typeof snapshot.mode === 'string' ? snapshot.mode : '',
    batches: batches.map((batch) => ({
      id: typeof batch.id === 'string' ? batch.id : '',
      companies: Array.isArray(batch.companies) ? batch.companies.filter((c) => c && typeof c === 'object') : [],
      // prototype 汚染を防ぐため Object.create(null) ベースで安全コピー
      options: Object.assign(Object.create(null), batch.options && typeof batch.options === 'object' ? batch.options : {}),
    })).filter((b) => b.companies.length > 0),
    savedAt: typeof snapshot.savedAt === 'string' ? snapshot.savedAt : '',
  };
}

/**
 * Recovery snapshot を atomic に書き込む（tmp → rename）。
 * 失敗時は例外を再スローする（呼び出し元で try/catch すること）。
 *
 * @param {object} snapshot - `snapshotManagedAiBatchesForRecovery()` の戻り値
 */
function saveRecoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  const filePath = getRecoveryFilePath();
  ensureDir(filePath);
  const tmpFile = filePath + '.tmp.' + process.pid;
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    ...snapshot,
  }, null, 2);
  fs.writeFileSync(tmpFile, payload, 'utf8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      // Windows で共有違反が出るケースへのフォールバック
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
}

/**
 * Recovery snapshot を読み込む。
 * ファイルが存在しない / 壊れている場合は null を返す。
 *
 * @returns {object|null}
 */
function loadRecoverySnapshot() {
  const filePath = getRecoveryFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return validateSnapshot(parsed);
  } catch (_) {
    return null;
  }
}

/**
 * Recovery snapshot を削除する。存在しなければ no-op。
 */
function clearRecoverySnapshot() {
  const filePath = getRecoveryFilePath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

module.exports = {
  getRecoveryFilePath,
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  clearRecoverySnapshot,
};
