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
          if (!isSafeUrl(next)) { res.resume(); resolve(''); return; }
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

  // バックオフ付きfetch（最大3回リトライ — レート制限対応）
  async function fetchTextWithBackoff(targetUrl) {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

  // HTMLから構造化情報を抽出（タグ除去前に実行）
  function extractStructuredContent(html) {
    const metaDesc = (
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i) ||
      []
    )[1] || '';

    const headings = [];
    for (const m of html.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 3 && text.length < 80) headings.push(text);
    }

    // サービス・会社紹介ページのリンクを抽出
    const subpageLinks = [];
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"'#?]+)/gi)) {
      const href = m[1];
      if (/service|サービス|事業|about|会社|solution|strength|feature/i.test(href)) {
        subpageLinks.push(href);
      }
    }

    return {
      metaDescription: metaDesc.trim().slice(0, 200),
      headings: [...new Set(headings)].slice(0, 10),
      subpageLinks: [...new Set(subpageLinks)].slice(0, 3),
    };
  }

  const topHtml = await fetchTextWithBackoff(url);
  const structured = extractStructuredContent(topHtml);
  const siteText = extractText(topHtml);

  // サービスページを1枚追加取得（CVRに効く具体情報を増やす）
  let subpageText = '';
  for (const subUrl of structured.subpageLinks.slice(0, 2)) {
    if (!isSafeUrl(subUrl)) continue;
    try {
      const subHtml = await fetchTextWithBackoff(subUrl);
      const sub = extractText(subHtml).slice(0, 3000);
      if (sub.length > 200) { subpageText = sub; break; }
    } catch (_) {}
  }

  const combinedText = (siteText + '\n' + subpageText).slice(0, 10000);
  const siteTextExcerpt = combinedText.slice(0, 2000);
  const settings = require('./settings-manager.cjs');
  const strengths = settings.getStrengths();

  // 事業領域の抽出（キーワード密度スコアで信頼度を付ける）
  const areaChecks = [
    { key: 'si', label: 'システム開発・SIer', words: ['システム開発', 'システムインテグレーション', 'si事業', '受託開発', 'SIer'] },
    { key: 'infra', label: 'インフラ・クラウド', words: ['インフラ', 'ネットワーク', 'クラウド基盤', 'AWS', 'Azure', 'GCP'] },
    { key: 'consulting', label: 'コンサルティング', words: ['コンサルティング', 'コンサル', '経営支援', '業務改善', '戦略'] },
    { key: 'erp', label: 'ERP・基幹系', words: ['ERP', 'SAP', '基幹システム', '会計システム', '業務システム'] },
    { key: 'security', label: 'セキュリティ', words: ['セキュリティ', 'サイバー', '脆弱性', 'SOC', 'CSIRT'] },
    { key: 'data', label: 'データ分析・BI', words: ['データ分析', 'BI', 'データ活用', '可視化', 'ダッシュボード', 'データドリブン'] },
    { key: 'dx', label: 'DX推進', words: ['DX', 'デジタルトランスフォーメーション', 'デジタル変革', 'DX推進'] },
    { key: 'ai_ml', label: 'AI・機械学習', words: ['AI', '人工知能', '機械学習', 'ディープラーニング', '生成AI', 'LLM'] },
    { key: 'web', label: 'Web制作・開発', words: ['Web制作', 'ホームページ制作', 'Webサイト', 'サイト構築', 'フロントエンド'] },
    { key: 'saas', label: 'SaaS・プロダクト', words: ['SaaS', 'プロダクト', 'サブスクリプション', '自社サービス', 'クラウドサービス'] },
    { key: 'bpo', label: 'BPO・アウトソーシング', words: ['BPO', 'アウトソーシング', '業務代行', '委託'] },
    { key: 'hr', label: '人材・SES', words: ['人材', '派遣', 'エンジニア派遣', 'SES', '技術者派遣'] },
    { key: 'marketing', label: 'マーケティング', words: ['マーケティング', '広告', 'SEO', 'SEM', 'CRM', 'MA'] },
  ];
  const combinedLower = combinedText.toLowerCase();
  const businessAreas = areaChecks
    .map((c) => {
      const count = c.words.filter((w) => combinedLower.includes(w.toLowerCase())).length;
      return count > 0 ? { ...c, matchCount: count, confidence: Math.min(count / 2, 1.0) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.matchCount - a.matchCount);

  // ギャップ分析（自社強みのキーワードが相手サイトに少ない = 補完余地あり）
  const gaps = strengths.map((s) => {
    const keywords = (s.keywords || []).concat([s.label]);
    const matchCount = keywords.filter((k) => combinedLower.includes(String(k).toLowerCase())).length;
    if (matchCount === 0) return { strength: s, gap: 'absent', relevance: 'high' };
    if (matchCount < keywords.length * 0.3) return { strength: s, gap: 'weak', relevance: 'medium' };
    return null;
  }).filter(Boolean);

  // 注力領域
  const focusAreas = [];
  if (/パートナー|協業|提携|アライアンス/.test(combinedText)) focusAreas.push('パートナーを募集中');
  if (/新サービス|リリース|ローンチ|プレスリリース/.test(combinedText)) focusAreas.push('新サービス展開中');
  if (/DX|デジタル変革|デジタルトランスフォーメーション/.test(combinedText)) focusAreas.push('DX推進を強化中');
  if (/採用強化|積極採用|エンジニア募集/.test(combinedText)) focusAreas.push('採用強化中');

  // 関連パターン
  const allPatterns = settings.getSuccessPatterns();
  const relevantPatterns = allPatterns.filter((p) => {
    const pType = String(p.type || '').toLowerCase();
    return companyType && pType.includes(companyType.toLowerCase());
  });

  return {
    companyName,
    companyType: companyType || '',
    companyUrl: url || '',
    businessAreas: businessAreas.slice(0, 6),
    gaps: gaps.slice(0, 5),
    focusAreas,
    relevantPatterns: relevantPatterns.slice(0, 3),
    siteTextLength: combinedText.length,
    siteTextExcerpt,
    companyPhrases: structured.headings,
    metaDescription: structured.metaDescription,
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
        companyName, companyType: companyType || '', companyUrl: url || '', businessAreas: [], gaps: [],
        focusAreas: [], relevantPatterns: [], siteTextLength: 0, siteTextExcerpt: '', analysisMode: 'timeout',
      }), 15000)),
    ]);
    actionLogger.logAction(no, companyName, 'site_analysis', JSON.stringify(analysis));
    log(`[No.${no}] ${companyName}: サイト分析完了 (${analysis.businessAreas.length}領域検出, ${analysis.gaps.length}ギャップ)`, 'step');

    let resolvedFormUrl = formUrl || '';
    let formResolutionMethod = resolvedFormUrl ? 'preset' : 'none';
    // 初期値は 'unknown' としておき、下流で null チェック漏れが起きないようにする
    let resolvedFormType = resolvedFormUrl ? 'contact_form' : 'unknown';
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
        formResolutionMethod = resolved.method || 'resolved';
        resolvedFormType = resolved.formType || 'contact_form';
        // 発見したページに <form> が存在しない場合（メール/電話のみ）は formUrl を採用しない
        // → 下流の email_only/phone_only 分岐で skipped になる
        if (resolved.hasForm === false && (resolvedFormType === 'email_only' || resolvedFormType === 'phone_only')) {
          log(`[No.${no}] ${companyName}: 問い合わせページ発見もフォームなし (${resolvedFormType}) → skipped 対象`, 'warn');
        } else {
          resolvedFormUrl = resolved.formUrl;
          log(`[No.${no}] ${companyName}: フォームURL解決 ${resolvedFormUrl}`, 'step');
        }
      } else {
        formResolutionMethod = resolved && resolved.reason ? resolved.reason : 'unresolved';
        resolvedFormType = (resolved && resolved.formType) || 'not_found';
        log(`[No.${no}] ${companyName}: フォームURL未解決 (${formResolutionMethod}, type=${resolvedFormType})`, 'warn');
      }
    }

    if (resolvedFormUrl) {
      analysis.resolvedFormUrl = resolvedFormUrl;
      analysis.formResolutionMethod = formResolutionMethod;
      analysis.formType = resolvedFormType;
    } else if (resolvedFormType) {
      analysis.formType = resolvedFormType;
    }

    // formType に応じた早期リターン分岐:
    //   email_only → skipped (メールのみ = フォームなし)
    //   phone_only → skipped (電話のみ = フォームなし)
    //   not_found  → 従来の error 経路を維持（下流でメッセージ生成失敗時に拾う）
    if (!resolvedFormUrl && (resolvedFormType === 'email_only' || resolvedFormType === 'phone_only')) {
      const skipReason = resolvedFormType === 'email_only'
        ? 'メール問い合わせのみ: フォームなし'
        : '電話問い合わせのみ: フォームなし';
      log(`[No.${no}] ${companyName}: ${skipReason}`, 'warn');
      actionLogger.logAction(no, companyName, 'skipped', skipReason);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'skipped',
        step: skipReason,
      });
      const result = { ok: false, no, companyName, skipped: true, reason: skipReason, formType: resolvedFormType };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    // Step 2: メッセージ生成
    thinking(`[No.${no}] ${companyName}: メッセージ生成中`);
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'drafting',
      step: 'メッセージ生成中',
    });

    const templateDraft = messageBuilder.buildCustomMessage(analysis);
    const { prompt: messagePrompt } = messageBuilder.buildMessagePrompt(analysis);
    const MIN_MESSAGE_LENGTH = 50;
    if (templateDraft.trim().length < MIN_MESSAGE_LENGTH) {
      const warnMsg = `メッセージが短すぎます (${templateDraft.trim().length}文字 < ${MIN_MESSAGE_LENGTH}文字)。設定の会社プロフィール・提供価値を確認してください`;
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
    actionLogger.logAction(no, companyName, 'message_draft', templateDraft);
    log(`[No.${no}] ${companyName}: プロンプト+テンプレート生成完了 (${templateDraft.length}文字)`, 'step');

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
      message: templateDraft,
      messagePrompt,
      templateDraft,
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

if (require.main === module) {
  main();
}

module.exports = { analyzeCompanyLite };
