'use strict';

/**
 * Settings API Routes
 *
 * dashboard-server.cjs から切り出された設定系 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * ルーター関数を集約する。
 *
 * 対応エンドポイント:
 *  - POST   /api/settings/select-directory
 *  - GET    /api/settings/excel/export
 *  - POST   /api/settings/excel/import
 *  - GET    /api/settings
 *  - PUT    /api/settings/:section        (companyProfile/valuePropositions/targetList/exclusionRules/messageTemplates/preferences)
 *  - POST   /api/settings/upload-document
 *  - GET    /api/settings/target-list/preview
 *  - POST   /api/target-list/import
 *  - POST   /api/companies
 *  - POST   /api/companies/bulk-delete
 *  - PUT    /api/companies/:id
 *  - DELETE /api/companies/:id
 *  - POST   /api/outreach-targets
 *  - POST   /api/outreach/prepare         (410 Gone / 廃止済み)
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 */

const settings = require('../settings-manager.cjs');
const {
  appendCompany,
  deleteCompany,
  findCompaniesByNos,
  getTargetPreview,
  importTargetList,
  updateCompany,
} = require('../target-list.cjs');
const { setTargets } = require('../outreach-targets.cjs');
const {
  buildWorkbookBuffer: buildSettingsWorkbookBuffer,
  parseWorkbookBuffer: parseSettingsWorkbookBuffer,
} = require('../settings-excel.cjs');
// action-logger は PUT /api/settings/:section で監査ログに使う
const { logAction } = require('../action-logger.cjs');

const SETTINGS_SECTION_RE = /^\/api\/settings\/(companyProfile|valuePropositions|targetList|exclusionRules|messageTemplates|preferences)$/;

/**
 * Settings API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object>
 * @param {function} ctx.notifyClients - (payload) SSE クライアントに push
 * @param {function} ctx.refreshWatchTargets - () ターゲットリスト監視を再読み込み
 * @param {function} ctx.openDirectoryPicker - (initialPath?) → Promise<string|null>
 * @param {function} ctx.toStoredProjectPath - (absolutePath) → string
 * @param {function} ctx.loadData - (options?) → { companies, ... }
 * @param {function} ctx.purgeHistoryOnlyCompany - (companyNo) → { ok, company, ... }
 * @param {function} ctx.findRuntimeCompanyRecord - (companyNo) → runtime company | null
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createSettingsApiRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    notifyClients,
    refreshWatchTargets,
    openDirectoryPicker,
    toStoredProjectPath,
    loadData,
    purgeHistoryOnlyCompany,
    findRuntimeCompanyRecord,
  } = ctx;

  // ---------- 各ハンドラ関数 ----------

  // POST /api/settings/select-directory - open native folder picker
  async function handleSelectDirectory(req, res) {
    try {
      const body = await parseJsonBody(req).catch(() => ({}));
      const selectedPath = await openDirectoryPicker(body.currentPath || '');
      if (!selectedPath) {
        jsonResponse(res, 200, { ok: true, cancelled: true });
        return;
      }
      jsonResponse(res, 200, { ok: true, path: toStoredProjectPath(selectedPath) });
    } catch (e) {
      const statusCode = /desktop app|browser-only mode/i.test(String(e.message || '')) ? 409 : 500;
      jsonResponse(res, statusCode, { ok: false, error: e.message });
    }
  }

  // GET /api/settings/excel/export - export Company Profile + Value Propositions workbook
  async function handleSettingsExcelExport(req, res) {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const mode = requestUrl.searchParams.get('mode') === 'template' ? 'template' : 'current';
      const buffer = buildSettingsWorkbookBuffer({
        mode,
        settingsData: settings.getAll(),
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `sales-claw-settings-${mode}-${stamp}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      res.end(buffer);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/settings/excel/import - import Company Profile + Value Propositions workbook
  async function handleSettingsExcelImport(req, res) {
    try {
      const data = await parseJsonBody(req);
      const { contentBase64 } = data || {};
      if (!contentBase64) {
        jsonResponse(res, 400, { ok: false, error: 'contentBase64 is required.' });
        return;
      }
      const imported = parseSettingsWorkbookBuffer(Buffer.from(contentBase64, 'base64'));
      if (imported.sections.companyProfile) {
        settings.replaceSection('companyProfile', imported.sections.companyProfile);
      }
      if (imported.sections.valuePropositions) {
        settings.replaceSection('valuePropositions', imported.sections.valuePropositions);
      }
      notifyClients({ type: 'update', reason: 'settings-excel-imported', time: Date.now() });
      jsonResponse(res, 200, {
        ok: true,
        applied: imported.applied,
        summary: imported.summary,
        companyProfile: imported.sections.companyProfile || null,
        valuePropositions: imported.sections.valuePropositions || null,
      });
    } catch (e) {
      jsonResponse(res, 400, { ok: false, error: e.message });
    }
  }

  // GET /api/settings - returns all settings
  async function handleSettingsGet(req, res) {
    try {
      jsonResponse(res, 200, settings.getAll());
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  }

  // PUT /api/settings/:section - update a section
  // section はホワイトリスト正規表現を通過済みの値を dispatcher から受け取る
  async function handleSettingsPutSection(req, res, section) {
    try {
      const data = await parseJsonBody(req);
      settings.replaceSection(section, data);

      // 設定変更を監査ログに記録 (失敗時は warn に出して黙って消さない)
      try {
        logAction(-1, 'SYSTEM', 'settings_changed', 'セクション「' + section + '」を更新');
      } catch (logErr) {
        console.warn('[settings-api] settings_changed log failed:', logErr && logErr.message);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'settings-saved', time: Date.now() });
      jsonResponse(res, 200, { ok: true, data: settings.getSection(section) });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/settings/upload-document - register document file path
  async function handleSettingsUploadDocument(req, res) {
    try {
      const data = await parseJsonBody(req);
      const { name, filePath, description } = data;
      if (!name || !filePath) {
        jsonResponse(res, 400, { error: 'name and filePath are required' });
        return;
      }
      const vp = settings.getSection('valuePropositions');
      const docs = vp.documentPaths || [];
      docs.push({ name, path: filePath, description: description || '' });
      settings.updateSection('valuePropositions', { documentPaths: docs });
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
  }

  // GET /api/settings/target-list/preview - preview first 10 rows
  async function handleTargetListPreview(req, res) {
    try {
      const preview = getTargetPreview(10);
      if (!preview.ok) {
        jsonResponse(res, 200, { error: preview.error });
        return;
      }
      jsonResponse(res, 200, { headers: preview.headers, rows: preview.rows });
    } catch (e) {
      jsonResponse(res, 200, { error: e.message });
    }
  }

  // POST /api/target-list/import - import Excel/CSV and switch target list
  async function handleTargetListImport(req, res) {
    try {
      const data = await parseJsonBody(req);
      const { fileName, contentBase64 } = data || {};
      if (!fileName || !contentBase64) {
        jsonResponse(res, 400, { ok: false, error: 'fileName and contentBase64 are required.' });
        return;
      }

      const imported = importTargetList({
        fileName,
        buffer: Buffer.from(contentBase64, 'base64'),
      });

      if (!imported.ok) {
        jsonResponse(res, 400, { ok: false, error: imported.error || 'Import failed.' });
        return;
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'target-list-imported', time: Date.now() });
      jsonResponse(res, 200, { ok: true, ...imported });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/companies - add a company row to current target list
  async function handleCompanyCreate(req, res) {
    try {
      const data = await parseJsonBody(req);
      const created = appendCompany(data || {});
      if (!created.ok) {
        jsonResponse(res, 400, { ok: false, error: created.error || 'Company add failed.' });
        return;
      }

      if (data && data.addToTarget) {
        setTargets([{
          companyNo: created.company.no,
          companyName: created.company.companyName,
        }], true);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-added', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: created.company, targetPath: created.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/companies/bulk-delete
  async function handleCompanyBulkDelete(req, res) {
    try {
      const data = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }

      const uniqueCompanyNos = Array.from(new Set(companyNos.map((value) => String(value))));
      const deletedCompanies = [];
      const skippedCompanies = [];
      const runtimeCompanyMap = new Map(loadData().companies.map((company) => [String(company.no), company]));
      for (const companyNo of uniqueCompanyNos) {
        let removed = deleteCompany(companyNo);
        if (!removed.ok) removed = purgeHistoryOnlyCompany(companyNo);
        if (!removed.ok) {
          skippedCompanies.push({ companyNo, error: removed.error || `Failed to delete company ${companyNo}.` });
          continue;
        }
        const runtimeCompany = runtimeCompanyMap.get(String(companyNo));
        deletedCompanies.push({
          ...removed.company,
          no: removed.company && removed.company.no !== undefined ? removed.company.no : companyNo,
          companyName: (removed.company && removed.company.companyName) || (runtimeCompany && runtimeCompany.name) || String(companyNo),
        });
      }

      if (deletedCompanies.length > 0) {
        setTargets(deletedCompanies.map((company) => ({
          companyNo: company.no,
          companyName: company.companyName,
        })), false);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-bulk-deleted', time: Date.now() });
      jsonResponse(res, 200, {
        ok: true,
        deletedCount: deletedCompanies.length,
        companies: deletedCompanies,
        skippedCount: skippedCompanies.length,
        skippedCompanies,
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // PUT /api/companies/:id
  async function handleCompanyUpdate(req, res, companyApiMatch) {
    try {
      const companyNo = decodeURIComponent(companyApiMatch[1]);
      const data = await parseJsonBody(req);
      const updated = updateCompany(companyNo, data || {});
      if (!updated.ok) {
        jsonResponse(res, 400, { ok: false, error: updated.error || 'Company update failed.' });
        return;
      }

      if (data && Object.prototype.hasOwnProperty.call(data, 'addToTarget')) {
        setTargets([{
          companyNo: updated.company.no,
          companyName: updated.company.companyName,
        }], !!data.addToTarget);
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-updated', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: updated.company, targetPath: updated.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // DELETE /api/companies/:id
  async function handleCompanyDelete(req, res, companyApiMatch) {
    try {
      const companyNo = decodeURIComponent(companyApiMatch[1]);
      const runtimeCompany = findRuntimeCompanyRecord(companyNo);
      let removed = deleteCompany(companyNo);
      if (!removed.ok) removed = purgeHistoryOnlyCompany(companyNo);
      if (!removed.ok) {
        jsonResponse(res, 400, { ok: false, error: removed.error || 'Company delete failed.' });
        return;
      }

      setTargets([{
        companyNo: removed.company.no,
        companyName: removed.company.companyName || (runtimeCompany && runtimeCompany.name) || String(companyNo),
      }], false);

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'company-deleted', time: Date.now() });
      jsonResponse(res, 200, { ok: true, company: removed.company, targetPath: removed.targetPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/outreach-targets - persist outreach target selection
  async function handleOutreachTargets(req, res) {
    try {
      const data = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      const active = data && data.active !== false;
      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }

      const found = findCompaniesByNos(companyNos);
      if (!found.ok) {
        jsonResponse(res, 400, { ok: false, error: found.error || 'Target companies not found.' });
        return;
      }

      const targets = found.companies.map((company) => ({
        companyNo: company.no,
        companyName: company.companyName,
      }));
      setTargets(targets, active);
      notifyClients({ type: 'update', reason: 'outreach-targets-updated', time: Date.now() });
      jsonResponse(res, 200, { ok: true, count: targets.length, active });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/outreach/prepare - disabled to prevent direct JS automation fallback
  async function handleOutreachPrepare(_req, res) {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS outreach preparation has been removed. Use /api/ai-form-fill with a managed AI session.',
    });
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が settings API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname) {
    // すべて pathname (? 除去済み) で比較する。
    // req.url 直接参照はクエリ文字列で誤マッチ or バイパスするリスクがある。
    const method = req.method;

    // POST /api/settings/select-directory
    if (pathname === '/api/settings/select-directory' && method === 'POST') {
      await handleSelectDirectory(req, res);
      return true;
    }

    // GET /api/settings/excel/export (クエリ ?mode=template を許容するため pathname === で一致)
    if (pathname === '/api/settings/excel/export' && method === 'GET') {
      await handleSettingsExcelExport(req, res);
      return true;
    }

    // POST /api/settings/excel/import
    if (pathname === '/api/settings/excel/import' && method === 'POST') {
      await handleSettingsExcelImport(req, res);
      return true;
    }

    // GET /api/settings
    if (pathname === '/api/settings' && method === 'GET') {
      await handleSettingsGet(req, res);
      return true;
    }

    // PUT /api/settings/:section (section はホワイトリスト正規表現)
    if (method === 'PUT') {
      const sectionMatch = pathname.match(SETTINGS_SECTION_RE);
      if (sectionMatch) {
        await handleSettingsPutSection(req, res, sectionMatch[1]);
        return true;
      }
    }

    // POST /api/settings/upload-document
    if (pathname === '/api/settings/upload-document' && method === 'POST') {
      await handleSettingsUploadDocument(req, res);
      return true;
    }

    // GET /api/settings/target-list/preview
    if (pathname === '/api/settings/target-list/preview' && method === 'GET') {
      await handleTargetListPreview(req, res);
      return true;
    }

    // POST /api/target-list/import
    if (pathname === '/api/target-list/import' && method === 'POST') {
      await handleTargetListImport(req, res);
      return true;
    }

    // POST /api/companies
    if (pathname === '/api/companies' && method === 'POST') {
      await handleCompanyCreate(req, res);
      return true;
    }

    // POST /api/companies/bulk-delete (companyApiMatch よりも先に判定)
    if (pathname === '/api/companies/bulk-delete' && method === 'POST') {
      await handleCompanyBulkDelete(req, res);
      return true;
    }

    // PUT /api/companies/:id / DELETE /api/companies/:id
    const companyApiMatch = pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (companyApiMatch && method === 'PUT') {
      await handleCompanyUpdate(req, res, companyApiMatch);
      return true;
    }
    if (companyApiMatch && method === 'DELETE') {
      await handleCompanyDelete(req, res, companyApiMatch);
      return true;
    }

    // POST /api/outreach-targets
    if (pathname === '/api/outreach-targets' && method === 'POST') {
      await handleOutreachTargets(req, res);
      return true;
    }

    // POST /api/outreach/prepare (410 Gone)
    if (pathname === '/api/outreach/prepare' && method === 'POST') {
      await handleOutreachPrepare(req, res);
      return true;
    }

    // 管轄外
    return false;
  };
};
