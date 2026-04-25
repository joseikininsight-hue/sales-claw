'use strict';

/**
 * Simple API Routes
 *
 * dashboard-server.cjs から切り出された軽量 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * シンプルなエンドポイントをまとめる。
 *
 * 対応エンドポイント:
 *  - POST /api/cli-log              — CLI からの外部ログ受信 (SSE push)
 *  - POST /api/install-update       — 自動更新インストールフラグ書き出し
 *  - GET  /api/update-status        — 更新ステータス返却 (electron-main が書き込んだ JSON を読む)
 *  - GET  /api/export               — action-log / companies の Excel export
 *  - GET  /api/data                 — ダッシュボードデータ (loadData 結果) を返す
 *  - GET  /api/claude-status        — AI プロバイダ状態 (エイリアス)
 *  - GET  /api/ai/status            — AI プロバイダ状態
 *  - GET  /api/ai/setup-diagnostics — セットアップ診断情報
 *  - POST /api/ai-submit            — 410 Gone (直接 JS 送信廃止)
 *  - GET  /api/ai-submit-status     — 410 Gone (直接 JS 送信ステータス廃止)
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 */

const fs = require('fs');
const XLSX = require('xlsx');
const settings = require('../settings-manager.cjs');
const { ensureDataDir, resolveDataPath } = require('../data-paths.cjs');

/**
 * Simple API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object> (現状未使用だが将来用に受け取る)
 * @param {function} ctx.loadData - () → { companies, recentLogs, ... }
 * @param {Set} ctx.sseClients - SSE 接続中の res オブジェクトセット (cli-log の push 先)
 * @param {function} ctx.probeClaudeStatus - (providerId) → Promise<status>
 * @param {function} ctx.probeAiSetupDiagnostics - (providerId) → Promise<diagnostics>
 * @param {function} ctx.getSelectedAiProvider - () → string (現在選択中プロバイダID)
 * @param {function} ctx.ensureParentDir - (filePath) 親ディレクトリを作る
 * @param {boolean}  ctx.AUTO_UPDATE_ENABLED - 自動更新が有効か
 * @param {string}   ctx.APP_BUILD_SOURCE - 'development' | 'dashboard-only' | 'packaged' など
 * @param {string}   ctx.APP_VERSION - アプリバージョン文字列
 * @returns {function} dispatch(req, res, pathname, requestUrl) → Promise<boolean> (handled なら true)
 */
module.exports = function createSimpleApiRoutes(ctx) {
  const {
    jsonResponse,
    loadData,
    sseClients,
    probeClaudeStatus,
    probeAiSetupDiagnostics,
    getSelectedAiProvider,
    ensureParentDir,
    AUTO_UPDATE_ENABLED,
    APP_BUILD_SOURCE,
    APP_VERSION,
  } = ctx;

  // ---------- 各ハンドラ関数 ----------

  // POST /api/ai-submit — 410 Gone
  async function handleAiSubmit(_req, res) {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission has been removed. Submit manually from the preserved browser tab.',
    });
  }

  // GET /api/ai-submit-status — 410 Gone
  async function handleAiSubmitStatus(_req, res) {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission status has been removed.',
    });
  }

  // POST /api/cli-log — CLI からのログを SSE で push
  async function handleCliLog(req, res) {
    const CLI_LOG_MAX = 64 * 1024;
    let body = '';
    let bodyOverflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > CLI_LOG_MAX) {
        bodyOverflow = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (bodyOverflow) return;
      try {
        const { message, type } = JSON.parse(body);
        const CLI_LOG_ALLOWED_TYPES = new Set(['info', 'step', 'error', 'action', 'warn', 'warning', 'thinking', 'debug']);
        const safeType = CLI_LOG_ALLOWED_TYPES.has(type) ? type : 'info';
        sseClients.forEach(r => {
          r.write(`data: ${JSON.stringify({ type: 'cli-log', message: String(message || '').slice(0, 4000), logType: safeType, time: new Date().toISOString() })}\n\n`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  // GET /api/ai/status (エイリアス: /api/claude-status)
  async function handleAiStatus(req, res, requestUrl) {
    try {
      const requestedProvider = requestUrl.searchParams.get('provider') || getSelectedAiProvider();
      const status = await probeClaudeStatus(requestedProvider);
      jsonResponse(res, 200, status);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/ai/setup-diagnostics — プロバイダセットアップ診断
  async function handleAiSetupDiagnostics(req, res, requestUrl) {
    try {
      const requestedProvider = requestUrl.searchParams.get('provider') || getSelectedAiProvider();
      const diagnostics = await probeAiSetupDiagnostics(requestedProvider);
      jsonResponse(res, 200, { ok: true, ...diagnostics });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/install-update — electron-main.js 用のインストールフラグを書き出す
  async function handleInstallUpdate(_req, res) {
    try {
      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 409, {
          ok: false,
          error: APP_BUILD_SOURCE === 'development'
            ? 'Development build does not support auto-install updates.'
            : 'Auto-update is not available in this runtime.',
          buildSource: APP_BUILD_SOURCE,
          appVersion: APP_VERSION,
        });
        return;
      }
      ensureDataDir();
      const flagFile = resolveDataPath('install-update.flag');
      ensureParentDir(flagFile);
      fs.writeFileSync(flagFile, Date.now().toString());
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/update-status — electron-main.js が書き込んだステータスを返す
  async function handleUpdateStatus(_req, res) {
    try {
      if (APP_BUILD_SOURCE === 'dashboard-only') {
        jsonResponse(res, 200, {
          ok: true,
          state: 'dashboard-only',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 200, {
          ok: true,
          state: APP_BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      const statusFile = resolveDataPath('update-status.json');
      if (fs.existsSync(statusFile)) {
        const raw = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        jsonResponse(res, 200, { ok: true, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED, ...raw, appVersion: APP_VERSION });
      } else {
        jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
      }
    } catch (e) {
      jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
    }
  }

  // GET /api/export — Excel export
  async function handleExport(_req, res) {
    try {
      const data = loadData();
      const prefs = settings.getSection('preferences');
      const prefix = prefs.exportFilenamePrefix || 'outreach_progress';
      const wb = XLSX.utils.book_new();
      const rows = [['No.', 'Status', 'Company', 'Type', 'Progress', 'Form URL', 'CAPTCHA', 'Last Action', 'Last Action Time', 'Details']];
      data.companies.forEach(c => {
        rows.push([
          c.no, c.status, c.name, c.type,
          c.lastAction || c.progress || 'Pending',
          c.formUrl, c.captcha,
          c.lastLog ? c.lastLog.action : '',
          c.lastLog ? new Date(c.lastLog.timestamp).toLocaleString('ja-JP', { timeZone: settings.getSection('preferences').timezone || 'Asia/Tokyo' }) : '',
          c.lastErrorDetail || (c.logs.length > 0 ? c.logs.map(l => `${l.action}: ${typeof l.details === 'object' ? JSON.stringify(l.details) : l.details}`).join(' | ') : ''),
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 5 }, { wch: 8 }, { wch: 25 }, { wch: 25 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 15 }, { wch: 18 }, { wch: 50 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Progress');

      const logRows = [['Time', 'No.', 'Company', 'Action', 'Details']];
      data.recentLogs.forEach(l => {
        logRows.push([new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: settings.getSection('preferences').timezone || 'Asia/Tokyo' }), l.companyNo, l.companyName, l.action, typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '']);
      });
      const ws2 = XLSX.utils.aoa_to_sheet(logRows);
      ws2['!cols'] = [{ wch: 20 }, { wch: 5 }, { wch: 25 }, { wch: 15 }, { wch: 60 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Action Log');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${prefix}_${new Date().toISOString().slice(0,10)}.xlsx"`,
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Export error: ' + e.message);
    }
  }

  // GET /api/data — ダッシュボードデータ
  async function handleData(_req, res) {
    try {
      jsonResponse(res, 200, loadData());
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が simple API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @param {URL} requestUrl - new URL(req.url, 'http://127.0.0.1') 等で事前に構築した URL オブジェクト
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname, requestUrl) {
    // すべて pathname (? 除去済み) で比較する。
    // req.url 直接参照はクエリ文字列で誤マッチ or バイパスするリスクがある。
    const method = req.method;

    // POST /api/ai-submit (410 Gone)
    if (pathname === '/api/ai-submit' && method === 'POST') {
      await handleAiSubmit(req, res);
      return true;
    }

    // GET /api/ai-submit-status (410 Gone) — オリジナルは method 指定なしだったため GET のみに限定せず ?
    //   元コード: if (req.url === '/api/ai-submit-status') { ... }
    //   method に関係なく 410 を返していたので、そのまま踏襲する。
    if (pathname === '/api/ai-submit-status') {
      await handleAiSubmitStatus(req, res);
      return true;
    }

    // POST /api/cli-log
    if (pathname === '/api/cli-log' && method === 'POST') {
      await handleCliLog(req, res);
      return true;
    }

    // GET /api/claude-status または /api/ai/status
    if ((pathname === '/api/claude-status' || pathname === '/api/ai/status') && method === 'GET') {
      await handleAiStatus(req, res, requestUrl);
      return true;
    }

    // GET /api/ai/setup-diagnostics
    if (pathname === '/api/ai/setup-diagnostics' && method === 'GET') {
      await handleAiSetupDiagnostics(req, res, requestUrl);
      return true;
    }

    // POST /api/install-update
    if (pathname === '/api/install-update' && method === 'POST') {
      await handleInstallUpdate(req, res);
      return true;
    }

    // GET /api/update-status
    if (pathname === '/api/update-status' && method === 'GET') {
      await handleUpdateStatus(req, res);
      return true;
    }

    // GET /api/export
    //   元コード: if (req.url === '/api/export') { ... } (method チェックなし)
    //   そのまま method 指定なしで踏襲する
    if (pathname === '/api/export') {
      await handleExport(req, res);
      return true;
    }

    // GET /api/data
    //   元コード: if (req.url === '/api/data') { ... } (method チェックなし)
    //   そのまま method 指定なしで踏襲する
    if (pathname === '/api/data') {
      await handleData(req, res);
      return true;
    }

    // 管轄外
    return false;
  };
};
