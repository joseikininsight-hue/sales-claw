'use strict';

/**
 * Managed AI PTY のログ I/O
 *
 * dashboard-server.cjs から切り出した PTY ログファイル管理。
 * ログはプロバイダごとに別ファイル、上限サイズを超えたら 1 段ローテート。
 *
 * ログ用途:
 * - AI セッションの stdout/stderr 記録（デバッグ）
 * - 復旧時の直近出力参照
 * - ユーザーに見せる「CLI Activity」タブの事後再生ソース
 */

const fs = require('fs');
const path = require('path');
const { resolveDataPath, ensureDataDir } = require('../data-paths.cjs');
const { stripAnsiCodes } = require('./batch-utils.cjs');

/** ログファイル上限: これを超えたら .1 にローテートして新規ファイルを開く */
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * プロバイダごとのログファイルパスを返す。
 * @param {string} providerId - 呼び出し側で normalize 済みの ID
 * @returns {string} 絶対パス
 */
function getManagedAiPtyLogFile(providerId) {
  const safe = String(providerId || 'claude').replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolveDataPath(path.join('ai-runs', `managed-${safe}-session.log`));
}

/**
 * 親ディレクトリが無ければ作る。
 * @param {string} filePath
 */
function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * PTY の出力/入力を 1 行ずつログに追記する。
 * ANSI 除去 + \r 削除 + 空行フィルタ。
 *
 * @param {string} providerId
 * @param {string|Buffer} chunk
 * @param {'output'|'input'|'system'} [kind='output']
 * @param {object} [options]
 * @param {number} [options.maxBytes] ローテート閾値 (default: 1 MiB)
 */
function appendManagedAiPtyLog(providerId, chunk, kind = 'output', options = {}) {
  const text = stripAnsiCodes(String(chunk || '')).replace(/\r/g, '');
  if (!text.trim()) return;

  const logFile = getManagedAiPtyLogFile(providerId);
  ensureDataDir();
  ensureParentDir(logFile);

  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;

  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > maxBytes) {
      const backupFile = `${logFile}.1`;
      try {
        if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      } catch (_) {}
      fs.renameSync(logFile, backupFile);
    }
  } catch (_) {
    // ローテート失敗しても追記は続行（データ欠落を防ぐ）
  }

  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return;
  const stamp = new Date().toISOString();
  const payload = lines.map((line) => `[${stamp}] [${kind}] ${line}`).join('\n') + '\n';

  try {
    fs.appendFileSync(logFile, payload, 'utf8');
  } catch (_) {
    // I/O エラーは無視（ログが書けないのはクリティカルではない）
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  getManagedAiPtyLogFile,
  appendManagedAiPtyLog,
};
