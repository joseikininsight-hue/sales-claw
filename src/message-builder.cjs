// 企業個別分析に基づくカスタム問い合わせ文面を生成する
// 設計方針:
//   1. 相手がやりたいことから入る（自社紹介から入らない）
//   2. 全部伝えようとしない（尖った強み1-2個に集中）
//   3. Win-Winは匂わせで十分（重くしない）
//   4. 相手のサイトを分析し、具体的なギャップに言及する
//   5. 相手の事業内容に触れ「ちゃんと見ている」感を出す

const settings = require('./settings-manager.cjs');

// 企業種別からプロファイル選択（設定ベース）
function getProfile(companyType) {
  const profiles = settings.getIndustryProfiles();
  if (!companyType || Object.keys(profiles).length === 0) {
    return profiles.default || { opener: '', point: '', examples: '', strength: '' };
  }

  const t = companyType.toLowerCase();

  // 完全一致 → 部分一致の順で検索
  for (const [key, profile] of Object.entries(profiles)) {
    if (key === 'default') continue;
    if (t.includes(key.toLowerCase()) || key.toLowerCase().includes(t)) {
      return profile;
    }
  }

  return profiles.default || { opener: '', point: '', examples: '', strength: '' };
}

// 問い合わせ本文を生成（テンプレートベース）
function buildMessage(companyName, companyType) {
  const sender = settings.getSender();
  const tmpl = settings.getSection('messageTemplates');
  const p = getProfile(companyType);

  const greeting = tmpl.greetingLine || 'お世話になります。';
  const name = sender.name ? sender.name.split(' ')[0] : '';
  const intro = sender.companyName && name ? `${sender.companyName}の${name}と申します。` : '';

  const parts = [greeting];
  if (intro) parts.push(intro);
  parts.push('');
  if (p.opener) parts.push(p.opener);
  parts.push('');
  if (p.point) parts.push(p.point);
  parts.push('');
  if (p.examples) parts.push(`（${p.examples}）`);

  // 参照URL
  if (sender.partnerPage && tmpl.referenceUrlText) {
    parts.push('');
    parts.push(tmpl.referenceUrlText);
    parts.push(sender.partnerPage);
  }

  // 締め文
  if (tmpl.closingLine) {
    parts.push('');
    parts.push(tmpl.closingLine);
  }

  // CTA
  if (tmpl.cta) {
    parts.push('');
    parts.push(tmpl.cta);
  }

  // 署名
  parts.push('');
  parts.push(settings.getSignature());

  return parts.join('\n');
}

// --- 企業分析ベースのカスタムメッセージ生成 ---

/**
 * 企業分析結果をもとに、その企業だけに刺さるメッセージを生成する
 * @param {Object} analysis - company-analyzer.cjs の analyzeCompany() の結果
 * @returns {string} カスタムメッセージ
 */
function buildCustomMessage(analysis) {
  const sender = settings.getSender();
  const tmpl = settings.getSection('messageTemplates');
  const { companyName, companyType, businessAreas, gaps, focusAreas, relevantPatterns } = analysis;

  const greeting = tmpl.greetingLine || 'お世話になります。';
  const name = sender.name ? sender.name.split(' ')[0] : '';
  const intro = sender.companyName && name ? `${sender.companyName}の${name}と申します。` : '';

  // 1. 相手の事業を理解した上での書き出し（相手起点）
  const opener = generateOpener(companyName, companyType, businessAreas, focusAreas);

  // 2. 相手のギャップに対して自社が埋められる具体的ポイント（1-2個に絞る）
  const hook = generateHook(gaps, businessAreas, companyType);

  // 3. 類似企業との協業実績（相手に近い1社だけ）
  const proof = generateProof(relevantPatterns, companyType);

  const parts = [greeting];
  if (intro) parts.push(intro);
  parts.push('');
  if (opener) parts.push(opener);
  parts.push('');
  if (hook) parts.push(hook);
  parts.push('');
  if (proof) parts.push(proof);

  // 参照URL
  if (sender.partnerPage && tmpl.referenceUrlText) {
    parts.push('');
    parts.push(tmpl.referenceUrlText);
    parts.push(sender.partnerPage);
  }

  // 締め文
  if (tmpl.closingLine) {
    parts.push('');
    parts.push(tmpl.closingLine);
  }

  // CTA
  if (tmpl.cta) {
    parts.push('');
    parts.push(tmpl.cta);
  }

  // 署名
  parts.push('');
  parts.push(settings.getSignature());

  return parts.join('\n');
}

/**
 * 相手の事業に触れた書き出しを生成
 */
function generateOpener(companyName, companyType, businessAreas, focusAreas) {
  const strengths = settings.getStrengths();
  const mainStrength = strengths.length > 0 ? strengths[0].label : '';

  // 相手が注力している分野があれば言及
  if (focusAreas.length > 0) {
    if (focusAreas.includes('パートナーを募集中') && mainStrength) {
      return `貴社のパートナー募集を拝見し、${mainStrength}の専門チームとして協業の可能性があるのではないかと思い、ご連絡いたしました。`;
    }
    return `貴社の${focusAreas[0].replace(/を.+$/, '')}への取り組みを拝見し、お力添えできることがあるのではないかと思い、ご連絡いたしました。`;
  }

  // 事業領域に基づく書き出し
  const topAreas = businessAreas.slice(0, 2).map(a => a.label);
  if (topAreas.length > 0) {
    const areaStr = topAreas.join('・');
    return `貴社の${areaStr}事業を拝見いたしました。顧客案件の中で、専門パートナーが必要になることはございませんでしょうか。`;
  }

  // フォールバック（種別ベース）
  const p = getProfile(companyType);
  return p.opener || '貴社の事業について拝見し、ご連絡いたしました。';
}

/**
 * ギャップ分析に基づく具体的な提案ポイントを生成
 */
function generateHook(gaps, businessAreas, companyType) {
  if (gaps.length > 0) {
    const topGap = gaps[0];
    const strength = topGap.strength;
    const partnerArea = businessAreas.length > 0 ? businessAreas[0].label : '';

    if (partnerArea && strength.detail) {
      return `弊社は${strength.label}を専門としており、${strength.detail}。貴社の${partnerArea}の知見と、弊社の技術力を組み合わせることで、顧客への提案の幅を広げるお手伝いができるのではないかと考えております。`;
    }
    if (strength.detail) {
      return `弊社は${strength.label}を専門としており、${strength.detail}。お力添えできるかと存じます。`;
    }
  }

  // ギャップが検出できなかった場合、種別ベースのフォールバック
  const p = getProfile(companyType);
  if (p.point) return p.point;

  // 最終フォールバック: 自社の強みの1つ目を使う
  const strengths = settings.getStrengths();
  if (strengths.length > 0) {
    return `弊社は${strengths[0].label}を専門としております。${strengths[0].detail || ''}`;
  }
  return '';
}

/**
 * 類似企業との実績を1社だけ具体的に出す
 */
function generateProof(patterns, companyType) {
  if (patterns.length > 0) {
    const best = patterns[0];
    return `実際に${best.partner}様とは、${best.proof}させていただいております。`;
  }

  const allPatterns = settings.getSuccessPatterns();
  if (allPatterns.length > 0) {
    return `多くの企業様との協業実績がございます。`;
  }

  return '';
}

module.exports = { buildMessage, buildCustomMessage, getProfile };
