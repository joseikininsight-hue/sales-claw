// Sales Claw Dashboard Server
// fs.watch でファイル変更をイベント検知 → SSE → フロントで差分DOM更新

const http = require('http');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getAllLogs } = require('./action-logger.cjs');
const { getHistory } = require('./contact-history.cjs');
const { readRuntime, toClientHost, writeRuntime, clearRuntime } = require('./dashboard-runtime.cjs');
const settings = require('./settings-manager.cjs');
const { getTranslations, t: i18nT } = require('./i18n.cjs');
const { findAvailablePort } = require('./port-utils.cjs');
const { getTargetPreview, readTargetList } = require('./target-list.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'action-log.json');
const CONTACT_HISTORY_FILE = path.join(DATA_DIR, 'contact-history.json');
const AI_QUEUE_FILE = path.join(DATA_DIR, 'ai-submit-queue.json');

// SSE クライアント管理
const sseClients = new Set();
const activeWatchers = new Map();
let heartbeatTimer = null;
let dashboardRuntime = null;
let serverStartPromise = null;
let _claudeStatusCache = null;
let _claudeStatusCacheTime = 0;

function notifyClients(payload) {
  const body = payload || { type: 'update', time: Date.now() };
  sseClients.forEach(res => {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
  });
}

let debounceTimer = null;
function queueClientRefresh(reason, filePath) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    refreshWatchTargets();
    if (filePath) {
      console.log(`[${new Date().toLocaleTimeString('ja-JP')}] 変更検知: ${path.basename(filePath)}`);
    }
    notifyClients({ type: 'update', reason, time: Date.now() });
  }, 250);
}

function closeWatchers() {
  activeWatchers.forEach(({ watcher }) => watcher.close());
  activeWatchers.clear();
}

function watchTarget(targetPath, mode) {
  if (!targetPath) return;

  const resolvedPath = path.resolve(targetPath);
  const effectiveMode = mode || (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory() ? 'dir' : 'file');
  const watchedPath = effectiveMode === 'dir'
    ? resolvedPath
    : (fs.existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath));
  const key = `${effectiveMode}:${resolvedPath}`;
  if (activeWatchers.has(key)) return;

  try {
    if (effectiveMode === 'dir' && !fs.existsSync(watchedPath)) {
      fs.mkdirSync(watchedPath, { recursive: true });
    }

    const watcher = fs.watch(watchedPath, (_, changedName) => {
      if (effectiveMode === 'file' && watchedPath !== resolvedPath && changedName) {
        if (String(changedName) !== path.basename(resolvedPath)) return;
      }
      queueClientRefresh(effectiveMode === 'dir' ? 'directory-change' : 'file-change', resolvedPath);
    });

    activeWatchers.set(key, { watcher, watchedPath });
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watching')}: ${path.basename(resolvedPath)}`);
  } catch (e) {
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watchFailed')}: ${path.basename(resolvedPath)} (${e.message})`);
  }
}

function refreshWatchTargets() {
  const desired = new Map();
  const screenshotDir = settings.getScreenshotDir();
  const targetPath = settings.getTargetListPath();
  const settingsPath = path.join(PROJECT_ROOT, 'data', 'settings.json');

  [
    { path: LOG_FILE, mode: 'file' },
    { path: CONTACT_HISTORY_FILE, mode: 'file' },
    { path: AI_QUEUE_FILE, mode: 'file' },
    { path: settingsPath, mode: 'file' },
    { path: screenshotDir, mode: 'dir' },
    ...(targetPath ? [{ path: targetPath, mode: 'file' }] : []),
  ].forEach((entry) => {
    if (!entry.path) return;
    desired.set(`${entry.mode}:${path.resolve(entry.path)}`, entry);
  });

  activeWatchers.forEach((value, key) => {
    if (!desired.has(key)) {
      value.watcher.close();
      activeWatchers.delete(key);
    }
  });

  desired.forEach((entry) => watchTarget(entry.path, entry.mode));
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    sseClients.forEach((res) => res.write(': heartbeat\n\n'));
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function getLatestLog(logs, action) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i].action === action) return logs[i];
  }
  return null;
}

function buildOperationalIssues(targetData, runtime) {
  const lang = settings.getSection('preferences').language || 'ja';
  const issues = [];
  const sender = settings.getSender();

  if (!settings.isConfigured()) {
    issues.push(lang === 'ja'
      ? '自社情報が未設定です。Settings で会社情報を入力してください。'
      : 'Company profile is incomplete. Open Settings and fill in your sender information.');
  }

  if (sender.email && /example\.com|demo/i.test(sender.email)) {
    issues.push(lang === 'ja'
      ? 'サンプル設定が読み込まれています。公開利用前に Settings で自社情報へ置き換えてください。'
      : 'Sample settings are active. Replace them with your real company information before production use.');
  }

  if (!targetData.ok) {
    issues.push(lang === 'ja'
      ? `ターゲットリスト未準備: ${targetData.error}`
      : `Target list is not ready: ${targetData.error}`);
  }

  if (runtime && runtime.preferredPort && runtime.port !== runtime.preferredPort) {
    issues.push(lang === 'ja'
      ? `設定ポート ${runtime.preferredPort} は使用中のため、現在は ${runtime.port} 番で起動しています。`
      : `Preferred port ${runtime.preferredPort} was busy, so the dashboard is currently running on port ${runtime.port}.`);
  }

  return issues;
}

// データ読み込み → JSON API 用
function loadData() {
  const targetData = readTargetList();
  const data = targetData.ok ? targetData.companies : [];
  const allLogs = getAllLogs();
  const logsByCompany = {};
  const nameToNo = {};
  data.forEach(row => {
    if (row.companyName && row.no !== null && row.no !== undefined) nameToNo[row.companyName] = row.no;
  });
  allLogs.forEach(log => {
    let no = log.companyNo;
    if (no === undefined || no === null) {
      const name = log.companyName || log.company || '';
      no = nameToNo[name];
      if (!no) {
        // 部分一致
        const match = Object.entries(nameToNo).find(([n]) => n.includes(name) || name.includes(n));
        if (match) no = match[1];
      }
    }
    if (no !== undefined && no !== null) {
      if (!logsByCompany[no]) logsByCompany[no] = [];
      logsByCompany[no].push(log);
    }
  });

  const statusExclude = settings.getExcludeStatuses();
  const stats = { total: 0, approachable: 0, hasFormUrl: 0, noFormUrl: 0, excluded: 0, formFill: 0, confirmReached: 0, submitted: 0, error: 0, awaitingApproval: 0 };

  const companies = data.map(row => {
    const no = row.no;
    const status = row.status || '';
    const isExcluded = statusExclude.includes(status);
    const isApproachable = !isExcluded;
    const logs = logsByCompany[no] || [];
    const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

    stats.total++;
    if (isExcluded) stats.excluded++;
    if (isApproachable) {
      stats.approachable++;
      if (row.formUrl) stats.hasFormUrl++; else stats.noFormUrl++;
    }
    if (lastLog) {
      if (lastLog.action === 'form_fill') stats.formFill++;
      if (lastLog.action === 'confirm_reached') stats.confirmReached++;
      if (lastLog.action === 'awaiting_approval') stats.awaitingApproval++;
      if (lastLog.action === 'submitted') stats.submitted++;
      if (lastLog.action === 'error') stats.error++;
    }

    const messageDraft = getLatestLog(logs, 'message_draft');
    const submittedLog = getLatestLog(logs, 'submitted');
    const siteAnalysis = getLatestLog(logs, 'site_analysis');
    const formFillLog = getLatestLog(logs, 'form_fill');
    const awaitingLog = getLatestLog(logs, 'awaiting_approval');
    const confirmLog = getLatestLog(logs, 'confirm_reached');
    const contactHist = getHistory(no);
    const contactCount = contactHist ? contactHist.contacts.length : 0;

    return {
      no, status, name: row.companyName || '', type: row.type || '',
      url: row.url || '', formUrl: row.formUrl || '',
      captcha: row.captcha || '', progress: row.progress || '',
      isApproachable,
      lastAction: lastLog ? lastLog.action : null,
      lastActionAt: lastLog ? lastLog.timestamp : null,
      lastLog,
      logs: logs.slice(-3).map(l => ({
        time: l.timestamp, action: l.action,
        details: typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '',
      })),
      sentMessage: messageDraft ? messageDraft.details : (formFillLog ? formFillLog.details : null),
      sentAt: submittedLog ? submittedLog.timestamp : null,
      analysis: siteAnalysis ? siteAnalysis.details : null,
      awaitingAt: awaitingLog ? awaitingLog.timestamp : (confirmLog ? confirmLog.timestamp : null),
      contactCount,
      contactHistory: contactHist ? contactHist.contacts : [],
    };
  });

  const runtime = dashboardRuntime || readRuntime();
  return {
    companies,
    stats,
    recentLogs: allLogs.slice(-100).reverse(),
    issues: buildOperationalIssues(targetData, runtime),
    runtime,
  };
}

// JSON body parser helper
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

// JSON response helper
function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// HTML テンプレート
function buildPage() {
  const _lang = settings.getSection('preferences').language || 'ja';
  const _t = getTranslations(_lang);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sales Claw</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --surface:#f7f9fb;--surface-low:#f0f4f7;--surface-lowest:#ffffff;--surface-high:#e1e9ee;
  --primary:#465f88;--primary-dim:#3a537c;--on-primary:#ffffff;
  --on-surface:#2a3439;--on-surface-variant:#566166;--outline-variant:#a9b4b9;
  --secondary-container:#dce4eb;--error:#9f403d;--error-container:#f5dedd;
  --success:#2d7a4f;--success-container:#d4edda;--warning:#8a6700;--warning-container:#fff3cd;
  --info:#3a6f9a;--info-container:#d0e8f7;
  --font-display:'Manrope',sans-serif;--font-body:'Inter','Yu Gothic',sans-serif;
  --radius-md:0.375rem;--radius-lg:0.5rem;
  --shadow-ambient:0 2px 32px rgba(42,52,57,.06);
}
*{box-sizing:border-box}
body{font-family:var(--font-body);background:var(--surface);margin:0;color:var(--on-surface);font-size:.875rem;line-height:1.5}
.header{background:linear-gradient(135deg,var(--primary) 0%,var(--primary-dim) 100%);color:var(--on-primary);padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem}
.header h1{font-family:var(--font-display);font-size:1.15rem;margin:0;font-weight:700;letter-spacing:.3px}
.sc{background:var(--surface-lowest);border-radius:var(--radius-lg);box-shadow:var(--shadow-ambient);transition:transform .15s}
.sc:hover{transform:translateY(-1px)}
.sn{font-family:var(--font-display);font-size:1.6rem;font-weight:800;transition:color .3s}
.sn.changed{animation:pop .4s}
.sl{font-size:.7rem;color:var(--on-surface-variant);margin-top:2px;font-weight:500;text-transform:uppercase;letter-spacing:.05em}
@keyframes pop{0%{transform:scale(1)}50%{transform:scale(1.1)}100%{transform:scale(1)}}
.tc{background:var(--surface-lowest);border-radius:var(--radius-lg);box-shadow:var(--shadow-ambient)}
.furl{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.log-entry{font-size:.75rem;color:var(--on-surface-variant);padding:4px 8px;margin:2px 0;background:var(--surface-low);border-radius:var(--radius-md)}
.log-entry.error{background:var(--error-container)}
.log-entry.success{background:var(--success-container)}
.ts{font-size:.7rem;color:var(--outline-variant)}
.fb{border-radius:var(--radius-md);font-size:.78rem;padding:5px 14px;border:none;background:var(--surface-high);color:var(--on-surface);cursor:pointer;transition:all .15s}
.fb.active{background:var(--primary);color:var(--on-primary)}
.fb:not(.active):hover{background:var(--secondary-container)}
tr.excluded{opacity:.25}
tr.updated{animation:rowFlash .8s}
@keyframes rowFlash{0%{background:var(--success-container)}100%{background:transparent}}
.live-dot{width:8px;height:8px;border-radius:50%;display:inline-block;animation:pulse 1.5s infinite}
.live-dot.on{background:var(--success)}
.live-dot.off{background:var(--error);animation:none}
.live-dot.warn{background:var(--warning)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.badge{font-size:.65rem;font-weight:600;letter-spacing:.03em;padding:3px 8px;border-radius:var(--radius-md)}
.badge.bg-success{background:var(--success)!important}.badge.bg-danger{background:var(--error)!important}
.badge.bg-warning{background:var(--warning-container)!important;color:var(--warning)!important}
.badge.bg-info{background:var(--info-container)!important;color:var(--info)!important}
.badge.bg-secondary{background:var(--surface-high)!important;color:var(--on-surface-variant)!important}
.badge.bg-primary{background:var(--primary)!important}
.progress-pipeline{display:flex;gap:2px;align-items:center;margin:1rem 0}
.pip-seg{height:6px;border-radius:3px;transition:width .5s}
.table{--bs-table-bg:transparent}
.table thead th{font-family:var(--font-body);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--on-surface-variant);user-select:none;padding:.6rem .5rem;border-bottom:none!important;background:var(--surface-low)}
.table thead th[onclick]:hover{background:var(--surface-high)}
.table tbody td{padding:.55rem .5rem;border-bottom:none!important;font-size:.8rem}
.table tbody tr{background:var(--surface-lowest)}
.table tbody tr:nth-child(even){background:var(--surface-low)}
.table tbody tr:hover{background:var(--surface-high)}
.sort-icon{font-size:.55rem;color:var(--primary);margin-left:2px}
.table tbody td{font-size:.82rem;vertical-align:middle}
.export-btn{background:var(--surface-lowest);border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:.78rem;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s;color:var(--on-surface)}
.export-btn:hover{background:var(--surface-high)}
.tab-nav{display:flex;gap:0;margin-bottom:1.2rem;background:var(--surface-low);border-radius:var(--radius-lg);padding:3px;width:fit-content}
.tab-btn{background:none;border:none;padding:8px 18px;font-size:.8rem;font-weight:500;color:var(--on-surface-variant);cursor:pointer;border-radius:var(--radius-md);transition:all .2s}
.tab-btn.active{background:var(--surface-lowest);color:var(--on-surface);font-weight:600;box-shadow:var(--shadow-ambient)}
.tab-btn:not(.active):hover{color:var(--on-surface)}
.tab-content{display:none}
.tab-content.active{display:block}
.btn-sm{font-size:.75rem;font-weight:500;border-radius:var(--radius-md);padding:4px 12px}
.btn-success{background:var(--success);border-color:var(--success)}
.btn-primary{background:var(--primary);border-color:var(--primary)}
.btn-outline-danger{color:var(--error);border-color:var(--error)}
.btn-outline-danger:hover{background:var(--error);color:var(--on-primary)}
.form-control-sm{border:none;background:var(--surface-low);font-size:.8rem;border-radius:var(--radius-lg)}
.form-control-sm:focus{background:var(--surface-lowest);box-shadow:0 0 0 2px rgba(70,95,136,.3);outline:none}

/* Settings tab styles */
.settings-layout{display:flex;gap:0;min-height:500px}
.settings-sidebar{width:220px;background:var(--surface-low);border-radius:var(--radius-lg) 0 0 var(--radius-lg);padding:12px 0;flex-shrink:0}
.settings-sidebar-btn{display:block;width:100%;text-align:left;background:none;border:none;padding:10px 20px;font-size:.82rem;color:var(--on-surface-variant);cursor:pointer;transition:all .15s;border-left:3px solid transparent}
.settings-sidebar-btn:hover{background:var(--surface-high);color:var(--on-surface)}
.settings-sidebar-btn.active{background:var(--surface-lowest);color:var(--primary);font-weight:600;border-left-color:var(--primary)}
.settings-main{flex:1;padding:24px;background:var(--surface-lowest);border-radius:0 var(--radius-lg) var(--radius-lg) 0;overflow-y:auto;max-height:75vh}
.settings-section{display:none}
.settings-section.active{display:block}
.settings-section h3{font-family:var(--font-display);font-size:1rem;font-weight:700;margin-bottom:4px;color:var(--on-surface)}
.settings-section .section-desc{font-size:.78rem;color:var(--on-surface-variant);margin-bottom:20px}
.settings-group{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--surface-high)}
.settings-group:last-child{border-bottom:none}
.settings-group label{display:block;font-size:.78rem;font-weight:600;color:var(--on-surface);margin-bottom:4px}
.settings-group .help-text{font-size:.7rem;color:var(--outline-variant);margin-top:2px}
.settings-group input[type="text"],
.settings-group input[type="number"],
.settings-group input[type="email"],
.settings-group input[type="tel"],
.settings-group textarea,
.settings-group select{width:100%;padding:8px 12px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.82rem;background:var(--surface-lowest);color:var(--on-surface);transition:border-color .15s}
.settings-group input:focus,
.settings-group textarea:focus,
.settings-group select:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 2px rgba(70,95,136,.15)}
.settings-group textarea{min-height:80px;resize:vertical;font-family:var(--font-body)}
.settings-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.settings-row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.list-manager{border:1px solid var(--surface-high);border-radius:var(--radius-md);padding:12px;background:var(--surface)}
.list-manager .list-item{display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface-lowest);border-radius:var(--radius-md);margin-bottom:4px;font-size:.8rem}
.list-manager .list-item .remove-btn{background:none;border:none;color:var(--error);cursor:pointer;font-size:1rem;padding:0 4px;line-height:1}
.list-manager .list-item .remove-btn:hover{opacity:.7}
.list-manager .add-row{display:flex;gap:8px;margin-top:8px}
.list-manager .add-row input{flex:1;padding:6px 10px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem}
.list-manager .add-row button{padding:6px 14px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius-md);font-size:.78rem;cursor:pointer}
.list-manager .add-row button:hover{opacity:.9}
.save-bar{position:sticky;bottom:0;background:var(--surface-lowest);border-top:1px solid var(--surface-high);padding:12px 0;display:flex;justify-content:flex-end;gap:8px;z-index:10}
.save-bar .btn-save{padding:8px 24px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius-md);font-size:.82rem;font-weight:600;cursor:pointer;transition:all .15s}
.save-bar .btn-save:hover{opacity:.9}
.toast-container{position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px}
.toast-msg{padding:12px 20px;border-radius:var(--radius-md);font-size:.82rem;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,.15);animation:slideIn .3s}
.toast-msg.success{background:var(--success);color:#fff}
.toast-msg.error{background:var(--error);color:#fff}
@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
.status-banner-wrap{padding:14px 20px 0}
.status-banner{background:var(--warning-container);color:var(--on-surface);border:1px solid rgba(138,103,0,.18);border-radius:var(--radius-lg);padding:12px 14px;box-shadow:var(--shadow-ambient)}
.status-banner.hidden{display:none}
.status-banner strong{font-family:var(--font-display);font-size:.82rem}
.status-banner ul{margin:8px 0 0;padding-left:18px}
.status-banner li{font-size:.8rem;line-height:1.5;margin-bottom:4px}
.status-meta{font-size:.74rem;color:var(--on-surface-variant);margin-top:8px}
.preview-table{font-size:.75rem;width:100%;border-collapse:collapse;margin-top:8px}
.preview-table th,.preview-table td{padding:4px 8px;border:1px solid var(--surface-high);text-align:left}
.preview-table th{background:var(--surface-low);font-weight:600}
.column-map-row{display:grid;grid-template-columns:1fr 80px;gap:8px;align-items:center;margin-bottom:6px}
.column-map-row label{font-size:.78rem}
.column-map-row input{width:80px;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem;text-align:center}
.obj-list-item{border:1px solid var(--surface-high);border-radius:var(--radius-md);padding:10px;margin-bottom:8px;background:var(--surface-lowest)}
.obj-list-item .obj-row{display:flex;gap:8px;margin-bottom:4px;align-items:center}
.obj-list-item .obj-row label{font-size:.72rem;color:var(--on-surface-variant);min-width:60px}
.obj-list-item .obj-row input{flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem}
</style>
</head>
<body>
<!-- Toast container -->
<div class="toast-container" id="toastContainer"></div>

<!-- Header -->
<div class="header">
  <img src="/assets/favicon.png" alt="Sales Claw" style="width:28px;height:28px;object-fit:contain;margin-right:8px;vertical-align:middle">
  <h1 style="display:inline;vertical-align:middle">Sales Claw</h1>
  <span class="live-dot on" id="liveDot"></span>
  <span style="color:rgba(255,255,255,.7);font-size:.7rem;font-weight:500;letter-spacing:.05em" id="liveLabel">${_t['app.live'] || 'LIVE'}</span>
  <small style="color:rgba(255,255,255,.5);margin-left:auto;font-size:.72rem" id="lastUpdate"></small>
  <button class="export-btn" onclick="showDocsModal()" title="${_t['app.docsTitle']}">
    <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M1 2.828c.885-.37 2.154-.769 3.388-.893 1.33-.134 2.458.063 3.112.752v9.746c-.935-.53-2.12-.603-3.213-.493-1.18.12-2.37.461-3.287.811V2.828zm7.5-.141c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492V2.687zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 0 0 0 2.5v11a.5.5 0 0 0 .707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 0 0 .78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0 0 16 13.5v-11a.5.5 0 0 0-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783z"/></svg>
    ${_t['app.docs']}
  </button>
  <div id="claudeStatusWidget" style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px 10px;font-size:.75rem">
    <span id="claudeStatusDot" class="live-dot" style="width:8px;height:8px;flex-shrink:0"></span>
    <span id="claudeStatusLabel" style="color:rgba(255,255,255,.7);white-space:nowrap">${_t['claude.status.checking'] || 'Checking...'}</span>
    <button id="claudeActionBtn" onclick="claudeAction()" style="display:none;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.35);border-radius:4px;color:#fff;font-size:.72rem;padding:2px 8px;cursor:pointer;white-space:nowrap"></button>
  </div>
  <button class="export-btn" onclick="location.href='/api/export'">
    <svg width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
    ${_t['app.export'] || 'Export Excel'}
  </button>
</div>

<div class="status-banner-wrap">
  <div class="status-banner hidden" id="statusBanner"></div>
</div>

<!-- Docs Modal -->
<div id="docsModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:none;align-items:center;justify-content:center">
  <div style="background:var(--surface-lowest);border-radius:var(--radius-lg);padding:0;max-width:700px;width:90%;max-height:85vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="background:var(--primary);color:var(--on-primary);padding:16px 24px;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-family:var(--font-display);font-size:1rem">${_t['docs.title']}</h3>
      <button onclick="closeDocsModal()" style="background:none;border:none;color:var(--on-primary);font-size:1.2rem;cursor:pointer">&times;</button>
    </div>
    <div style="padding:24px;overflow-y:auto;max-height:calc(85vh - 60px)">
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">1. ${_t['docs.quickStart']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.quickStartContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">2. ${_t['docs.settingsGuide']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.settingsGuideContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">3. ${_t['docs.workflow']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.workflowContent']}</pre>
      </div>
      <div style="text-align:center;padding-top:12px;border-top:1px solid var(--surface-high)">
        <button onclick="closeDocsModal()" style="padding:8px 24px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius-md);font-size:.82rem;cursor:pointer">${_t['docs.close']}</button>
      </div>
    </div>
  </div>
</div>

<div class="container-fluid py-3">
  <!-- Stats cards -->
  <div class="row mb-3 g-2" id="statsRow">
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--primary)" id="s-approachable">-</div><div class="sl">${_t['stats.target']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--info)" id="s-hasFormUrl">-</div><div class="sl">${_t['stats.hasForm']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:#6e5b9e" id="s-formFill">-</div><div class="sl">${_t['stats.filled']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--warning)" id="s-awaitingApproval">-</div><div class="sl">${_t['stats.awaiting']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--success)" id="s-submitted">-</div><div class="sl">${_t['stats.sent']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--error)" id="s-error">-</div><div class="sl">${_t['stats.error']}</div></div></div>
    <div class="col"><div class="card sc p-2 text-center"><div class="sn" style="color:var(--outline-variant)" id="s-excluded">-</div><div class="sl">${_t['stats.excluded']}</div></div></div>
  </div>

  <!-- Progress pipeline -->
  <div class="tc p-3 mb-3">
    <div class="d-flex justify-content-between align-items-center mb-1">
      <small class="fw-bold">${_t['progress.title']}</small>
      <small class="text-muted" id="progressLabel">-</small>
    </div>
    <div class="progress-pipeline" id="pipeline">
      <div class="pip-seg" style="background:#6c757d;flex:1"></div>
    </div>
    <div class="d-flex gap-3 mt-1" style="font-size:.7rem;color:#888">
      <span style="color:#0dcaf0">&#9632; ${_t['progress.hasForm']}</span>
      <span style="color:#7c3aed">&#9632; ${_t['progress.filled']}</span>
      <span style="color:var(--warning)">&#9632; ${_t['progress.awaiting']}</span>
      <span style="color:var(--success)">&#9632; ${_t['progress.sent']}</span>
      <span style="color:var(--error)">&#9632; ${_t['progress.error']}</span>
      <span style="color:var(--outline-variant)">&#9632; ${_t['progress.unprocessed']}</span>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tab-nav">
    <button class="tab-btn active" data-tab="companies">${_t['tab.companies']}</button>
    <button class="tab-btn" data-tab="awaiting">${_t['tab.awaiting']} <span class="badge bg-warning text-dark" id="awaitingCount">0</span></button>
    <button class="tab-btn" data-tab="sent">${_t['tab.sent']}</button>
    <button class="tab-btn" data-tab="logs">${_t['tab.logs']}</button>
    <button class="tab-btn" data-tab="settings">${_t['tab.settings']}</button>
  </div>

  <!-- Companies tab -->
  <div class="tab-content active" id="tab-companies">
    <div class="mb-2 d-flex align-items-center flex-wrap gap-1">
      <button class="fb active" data-f="all">${_t['filter.all']}</button>
      <button class="fb" data-f="approachable">${_t['filter.target']}</button>
      <button class="fb" data-f="has-form">${_t['filter.hasForm']}</button>
      <button class="fb" data-f="no-form">${_t['filter.noForm']}</button>
      <button class="fb" data-f="submitted">${_t['filter.sent']}</button>
      <button class="fb" data-f="error">${_t['filter.error']}</button>
      <button class="fb" data-f="excluded">${_t['filter.excluded']}</button>
      <input type="text" id="q" class="form-control form-control-sm ms-2" style="width:200px;border-radius:20px" placeholder="${_t['filter.search']}">
    </div>
    <div class="tc p-3" style="overflow-x:auto">
      <table class="table table-hover table-sm mb-0" id="mt">
        <thead><tr style="border-bottom:2px solid #dee2e6"><th style="width:40px;cursor:pointer" onclick="sortTable('no')">${_t['th.no']} <span class="sort-icon" data-col="no"></span></th><th style="cursor:pointer" onclick="sortTable('name')">${_t['th.company']} <span class="sort-icon" data-col="name"></span></th><th style="cursor:pointer" onclick="sortTable('type')">${_t['th.type']} <span class="sort-icon" data-col="type"></span></th><th style="width:80px;cursor:pointer" onclick="sortTable('progress')">${_t['th.progress']} <span class="sort-icon" data-col="progress"></span></th><th style="width:60px;cursor:pointer" onclick="sortTable('sent')">${_t['th.sent']} <span class="sort-icon" data-col="sent"></span></th><th>${_t['th.formUrl']}</th><th style="width:200px">${_t['th.message']}</th><th style="width:100px">${_t['th.action']}</th></tr></thead>
        <tbody id="companyBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Awaiting tab -->
  <div class="tab-content" id="tab-awaiting">
    <div class="tc p-3">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <p class="text-muted mb-0" style="font-size:.85rem">${_t['awaiting.description']}</p>
        <div class="d-flex gap-2 align-items-center">
          <button class="btn btn-sm btn-outline-primary" onclick="toggleAllAwaiting()">${_t['action.selectAll']}</button>
          <button class="btn btn-sm btn-success" onclick="bulkApprove('sent')">${_t['action.bulkSent']}</button>
          <button class="btn btn-sm btn-primary" onclick="bulkAiSubmit()">${_t['action.bulkAiSubmit']}</button>
          <button class="btn btn-sm btn-outline-danger" onclick="bulkSkipWithFeedback()">${_t['action.bulkSkip']}</button>
        </div>
      </div>
      <div id="awaitingList"></div>
    </div>
  </div>

  <!-- Sent tab -->
  <div class="tab-content" id="tab-sent">
    <div class="tc p-3">
      <div class="d-flex align-items-center flex-wrap gap-2 mb-3">
        <input type="text" id="sentSearch" class="form-control form-control-sm" style="width:200px;border-radius:20px" placeholder="${_t['sent.search']}">
        <button class="btn btn-sm btn-outline-secondary fb-sent active" data-sf="all">${_t['sent.all']}</button>
        <button class="btn btn-sm btn-outline-success fb-sent" data-sf="1">${_t['sent.firstOnly']}</button>
        <button class="btn btn-sm btn-outline-info fb-sent" data-sf="2+">${_t['sent.multipleOnly']}</button>
        <small class="text-muted ms-auto" id="sentCount">0 items</small>
      </div>
      <div id="sentList"></div>
    </div>
  </div>

  <!-- CLI Activity tab -->
  <div class="tab-content" id="tab-logs">
    <div class="tc p-3">
      <div class="mb-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <div class="d-flex align-items-center gap-2">
            <span class="live-dot on" id="cliDot"></span>
            <small style="font-weight:600;color:var(--on-surface)">${_t['cli.stream']}</small>
          </div>
          <small class="text-muted" id="cliLastEvent">-</small>
        </div>
        <div id="cliStream" style="background:var(--on-surface);color:#e0e0e0;border-radius:var(--radius-lg);padding:12px;font-family:var(--font-terminal,monospace);font-size:.72rem;line-height:1.6;max-height:250px;overflow-y:auto;white-space:pre-wrap"></div>
      </div>
      <div class="d-flex justify-content-between align-items-center mb-2">
        <small style="font-weight:600;color:var(--on-surface)">${_t['cli.actionLog']}</small>
        <small class="text-muted" id="logCount">0 items</small>
      </div>
      <table class="table table-sm mb-0">
        <thead><tr><th>${_t['cli.datetime']}</th><th>${_t['th.no']}</th><th>${_t['cli.companyName']}</th><th>${_t['cli.actionType']}</th><th>${_t['cli.details']}</th></tr></thead>
        <tbody id="logBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Settings tab -->
  <div class="tab-content" id="tab-settings">
    <div class="tc settings-layout">
      <div class="settings-sidebar">
        <button class="settings-sidebar-btn active" data-section="companyProfile">${_t['settings.companyProfile']}</button>
        <button class="settings-sidebar-btn" data-section="valuePropositions">${_t['settings.valuePropositions']}</button>
        <button class="settings-sidebar-btn" data-section="targetList">${_t['settings.targetList']}</button>
        <button class="settings-sidebar-btn" data-section="exclusionRules">${_t['settings.exclusionRules']}</button>
        <button class="settings-sidebar-btn" data-section="messageTemplates">${_t['settings.messageTemplates']}</button>
        <button class="settings-sidebar-btn" data-section="preferences">${_t['settings.preferences']}</button>
      </div>
      <div class="settings-main" id="settingsMain">

        <!-- Company Profile section -->
        <div class="settings-section active" id="sec-companyProfile">
          <h3>${_t['settings.companyProfile']}</h3>
          <p class="section-desc">${_t['settings.companyProfile.desc']}</p>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyName']}</label>
              <input type="text" id="cp-companyName" placeholder="${_t['ph.companyName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.companyNameEn']}</label>
              <input type="text" id="cp-companyNameEn" placeholder="${_t['ph.companyNameEn']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyNameKana']}</label>
              <input type="text" id="cp-companyNameKana" placeholder="${_t['ph.companyNameKana']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.representative']}</label>
              <input type="text" id="cp-representative" placeholder="${_t['ph.representative']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactName']}</label>
              <input type="text" id="cp-contactName" placeholder="${_t['ph.contactName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.contactNameKana']}</label>
              <input type="text" id="cp-contactNameKana" placeholder="${_t['ph.contactNameKana']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactTitle']}</label>
              <input type="text" id="cp-contactTitle" placeholder="${_t['ph.contactTitle']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.department']}</label>
              <input type="text" id="cp-department" placeholder="${_t['ph.department']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.email']}</label>
              <input type="email" id="cp-email" placeholder="${_t['ph.email']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.phone']}</label>
              <input type="tel" id="cp-phone" placeholder="03-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fax']}</label>
              <input type="tel" id="cp-fax" placeholder="03-1234-5679">
            </div>
            <div class="settings-group">
              <label>${_t['field.mobile']}</label>
              <input type="tel" id="cp-mobile" placeholder="090-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.postalCode']}</label>
              <input type="text" id="cp-postalCode" placeholder="100-0001">
            </div>
            <div class="settings-group">
              <label>${_t['field.address']}</label>
              <input type="text" id="cp-address" placeholder="${_t['ph.addressFull']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.addressEn']}</label>
            <input type="text" id="cp-addressEn" placeholder="${_t['ph.addressEn']}">
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.website']}</label>
              <input type="text" id="cp-website" placeholder="https://example.com">
            </div>
            <div class="settings-group">
              <label>${_t['field.partnerPage']}</label>
              <input type="text" id="cp-partnerPage" placeholder="${_t['ph.partnerPage']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.corporateProfile']}</label>
            <input type="text" id="cp-corporateProfile" placeholder="${_t['ph.corporateProfile']}">
          </div>
          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.established']}</label>
              <input type="text" id="cp-established" placeholder="${_t['ph.established']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.employeeCount']}</label>
              <input type="text" id="cp-employeeCount" placeholder="${_t['ph.employeeCount']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.capital']}</label>
              <input type="text" id="cp-capital" placeholder="${_t['ph.capital']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.industry']}</label>
              <input type="text" id="cp-industry" placeholder="${_t['ph.industry']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.businessDescription']}</label>
              <input type="text" id="cp-businessDescription" placeholder="${_t['ph.businessDescription']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.notes']}</label>
            <textarea id="cp-notes" placeholder="${_t['ph.notes']}"></textarea>
            <div class="help-text">${_t['help.notes']}</div>
          </div>
          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('companyProfile')">${_t['settings.save']} ${_t['settings.companyProfile']}</button>
          </div>
        </div>

        <!-- Value Propositions section -->
        <div class="settings-section" id="sec-valuePropositions">
          <h3>${_t['settings.valuePropositions']}</h3>
          <p class="section-desc">${_t['settings.valuePropositions.desc']}</p>

          <div class="settings-group">
            <label>${_t['field.companyUrl']}</label>
            <input type="text" id="vp-companyUrl" placeholder="${_t['ph.websiteUrl']}">
            <div class="help-text">${_t['help.companyUrl']}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.serviceUrls']}</label>
            <div class="help-text mb-2">${_t['help.serviceUrls']}</div>
            <div class="list-manager" id="vp-serviceUrls-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.documents']}</label>
            <div class="help-text mb-2">${_t['help.documents']}</div>
            <div class="list-manager" id="vp-documentPaths-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.strengths']}</label>
            <div class="help-text mb-2">${_t['help.strengths']}</div>
            <div id="vp-strengths-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addStrengthItem()">${_t['field.addStrength']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.successPatterns']}</label>
            <div class="help-text mb-2">${_t['help.successPatterns']}</div>
            <div id="vp-successPatterns-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addSuccessPatternItem()">${_t['field.addPattern']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.industryProfiles']}</label>
            <div class="help-text mb-2">${_t['help.industryProfiles']}</div>
            <div id="vp-industryProfiles-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addIndustryProfile()">${_t['field.addProfile']}</button>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('valuePropositions')">${_t['settings.save']} ${_t['settings.valuePropositions']}</button>
          </div>
        </div>

        <!-- Target List section -->
        <div class="settings-section" id="sec-targetList">
          <h3>${_t['settings.targetList']}</h3>
          <p class="section-desc">${_t['settings.targetList.desc']}</p>

          <div class="settings-group">
            <label>${_t['field.filePath']}</label>
            <input type="text" id="tl-filePath" placeholder="${_t['ph.filePath']}">
            <div class="help-text">${_t['help.filePath']}</div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fileType']}</label>
              <select id="tl-fileType">
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV (.csv)</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.sheetIndex']}</label>
              <input type="number" id="tl-sheetIndex" min="0" value="0">
              <div class="help-text">${_t['help.sheetIndex']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.columnMapping']}</label>
            <div class="help-text mb-2">${_t['help.columnMapping']}</div>
            <div class="column-map-row"><label>${_t['field.colNo']}</label><input type="number" id="tl-col-no" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colStatus']}</label><input type="number" id="tl-col-status" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colCompanyName']}</label><input type="number" id="tl-col-companyName" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colType']}</label><input type="number" id="tl-col-type" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colUrl']}</label><input type="number" id="tl-col-url" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colFormUrl']}</label><input type="number" id="tl-col-formUrl" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colNotes']}</label><input type="number" id="tl-col-notes" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colCaptcha']}</label><input type="number" id="tl-col-captcha" min="0"></div>
            <div class="column-map-row"><label>${_t['field.colProgress']}</label><input type="number" id="tl-col-progress" min="0"></div>
          </div>

          <div class="settings-group">
            <label>${_t['settings.preview']}</label>
            <div class="help-text mb-2">${_t['help.targetPreview']}</div>
            <button class="btn btn-sm btn-outline-primary mb-2" onclick="loadTargetPreview()">${_t['field.loadPreview']}</button>
            <div id="targetPreview"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('targetList')">${_t['settings.save']} ${_t['settings.targetList']}</button>
          </div>
        </div>

        <!-- Exclusion Rules section -->
        <div class="settings-section" id="sec-exclusionRules">
          <h3>${_t['settings.exclusionRules']}</h3>
          <p class="section-desc">${_t['settings.exclusionRules.desc']}</p>

          <div class="settings-group">
            <label>${_t['field.competitors']}</label>
            <div class="help-text mb-2">${_t['help.competitors']}</div>
            <div id="er-competitors-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('competitors')">${_t['field.addCompetitor']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.existingClients']}</label>
            <div class="help-text mb-2">${_t['help.existingClients']}</div>
            <div id="er-existingClients-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('existingClients')">${_t['field.addClient']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.ngList']}</label>
            <div class="help-text mb-2">${_t['help.ngList']}</div>
            <div id="er-ngList-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addNgItem()">${_t['field.addNg']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.customRules']}</label>
            <div class="help-text mb-2">${_t['help.customRules']}</div>
            <div id="er-customRules-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addCustomRule()">${_t['field.addCustomRule']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.excludeStatuses']}</label>
            <div class="help-text mb-2">${_t['help.excludeStatuses']}</div>
            <div class="list-manager" id="er-excludeStatuses-list"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('exclusionRules')">${_t['settings.save']} ${_t['settings.exclusionRules']}</button>
          </div>
        </div>

        <!-- Message Templates section -->
        <div class="settings-section" id="sec-messageTemplates">
          <h3>${_t['settings.messageTemplates']}</h3>
          <p class="section-desc">${_t['settings.messageTemplates.desc']}</p>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.tone']}</label>
              <select id="mt-tone">
                <option value="formal">${_t['field.toneOptions.formal']}</option>
                <option value="casual">${_t['field.toneOptions.casual']}</option>
                <option value="business">${_t['field.toneOptions.business']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.msgLanguage']}</label>
              <select id="mt-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLength']}</label>
              <input type="number" id="mt-maxLength" min="100" max="10000">
              <div class="help-text">${_t['help.maxLength']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.signatureFormat']}</label>
            <select id="mt-signatureFormat">
              <option value="full">${_t['field.sigFull']}</option>
              <option value="minimal">${_t['field.sigMinimal']}</option>
              <option value="none">${_t['field.sigNone']}</option>
            </select>
          </div>

          <div class="settings-group">
            <label>${_t['field.inquiryTypes']}</label>
            <div class="help-text mb-2">${_t['help.inquiryTypes']}</div>
            <div class="list-manager" id="mt-inquiryTypes-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.greetingLine']}</label>
            <input type="text" id="mt-greetingLine" placeholder="${_t['ph.greeting']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.closingLine']}</label>
            <textarea id="mt-closingLine" placeholder="${_t['ph.closing']}"></textarea>
          </div>
          <div class="settings-group">
            <label>${_t['field.cta']}</label>
            <input type="text" id="mt-cta" placeholder="${_t['ph.cta']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.referenceUrlText']}</label>
            <input type="text" id="mt-referenceUrlText" placeholder="${_t['ph.referenceUrl']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.signatureTemplate']}</label>
            <textarea id="mt-signatureTemplate" placeholder="${_t['ph.signature']}"></textarea>
            <div class="help-text">${_t['help.signaturePlaceholders']}</div>
          </div>

          <div class="settings-group" style="margin-top:16px;padding-top:16px;border-top:2px solid var(--surface-high)">
            <label>${_t['field.letterTemplate']}</label>
            <div class="help-text mb-2">${_t['help.letterTemplate']}</div>
            <div class="settings-row-3">
              <div class="settings-group">
                <label>${_t['field.letterEnabled']}</label>
                <select id="mt-letter-enabled">
                  <option value="false">${_t['field.yesNo.no']}</option>
                  <option value="true">${_t['field.yesNo.yes']}</option>
                </select>
              </div>
              <div class="settings-group">
                <label>${_t['field.letterFormat']}</label>
                <select id="mt-letter-format">
                  <option value="A4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </div>
              <div></div>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterHeader']}</label>
              <textarea id="mt-letter-header" placeholder="${_t['ph.letterHeader']}"></textarea>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterFooter']}</label>
              <textarea id="mt-letter-footer" placeholder="${_t['ph.letterFooter']}"></textarea>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('messageTemplates')">${_t['settings.save']} ${_t['settings.messageTemplates']}</button>
          </div>
        </div>

        <!-- Preferences section -->
        <div class="settings-section" id="sec-preferences">
          <h3>${_t['settings.preferences']}</h3>
          <p class="section-desc">${_t['settings.preferences.desc']}</p>

          <div class="settings-group" style="background:var(--info-container);padding:12px;border-radius:var(--radius-md);margin-bottom:16px">
            <small style="color:var(--info)">${_t['help.portRestart']}</small>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.dashboardPort']}</label>
              <input type="number" id="pf-dashboardPort" min="1024" max="65535">
            </div>
            <div class="settings-group">
              <label>${_t['field.dashboardHost']}</label>
              <input type="text" id="pf-dashboardHost" placeholder="127.0.0.1">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.language']}</label>
              <select id="pf-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.timezone']}</label>
              <input type="text" id="pf-timezone" placeholder="Asia/Tokyo">
            </div>
            <div class="settings-group">
              <label>${_t['field.dateFormat']}</label>
              <input type="text" id="pf-dateFormat" placeholder="YYYY-MM-DD HH:mm">
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.screenshotDir']}</label>
              <input type="text" id="pf-screenshotDir" placeholder="screenshots">
            </div>
            <div class="settings-group">
              <label>${_t['field.dataDir']}</label>
              <input type="text" id="pf-dataDir" placeholder="data">
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.emailKeyword']}</label>
              <input type="text" id="pf-emailSearchKeyword" placeholder="${_t['ph.emailKeyword']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.emailProvider']}</label>
              <select id="pf-emailProvider">
                <option value="outlook">Outlook</option>
                <option value="gmail">Gmail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.maxRetries']}</label>
              <input type="number" id="pf-maxRetries" min="0" max="10">
              <div class="help-text">${_t['help.maxRetries']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.pageTimeout']}</label>
              <input type="number" id="pf-pageTimeout" min="1000" max="120000">
            </div>
            <div class="settings-group">
              <label>${_t['field.formFillTimeout']}</label>
              <input type="number" id="pf-formFillTimeout" min="1000" max="60000">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.headless']}</label>
              <select id="pf-headless">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.headless']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.locale']}</label>
              <input type="text" id="pf-locale" placeholder="ja-JP">
            </div>
            <div class="settings-group">
              <label>${_t['field.requireApproval']}</label>
              <select id="pf-requireApprovalBeforeSend">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.requireApproval']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.userAgent']}</label>
            <input type="text" id="pf-userAgent" placeholder="${_t['ph.userAgent']}">
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.logLevel']}</label>
              <select id="pf-logLevel">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLogEntries']}</label>
              <input type="number" id="pf-maxLogEntries" min="100" max="100000">
            </div>
            <div class="settings-group">
              <label>${_t['field.exportPrefix']}</label>
              <input type="text" id="pf-exportFilenamePrefix" placeholder="${_t['ph.exportPrefix']}">
            </div>
          </div>

          <!-- Claude Code model setting -->
          <div class="settings-group" style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
            <label>${_t['field.claudeModel']}</label>
            <select id="pf-claudeModel">
              <option value="claude-sonnet-4-6">${_t['field.claudeModel.sonnet']}</option>
              <option value="claude-haiku-4-5-20251001">${_t['field.claudeModel.haiku']}</option>
              <option value="claude-opus-4-6">${_t['field.claudeModel.opus']}</option>
            </select>
            <div class="help-text">${_t['help.claudeModel']}</div>
            <div class="help-text" style="margin-top:4px;color:var(--warning)">${_t['help.claudeModelNote']}</div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('preferences')">${_t['settings.save']} ${_t['settings.preferences']}</button>
          </div>
        </div>

      </div>
    </div>
  </div>
</div>

<script>
const LANG = '${_lang}';
const I18N = ${JSON.stringify(_t)};
function t(key, params) {
  let text = I18N[key] || key;
  if (params) Object.entries(params).forEach(([k,v]) => { text = text.replace('{'+k+'}', v); });
  return text;
}
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Docs modal
function showDocsModal(){const m=document.getElementById('docsModal');m.style.display='flex';}
function closeDocsModal(){document.getElementById('docsModal').style.display='none';}
document.getElementById('docsModal').addEventListener('click',function(e){if(e.target===this)closeDocsModal();});

// Launch Claude
async function launchClaude() {
  try {
    const res = await fetch('/api/launch-claude', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast(t('app.launchClaude.success'), 'success');
      setTimeout(pollClaudeStatus, 3000);
    } else {
      showToast(t('app.launchClaude.error') + ': ' + (data.error || ''), 'error');
    }
  } catch (e) {
    showToast(t('app.launchClaude.error') + ': ' + e.message, 'error');
  }
}

// Claude CLI status polling
let _claudeStatusTimer = null;
async function pollClaudeStatus() {
  try {
    const res = await fetch('/api/claude-status');
    const data = await res.json();
    const dot = document.getElementById('claudeStatusDot');
    const label = document.getElementById('claudeStatusLabel');
    const btn = document.getElementById('claudeActionBtn');
    if (!dot) return;
    if (data.running) {
      dot.className = 'live-dot on';
      label.textContent = t('claude.status.connected') + (data.version ? ' ' + data.version : '');
      btn.style.display = 'none';
    } else if (data.installed) {
      dot.className = 'live-dot warn';
      label.textContent = t('claude.status.notRunning');
      btn.textContent = t('claude.btn.launch');
      btn.style.display = '';
      btn._action = 'launch';
    } else {
      dot.className = 'live-dot off';
      label.textContent = t('claude.status.notInstalled');
      btn.textContent = t('claude.btn.install');
      btn.style.display = '';
      btn._action = 'install';
    }
  } catch (e) {
    // network error — leave as-is
  }
}
function claudeAction() {
  const btn = document.getElementById('claudeActionBtn');
  if (!btn) return;
  if (btn._action === 'launch') {
    launchClaude();
  } else if (btn._action === 'install') {
    const cmd = 'npm install -g @anthropic-ai/claude-code';
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd).then(() => {
        showToast(t('claude.install.copied'), 'success');
      }).catch(() => showToast(t('claude.install.error'), 'error'));
    } else {
      showToast(cmd, 'info');
    }
  }
}

const statusBadge=s=>{
  const m={'':'secondary">'+t('status.unclassified'),'\\u3007':'success">'+t('status.priority'),'\\u00d7':'danger">'+t('status.excluded'),'web\\u00d7':'warning text-dark">'+t('status.webNg')};
  return '<span class="badge bg-'+(m[s]||'secondary">'+esc(s))+'</span>';
};

const actionBadge=a=>{
  if(!a)return'<span class="text-muted">-</span>';
  const m={form_analysis:'info text-dark">'+t('status.analyzed'),form_fill:'primary">'+t('status.filled'),confirm_reached:'warning text-dark">'+t('status.confirmScreen'),awaiting_approval:'warning text-dark">'+t('status.awaitingApproval'),submitted:'success">'+t('status.sent'),skipped:'secondary">'+t('status.skipped'),error:'danger">'+t('status.error')};
  return'<span class="badge bg-'+(m[a]||'secondary">'+esc(a))+'</span>';
};

let currentFilter='all';
let prevStats={};

function updateStat(id,val){
  const el=document.getElementById(id);
  if(el.textContent!==String(val)){
    el.textContent=val;
    el.classList.add('changed');
    setTimeout(()=>el.classList.remove('changed'),500);
  }
}

// Toast notification
function showToast(message, type) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast-msg ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity .3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

let renderVersion = 0;
let refreshInFlight = false;
let pendingRefresh = false;
let es = null;
let reconnectTimer = null;
let offlinePollTimer = null;

function screenshotUrl(fileName) {
  return '/screenshots/' + encodeURIComponent(fileName) + '?v=' + renderVersion;
}

function renderStatusBanner(data) {
  const banner = document.getElementById('statusBanner');
  const issues = Array.isArray(data.issues) ? data.issues.filter(Boolean) : [];
  if (issues.length === 0) {
    banner.className = 'status-banner hidden';
    banner.innerHTML = '';
    return;
  }

  const runtime = data.runtime || null;
  const runtimeMeta = runtime && runtime.url
    ? '<div class="status-meta">Runtime: <a href="' + esc(runtime.url) + '" target="_blank">' + esc(runtime.url) + '</a></div>'
    : '';

  banner.className = 'status-banner';
  banner.innerHTML =
    '<strong>' + (LANG === 'ja' ? '運用メモ' : 'Operational Notice') + '</strong>' +
    '<ul>' + issues.map(issue => '<li>' + esc(issue) + '</li>').join('') + '</ul>' +
    runtimeMeta;
}

async function refreshData(options = {}) {
  if (refreshInFlight) {
    pendingRefresh = true;
    return;
  }

  refreshInFlight = true;
  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load dashboard data.');
    render(data);
  } catch (e) {
    renderStatusBanner({ issues: [e.message] });
    if (options.toastOnError) showToast((LANG === 'ja' ? '読込失敗: ' : 'Load failed: ') + e.message, 'error');
  } finally {
    refreshInFlight = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshData();
    }
  }
}

function render(data){
  renderVersion++;
  renderStatusBanner(data);
  const{companies,stats,recentLogs}=data;
  _allCompanies=companies;

  // Stats
  ['approachable','hasFormUrl','formFill','awaitingApproval','submitted','error','excluded'].forEach(k=>{
    updateStat('s-'+k,stats[k]);
  });

  // Company table
  const body=document.getElementById('companyBody');
  const oldRows={};
  body.querySelectorAll('tr').forEach(tr=>oldRows[tr.dataset.no]=tr.dataset.la);

  let html='';
  companies.forEach(c=>{
    const f=!c.isApproachable?'excluded':c.lastAction==='submitted'?'submitted':c.lastAction==='error'?'error':c.formUrl?'has-form':'no-form';
    const excl=c.isApproachable?'':'excluded';
    const isNew=oldRows[c.no]!==undefined&&oldRows[c.no]!==(c.lastAction||'');
    const upd=isNew?' updated':'';

    const display=currentFilter==='all'?'':currentFilter==='approachable'?(f!=='excluded'?'':'none'):(f===currentFilter?'':'none');

    const cnt=c.contactCount||0;
    const cntHtml=cnt===0?'<span class="text-muted">-</span>':cnt===1?'<span class="badge bg-success">1x</span>':'<span class="badge bg-info">'+cnt+'x</span>';

    let msgHtml='-';
    if(c.sentMessage){
      const preview=esc(c.sentMessage).substring(0,50);
      msgHtml='<span class="text-muted" style="font-size:.75rem;cursor:pointer" title="Click to view full message" onclick="showMsg('+c.no+')">'+preview+'...</span>';
    }

    let actionHtml='';
    const cname=esc(c.name).replace(/'/g,"\\'");
    if(c.lastAction==='awaiting_approval'||c.lastAction==='confirm_reached'){
      actionHtml='<button class="btn btn-success btn-sm py-0 px-1" style="font-size:.7rem" onclick="approveCompany('+c.no+',\\x27'+cname+'\\x27,\\x27sent\\x27)">'+t('action.markSent')+'</button>'
        +' <button class="btn btn-outline-secondary btn-sm py-0 px-1" style="font-size:.7rem" onclick="approveCompany('+c.no+',\\x27'+cname+'\\x27,\\x27skip\\x27)">'+t('action.skip')+'</button>';
    }else if(c.lastAction==='submitted'){
      actionHtml='<span style="font-size:.7rem;color:#198754">'+t('action.done')+'</span>';
    }

    html+='<tr class="'+excl+upd+'" data-f="'+f+'" data-n="'+esc(c.name).toLowerCase()+'" data-no="'+c.no+'" data-la="'+(c.lastAction||'')+'" data-type="'+esc(c.type).toLowerCase()+'" data-cnt="'+cnt+'" data-progress="'+(c.lastAction||'')+'" style="display:'+display+'">'
      +'<td>'+c.no+'</td>'
      +'<td><a href="'+esc(c.url)+'" target="_blank">'+esc(c.name)+'</a></td>'
      +'<td><small>'+esc(c.type)+'</small></td>'
      +'<td>'+actionBadge(c.lastAction)+'</td>'
      +'<td class="text-center">'+cntHtml+'</td>'
      +'<td class="furl">'+(c.formUrl?'<a href="'+esc(c.formUrl)+'" target="_blank" title="'+esc(c.formUrl)+'">'+esc(c.formUrl).substring(0,35)+'</a>':'-')+'</td>'
      +'<td>'+msgHtml+'</td>'
      +'<td>'+actionHtml+'</td>'
      +'</tr>';
  });
  body.innerHTML=html;

  // Log table
  const lbody=document.getElementById('logBody');
  lbody.innerHTML=recentLogs.map(l=>{
    const t=new Date(l.timestamp).toLocaleString('ja-JP');
    const cls=l.action==='error'?'table-danger':l.action==='submitted'?'table-success':l.action==='confirm_reached'?'table-warning':'';
    const d=typeof l.details==='object'?JSON.stringify(l.details):l.details||'';
    return'<tr class="'+cls+'"><td class="ts">'+t+'</td><td>'+l.companyNo+'</td><td>'+esc(l.companyName)+'</td><td><code>'+esc(l.action)+'</code></td><td><small>'+esc(d).substring(0,120)+'</small></td></tr>';
  }).join('');

  // Awaiting list
  const awaitingCompanies=companies.filter(c=>
    c.lastAction==='awaiting_approval'||
    (c.lastAction==='confirm_reached'&&!c.sentAt)
  );
  const awEl=document.getElementById('awaitingList');
  document.getElementById('awaitingCount').textContent=awaitingCompanies.length||'';
  if(awaitingCompanies.length===0){
    awEl.innerHTML='<div class="text-center text-muted py-4">'+t('awaiting.empty')+'</div>';
  }else{
    awEl.innerHTML=awaitingCompanies.map(c=>{
      const date=c.awaitingAt?new Date(c.awaitingAt).toLocaleString('ja-JP'):'-';
      const msg=esc(c.sentMessage||'').split(String.fromCharCode(10)).join('<br>');
      const ssConfirm='<img src="'+screenshotUrl('ss-'+c.no+'-confirm.png')+'" style="width:140px;height:auto;object-fit:contain;border:1px solid #ddd;border-radius:4px;cursor:pointer" onclick="window.open(this.src)" onerror="this.src=\\x27'+screenshotUrl('ss-'+c.no+'-input.png')+'\\x27;this.onerror=function(){this.style.display=\\x27none\\x27}" alt="Confirm screenshot">';
      const cname=esc(c.name).replace(/'/g,"\\'");
      return'<div class="mb-3 p-3 awaiting-card" data-no="'+c.no+'" data-name="'+cname+'" style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px">'
        +'<div class="d-flex justify-content-between align-items-center mb-2">'
        +'<div class="d-flex align-items-center gap-2"><input type="checkbox" class="form-check-input awaiting-check" data-no="'+c.no+'" style="width:18px;height:18px;cursor:pointer"><span class="badge bg-warning text-dark">'+t('awaiting.badge')+'</span><strong>'+esc(c.name)+'</strong> <small class="text-muted">'+esc(c.type)+'</small></div>'
        +'<small class="text-muted">'+date+'</small></div>'
        +'<div class="row g-3"><div class="col-md-4 mb-2">'+ssConfirm+'</div>'
        +'<div class="col-md-8"><div style="font-size:.82rem;background:#fff;padding:12px;border-radius:6px;border:1px solid #e9ecef;white-space:pre-wrap;line-height:1.6;max-height:250px;overflow-y:auto">'+msg+'</div></div></div>'
        +'<div class="mt-2 d-flex gap-2 align-items-center flex-wrap">'
        +'<button class="btn btn-success btn-sm" onclick="approveCompany('+c.no+',\\x27'+cname+'\\x27,\\x27sent\\x27)">'+t('action.markSent')+'</button>'
        +'<button class="btn btn-primary btn-sm" onclick="aiSubmit('+c.no+',\\x27'+cname+'\\x27)">'+t('action.aiSubmit')+'</button>'
        +'<button class="btn btn-outline-danger btn-sm" onclick="skipWithFeedback('+c.no+',\\x27'+cname+'\\x27)">'+t('action.skip')+'</button>'
        +'<small class="text-muted ms-2">'+t('awaiting.sentTo')+': <a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a></small>'
        +'</div></div>';
    }).join('');
  }

  // Sent list
  const sentCompanies=companies.filter(c=>c.sentAt).sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt));
  const sentEl=document.getElementById('sentList');
  document.getElementById('sentCount').textContent=sentCompanies.length+' items';
  if(sentCompanies.length===0){
    sentEl.innerHTML='<div class="text-center text-muted py-4">'+t('sent.empty')+'</div>';
  }else{
    sentEl.innerHTML=sentCompanies.map(c=>{
      const count=c.contactCount||1;
      const countBadge=count>=2?'<span class="badge bg-info ms-1">'+count+'x</span>':'<span class="badge bg-secondary ms-1">1st</span>';
      let historyHtml='';
      if(c.contactHistory&&c.contactHistory.length>0){
        historyHtml='<div class="mt-2" style="border-top:1px solid #e9ecef;padding-top:8px"><small class="fw-bold text-muted">'+t('sent.contactHistory')+'</small>';
        historyHtml+=c.contactHistory.map((h,i)=>{
          const d=new Date(h.date).toLocaleString('ja-JP');
          const resp=h.response?'<span class="badge bg-'+(h.response==='replied'||h.response==='\\u8fd4\\u4fe1\\u3042\\u308a'?'success':h.response==='meeting'||h.response==='\\u5546\\u8ac7\\u8a2d\\u5b9a'?'primary':'secondary')+'">'+esc(h.response)+'</span>':'<span class="badge bg-light text-dark">'+t('sent.replyWaiting')+'</span>';
          const msgPreview=esc(h.message||'').substring(0,100)+'...';
          return'<div class="mt-1 p-2" style="background:#f8f9fa;border-radius:4px;font-size:.78rem">'
            +'<div class="d-flex justify-content-between"><span><strong>#'+(i+1)+'</strong> '+d+'</span>'+resp+'</div>'
            +'<div class="text-muted mt-1" style="cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\x27none\\x27?\\x27block\\x27:\\x27none\\x27">'+msgPreview+' <u>'+t('sent.showFull')+'</u></div>'
            +'<div style="display:none;white-space:pre-wrap;background:#fff;padding:8px;border-radius:4px;border:1px solid #e9ecef;margin-top:4px;max-height:200px;overflow-y:auto">'+esc(h.message||'').split(String.fromCharCode(10)).join('<br>')+'</div>'
            +(h.notes?'<div class="text-muted mt-1">Note: '+esc(h.notes)+'</div>':'')
            +'</div>';
        }).join('');
        historyHtml+='</div>';
      }
      const date=new Date(c.sentAt).toLocaleString('ja-JP');
      const msg=esc(c.sentMessage||'').split(String.fromCharCode(10)).join('<br>');
      const ssInput='<img src="'+screenshotUrl('ss-'+c.no+'-input.png')+'" style="width:120px;height:auto;object-fit:contain;border:1px solid #ddd;border-radius:4px;cursor:pointer" onclick="window.open(this.src)" onerror="this.style.display=\\x27none\\x27" title="Input screenshot">';
      const ssConfirm='<img src="'+screenshotUrl('ss-'+c.no+'-confirm.png')+'" style="width:120px;height:auto;object-fit:contain;border:1px solid #ddd;border-radius:4px;cursor:pointer" onclick="window.open(this.src)" onerror="this.style.display=\\x27none\\x27" title="Confirm screenshot">';
      return'<div class="mb-3 p-3 sent-card" data-sn="'+esc(c.name).toLowerCase()+' '+esc(c.type).toLowerCase()+'" data-sc="'+count+'" style="background:#f8fdf8;border:1px solid #c3e6cb;border-radius:8px">'
        +'<div class="d-flex justify-content-between align-items-center mb-2">'
        +'<div><span class="badge bg-success me-2">'+t('sent.badge')+'</span>'+countBadge+'<strong class="ms-1">'+esc(c.name)+'</strong> <small class="text-muted">'+esc(c.type)+'</small></div>'
        +'<small class="text-muted">Last: '+date+'</small></div>'
        +'<div class="row g-3"><div class="col-md-8">'
        +'<div style="font-size:.82rem;background:#fff;padding:12px;border-radius:6px;border:1px solid #e9ecef;white-space:pre-wrap;line-height:1.6;max-height:300px;overflow-y:auto">'+msg+'</div>'
        +'</div><div class="col-md-4">'
        +'<div class="d-flex flex-column gap-1">'+ssInput+ssConfirm+'</div>'
        +'</div></div>'
        +'<div class="mt-2 d-flex justify-content-between align-items-center" style="font-size:.75rem;color:#888">'
        +'<span>Target: <a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a></span>'
        +'</div>'
        +historyHtml
        +'</div>';
    }).join('');
  }

  document.getElementById('lastUpdate').textContent=t('app.lastUpdate')+': '+new Date().toLocaleString('ja-JP');
  updatePipeline(stats);
}

// Approve / Skip
async function approveCompany(companyNo,companyName,decision){
  if(!confirm(decision==='sent'?t('confirm.markSent',{company:companyName}):t('confirm.skip',{company:companyName})))return;
  try{
    const res=await fetch('/api/approve',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({companyNo,companyName,decision}),
    });
    const d=await res.json();
    if(d.ok){refreshData();}
    else{alert(t('alert.error')+': '+(d.error||'Unknown'));}
  }catch(e){alert(t('alert.commError')+': '+e.message);}
}

// Show full message
let _allCompanies=[];
function showMsg(no){
  const c=_allCompanies.find(x=>x.no===no);
  if(!c||!c.sentMessage)return;
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.onclick=()=>overlay.remove();
  const box=document.createElement('div');
  box.style.cssText='background:#fff;border-radius:12px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)';
  box.onclick=e=>e.stopPropagation();
  const cnt=c.contactCount||0;
  box.innerHTML='<div class="d-flex justify-content-between align-items-center mb-3"><div><strong>'+esc(c.name)+'</strong> <small class="text-muted">'+esc(c.type)+'</small>'
    +(cnt>0?' <span class="badge bg-'+(cnt>=2?'info':'success')+'">'+cnt+'x sent</span>':'')
    +'</div><button class="btn-close" onclick="this.closest(\\x27div[style]\\x27).remove()"></button></div>'
    +'<div style="white-space:pre-wrap;font-size:.85rem;line-height:1.7;background:#f8f9fa;padding:16px;border-radius:8px">'+esc(c.sentMessage)+'</div>'
    +(c.formUrl?'<div class="mt-2" style="font-size:.75rem;color:#888">Target: <a href="'+esc(c.formUrl)+'" target="_blank">'+esc(c.formUrl)+'</a></div>':'');
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// AI Submit
async function aiSubmit(companyNo, companyName) {
  if (!confirm(t('confirm.aiSubmit', {company: companyName}))) return;
  try {
    const res = await fetch('/api/ai-submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNo, companyName }),
    });
    const d = await res.json();
    if (d.ok) {
      const banner = document.createElement('div');
      banner.id = 'ai-banner-' + companyNo;
      banner.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1a1a2e;color:#fff;padding:12px 20px;border-radius:8px;z-index:9999;font-size:.85rem;min-width:300px;box-shadow:0 4px 20px rgba(0,0,0,.3)';
      banner.innerHTML = '<div class="d-flex align-items-center gap-2"><div class="spinner-border spinner-border-sm text-info"></div><span id="ai-status-'+companyNo+'">'+t('ai.processing',{company:companyName})+'</span></div>';
      document.body.appendChild(banner);
      const poll = setInterval(async () => {
        try {
          const sr = await fetch('/api/ai-submit-status');
          const sq = await sr.json();
          const item = sq.find(q => q.companyNo === companyNo);
          if (!item) return;
          const statusEl = document.getElementById('ai-status-' + companyNo);
          if (statusEl) statusEl.textContent = companyName + ': ' + (item.detail || item.status);
          if (item.status === 'completed') {
            clearInterval(poll);
            banner.style.background = '#198754';
            banner.innerHTML = '<div>' + t('ai.completed',{company:companyName}) + '</div>';
            setTimeout(() => banner.remove(), 5000);
            refreshData();
          } else if (item.status === 'user_required') {
            clearInterval(poll);
            banner.style.background = '#dc3545';
            banner.innerHTML = '<div>' + t('ai.failed',{company:companyName}) + '</div>';
            setTimeout(() => banner.remove(), 10000);
            refreshData();
          }
        } catch (e) {}
      }, 2000);
    } else {
      alert(t('alert.error') + ': ' + (d.error || 'Unknown'));
    }
  } catch (e) { alert(t('alert.commError') + ': ' + e.message); }
}

// Skip with feedback
function skipWithFeedback(companyNo, companyName) {
  const feedback = prompt(t('confirm.skipReason', {company: companyName}));
  if (feedback === null) return;
  fetch('/api/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyNo, companyName, decision: 'skip', feedback: feedback || '' }),
  }).then(r => r.json()).then(d => {
    if (d.ok) refreshData();
    else alert(t('alert.error') + ': ' + (d.error || 'Unknown'));
  }).catch(e => alert(t('alert.commError') + ': ' + e.message));
}

// Bulk awaiting operations
function toggleAllAwaiting(){
  const cbs=document.querySelectorAll('.awaiting-check');
  const allChecked=Array.from(cbs).every(c=>c.checked);
  cbs.forEach(c=>c.checked=!allChecked);
}

async function bulkApprove(decision){
  const checked=document.querySelectorAll('.awaiting-check:checked');
  if(checked.length===0){alert(t('alert.selectCompanies'));return;}
  if(!confirm(decision==='sent'?t('confirm.bulkSent',{count:checked.length}):t('confirm.bulkSkip',{count:checked.length})))return;
  let ok=0,fail=0;
  for(const cb of checked){
    const card=cb.closest('.awaiting-card');
    const no=parseInt(card.dataset.no);
    const name=card.dataset.name;
    try{
      const res=await fetch('/api/approve',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({companyNo:no,companyName:name,decision}),
      });
      const d=await res.json();
      if(d.ok)ok++;else fail++;
    }catch(e){fail++;}
  }
  if(fail>0)alert(t('alert.success',{ok:ok})+t('alert.failure',{fail:fail}));
  refreshData();
}

async function bulkAiSubmit(){
  const checked=document.querySelectorAll('.awaiting-check:checked');
  if(checked.length===0){alert(t('alert.selectCompanies'));return;}
  if(!confirm(t('confirm.bulkAiSubmit',{count:checked.length})))return;
  let ok=0,fail=0;
  for(const cb of checked){
    const card=cb.closest('.awaiting-card');
    try{
      const res=await fetch('/api/ai-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyNo:parseInt(card.dataset.no),companyName:card.dataset.name})});
      const d=await res.json();if(d.ok)ok++;else fail++;
    }catch(e){fail++;}
  }
  alert(t('alert.submitStarted',{ok:ok})+(fail>0?t('alert.submitFailed',{fail:fail}):''));
  refreshData();
}

async function bulkSkipWithFeedback(){
  const checked=document.querySelectorAll('.awaiting-check:checked');
  if(checked.length===0){alert(t('alert.selectCompanies'));return;}
  const feedback=prompt(t('confirm.bulkSkipReason',{count:checked.length}));
  if(feedback===null)return;
  let ok=0,fail=0;
  for(const cb of checked){
    const card=cb.closest('.awaiting-card');
    try{
      const res=await fetch('/api/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyNo:parseInt(card.dataset.no),companyName:card.dataset.name,decision:'skip',feedback:feedback||''})});
      const d=await res.json();if(d.ok)ok++;else fail++;
    }catch(e){fail++;}
  }
  if(fail>0)alert(t('alert.success',{ok:ok})+t('alert.failure',{fail:fail}));
  refreshData();
}

function connectEvents(){
  if(es){
    es.close();
    es=null;
  }
  es=new EventSource('/events');
  es.onmessage=function(e){
    try{
      const d=JSON.parse(e.data);
      if(d.type==='cli-log'){
        appendCliLog(d.message,d.logType,d.time);
        if(d.logType==='action') refreshData();
      }else{
        refreshData();
      }
    }catch(err){
      refreshData();
    }
  };
  es.onerror=function(){
    document.getElementById('liveLabel').textContent=t('app.offline');
    document.getElementById('liveDot').className='live-dot off';
    document.getElementById('cliDot').className='live-dot off';
    if(es){
      es.close();
      es=null;
    }
    if(!reconnectTimer){
      reconnectTimer=setTimeout(()=>{
        reconnectTimer=null;
        connectEvents();
      },3000);
    }
    if(!offlinePollTimer){
      offlinePollTimer=setInterval(()=>refreshData(),15000);
    }
  };
  es.onopen=function(){
    document.getElementById('liveLabel').textContent=t('app.live');
    document.getElementById('liveDot').className='live-dot on';
    document.getElementById('cliDot').className='live-dot on';
    if(reconnectTimer){
      clearTimeout(reconnectTimer);
      reconnectTimer=null;
    }
    if(offlinePollTimer){
      clearInterval(offlinePollTimer);
      offlinePollTimer=null;
    }
  };
}

// Initial data fetch
refreshData({toastOnError:true});
connectEvents();

// Claude CLI status — initial check + periodic polling
pollClaudeStatus();
_claudeStatusTimer = setInterval(pollClaudeStatus, 10000);

// CLI log stream
const cliColors={info:'#8bc5ed',action:'#4ade80',error:'#f87171',warn:'#fbbf24',step:'#a78bfa'};
function appendCliLog(msg,type,time){
  const el=document.getElementById('cliStream');
  const t=time?new Date(time).toLocaleTimeString('ja-JP'):'';
  const color=cliColors[type]||'#e0e0e0';
  const prefix=type==='error'?'[ERROR] ':type==='action'?'[ACTION] ':type==='step'?'[STEP] ':type==='warn'?'[WARN] ':'';
  el.innerHTML+='<span style="color:#666">'+t+'</span> <span style="color:'+color+'">'+prefix+esc(msg)+'</span>'+String.fromCharCode(10);
  el.scrollTop=el.scrollHeight;
  document.getElementById('cliLastEvent').textContent=t;
  const lines=el.innerHTML.split(String.fromCharCode(10));
  if(lines.length>500)el.innerHTML=lines.slice(-300).join(String.fromCharCode(10));
}

// Filters
document.querySelectorAll('.fb').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.fb').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    currentFilter=b.dataset.f;
    document.querySelectorAll('#mt tbody tr').forEach(tr=>{
      if(currentFilter==='all')tr.style.display='';
      else if(currentFilter==='approachable')tr.style.display=tr.dataset.f!=='excluded'?'':'none';
      else tr.style.display=tr.dataset.f===currentFilter?'':'none';
    });
  });
});

// Company search
document.getElementById('q').addEventListener('input',e=>{
  const q=e.target.value.toLowerCase();
  document.querySelectorAll('#mt tbody tr').forEach(tr=>{
    const matchQ=!q||(tr.dataset.n||'').includes(q);
    const matchF=currentFilter==='all'||
      (currentFilter==='approachable'&&tr.dataset.f!=='excluded')||
      tr.dataset.f===currentFilter;
    tr.style.display=(matchQ&&matchF)?'':'none';
  });
});

// Sort table
let sortCol='no',sortAsc=true;
function sortTable(col){
  if(sortCol===col){sortAsc=!sortAsc;}else{sortCol=col;sortAsc=true;}
  document.querySelectorAll('.sort-icon').forEach(s=>s.textContent='');
  const icon=document.querySelector('.sort-icon[data-col="'+col+'"]');
  if(icon)icon.textContent=sortAsc?'\\u25B2':'\\u25BC';
  const tbody=document.getElementById('companyBody');
  const rows=Array.from(tbody.querySelectorAll('tr'));
  rows.sort((a,b)=>{
    let va,vb;
    if(col==='no'){va=parseInt(a.dataset.no)||0;vb=parseInt(b.dataset.no)||0;}
    else if(col==='name'){va=a.dataset.n||'';vb=b.dataset.n||'';}
    else if(col==='type'){va=a.dataset.type||'';vb=b.dataset.type||'';}
    else if(col==='progress'){
      const order={submitted:5,awaiting_approval:4,confirm_reached:3,form_fill:2,error:1,'':0};
      va=order[a.dataset.progress]||0;vb=order[b.dataset.progress]||0;
    }
    else if(col==='sent'){va=parseInt(a.dataset.cnt)||0;vb=parseInt(b.dataset.cnt)||0;}
    else{va=0;vb=0;}
    if(typeof va==='string'){return sortAsc?va.localeCompare(vb):vb.localeCompare(va);}
    return sortAsc?va-vb:vb-va;
  });
  rows.forEach(r=>tbody.appendChild(r));
}

// Sent tab filter
let sentFilter='all';
document.querySelectorAll('.fb-sent').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.fb-sent').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    sentFilter=b.dataset.sf;
    applySentFilter();
  });
});
document.getElementById('sentSearch').addEventListener('input',()=>applySentFilter());
function applySentFilter(){
  const q=(document.getElementById('sentSearch').value||'').toLowerCase();
  let visible=0;
  document.querySelectorAll('.sent-card').forEach(card=>{
    const matchQ=!q||(card.dataset.sn||'').includes(q);
    const cnt=parseInt(card.dataset.sc)||1;
    const matchF=sentFilter==='all'||(sentFilter==='1'&&cnt===1)||(sentFilter==='2+'&&cnt>=2);
    const show=matchQ&&matchF;
    card.style.display=show?'':'none';
    if(show)visible++;
  });
  document.getElementById('sentCount').textContent=visible+' items';
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='settings') loadSettings();
  });
});

// Progress pipeline
function updatePipeline(stats){
  const total=stats.approachable||1;
  const segments=[
    {val:stats.submitted,color:'#10b981',label:t('progress.sent')},
    {val:stats.awaitingApproval,color:'#fb923c',label:t('progress.awaiting')},
    {val:stats.confirmReached,color:'#f59e0b',label:t('awaiting.confirmTitle')},
    {val:stats.formFill,color:'#7c3aed',label:t('progress.filled')},
    {val:stats.error,color:'#dc3545',label:t('progress.error')},
    {val:stats.hasFormUrl-stats.submitted-stats.confirmReached-stats.formFill-stats.error,color:'#0dcaf0',label:t('progress.hasForm')},
  ];
  const remaining=total-segments.reduce((s,x)=>s+Math.max(0,x.val),0);
  segments.push({val:remaining,color:'#dee2e6',label:t('progress.unprocessed')});

  const el=document.getElementById('pipeline');
  el.innerHTML=segments.filter(s=>s.val>0).map(s=>
    '<div class="pip-seg" style="background:'+s.color+';flex:'+Math.max(s.val,0)+'" title="'+s.label+': '+s.val+'"></div>'
  ).join('');

  const done=stats.submitted+stats.confirmReached;
  document.getElementById('progressLabel').textContent=done+' / '+total+' '+t('progress.complete')+' ('+Math.round(done/total*100)+'%)';
}

// ===================== SETTINGS TAB LOGIC =====================

// Settings sidebar navigation
document.querySelectorAll('.settings-sidebar-btn').forEach(b=>{
  b.addEventListener('click',()=>{
    document.querySelectorAll('.settings-sidebar-btn').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('sec-'+b.dataset.section).classList.add('active');
  });
});

let _settingsCache = null;

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    _settingsCache = data;
    populateCompanyProfile(data.companyProfile);
    populateValuePropositions(data.valuePropositions);
    populateTargetList(data.targetList);
    populateExclusionRules(data.exclusionRules);
    populateMessageTemplates(data.messageTemplates);
    populatePreferences(data.preferences);
  } catch (e) {
    showToast(t('alert.error') + ': ' + e.message, 'error');
  }
}

// --- Populate helpers ---

function populateCompanyProfile(cp) {
  const fields = ['companyName','companyNameEn','companyNameKana','representative','contactName','contactNameKana','contactTitle','department','email','phone','fax','mobile','postalCode','address','addressEn','website','partnerPage','corporateProfile','established','employeeCount','capital','industry','businessDescription','notes'];
  fields.forEach(f => {
    const el = document.getElementById('cp-'+f);
    if (el) el.value = cp[f] || '';
  });
}

function populateValuePropositions(vp) {
  document.getElementById('vp-companyUrl').value = vp.companyUrl || '';

  // Service URLs
  renderSimpleObjList('vp-serviceUrls-list', vp.serviceUrls || [], ['label','url'], {label:LANG==='ja'?'ラベル':'Label',url:'URL'});

  // Document paths
  renderSimpleObjList('vp-documentPaths-list', vp.documentPaths || [], ['name','path','description'], {name:LANG==='ja'?'名前':'Name',path:LANG==='ja'?'ファイルパス':'Path',description:LANG==='ja'?'説明':'Description'});

  // Strengths
  renderStrengthsList(vp.strengths || []);

  // Success patterns
  renderSuccessPatternsList(vp.successPatterns || []);

  // Industry profiles
  renderIndustryProfilesList(vp.industryProfiles || {});
}

function populateTargetList(tl) {
  document.getElementById('tl-filePath').value = tl.filePath || '';
  document.getElementById('tl-fileType').value = tl.fileType || 'xlsx';
  document.getElementById('tl-sheetIndex').value = tl.sheetIndex || 0;
  const cm = tl.columnMapping || {};
  ['no','status','companyName','type','url','formUrl','notes','captcha','progress'].forEach(f => {
    const el = document.getElementById('tl-col-'+f);
    if (el) el.value = cm[f] !== undefined ? cm[f] : '';
  });
}

function populateExclusionRules(er) {
  renderExclusionList('er-competitors-list', er.competitors || [], ['pattern','status']);
  renderExclusionList('er-existingClients-list', er.existingClients || [], ['pattern','status']);
  renderNgList(er.ngList || []);
  renderCustomRulesList(er.customRules || []);
  renderStringList('er-excludeStatuses-list', er.excludeStatuses || []);
}

function populateMessageTemplates(mt) {
  const style = mt.style || {};
  document.getElementById('mt-tone').value = style.tone || 'formal';
  document.getElementById('mt-language').value = style.language || 'ja';
  document.getElementById('mt-maxLength').value = style.maxLength || 2000;
  document.getElementById('mt-signatureFormat').value = style.signatureFormat || 'full';
  renderStringList('mt-inquiryTypes-list', mt.inquiryTypes || []);
  document.getElementById('mt-greetingLine').value = mt.greetingLine || '';
  document.getElementById('mt-closingLine').value = mt.closingLine || '';
  document.getElementById('mt-cta').value = mt.cta || '';
  document.getElementById('mt-referenceUrlText').value = mt.referenceUrlText || '';
  document.getElementById('mt-signatureTemplate').value = mt.signatureTemplate || '';
  const letter = mt.letterTemplate || {};
  document.getElementById('mt-letter-enabled').value = String(letter.enabled || false);
  document.getElementById('mt-letter-format').value = letter.format || 'A4';
  document.getElementById('mt-letter-header').value = letter.header || '';
  document.getElementById('mt-letter-footer').value = letter.footer || '';
}

function populatePreferences(pf) {
  const fields = {
    dashboardPort:'number', dashboardHost:'text', language:'select', timezone:'text', dateFormat:'text',
    screenshotDir:'text', dataDir:'text', emailSearchKeyword:'text', emailProvider:'select',
    maxRetries:'number', pageTimeout:'number', formFillTimeout:'number',
    headless:'select', locale:'text', requireApprovalBeforeSend:'select',
    userAgent:'text', logLevel:'select', maxLogEntries:'number', exportFilenamePrefix:'text',
    claudeModel:'select'
  };
  Object.keys(fields).forEach(f => {
    const el = document.getElementById('pf-'+f);
    if (!el) return;
    const val = pf[f];
    if (fields[f] === 'select') {
      el.value = String(val !== undefined ? val : '');
    } else {
      el.value = val !== undefined ? val : '';
    }
  });
}

// --- String list renderer (for excludeStatuses, inquiryTypes) ---
function renderStringList(containerId, items) {
  const container = document.getElementById(containerId);
  let html = '';
  items.forEach((item, i) => {
    html += '<div class="list-item"><span style="flex:1">'+esc(item)+'</span><button class="remove-btn" onclick="removeStringItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button></div>';
  });
  html += '<div class="add-row"><input type="text" placeholder="'+t('settings.add')+'..." onkeydown="if(event.key===\\x27Enter\\x27)addStringItem(\\x27'+containerId+'\\x27,this)"><button onclick="addStringItem(\\x27'+containerId+'\\x27,this.previousElementSibling)">'+t('settings.add')+'</button></div>';
  container.innerHTML = html;
  container.dataset.items = JSON.stringify(items);
}

function addStringItem(containerId, input) {
  const val = input.value.trim();
  if (!val) return;
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  items.push(val);
  renderStringList(containerId, items);
}

function removeStringItem(containerId, idx) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  items.splice(idx, 1);
  renderStringList(containerId, items);
}

function getStringListItems(containerId) {
  const container = document.getElementById(containerId);
  return JSON.parse(container.dataset.items || '[]');
}

// --- Simple object list renderer (for serviceUrls, documentPaths) ---
function renderSimpleObjList(containerId, items, fields, labels) {
  const container = document.getElementById(containerId);
  let html = '';
  items.forEach((item, i) => {
    const display = fields.map(f => esc(item[f] || '')).join(' | ');
    html += '<div class="list-item"><span style="flex:1;font-size:.78rem">'+display+'</span><button class="remove-btn" onclick="removeObjItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button></div>';
  });
  const addInputs = fields.map(f => '<input type="text" placeholder="'+esc(labels[f]||f)+'" data-field="'+f+'">').join('');
  html += '<div class="add-row">'+addInputs+'<button onclick="addObjItem(\\x27'+containerId+'\\x27,['+fields.map(f=>"\\x27"+f+"\\x27").join(',')+'])">'+t('settings.add')+'</button></div>';
  container.innerHTML = html;
  container.dataset.items = JSON.stringify(items);
  container.dataset.fields = JSON.stringify(fields);
}

function addObjItem(containerId, fields) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  const storedFields = JSON.parse(container.dataset.fields || '[]');
  const inputs = container.querySelectorAll('.add-row input');
  const obj = {};
  let hasVal = false;
  inputs.forEach(input => {
    obj[input.dataset.field] = input.value.trim();
    if (input.value.trim()) hasVal = true;
  });
  if (!hasVal) return;
  items.push(obj);
  const labels = {};
  inputs.forEach(input => { labels[input.dataset.field] = input.placeholder; });
  renderSimpleObjList(containerId, items, storedFields, labels);
}

function removeObjItem(containerId, idx) {
  const container = document.getElementById(containerId);
  const items = JSON.parse(container.dataset.items || '[]');
  const fields = JSON.parse(container.dataset.fields || '[]');
  items.splice(idx, 1);
  const labels = {};
  fields.forEach(f => { labels[f] = f; });
  renderSimpleObjList(containerId, items, fields, labels);
}

function getObjListItems(containerId) {
  const container = document.getElementById(containerId);
  return JSON.parse(container.dataset.items || '[]');
}

// --- Strengths list ---
function renderStrengthsList(items) {
  const container = document.getElementById('vp-strengths-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+(item.label||item.key||'Strength '+(i+1))+'</strong><button class="remove-btn" onclick="removeStrengthItem('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'キー':'Key')+'</label><input type="text" value="'+esc(item.key||'')+'" data-field="key"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'ラベル':'Label')+'</label><input type="text" value="'+esc(item.label||'')+'" data-field="label"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'詳細':'Detail')+'</label><input type="text" value="'+esc(item.detail||'')+'" data-field="detail"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'キーワード':'Keywords')+'</label><input type="text" value="'+esc((item.keywords||[]).join(', '))+'" data-field="keywords" placeholder="'+(LANG==='ja'?'カンマ区切り':'comma separated')+'"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
}

function addStrengthItem() {
  const container = document.getElementById('vp-strengths-list');
  const items = collectStrengthItems();
  items.push({ key: '', label: '', detail: '', keywords: [] });
  renderStrengthsList(items);
}

function removeStrengthItem(idx) {
  const items = collectStrengthItems();
  items.splice(idx, 1);
  renderStrengthsList(items);
}

function collectStrengthItems() {
  const container = document.getElementById('vp-strengths-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => {
      if (inp.dataset.field === 'keywords') {
        obj.keywords = inp.value.split(',').map(s=>s.trim()).filter(Boolean);
      } else {
        obj[inp.dataset.field] = inp.value;
      }
    });
    return obj;
  });
}

// --- Success patterns list ---
function renderSuccessPatternsList(items) {
  const container = document.getElementById('vp-successPatterns-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+(item.partner||'Pattern '+(i+1))+'</strong><button class="remove-btn" onclick="removeSuccessPatternItem('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'パートナー':'Partner')+'</label><input type="text" value="'+esc(item.partner||'')+'" data-field="partner"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'実績内容':'Proof')+'</label><input type="text" value="'+esc(item.proof||'')+'" data-field="proof"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'カテゴリ':'Type')+'</label><input type="text" value="'+esc(item.type||'')+'" data-field="type"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
}

function addSuccessPatternItem() {
  const items = collectSuccessPatternItems();
  items.push({ partner: '', proof: '', type: '' });
  renderSuccessPatternsList(items);
}

function removeSuccessPatternItem(idx) {
  const items = collectSuccessPatternItems();
  items.splice(idx, 1);
  renderSuccessPatternsList(items);
}

function collectSuccessPatternItems() {
  const container = document.getElementById('vp-successPatterns-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// --- Industry profiles ---
function renderIndustryProfilesList(profiles) {
  const container = document.getElementById('vp-industryProfiles-list');
  const entries = Object.entries(profiles);
  container.innerHTML = entries.map(([key, val], i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between"><strong style="font-size:.82rem">'+esc(key)+'</strong><button class="remove-btn" onclick="removeIndustryProfile('+i+')">&times;</button></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'業種キー':'Key')+'</label><input type="text" value="'+esc(key)+'" data-field="__key"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'オープナー':'Opener')+'</label><input type="text" value="'+esc(val.opener||'')+'" data-field="opener"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'ポイント':'Point')+'</label><input type="text" value="'+esc(val.point||'')+'" data-field="point"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'実績例':'Examples')+'</label><input type="text" value="'+esc(val.examples||'')+'" data-field="examples"></div>'
    +'<div class="obj-row"><label>'+(LANG==='ja'?'強み':'Strength')+'</label><input type="text" value="'+esc(val.strength||'')+'" data-field="strength"></div>'
    +'</div>'
  ).join('');
  container.dataset.items = JSON.stringify(profiles);
}

function addIndustryProfile() {
  const profiles = collectIndustryProfiles();
  profiles['new_type'] = { opener: '', point: '', examples: '', strength: '' };
  renderIndustryProfilesList(profiles);
}

function removeIndustryProfile(idx) {
  const profiles = collectIndustryProfiles();
  const keys = Object.keys(profiles);
  if (keys[idx]) delete profiles[keys[idx]];
  renderIndustryProfilesList(profiles);
}

function collectIndustryProfiles() {
  const container = document.getElementById('vp-industryProfiles-list');
  const cards = container.querySelectorAll('.obj-list-item');
  const result = {};
  cards.forEach(card => {
    const inputs = card.querySelectorAll('input');
    let key = '';
    const obj = {};
    inputs.forEach(inp => {
      if (inp.dataset.field === '__key') key = inp.value.trim();
      else obj[inp.dataset.field] = inp.value;
    });
    if (key) result[key] = obj;
  });
  return result;
}

// --- Exclusion lists ---
const _exclPh = LANG==='ja' ? {pattern:'会社名パターン',status:'ステータス',reason:'理由'} : {pattern:'Pattern',status:'Status',reason:'Reason'};
function renderExclusionList(containerId, items, fields) {
  const container = document.getElementById(containerId);
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +fields.map(f => '<input type="text" value="'+esc(item[f]||'')+'" data-field="'+f+'" placeholder="'+(_exclPh[f]||f)+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">').join('')
    +'</div>'
    +'<button class="remove-btn" onclick="removeExclusionItem(\\x27'+containerId+'\\x27,'+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
  container.dataset.fields = JSON.stringify(fields);
}

function addExclusionItem(type) {
  const containerId = 'er-'+type+'-list';
  const items = collectExclusionItems(containerId);
  items.push({ pattern: '', status: '' });
  const fields = JSON.parse(document.getElementById(containerId).dataset.fields || '["pattern","status"]');
  renderExclusionList(containerId, items, fields);
}

function removeExclusionItem(containerId, idx) {
  const items = collectExclusionItems(containerId);
  items.splice(idx, 1);
  const fields = JSON.parse(document.getElementById(containerId).dataset.fields || '["pattern","status"]');
  renderExclusionList(containerId, items, fields);
}

function collectExclusionItems(containerId) {
  const container = document.getElementById(containerId);
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// NG list
function renderNgList(items) {
  const container = document.getElementById('er-ngList-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +'<input type="text" value="'+esc(item.pattern||'')+'" data-field="pattern" placeholder="'+(LANG==='ja'?'会社名パターン':'Pattern')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.reason||'')+'" data-field="reason" placeholder="'+(LANG==='ja'?'除外理由':'Reason')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.status||'NG')+'" data-field="status" placeholder="'+(LANG==='ja'?'ステータス':'Status')+'" style="width:80px;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'</div>'
    +'<button class="remove-btn" onclick="removeNgItem('+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
}

function addNgItem() {
  const items = collectNgItems();
  items.push({ pattern: '', reason: '', status: 'NG' });
  renderNgList(items);
}

function removeNgItem(idx) {
  const items = collectNgItems();
  items.splice(idx, 1);
  renderNgList(items);
}

function collectNgItems() {
  const container = document.getElementById('er-ngList-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// Custom rules
function renderCustomRulesList(items) {
  const container = document.getElementById('er-customRules-list');
  container.innerHTML = items.map((item, i) =>
    '<div class="obj-list-item" data-idx="'+i+'">'
    +'<div class="d-flex justify-content-between align-items-center">'
    +'<div style="flex:1;display:flex;gap:8px">'
    +'<input type="text" value="'+esc(item.pattern||'')+'" data-field="pattern" placeholder="'+(LANG==='ja'?'正規表現パターン':'Regex pattern')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.status||'')+'" data-field="status" placeholder="'+(LANG==='ja'?'ステータス':'Status')+'" style="width:120px;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'<input type="text" value="'+esc(item.reason||'')+'" data-field="reason" placeholder="'+(LANG==='ja'?'理由':'Reason')+'" style="flex:1;padding:4px 8px;border:1px solid var(--surface-high);border-radius:var(--radius-md);font-size:.8rem">'
    +'</div>'
    +'<button class="remove-btn" onclick="removeCustomRule('+i+')">&times;</button>'
    +'</div></div>'
  ).join('');
  container.dataset.items = JSON.stringify(items);
}

function addCustomRule() {
  const items = collectCustomRules();
  items.push({ pattern: '', status: '', reason: '' });
  renderCustomRulesList(items);
}

function removeCustomRule(idx) {
  const items = collectCustomRules();
  items.splice(idx, 1);
  renderCustomRulesList(items);
}

function collectCustomRules() {
  const container = document.getElementById('er-customRules-list');
  const cards = container.querySelectorAll('.obj-list-item');
  return Array.from(cards).map(card => {
    const obj = {};
    card.querySelectorAll('input').forEach(inp => { obj[inp.dataset.field] = inp.value; });
    return obj;
  });
}

// --- Save section ---
async function saveSection(section) {
  let data;
  try {
    if (section === 'companyProfile') {
      data = {};
      ['companyName','companyNameEn','companyNameKana','representative','contactName','contactNameKana','contactTitle','department','email','phone','fax','mobile','postalCode','address','addressEn','website','partnerPage','corporateProfile','established','employeeCount','capital','industry','businessDescription','notes'].forEach(f => {
        data[f] = document.getElementById('cp-'+f).value;
      });
    } else if (section === 'valuePropositions') {
      data = {
        companyUrl: document.getElementById('vp-companyUrl').value,
        serviceUrls: getObjListItems('vp-serviceUrls-list'),
        documentPaths: getObjListItems('vp-documentPaths-list'),
        strengths: collectStrengthItems(),
        successPatterns: collectSuccessPatternItems(),
        industryProfiles: collectIndustryProfiles(),
      };
    } else if (section === 'targetList') {
      data = {
        filePath: document.getElementById('tl-filePath').value,
        fileType: document.getElementById('tl-fileType').value,
        sheetIndex: parseInt(document.getElementById('tl-sheetIndex').value) || 0,
        columnMapping: {},
      };
      ['no','status','companyName','type','url','formUrl','notes','captcha','progress'].forEach(f => {
        const val = document.getElementById('tl-col-'+f).value;
        data.columnMapping[f] = val !== '' ? parseInt(val) : 0;
      });
    } else if (section === 'exclusionRules') {
      data = {
        competitors: collectExclusionItems('er-competitors-list'),
        existingClients: collectExclusionItems('er-existingClients-list'),
        ngList: collectNgItems(),
        customRules: collectCustomRules(),
        excludeStatuses: getStringListItems('er-excludeStatuses-list'),
      };
    } else if (section === 'messageTemplates') {
      data = {
        style: {
          tone: document.getElementById('mt-tone').value,
          language: document.getElementById('mt-language').value,
          maxLength: parseInt(document.getElementById('mt-maxLength').value) || 2000,
          signatureFormat: document.getElementById('mt-signatureFormat').value,
        },
        inquiryTypes: getStringListItems('mt-inquiryTypes-list'),
        greetingLine: document.getElementById('mt-greetingLine').value,
        closingLine: document.getElementById('mt-closingLine').value,
        cta: document.getElementById('mt-cta').value,
        referenceUrlText: document.getElementById('mt-referenceUrlText').value,
        signatureTemplate: document.getElementById('mt-signatureTemplate').value,
        letterTemplate: {
          enabled: document.getElementById('mt-letter-enabled').value === 'true',
          format: document.getElementById('mt-letter-format').value,
          header: document.getElementById('mt-letter-header').value,
          footer: document.getElementById('mt-letter-footer').value,
        },
      };
    } else if (section === 'preferences') {
      data = {
        dashboardPort: parseInt(document.getElementById('pf-dashboardPort').value) || 3765,
        dashboardHost: document.getElementById('pf-dashboardHost').value,
        language: document.getElementById('pf-language').value,
        timezone: document.getElementById('pf-timezone').value,
        dateFormat: document.getElementById('pf-dateFormat').value,
        screenshotDir: document.getElementById('pf-screenshotDir').value,
        dataDir: document.getElementById('pf-dataDir').value,
        emailSearchKeyword: document.getElementById('pf-emailSearchKeyword').value,
        emailProvider: document.getElementById('pf-emailProvider').value,
        maxRetries: parseInt(document.getElementById('pf-maxRetries').value) || 3,
        pageTimeout: parseInt(document.getElementById('pf-pageTimeout').value) || 15000,
        formFillTimeout: parseInt(document.getElementById('pf-formFillTimeout').value) || 5000,
        headless: document.getElementById('pf-headless').value === 'true',
        locale: document.getElementById('pf-locale').value,
        requireApprovalBeforeSend: document.getElementById('pf-requireApprovalBeforeSend').value === 'true',
        userAgent: document.getElementById('pf-userAgent').value,
        logLevel: document.getElementById('pf-logLevel').value,
        maxLogEntries: parseInt(document.getElementById('pf-maxLogEntries').value) || 10000,
        exportFilenamePrefix: document.getElementById('pf-exportFilenamePrefix').value,
        claudeModel: document.getElementById('pf-claudeModel').value,
      };
    }

    const res = await fetch('/api/settings/' + section, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.ok) {
      showToast(t('settings.saved'), 'success');
    } else {
      showToast(t('settings.saveError') + ': ' + (result.error || 'Unknown'), 'error');
    }
  } catch (e) {
    showToast(t('settings.saveError') + ': ' + e.message, 'error');
  }
}

// Target list preview
async function loadTargetPreview() {
  try {
    const res = await fetch('/api/settings/target-list/preview');
    const data = await res.json();
    if (data.error) { document.getElementById('targetPreview').innerHTML = '<div class="text-danger">'+esc(data.error)+'</div>'; return; }
    const rows = data.rows || [];
    if (rows.length === 0) { document.getElementById('targetPreview').innerHTML = '<div class="text-muted">No data found.</div>'; return; }
    const headers = data.headers || [];
    let html = '<table class="preview-table"><thead><tr>';
    headers.forEach((h,i) => { html += '<th>Col '+i+(h?' ('+esc(h)+')':'')+'</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(row => {
      html += '<tr>';
      for (let i = 0; i < headers.length; i++) { html += '<td>'+esc(row[i]||'')+'</td>'; }
      html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('targetPreview').innerHTML = html;
  } catch (e) {
    document.getElementById('targetPreview').innerHTML = '<div class="text-danger">'+esc(e.message)+'</div>';
  }
}
</script>
</body>
</html>`;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Assets serving (favicon, icons)
  if (req.url.startsWith('/assets/')) {
    const filename = path.basename(req.url);
    const filepath = path.join(__dirname, '..', 'assets', filename);
    try {
      const data = fs.readFileSync(filepath);
      const ext = path.extname(filename).toLowerCase();
      const mime = ext === '.ico' ? 'image/x-icon' : ext === '.png' ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Screenshot serving
  if (req.url.startsWith('/screenshots/')) {
    const filename = path.basename(req.url);
    const filepath = path.join(settings.getScreenshotDir(), filename);
    try {
      const img = fs.readFileSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- Settings API endpoints ---

  // GET /api/settings - returns all settings
  if (req.url === '/api/settings' && req.method === 'GET') {
    try {
      const allSettings = settings.getAll();
      // Inject current claudeModel from .claude/settings.local.json
      try {
        const claudeSettingsPath = path.join(__dirname, '../.claude', 'settings.local.json');
        const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
        if (claudeSettings.model) {
          allSettings.preferences = allSettings.preferences || {};
          allSettings.preferences.claudeModel = claudeSettings.model;
        }
      } catch (_) {}
      jsonResponse(res, 200, allSettings);
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // PUT /api/settings/:section - update a section
  if (req.url.match(/^\/api\/settings\/(companyProfile|valuePropositions|targetList|exclusionRules|messageTemplates|preferences)$/) && req.method === 'PUT') {
    try {
      const section = req.url.split('/').pop();
      const data = await parseJsonBody(req);
      settings.replaceSection(section, data);

      // When preferences are saved, sync claudeModel → .claude/settings.local.json
      if (section === 'preferences' && data.claudeModel) {
        const claudeSettingsPath = path.join(__dirname, '../.claude', 'settings.local.json');
        let claudeSettings = {};
        try { claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')); } catch (_) {}
        claudeSettings.model = data.claudeModel;
        fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2), 'utf8');
      }

      refreshWatchTargets();
      notifyClients({ type: 'update', reason: 'settings-saved', time: Date.now() });
      jsonResponse(res, 200, { ok: true, data: settings.getSection(section) });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // POST /api/settings/upload-document - register document file path
  if (req.url === '/api/settings/upload-document' && req.method === 'POST') {
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
    return;
  }

  // GET /api/settings/target-list/preview - preview first 10 rows
  if (req.url === '/api/settings/target-list/preview' && req.method === 'GET') {
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
    return;
  }

  // --- Existing API endpoints ---

  // Approve / Skip
  if (req.url === '/api/approve' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { companyNo, companyName, decision, feedback } = JSON.parse(body);
        if (!companyNo || !decision) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'companyNo and decision required' }));
          return;
        }
        const { logAction } = require('./action-logger.cjs');
        const { recordContact, getHistory } = require('./contact-history.cjs');
        if (decision === 'sent') {
          logAction(companyNo, companyName, 'submitted', 'Manually marked as sent from dashboard');
          const allLogs = getAllLogs();
          const draft = allLogs.filter(l => l.companyNo === companyNo && l.action === 'message_draft').pop();
          const existingHistory = getHistory(companyNo);
          const alreadyRecorded = existingHistory && existingHistory.contacts.length > 0 &&
            existingHistory.contacts.some(c => draft && c.message === draft.details);
          if (!alreadyRecorded) {
            recordContact(companyNo, companyName, {
              message: draft ? draft.details : '',
              method: 'web_form',
            });
          }
        } else if (decision === 'skip') {
          const reason = feedback ? 'Skip reason: ' + feedback : 'Skipped from dashboard';
          logAction(companyNo, companyName, 'skipped', reason);
          if (feedback) {
            const fbFile = path.join(__dirname, '../data', 'skip-feedback.json');
            let fbData = [];
            try { fbData = JSON.parse(fs.readFileSync(fbFile, 'utf-8')); } catch {}
            fbData.push({ date: new Date().toISOString(), companyNo, companyName, feedback });
            fs.writeFileSync(fbFile, JSON.stringify(fbData, null, 2), 'utf-8');
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'decision must be "sent" or "skip"' }));
          return;
        }
        notifyClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AI Submit
  if (req.url === '/api/ai-submit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { companyNo, companyName } = JSON.parse(body);
        const queueFile = path.join(__dirname, '../data', 'ai-submit-queue.json');
        let queue = [];
        try { queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8')); } catch {}
        queue.push({ companyNo, companyName, status: 'pending', detail: 'Queued', requestedAt: new Date().toISOString() });
        fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf-8');

        const { spawn } = require('child_process');
        const child = spawn('node', [path.join(__dirname, 'ai-submitter.cjs')], {
          detached: true, stdio: 'ignore',
        });
        child.unref();

        notifyClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'AI submission started' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // AI Submit status
  if (req.url === '/api/ai-submit-status') {
    try {
      const queueFile = path.join(__dirname, '../data', 'ai-submit-queue.json');
      let queue = [];
      try { queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(queue));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // CLI log post
  if (req.url === '/api/cli-log' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { message, type } = JSON.parse(body);
        sseClients.forEach(r => {
          r.write(`data: ${JSON.stringify({ type: 'cli-log', message, logType: type || 'info', time: new Date().toISOString() })}\n\n`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/claude-status — check if Claude CLI is installed and running
  if (req.url === '/api/claude-status' && req.method === 'GET') {
    const { exec } = require('child_process');
    const now = Date.now();
    if (_claudeStatusCache && now - _claudeStatusCacheTime < 8000) {
      jsonResponse(res, 200, _claudeStatusCache);
      return;
    }
    const isWin = process.platform === 'win32';
    const checkInstalled = isWin ? 'where claude' : 'which claude';
    const checkRunning = isWin
      ? 'tasklist /FI "IMAGENAME eq claude.exe" /NH'
      : 'pgrep -x claude';
    exec(checkInstalled, { timeout: 2000 }, (err1) => {
      const installed = !err1;
      if (!installed) {
        _claudeStatusCache = { installed: false, running: false, version: null };
        _claudeStatusCacheTime = Date.now();
        jsonResponse(res, 200, _claudeStatusCache);
        return;
      }
      exec('claude --version', { timeout: 3000 }, (err2, stdout2) => {
        const version = err2 ? null : (stdout2 || '').trim().split('\n')[0].trim() || null;
        exec(checkRunning, { timeout: 2000 }, (err3, stdout3) => {
          let running = false;
          if (isWin) {
            running = !err3 && (stdout3 || '').toLowerCase().includes('claude');
          } else {
            running = !err3 && (stdout3 || '').trim().length > 0;
          }
          _claudeStatusCache = { installed: true, running, version };
          _claudeStatusCacheTime = Date.now();
          jsonResponse(res, 200, _claudeStatusCache);
        });
      });
    });
    return;
  }

  // POST /api/launch-claude — open new terminal with claude running
  if (req.url === '/api/launch-claude' && req.method === 'POST') {
    try {
      const { exec } = require('child_process');
      const projectDir = PROJECT_ROOT;
      let cmd;
      if (process.platform === 'win32') {
        cmd = `start cmd /k "cd /d "${projectDir}" && claude"`;
      } else if (process.platform === 'darwin') {
        cmd = `osascript -e 'tell application "Terminal" to do script "cd \\"${projectDir}\\" && claude"'`;
      } else {
        cmd = `x-terminal-emulator -e bash -c 'cd "${projectDir}" && claude; exec bash' 2>/dev/null || xterm -e bash -c 'cd "${projectDir}" && claude; exec bash' &`;
      }
      exec(cmd, (err) => {
        if (err) console.error('launch-claude error:', err.message);
        _claudeStatusCache = null; // invalidate cache so next poll reflects new state
      });
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  // Excel export
  if (req.url === '/api/export') {
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
          c.lastLog ? new Date(c.lastLog.timestamp).toLocaleString('ja-JP') : '',
          c.logs.length > 0 ? c.logs.map(l => `${l.action}: ${typeof l.details === 'object' ? JSON.stringify(l.details) : l.details}`).join(' | ') : '',
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 5 }, { wch: 8 }, { wch: 25 }, { wch: 25 }, { wch: 12 }, { wch: 40 }, { wch: 8 }, { wch: 15 }, { wch: 18 }, { wch: 50 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Progress');

      const logRows = [['Time', 'No.', 'Company', 'Action', 'Details']];
      data.recentLogs.forEach(l => {
        logRows.push([new Date(l.timestamp).toLocaleString('ja-JP'), l.companyNo, l.companyName, l.action, typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '']);
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
    return;
  }

  if (req.url === '/api/data') {
    try {
      jsonResponse(res, 200, loadData());
    } catch (e) {
      jsonResponse(res, 500, { error: e.message });
    }
    return;
  }

  // Dashboard HTML
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(buildPage());
});

async function startDashboardServer() {
  if (dashboardRuntime && server.listening) return dashboardRuntime;
  if (serverStartPromise) return serverStartPromise;

  serverStartPromise = (async () => {
    const preferredPort = settings.getPort();
    const bindHost = settings.getHost();
    const listenPort = await findAvailablePort(preferredPort, bindHost);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    dashboardRuntime = writeRuntime({
      bindHost,
      host: bindHost,
      port: typeof address === 'object' && address ? address.port : preferredPort,
      preferredPort,
    });

    refreshWatchTargets();
    startHeartbeat();

    const _sl = settings.getSection('preferences').language || 'ja';
    console.log(`\n===================================`);
    console.log(`  ${i18nT(_sl, 'startup.title')}`);
    console.log(`  ${dashboardRuntime.url}`);
    console.log(`===================================\n`);
    console.log(`\n${i18nT(_sl, 'startup.noPolling')}`);
    console.log(`${i18nT(_sl, 'startup.stop')}\n`);

    return dashboardRuntime;
  })().catch((error) => {
    serverStartPromise = null;
    throw error;
  });

  return serverStartPromise;
}

server.on('close', () => {
  closeWatchers();
  clearRuntime();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  dashboardRuntime = null;
  serverStartPromise = null;
});

if (require.main === module) {
  startDashboardServer().catch((error) => {
    console.error('[Dashboard] 起動失敗:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  loadData,
  server,
  startDashboardServer,
};
