// Settings Manager — 全設定の一元管理
// data/settings.json を Single Source of Truth として管理
// ダッシュボードUI・各モジュールがここを通じて設定を読み書きする

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../data', 'settings.json');

const DEFAULT_SETTINGS = {
  // === 会社プロフィール（詳細） ===
  companyProfile: {
    companyName: '',
    companyNameEn: '',
    companyNameKana: '',
    representative: '',           // 代表者名
    contactName: '',              // 担当者名
    contactNameKana: '',          // 担当者名カナ
    contactTitle: '',             // 役職
    department: '',               // 部署名
    email: '',
    phone: '',
    fax: '',
    mobile: '',                   // 携帯番号
    postalCode: '',
    address: '',
    addressEn: '',
    website: '',
    partnerPage: '',              // パートナー募集ページURL
    corporateProfile: '',         // 会社概要URL
    established: '',              // 設立年
    employeeCount: '',            // 従業員数
    capital: '',                  // 資本金
    industry: '',                 // 業種
    businessDescription: '',      // 事業内容（自由記述）
    notes: '',                    // 備考（自由記述）
  },

  // === 提供価値 ===
  valuePropositions: {
    // 自社サイト・サービス情報URL
    companyUrl: '',               // 自社サイトURL
    serviceUrls: [],              // サービス紹介URL配列 [{label, url}]
    documentPaths: [],            // アップロード済みドキュメントパス [{name, path, description}]

    // 自社の強み
    strengths: [
      // { key: 'example', label: '強みの名前', detail: '詳細説明', keywords: ['関連ワード1', '関連ワード2'] }
    ],

    // 協業実績パターン
    successPatterns: [
      // { partner: '匿名企業A', proof: '協業内容の概要', type: 'SIer' }
    ],

    // 業種別プロフィール（メッセージテンプレート）
    industryProfiles: {
      // 'SIer': { opener: '...', point: '...', examples: '...', strength: '...' },
      // 'default': { opener: '...', point: '...', examples: '...', strength: '...' },
    },
  },

  // === ターゲットリスト ===
  targetList: {
    filePath: '',                 // Excelファイルパス（プロジェクトルートからの相対パス）
    fileType: 'xlsx',             // 'xlsx' | 'csv'
    sheetIndex: 0,                // シートインデックス
    columnMapping: {              // Excelカラムマッピング（0-based index）
      no: 0,                      // No.列
      status: 1,                  // ステータス列
      companyName: 2,             // 企業名列
      type: 3,                    // 種別列
      url: 4,                     // WebサイトURL列
      formUrl: 5,                 // 問い合わせフォームURL列
      notes: 6,                   // 備考列
      captcha: 8,                 // CAPTCHA列
      progress: 10,               // 進捗列
    },
  },

  // === 除外ルール ===
  exclusionRules: {
    competitors: [
      // { pattern: '会社名パターン', status: '競合' }
    ],
    existingClients: [
      // { pattern: '会社名パターン', status: '既存契約' }
    ],
    ngList: [
      // { pattern: '会社名パターン', reason: '除外理由', status: 'NG' }
    ],
    customRules: [
      // { pattern: '正規表現パターン', status: 'カスタムステータス', reason: '理由' }
    ],
    // 除外ステータス一覧（これらのステータスを持つ企業は対象外）
    excludeStatuses: ['×', 'web×', '競合', '規模×', '既存契約', 'パイプ有', '提案辞退', '失注', 'NG'],
  },

  // === メッセージテンプレート ===
  messageTemplates: {
    style: {
      tone: 'formal',             // 'formal' | 'casual' | 'business'
      language: 'ja',             // 'ja' | 'en'
      maxLength: 2000,            // 最大文字数
      signatureFormat: 'full',    // 'full' | 'minimal' | 'none'
    },
    // 問い合わせ種別（フォームのドロップダウン値候補）
    inquiryTypes: ['その他', 'お問い合わせ', '協業・パートナーシップ', 'サービスについて', 'その他のお問い合わせ'],
    // 締め文
    closingLine: 'もしご興味がございましたら、30分程度の情報交換の場をいただけないでしょうか。\n貴社のお取り組みについてもお伺いできればと存じます。',
    // 挨拶文
    greetingLine: 'お世話になります。',
    // CTA
    cta: '何卒よろしくお願いいたします。',
    // 参照URL案内テキスト
    referenceUrlText: '詳細はこちらをご覧いただけますと幸いです。',
    // 署名テンプレート（プレースホルダー使用）
    signatureTemplate: '{companyName}\n{contactName}\nTEL: {phone}\nMAIL: {email}',
    // 書面テンプレート（PDF/手紙用）
    letterTemplate: {
      enabled: false,
      header: '',                 // 書面ヘッダー（「拝啓　時下ますます…」等）
      footer: '',                 // 書面フッター（「敬具」等）
      format: 'A4',              // 'A4' | 'letter'
    },
  },

  // === 環境設定（詳細） ===
  preferences: {
    // サーバー
    dashboardPort: 3765,
    dashboardHost: '127.0.0.1',
    // 表示
    language: 'ja',               // 'ja' | 'en'
    timezone: 'Asia/Tokyo',
    dateFormat: 'YYYY-MM-DD HH:mm',
    // ストレージ
    screenshotDir: 'screenshots',
    dataDir: 'data',
    // メール取得
    emailSearchKeyword: '',
    emailProvider: 'outlook',     // 'outlook' | 'gmail' | 'other'
    // 自動化
    maxRetries: 3,                // フォーム送信リトライ回数
    pageTimeout: 15000,           // ページ読み込みタイムアウト(ms)
    formFillTimeout: 5000,        // フォーム入力タイムアウト(ms)
    // ブラウザ
    headless: true,               // ヘッドレスモード
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'ja-JP',
    // ログ
    logLevel: 'info',             // 'debug' | 'info' | 'warn' | 'error'
    maxLogEntries: 10000,         // ログの最大保持件数
    // セキュリティ
    requireApprovalBeforeSend: true,  // 送信前に承認を要求
    // エクスポート
    exportFilenamePrefix: 'outreach_progress',
  },
};

// --- Core Functions ---

function ensureDataDir() {
  const dir = path.join(__dirname, '../data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const saved = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function save(settings) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

function getAll() {
  return load();
}

function getSection(section) {
  const settings = load();
  if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
  return settings[section];
}

function updateSection(section, data) {
  const settings = load();
  if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
  settings[section] = deepMerge(settings[section], data);
  save(settings);
  return settings[section];
}

function replaceSection(section, data) {
  const settings = load();
  if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
  settings[section] = data;
  save(settings);
  return settings[section];
}

function get(section, key) {
  const sectionData = getSection(section);
  return key ? sectionData[key] : sectionData;
}

function set(section, key, value) {
  const settings = load();
  if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
  settings[section][key] = value;
  save(settings);
  return settings[section][key];
}

// --- Helpers ---

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])
        && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// --- Convenience Getters ---

function getSender() {
  const profile = getSection('companyProfile');
  return {
    companyName: profile.companyName,
    name: profile.contactName,
    nameKana: profile.contactNameKana,
    email: profile.email,
    phone: profile.phone,
    mobile: profile.mobile,
    fax: profile.fax,
    postalCode: profile.postalCode,
    address: profile.address,
    website: profile.website,
    partnerPage: profile.partnerPage,
    department: profile.department,
    title: profile.contactTitle,
  };
}

function getStrengths() {
  return getSection('valuePropositions').strengths || [];
}

function getSuccessPatterns() {
  return getSection('valuePropositions').successPatterns || [];
}

function getIndustryProfiles() {
  return getSection('valuePropositions').industryProfiles || {};
}

function getExcludeStatuses() {
  return getSection('exclusionRules').excludeStatuses || [];
}

function getTargetListPath() {
  const tl = getSection('targetList');
  if (!tl.filePath) return null;
  return path.isAbsolute(tl.filePath) ? tl.filePath : path.join(__dirname, '..', tl.filePath);
}

function getPort() {
  const port = Number(getSection('preferences').dashboardPort);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  return 3765;
}

function getHost() {
  const host = (getSection('preferences').dashboardHost || '').trim();
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  return host;
}

function getScreenshotDir() {
  const dir = getSection('preferences').screenshotDir || 'screenshots';
  return path.isAbsolute(dir) ? dir : path.join(__dirname, '..', dir);
}

function isConfigured() {
  const profile = getSection('companyProfile');
  return !!(profile.companyName && profile.contactName && profile.email);
}

function getSignature() {
  const profile = getSection('companyProfile');
  const tmpl = getSection('messageTemplates');
  const template = tmpl.signatureTemplate || '{companyName}\n{contactName}\nTEL: {phone}\nMAIL: {email}';
  return template
    .replace('{companyName}', profile.companyName || '')
    .replace('{contactName}', profile.contactName || '')
    .replace('{contactTitle}', profile.contactTitle || '')
    .replace('{department}', profile.department || '')
    .replace('{phone}', profile.phone || '')
    .replace('{mobile}', profile.mobile || '')
    .replace('{fax}', profile.fax || '')
    .replace('{email}', profile.email || '')
    .replace('{website}', profile.website || '')
    .replace('{partnerPage}', profile.partnerPage || '')
    .replace('{address}', profile.address || '');
}

// --- Export ---

module.exports = {
  // Core
  load, save, getAll, getSection, updateSection, replaceSection, get, set,
  // Convenience
  getSender, getStrengths, getSuccessPatterns, getIndustryProfiles,
  getExcludeStatuses, getTargetListPath, getPort, getScreenshotDir,
  getHost,
  isConfigured, getSignature,
  // Constants
  DEFAULT_SETTINGS, SETTINGS_FILE,
};
