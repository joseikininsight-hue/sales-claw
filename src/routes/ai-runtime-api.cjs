'use strict';

/**
 * AI Runtime API Routes
 *
 * dashboard-server.cjs から切り出された AI runtime 系 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * AI (Claude/他) の CLI インストール・PTY 起動/停止・入力送信に関わる
 * ルーター関数を集約する。
 *
 * 対応エンドポイント:
 *  - POST /api/install-claude-cli     (legacy 名) / POST /api/install-ai-cli
 *  - POST /api/launch-claude          (legacy 名) / POST /api/launch-ai
 *  - POST /api/launch-claude-external (legacy 名) / POST /api/launch-ai-external
 *  - POST /api/stop-claude            (legacy 名) / POST /api/stop-ai
 *  - POST /api/claude-input           (legacy 名) / POST /api/ai-input
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 * claudePty / claudeProcess のような state は依然として dashboard-server.cjs に
 * 存在するため、getter / setter 関数で ctx 経由で参照する。
 */

const {
  getInstallCommand,
  getInstallSpawnArgs,
} = require('../ai-providers.cjs');

/**
 * AI Runtime API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティ & state アクセサを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object>
 * @param {string}   ctx.PROJECT_ROOT - プロジェクトルート絶対パス
 *
 * @param {function} ctx.normalizeProviderId - (id) → 正規化された providerId
 * @param {function} ctx.getSelectedAiProvider - () → 現在選択中の providerId
 * @param {function} ctx.getProvider - (providerId) → provider定義 (displayName/cliLabel 等)
 * @param {function} ctx.getProviderDisplayName - (providerId) → 表示名
 *
 * @param {function} ctx.probeNpmStatus - () → Promise<{ available, error? }>
 * @param {function} ctx.probeClaudeStatus - (providerId) → Promise<{ installed, version }>
 * @param {function} ctx.setProviderInstallState - (providerId, state, error) → void
 * @param {function} ctx.invalidateAiStatusCache - (providerId?) → void
 * @param {function} ctx.clearAiExecutablePath - (providerId) → void (既存の `_aiExecutablePath[providerId] = null;` と同等)
 *
 * @param {function} ctx.startManagedAiSession - (mode, providerId, options) → Promise<Result>
 * @param {function} ctx.launchClaudeInExternalTerminal - (mode, providerId, autoSendSafe) → Promise<Result>
 * @param {function} ctx.stopManagedClaudePty - (options) → Promise<Result>
 * @param {function} ctx.stopHeadlessAiRun - (providerId) → Promise<Result>
 * @param {function} ctx.getActiveHeadlessRun - (providerId?) → run | null
 * @param {function} ctx.getHeadlessAiRun - () → headlessAiRun (state snapshot for provider selection)
 *
 * @param {function} ctx.getClaudePty - () → claudePty | null  (PTY インスタンスを取得)
 * @param {function} ctx.getClaudeProcess - () → claudeProcess | null
 * @param {function} ctx.clearClaudeProcess - () → void (claudeProcess && kill(); null 代入)
 *
 * @param {function} ctx.appendDiagnosticEvent - (type, payload) → void
 *
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createAiRuntimeRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    PROJECT_ROOT,
    normalizeProviderId,
    getSelectedAiProvider,
    getProvider,
    getProviderDisplayName,
    probeNpmStatus,
    probeClaudeStatus,
    setProviderInstallState,
    invalidateAiStatusCache,
    clearAiExecutablePath,
    startManagedAiSession,
    launchClaudeInExternalTerminal,
    stopManagedClaudePty,
    stopHeadlessAiRun,
    getActiveHeadlessRun,
    getHeadlessAiRun,
    getClaudePty,
    getClaudeProcess,
    clearClaudeProcess,
    // appendDiagnosticEvent は現状このモジュール内では未使用だが、互換性維持のため受け取る
  } = ctx;

  // ---------- 各ハンドラ関数 ----------

  // POST /api/install-ai-cli (legacy: /api/install-claude-cli) — attempt automatic global install
  async function handleInstallAi(req, res) {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const provider = getProvider(providerId);
      const npmStatus = await probeNpmStatus();
      if (!npmStatus.available) {
        const installError = `${provider.cliLabel} の自動インストールには npm が必要です。${npmStatus.error || ''}`.trim();
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 409, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          command: getInstallCommand(providerId),
        });
        return;
      }
      const installSpec = getInstallSpawnArgs(providerId);
      setProviderInstallState(providerId, 'installing', null);
      invalidateAiStatusCache(providerId);
      clearAiExecutablePath(providerId);

      const { spawn } = require('child_process');
      const child = spawn(installSpec.command, installSpec.args, {
        cwd: PROJECT_ROOT,
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      child.stdout && child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr && child.stderr.on('data', (data) => { stderr += data.toString(); });

      const result = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve({ code }));
      });

      if (result.code !== 0) {
        const installError = (stderr || stdout || `npm exited with code ${result.code}`).trim();
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          code: result.code,
          command: getInstallCommand(providerId),
        });
        return;
      }

      invalidateAiStatusCache(providerId);
      const status = await probeClaudeStatus(providerId);
      if (!status.installed) {
        const installError = `${provider.cliLabel} was not detected after installation.`;
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          command: getInstallCommand(providerId),
        });
        return;
      }

      setProviderInstallState(providerId, 'idle', null);
      jsonResponse(res, 200, {
        ok: true,
        provider: providerId,
        providerLabel: provider.displayName,
        installed: status.installed,
        version: status.version,
        command: getInstallCommand(providerId),
      });
    } catch (e) {
      const providerId = getSelectedAiProvider();
      setProviderInstallState(providerId, 'failed', e.message);
      jsonResponse(res, 500, { ok: false, provider: providerId, error: e.message, command: getInstallCommand(providerId) });
    }
  }

  // POST /api/launch-ai (legacy: /api/launch-claude) — spawn selected provider in a real PTY via node-pty
  async function handleLaunchAi(req, res) {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const { mode = 'default', cols = 120, rows = 30 } = body;
      const autoSendSafe = body.autoSendSafe === true;
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const result = await startManagedAiSession(mode, providerId, {
        cols,
        rows,
        allowReuse: false,
        autoSendSafe,
      });
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/launch-ai-external (legacy: /api/launch-claude-external) — open selected provider in an interactive external terminal
  async function handleLaunchAiExternal(req, res) {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const { mode = 'default' } = body;
      const result = await launchClaudeInExternalTerminal(mode, providerId, body.autoSendSafe === true);
      invalidateAiStatusCache(providerId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/stop-ai (legacy: /api/stop-claude) — stop active AI runtime
  async function handleStopAi(req, res) {
    const headlessRun = typeof getHeadlessAiRun === 'function' ? getHeadlessAiRun() : null;
    const providerId = headlessRun ? headlessRun.provider : getSelectedAiProvider();
    const provider = getProvider(providerId);
    const stopped = getActiveHeadlessRun(providerId)
      ? await stopHeadlessAiRun(providerId)
      : await stopManagedClaudePty({ suppressAutoRecovery: true });
    if (!stopped.ok) {
      jsonResponse(res, 500, stopped);
      return;
    }
    const claudeProcess = typeof getClaudeProcess === 'function' ? getClaudeProcess() : null;
    if (claudeProcess && !claudeProcess.killed) {
      try { clearClaudeProcess(); } catch (_) {}
    }
    invalidateAiStatusCache(providerId);
    jsonResponse(res, 200, { ...stopped, provider: providerId, providerLabel: provider.displayName });
  }

  // POST /api/ai-input (legacy: /api/claude-input) — send text to managed AI PTY (fallback for non-WS clients)
  async function handleAiInput(req, res) {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const { text } = body;
      const claudePty = getClaudePty();
      if (claudePty) {
        claudePty.write(text || '');
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 409, { ok: false, error: `${getProviderDisplayName(getSelectedAiProvider())} is not running (managed mode)` });
      }
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が AI runtime API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * legacy 名 (/api/*-claude*) と新 名 (/api/*-ai*) の両方を受け付ける。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname) {
    const method = req.method;

    // POST /api/install-claude-cli | /api/install-ai-cli
    if ((pathname === '/api/install-claude-cli' || pathname === '/api/install-ai-cli') && method === 'POST') {
      await handleInstallAi(req, res);
      return true;
    }

    // POST /api/launch-claude | /api/launch-ai
    if ((pathname === '/api/launch-claude' || pathname === '/api/launch-ai') && method === 'POST') {
      await handleLaunchAi(req, res);
      return true;
    }

    // POST /api/launch-claude-external | /api/launch-ai-external
    if ((pathname === '/api/launch-claude-external' || pathname === '/api/launch-ai-external') && method === 'POST') {
      await handleLaunchAiExternal(req, res);
      return true;
    }

    // POST /api/stop-claude | /api/stop-ai
    if ((pathname === '/api/stop-claude' || pathname === '/api/stop-ai') && method === 'POST') {
      await handleStopAi(req, res);
      return true;
    }

    // POST /api/claude-input | /api/ai-input
    if ((pathname === '/api/claude-input' || pathname === '/api/ai-input') && method === 'POST') {
      await handleAiInput(req, res);
      return true;
    }

    // 管轄外
    return false;
  };
};
