'use strict';

// バッチ停滞検知ロジック（純関数）
// dashboard-server.cjs から切り出し、単体テスト可能にするためのモジュール
// 主目的: message_draft / site_analysis / form_fill のまま stall している企業を
//        自動 error 化するため、対象 companyNo を特定する

/** 停滞中と判定するアクション名 */
const STALL_CANDIDATE_ACTIONS = new Set(['message_draft', 'site_analysis', 'form_fill']);

/**
 * 人間向けのアクションラベル（formatStallReason 用）
 */
const ACTION_LABELS = {
  message_draft: 'メッセージ生成後',
  site_analysis: 'サイト分析後',
  form_fill: 'フォーム入力後',
};

/**
 * アクション名の抽出（latestAction / action のどちらにも対応）
 * @param {object} status
 * @returns {string}
 */
function extractAction(status) {
  if (!status) return '';
  if (status.latestAction) return String(status.latestAction);
  if (status.action) return String(status.action);
  return '';
}

/**
 * タイムスタンプ文字列の抽出（latestTimestamp / updatedAt / timestamp どれでも）
 * @param {object} status
 * @returns {string|null}
 */
function extractTimestamp(status) {
  if (!status) return null;
  return status.latestTimestamp || status.updatedAt || status.timestamp || null;
}

/**
 * active batch の中で stall している企業の companyNo 配列を返す。
 *
 * @param {object} activeBatch - `managedAiBatchController.activeBatch` と同じ形。
 *   - companyNos: number[]
 *   - companies: Array<{no:number, companyName?:string}>
 *   - lastProgressAt: number (ms epoch)
 * @param {Array<object>} statuses - `getManagedAiBatchProgressSnapshot().statuses`
 *   - {companyNo, action(または latestAction), monitorStatus, terminal, latestTimestamp?}
 * @param {object} options
 * @param {number} options.stallMs - 停滞とみなす idle ms
 * @param {number} [options.now] - 現在時刻 (テスト用。既定: Date.now())
 * @returns {number[]} stall 判定された companyNo の配列
 */
function detectStalledCompanies(activeBatch, statuses, options = {}) {
  if (!activeBatch || !Array.isArray(statuses)) return [];
  const stallMs = Number(options.stallMs) || 0;
  if (stallMs <= 0) return [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const stalled = [];
  for (const status of statuses) {
    if (!status) continue;
    if (status.terminal) continue;
    const action = extractAction(status);
    if (!STALL_CANDIDATE_ACTIONS.has(action)) continue;

    // 優先: status.latestTimestamp ベースでの idle 判定
    const tsRaw = extractTimestamp(status);
    if (tsRaw) {
      const tsMs = Date.parse(tsRaw);
      if (Number.isFinite(tsMs) && (now - tsMs) > stallMs) {
        stalled.push(Number(status.companyNo));
        continue;
      }
      // latestTimestamp が存在するなら、それが stall 未満ならスキップ
      if (Number.isFinite(tsMs)) continue;
    }

    // フォールバック: activeBatch.lastProgressAt を使った idle 判定
    // (既存のバッチ全体 stall 検知と整合させる)
    const lastProgressAt = Number(activeBatch.lastProgressAt) || 0;
    if (lastProgressAt > 0 && (now - lastProgressAt) > stallMs) {
      stalled.push(Number(status.companyNo));
    }
  }
  return stalled;
}

/**
 * error ログの理由文字列を生成する。
 *
 * @param {string} action - stall 発生時のアクション（message_draft / site_analysis / form_fill / unknown）
 * @param {number} idleMs - 最終更新からの経過 ms
 * @returns {string} 日本語の理由文字列
 */
function formatStallReason(action, idleMs) {
  const label = ACTION_LABELS[action] || action || 'unknown';
  const idleSec = Math.max(0, Math.round(Number(idleMs) / 1000) || 0);
  return `フェーズB遷移タイムアウト: ${label} で ${idleSec}秒更新なし（自動タイムアウト）`;
}

module.exports = {
  STALL_CANDIDATE_ACTIONS,
  detectStalledCompanies,
  formatStallReason,
};
