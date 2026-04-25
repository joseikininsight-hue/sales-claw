'use strict';

/**
 * AI バッチ制御の純粋関数群
 *
 * 状態に依存しない / 外部副作用のないヘルパーのみを集約する。
 * dashboard-server.cjs が require して使う。
 *
 * なぜ分離するか:
 * - dashboard-server.cjs が 12,000 行超のモノリスになっていた
 * - 純粋関数は単体テストが容易で、責務分離の最初の一歩として最適
 *
 * 分離した関数:
 * - chunkManagedAiCompanies     : 企業リストを指定サイズでチャンク化
 * - buildManagedAiBatchOptionsSubset : バッチごとの options を subset 化
 * - createManagedAiBatchController   : batch controller の初期状態を生成
 * - parseEventTimestampMs       : action-log / live-monitor のタイムスタンプを ms に
 * - stripAnsiCodes              : ANSI エスケープシーケンスを除去
 *
 * 将来の拡張:
 * - 更に状態依存のロジック (dispatch, poller 等) をここに集約する場合は、
 *   closure factory パターンで controller を返す形にするのが自然。
 */

/**
 * 企業リストを chunkSize ごとに分割する。
 * @param {Array<object>} companies
 * @param {number} [chunkSize=3]
 * @returns {Array<Array<object>>}
 */
function chunkManagedAiCompanies(companies, chunkSize = 3) {
  const normalizedChunkSize = Math.max(1, Number(chunkSize) || 3);
  const chunks = [];
  const source = Array.isArray(companies) ? companies : [];
  for (let i = 0; i < source.length; i += normalizedChunkSize) {
    chunks.push(source.slice(i, i + normalizedChunkSize));
  }
  return chunks;
}

/**
 * baseOptions から、対象企業だけに絞った subset options を作る。
 * phaseAByCompany (Map), phaseASuccesses, phaseAFailures を subset 化。
 *
 * @param {object} baseOptions
 * @param {Array<{no:number|string}>} companies
 * @returns {object}
 */
function buildManagedAiBatchOptionsSubset(baseOptions = {}, companies = []) {
  const companyKeySet = new Set(companies.map((company) => String(company.no)));
  const subsetMap = new Map();
  const sourceMap = baseOptions.phaseAByCompany instanceof Map ? baseOptions.phaseAByCompany : null;
  if (sourceMap) {
    companies.forEach((company) => {
      const key = String(company.no);
      if (sourceMap.has(key)) subsetMap.set(key, sourceMap.get(key));
    });
  }
  return {
    ...baseOptions,
    phaseAByCompany: subsetMap,
    phaseASuccesses: Array.isArray(baseOptions.phaseASuccesses)
      ? baseOptions.phaseASuccesses.filter((entry) => companyKeySet.has(String(entry.companyNo)))
      : [],
    phaseAFailures: Array.isArray(baseOptions.phaseAFailures)
      ? baseOptions.phaseAFailures.filter((entry) => companyKeySet.has(String(entry.companyNo)))
      : [],
  };
}

/**
 * batch controller の初期状態を生成する。
 * providerId の normalization は呼び出し側 (dashboard-server.cjs) の責務
 * （ai-providers モジュールへの依存を避けるため）。
 *
 * @param {string} providerId - 既に normalize 済みのプロバイダ ID
 * @param {boolean} autoSendSafe
 * @returns {object}
 */
function createManagedAiBatchController(providerId, autoSendSafe) {
  return {
    providerId,
    autoSendSafe: !!autoSendSafe,
    pending: [],
    activeBatch: null,
    batchCounter: 0,
    pollTimer: null,
  };
}

/**
 * timestamp 文字列 / 数値を epoch ms に変換する。無効値は 0。
 * @param {unknown} value
 * @returns {number}
 */
function parseEventTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * ANSI エスケープシーケンスを文字列から除去する。
 * PTY 出力をログや diff 比較に使う前処理として使う。
 * @param {unknown} value
 * @returns {string}
 */
function stripAnsiCodes(value) {
  return String(value || '').replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]|\u009b[0-9;?]*[ -/]*[@-~]/g,
    '',
  );
}

module.exports = {
  chunkManagedAiCompanies,
  buildManagedAiBatchOptionsSubset,
  createManagedAiBatchController,
  parseEventTimestampMs,
  stripAnsiCodes,
};
