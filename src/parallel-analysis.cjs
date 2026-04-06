'use strict';

// サブエージェントが並列実行するスタンドアロン企業分析 + メッセージ生成スクリプト
// Usage: node src/parallel-analysis.cjs '{"no":1,"companyName":"...","url":"...","type":"..."}'
//
// MCP不使用。直接 Playwright または HTTP フェッチで企業サイトを分析し、
// message-builder.cjs でメッセージを生成する。
// 結果は stdout に JSON で出力。副作用として action-log.json と live-monitor.json を更新する。

const path = require('path');
const { log, thinking } = require('./cli-logger.cjs');
const { updateLiveMonitor } = require('./live-monitor.cjs');
const { resolveContactFormUrl } = require('./form-url-resolver.cjs');

function loadActionLogger() {
  try {
    return require('./action-logger.cjs');
  } catch (_) {
    return { logAction: () => {} };
  }
}

function loadMessageBuilder() {
  return require('./message-builder.cjs');
}

// URL安全性チェック（SSRF防止: プライベートIP・非HTTP(S)をブロック）
function isSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  // 標準的なプライベートIP/ループバック
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.|0\.|::1|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|::ffff:)/.test(bareHost)) return false;
  // 10進数IP (例: 2130706433 = 127.0.0.1) と16進数IP (例: 0x7f000001)
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return false;
  // ドットなしホスト名（ローカル解決リスク）
  if (!hostname.includes('.') && !hostname.includes(':')) return false;
  return true;
}

// HTTP ベースの軽量サイト分析（Playwright 不使用）
async function analyzeCompanyLite(url, companyName, companyType) {
  const https = require('https');
  const http = require('http');

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // DNS rebinding対策: 解決済みIPがプライベート範囲でないか検証
  function isPrivateIP(ip) {
    return /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc|fd|fe80|::ffff:)/.test(ip);
  }
  function safeLookup(hostname, options, callback) {
    const dns = require('dns');
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (isPrivateIP(address)) return callback(new Error('DNS resolved to private IP: ' + address));
      callback(null, address, family);
    });
  }

  function fetchText(targetUrl, redirects = 3) {
    if (!isSafeUrl(targetUrl)) { return Promise.resolve(''); }
    return new Promise((resolve) => {
      if (redirects <= 0) { resolve(''); return; }
      const mod = targetUrl.startsWith('https') ? https : http;
      const req = mod.get(targetUrl, { timeout: 10000, lookup: safeLookup, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
        // レート制限検知: 429/503 → 空文字を返す（バックオフはcaller側）
        if (res.statusCode === 429 || res.statusCode === 503) {
          res.resume();
          resolve('__RATE_LIMITED__');
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, targetUrl).href;
          resolve(fetchText(next, redirects - 1));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; if (body.length > 200000) res.destroy(); });
        res.on('end', () => resolve(body));
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  // バックオフ付きfetch（最大2回リトライ）
  async function fetchTextWithBackoff(targetUrl) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delayMs = 1000 * Math.pow(2, attempt);
        log('[WARN] Rate limited by ' + targetUrl + ', retrying in ' + delayMs + 'ms', 'warn');
        await sleep(delayMs);
      }
      const result = await fetchText(targetUrl);
      if (result !== '__RATE_LIMITED__') return result;
    }
    log('[WARN] Rate limit persists after retries, giving up: ' + targetUrl, 'warn');
    return '';
  }

  function extractText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  }

  const siteText = extractText(await fetchTextWithBackoff(url));
  const settings = require('./settings-manager.cjs');
  const strengths = settings.getStrengths();

  // 事業領域の抽出
  const businessAreas = [];
  const areaKeywords = ['AI', 'DX', 'クラウド', 'SaaS', 'セキュリティ', 'データ', 'IoT', 'Web', 'モバイル', 'EC', 'ERP', 'CRM', 'RPA', 'BI', 'インフラ'];
  const siteTextLower = siteText.toLowerCase();
  for (const kw of areaKeywords) {
    if (siteTextLower.includes(kw.toLowerCase())) {
      businessAreas.push({ label: kw, confidence: 0.7 });
    }
  }

  // ギャップ分析
  const gaps = strengths.map((s) => {
    const keywords = (s.keywords || []).concat([s.label]);
    const matched = keywords.some((k) => siteText.toLowerCase().includes(String(k).toLowerCase()));
    return matched ? null : { strength: s, gap: 'not_mentioned' };
  }).filter(Boolean);

  // 注力領域
  const focusAreas = [];
  if (/パートナー|協業|提携/.test(siteText)) focusAreas.push('パートナーを募集中');
  if (/採用|求人|キャリア/.test(siteText)) focusAreas.push('採用強化中');
  if (/新サービス|リリース|ローンチ/.test(siteText)) focusAreas.push('新サービス展開中');

  // 関連パターン
  const allPatterns = settings.getSuccessPatterns();
  const relevantPatterns = allPatterns.filter((p) => {
    const pType = String(p.type || '').toLowerCase();
    return companyType && pType.includes(companyType.toLowerCase());
  });

  return {
    companyName,
    companyType: companyType || '',
    businessAreas: businessAreas.slice(0, 5),
    gaps: gaps.slice(0, 5),
    focusAreas,
    relevantPatterns: relevantPatterns.slice(0, 3),
    siteTextLength: siteText.length,
    analysisMode: 'lite',
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('Usage: node parallel-analysis.cjs \'{"no":1,"companyName":"...","url":"..."}\'\n');
    process.exit(1);
  }

  let company;
  try {
    company = JSON.parse(input);
  } catch (e) {
    process.stderr.write('Invalid JSON input: ' + e.message + '\n');
    process.exit(1);
  }

  const { no, companyName, url, type: companyType, formUrl } = company;
  const actionLogger = loadActionLogger();
  const messageBuilder = loadMessageBuilder();

  try {
    // Step 1: サイト分析
    thinking(`[No.${no}] ${companyName}: サイト分析開始`);
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'analyzing',
      step: 'サイト分析中',
      currentUrl: url || '',
    });

    const analysis = await Promise.race([
      analyzeCompanyLite(url, companyName, companyType),
      new Promise((resolve) => setTimeout(() => resolve({
        companyName, companyType: companyType || '', businessAreas: [], gaps: [],
        focusAreas: [], relevantPatterns: [], siteTextLength: 0, analysisMode: 'timeout',
      }), 15000)),
    ]);
    actionLogger.logAction(no, companyName, 'site_analysis', JSON.stringify(analysis));
    log(`[No.${no}] ${companyName}: サイト分析完了 (${analysis.businessAreas.length}領域検出, ${analysis.gaps.length}ギャップ)`, 'step');

    let resolvedFormUrl = formUrl || '';
    let formResolutionMethod = resolvedFormUrl ? 'preset' : 'none';
    if (!resolvedFormUrl && url) {
      thinking(`[No.${no}] ${companyName}: フォームURL探索中`);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'analyzing',
        step: 'フォームURL探索中',
        currentUrl: url || '',
      });
      const resolved = await resolveContactFormUrl(url);
      if (resolved && resolved.found && resolved.formUrl) {
        resolvedFormUrl = resolved.formUrl;
        formResolutionMethod = resolved.method || 'resolved';
        log(`[No.${no}] ${companyName}: フォームURL解決 ${resolvedFormUrl}`, 'step');
      } else {
        formResolutionMethod = resolved && resolved.reason ? resolved.reason : 'unresolved';
        log(`[No.${no}] ${companyName}: フォームURL未解決 (${formResolutionMethod})`, 'warn');
      }
    }

    if (resolvedFormUrl) {
      analysis.resolvedFormUrl = resolvedFormUrl;
      analysis.formResolutionMethod = formResolutionMethod;
    }

    // Step 2: メッセージ生成
    thinking(`[No.${no}] ${companyName}: メッセージ生成中`);
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'drafting',
      step: 'メッセージ生成中',
    });

    const message = messageBuilder.buildCustomMessage(analysis);
    const MIN_MESSAGE_LENGTH = 50;
    if (message.trim().length < MIN_MESSAGE_LENGTH) {
      const warnMsg = `メッセージが短すぎます (${message.trim().length}文字 < ${MIN_MESSAGE_LENGTH}文字)。設定の会社プロフィール・提供価値を確認してください`;
      log(`[No.${no}] ${companyName}: ${warnMsg}`, 'warn');
      actionLogger.logAction(no, companyName, 'error', warnMsg);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'error',
        step: 'メッセージ生成エラー: 文字数不足',
      });
      const result = { ok: false, no, companyName, error: warnMsg };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }
    actionLogger.logAction(no, companyName, 'message_draft', message);
    log(`[No.${no}] ${companyName}: メッセージ生成完了 (${message.length}文字)`, 'step');

    // Step 3: 分析完了
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'draft_ready',
      step: '分析+メッセージ完了（フォーム入力待ち）',
    });

    const result = {
      ok: true,
      no,
      companyName,
      analysis,
      message,
      formUrl: resolvedFormUrl || formUrl || '',
      formResolutionMethod,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    log(`[No.${no}] ${companyName}: 分析エラー — ${e.message}`, 'error');
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'error',
      step: '分析エラー: ' + e.message,
    });
    const result = { ok: false, no, companyName, error: e.message };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }
}

main();
