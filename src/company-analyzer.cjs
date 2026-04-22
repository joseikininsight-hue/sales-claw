// 企業サイトを分析し、自社との協業ポイントを特定する
// Playwrightが利用可能ならブラウザで巡回、なければHTTP fetchにフォールバック

const settings = require('./settings-manager.cjs');
const { log: cliLog } = (() => { try { return require('./cli-logger.cjs'); } catch { return { log: () => {} }; } })();

function tryLoadPlaywright() {
  try {
    return require('playwright').chromium;
  } catch {
    return null;
  }
}

async function analyzeCompanyWithPlaywright(chromium, companyUrl, companyName, companyType) {
  const prefs = settings.getSection('preferences');
  const browser = await chromium.launch({ headless: prefs.headless !== false });
  const context = await browser.newContext({
    userAgent: prefs.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: prefs.locale || 'ja-JP',
  });

  const texts = [];

  try {
    const page = await context.newPage();
    await page.goto(companyUrl, { waitUntil: 'domcontentloaded', timeout: prefs.pageTimeout || 15000 });
    await page.waitForTimeout(2000);
    const topText = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    texts.push({ page: 'top', text: topText });

    const serviceLinks = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .map(a => ({ href: a.href, text: (a.textContent || '').trim() }))
        .filter(l => {
          const t = (l.text + l.href).toLowerCase();
          return (t.includes('サービス') || t.includes('service') || t.includes('事業') ||
                  t.includes('ソリューション') || t.includes('solution') || t.includes('製品') ||
                  t.includes('product') || t.includes('強み') || t.includes('特長')) &&
                 l.href.startsWith('http') && l.text.length < 30 && l.text.length > 0;
        })
        .slice(0, 3);
    });

    for (const link of serviceLinks.slice(0, 2)) {
      try {
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);
        const pageText = await page.evaluate(() => document.body.innerText.substring(0, 4000));
        texts.push({ page: link.text, text: pageText });
      } catch (_) { /* skip */ }
    }
  } catch (e) {
    cliLog('サイト分析エラー: ' + e.message.substring(0, 80), 'warn');
  }

  await browser.close();
  return texts;
}

/**
 * 企業サイトを分析して自社との協業ポイントを特定する
 * Playwrightが利用不可の場合は parallel-analysis.cjs の HTTP fetch にフォールバック
 */
async function analyzeCompany(companyUrl, companyName, companyType) {
  const chromium = tryLoadPlaywright();
  let texts = [];

  if (chromium) {
    texts = await analyzeCompanyWithPlaywright(chromium, companyUrl, companyName, companyType);
  } else {
    cliLog('Playwright未インストール: HTTP fetchで分析します', 'warn');
    const { analyzeCompanyLite } = require('./parallel-analysis.cjs');
    return analyzeCompanyLite(companyUrl, companyName, companyType);
  }

  const rawJoinedText = texts.map(t => t.text).join('\n');
  const allText = rawJoinedText.toLowerCase();
  const siteTextExcerpt = rawJoinedText.slice(0, 1200);
  const strengths = settings.getStrengths();

  return {
    companyName,
    companyType,
    companyUrl,
    businessAreas: detectBusinessAreas(allText),
    gaps: detectGaps(allText, strengths),
    focusAreas: detectFocusAreas(allText),
    relevantPatterns: findRelevantPatterns(companyType),
    rawTextLength: allText.length,
    siteTextExcerpt,
  };
}

function detectBusinessAreas(text) {
  const areas = [];
  const checks = [
    { key: 'si', label: 'システム開発', words: ['システム開発', 'システムインテグレーション', 'si事業', '受託開発'] },
    { key: 'infra', label: 'インフラ', words: ['インフラ', 'ネットワーク', 'サーバー', 'クラウド基盤'] },
    { key: 'consulting', label: 'コンサルティング', words: ['コンサルティング', 'コンサル', '経営支援', '業務改善'] },
    { key: 'erp', label: 'ERP・基幹系', words: ['erp', 'sap', '基幹システム', '会計システム', '業務システム'] },
    { key: 'security', label: 'セキュリティ', words: ['セキュリティ', 'サイバー', '脆弱性', 'soc'] },
    { key: 'data', label: 'データ分析', words: ['データ分析', 'bi', 'データ活用', '可視化', 'ダッシュボード'] },
    { key: 'dx', label: 'DX推進', words: ['dx', 'デジタルトランスフォーメーション', 'デジタル変革'] },
    { key: 'web', label: 'Web制作', words: ['web制作', 'ホームページ制作', 'ウェブサイト', 'サイト構築'] },
    { key: 'marketing', label: 'マーケティング', words: ['マーケティング', '広告', 'プロモーション', 'ブランド'] },
    { key: 'ai_ml', label: 'AI・機械学習', words: ['ai', '人工知能', '機械学習', 'ディープラーニング', '生成ai'] },
    { key: 'bpo', label: 'BPO・アウトソーシング', words: ['bpo', 'アウトソーシング', '業務代行'] },
    { key: 'embedded', label: '組込み・IoT', words: ['組込み', 'iot', '制御', 'ファームウェア'] },
    { key: 'hr', label: '人材・派遣', words: ['人材', '派遣', 'エンジニア派遣', 'ses', '技術者派遣'] },
  ];

  for (const check of checks) {
    const count = check.words.filter(w => text.includes(w)).length;
    if (count > 0) areas.push({ ...check, matchCount: count });
  }

  return areas.sort((a, b) => b.matchCount - a.matchCount);
}

/**
 * 自社の強みとのギャップを検出（設定ベース）
 */
function detectGaps(text, strengths) {
  const gaps = [];

  for (const strength of strengths) {
    const keywords = (strength.keywords || []).map(k => k.toLowerCase());
    const found = keywords.some(k => text.includes(k));
    if (!found && keywords.length > 0) {
      gaps.push({
        area: strength.key,
        description: `${strength.label}の専門性がない`,
        strength,
      });
    }
  }

  return gaps;
}

function detectFocusAreas(text) {
  const focus = [];
  const patterns = [
    { label: 'DX推進を強化中', words: ['dx推進', 'デジタル変革', 'dx戦略'] },
    { label: 'AI/データ活用に注力', words: ['ai活用', 'データドリブン', 'データ分析強化'] },
    { label: 'クラウド移行を推進', words: ['クラウドシフト', 'クラウド移行', 'クラウドファースト'] },
    { label: '新規事業を展開中', words: ['新規事業', '事業拡大', '新サービス'] },
    { label: 'パートナーを募集中', words: ['パートナー', '協業', '協力会社', 'ビジネスパートナー'] },
  ];

  for (const p of patterns) {
    if (p.words.some(w => text.includes(w))) {
      focus.push(p.label);
    }
  }

  return focus;
}

/**
 * 企業種別に合った協業パターンを返す（設定ベース）
 */
function findRelevantPatterns(companyType) {
  const patterns = settings.getSuccessPatterns();
  if (patterns.length === 0) return [];

  const t = (companyType || '').toLowerCase();

  // 種別に合うtypeを持つパターンを優先
  const typeMatches = patterns.filter(p => {
    const pType = (p.type || '').toLowerCase();
    return t.includes(pType) || pType.includes(t);
  });

  if (typeMatches.length > 0) return typeMatches.slice(0, 2);
  return patterns.slice(0, 2);
}

module.exports = { analyzeCompany };
