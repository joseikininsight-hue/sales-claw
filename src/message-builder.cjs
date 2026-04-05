// 企業個別分析に基づくカスタム問い合わせ文面を生成する
// 設計方針:
//   1. 相手がやりたいことから入る（自社紹介から入らない）
//   2. 全部伝えようとしない（尖った強み1-2個に集中）
//   3. Win-Winは匂わせで十分（重くしない）
//   4. 相手のサイトを分析し、具体的なギャップに言及する
//   5. 相手の事業内容に触れ「ちゃんと見ている」感を出す

const settings = require('./settings-manager.cjs');

function truncateMessage(text, maxLength) {
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 2000;
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

function applyLetterTemplate(message) {
  const template = settings.getLetterTemplate();
  if (!template.enabled) return message;

  const body = String(message || '').trim();
  const parts = [];
  if (template.header) parts.push(template.header.trim());
  if (body) parts.push(body);
  if (template.footer) parts.push(template.footer.trim());
  return parts.join('\n\n').trim();
}

function finalizeMessage(message) {
  const style = settings.getMessageStyle();
  const withTemplate = applyLetterTemplate(message);
  return truncateMessage(withTemplate, style.maxLength);
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateSoft(text, maxLength = 120) {
  const value = compactText(text);
  if (!value) return '';
  if (value.length <= maxLength) return value;

  const punctuations = ['。', '、', ' '];
  let cutIndex = -1;
  for (const marker of punctuations) {
    const idx = value.lastIndexOf(marker, maxLength);
    if (idx > cutIndex) cutIndex = idx;
  }

  const safeIndex = cutIndex > Math.floor(maxLength * 0.6) ? cutIndex : maxLength;
  return value.slice(0, safeIndex).replace(/[、。\s]+$/, '') + '…';
}

function uniqueStrings(items) {
  return Array.from(new Set((items || []).map((item) => compactText(item)).filter(Boolean)));
}

function formatAreaList(items, maxItems = 2) {
  return uniqueStrings(items).slice(0, maxItems).join('・');
}

function ensureSentence(text) {
  const value = compactText(text);
  if (!value) return '';
  return /[。！？]$/.test(value) ? value : `${value}。`;
}

function getPrimaryAreaLabel(businessAreas, companyType) {
  const areaLabel = formatAreaList((businessAreas || []).map((area) => area && area.label), 1);
  return areaLabel || compactText(companyType) || '案件対応';
}

function getSecondaryStrength(gaps, primaryKey) {
  return (gaps || []).find((gap) => {
    const strength = gap && gap.strength;
    return strength && compactText(strength.label) && strength.key !== primaryKey;
  }) || null;
}

function buildObservationPoints(companyName, companyType, businessAreas, focusAreas) {
  const observations = [];
  const focuses = uniqueStrings(focusAreas);
  const areaLabel = formatAreaList((businessAreas || []).map((area) => area && area.label), 2);

  if (focuses.includes('パートナーを募集中')) {
    observations.push('貴社サイトで外部連携や募集に関する記載を拝見しました。');
  }

  const prioritizedFocuses = focuses
    .filter((focus) => focus !== 'パートナーを募集中')
    .map((focus) => focus.replace(/を.+$/, ''));
  if (prioritizedFocuses.length > 0) {
    observations.push(`特に${formatAreaList(prioritizedFocuses, 2)}を継続テーマとして進めておられる点が印象に残りました。`);
  }

  if (areaLabel) {
    observations.push(`また、${areaLabel}を軸に事業展開されており、案件によって周辺領域まで含めた体制づくりが必要になるのではないかと感じました。`);
  }

  if (observations.length < 2 && companyType) {
    observations.push(`貴社が${companyType}として幅広い案件対応を担われている前提で拝見しました。`);
  }

  if (observations.length < 2 && companyName) {
    observations.push(`${companyName}様の公開情報を拝見し、汎用的な売り込みではなく実務面で補完できる余地を考えてご連絡しています。`);
  }

  return uniqueStrings(observations).slice(0, 2).map((point) => truncateSoft(point, 88));
}

function buildProposalPoint(gaps, businessAreas, companyType) {
  const profile = getProfile(companyType);
  const topGap = (gaps || []).find((gap) => gap && gap.strength && compactText(gap.strength.label)) || null;
  const areaLabel = getPrimaryAreaLabel(businessAreas, companyType);

  if (topGap) {
    const strength = topGap.strength;
    const strengthLabel = compactText(strength.label);
    const capability = ensureSentence(truncateSoft(strength.detail || `${strengthLabel}領域の実務支援が可能です`, 84));
    const secondaryGap = getSecondaryStrength(gaps, strength.key);
    const secondaryLabel = secondaryGap && secondaryGap.strength
      ? compactText(secondaryGap.strength.label)
      : '';
    const secondaryText = secondaryLabel && secondaryLabel !== strengthLabel
      ? `必要に応じて${secondaryLabel}周辺まで含めて柔軟に支援できます。`
      : '';

    return truncateSoft(
      `弊社では${strengthLabel}を主な対応領域としており、${capability}貴社の${areaLabel}案件でも、要件整理後の実装や不足しやすい専門工程の補完役としてご一緒できる余地があると考えております。${secondaryText}`,
      168
    );
  }

  if (profile.point) return truncateSoft(profile.point, 148);

  const strengths = settings.getStrengths();
  if (strengths.length > 0) {
    const primary = strengths[0];
    const label = compactText(primary.label);
    const detail = ensureSentence(truncateSoft(primary.detail || `${label}領域の支援が可能です`, 82));
    return truncateSoft(
      `弊社では${label}を主な対応領域としており、${detail}必要な工程だけを補完する形でもご一緒できます。`,
      150
    );
  }

  return '';
}

function buildProofPoint(patterns, companyType) {
  const relevant = Array.isArray(patterns) ? patterns : [];
  if (relevant.length > 0) {
    const best = relevant[0];
    const partner = compactText(best.partner);
    const proof = truncateSoft(best.proof, 86);
    const matchedType = compactText(best.type || companyType);
    return truncateSoft(
      `${partner ? `実際に${partner}様では、` : '実際の支援では、'}${proof}${proof.endsWith('。') ? '' : '。'}${matchedType ? `${matchedType}に近い文脈でも、必要な工程だけを補完する進め方に対応できます。` : '必要な工程だけを切り出して進める形にも対応できます。'}`
      ,
      150
    );
  }

  const allPatterns = settings.getSuccessPatterns();
  if (allPatterns.length > 0) {
    const sample = allPatterns[0];
    const proof = truncateSoft(sample.proof, 82);
    return truncateSoft(
      `${proof}${proof.endsWith('。') ? '' : '。'}要件整理後の実装や追加開発の補完といった進め方でご一緒することが多いです。`,
      140
    );
  }

  return '';
}

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

  return finalizeMessage(parts.join('\n'));
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

  const observations = buildObservationPoints(companyName, companyType, businessAreas, focusAreas);
  const proposal = buildProposalPoint(gaps, businessAreas, companyType);
  const proof = buildProofPoint(relevantPatterns, companyType);
  const fallbackOpener = generateOpener(companyName, companyType, businessAreas, focusAreas);
  const fallbackHook = generateHook(gaps, businessAreas, companyType);

  if (observations.length === 0 && !proposal && !proof && !fallbackOpener && !fallbackHook) {
    return buildMessage(companyName, companyType);
  }

  const parts = [greeting];
  if (intro) parts.push(intro);

  const bodyBlocks = observations.slice(0, 2);
  if (proposal || fallbackHook) bodyBlocks.push(proposal || truncateSoft(fallbackHook, 150));
  if (proof) bodyBlocks.push(proof);
  if (bodyBlocks.length < 4 && fallbackOpener) {
    bodyBlocks.unshift(truncateSoft(fallbackOpener, 88));
  }

  bodyBlocks
    .filter(Boolean)
    .slice(0, 4)
    .forEach((block) => {
      parts.push('');
      parts.push(block);
    });

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

  return finalizeMessage(parts.join('\n'));
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

module.exports = { buildMessage, buildCustomMessage, getProfile, finalizeMessage };
