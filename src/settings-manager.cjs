// Settings Manager — 全設定の一元管理
// data/settings.json を Single Source of Truth として管理
// ダッシュボードUI・各モジュールがここを通じて設定を読み書きする

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const STATIC_DATA_DIR = path.join(__dirname, '../data');
const LEGACY_SETTINGS_FILE = path.join(STATIC_DATA_DIR, 'settings.json');
const SAMPLE_SETTINGS_FILE = path.join(STATIC_DATA_DIR, 'sample-settings.json');
const DEFAULT_SETTINGS_DIR = path.join(getRuntimeRoot(), 'data');
const SETTINGS_FILE = path.join(DEFAULT_SETTINGS_DIR, 'settings.json');

function getRuntimeRoot() {
  const configured = typeof process.env.SALES_CLAW_USER_DATA_DIR === 'string'
    ? process.env.SALES_CLAW_USER_DATA_DIR.trim()
    : '';
  const base = configured || path.join(os.homedir(), '.sales-claw');
  return path.resolve(base);
}

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
    // 営業アプローチ方針（AI への内部指示）
    approachObjective: '',
    approachGuardrails: '',
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
    aiProvider: 'claude',
    aiModels: {
      claude: 'claude-sonnet-4-6',
      codex: '',
      gemini: '',
    },
    claudeModel: 'claude-sonnet-4-6',
    // ログ
    logLevel: 'info',             // 'debug' | 'info' | 'warn' | 'error'
    maxLogEntries: 10000,         // ログの最大保持件数
    // セキュリティ
    requireApprovalBeforeSend: true,  // 送信前に承認を要求
    autoSendEligibleForms: false,     // CAPTCHA等がない安全なフォームは自動送信
    // エクスポート
    exportFilenamePrefix: 'outreach_progress',
  },
};

// --- Core Functions ---

function ensureDataDir(dirPath = DEFAULT_SETTINGS_DIR) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readSettingsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function readLegacyClaudeModel() {
  try {
    const legacySettingsPath = path.join(PROJECT_ROOT, '.claude', 'settings.local.json');
    const parsed = JSON.parse(fs.readFileSync(legacySettingsPath, 'utf-8'));
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    return model || null;
  } catch {
    return null;
  }
}

function resolveConfiguredDataDir(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value || value.includes('\0')) return DEFAULT_SETTINGS_DIR;
  const resolved = path.isAbsolute(value) ? value : path.join(getRuntimeRoot(), value);
  return path.resolve(resolved);
}

function getBootstrapSettings() {
  return readSettingsFile(SETTINGS_FILE) || readSettingsFile(LEGACY_SETTINGS_FILE);
}

function getActiveSettingsFile() {
  const bootstrap = getBootstrapSettings();
  const dataDir = resolveConfiguredDataDir(bootstrap && bootstrap.preferences && bootstrap.preferences.dataDir);
  return path.join(dataDir, 'settings.json');
}

function load() {
  ensureDataDir(DEFAULT_SETTINGS_DIR);
  const activeSettingsFile = getActiveSettingsFile();
  const saved = readSettingsFile(activeSettingsFile)
    || readSettingsFile(SETTINGS_FILE)
    || readSettingsFile(LEGACY_SETTINGS_FILE)
    || readSettingsFile(SAMPLE_SETTINGS_FILE);
  const merged = normalizeSettings(deepMerge(structuredClone(DEFAULT_SETTINGS), saved || {}));
  const legacyClaudeModel = readLegacyClaudeModel();
  if (!merged.preferences.aiModels.claude && legacyClaudeModel) {
    merged.preferences.aiModels.claude = legacyClaudeModel;
  }
  if (!merged.preferences.claudeModel && legacyClaudeModel) {
    merged.preferences.claudeModel = legacyClaudeModel;
  }
  return merged;
}

function save(settings) {
  const normalized = normalizeSettings(settings);
  const configuredDir = resolveConfiguredDataDir(normalized && normalized.preferences && normalized.preferences.dataDir);
  const configuredFile = path.join(configuredDir, 'settings.json');
  const payload = JSON.stringify(normalized, null, 2);

  ensureDataDir(DEFAULT_SETTINGS_DIR);
  ensureDataDir(configuredDir);

  atomicWriteFileSync(configuredFile, payload);
  if (path.resolve(configuredFile) !== path.resolve(SETTINGS_FILE)) {
    atomicWriteFileSync(SETTINGS_FILE, payload);
  }
}

function atomicWriteFileSync(filePath, content) {
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, content, 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
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

function getAutoSubmitPolicy() {
  const prefs = getSection('preferences');
  return {
    enabled: prefs.autoSendEligibleForms === true,
    requireApproval: prefs.requireApprovalBeforeSend !== false,
    skipIfCaptcha: true,
  };
}

function getTargetListPath() {
  const tl = getSection('targetList');
  if (!tl.filePath) return null;
  return path.isAbsolute(tl.filePath) ? tl.filePath : path.join(getRuntimeRoot(), tl.filePath);
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
  const raw = getSection('preferences').screenshotDir || 'screenshots';
  const dir = typeof raw === 'string' && !raw.includes('\0') ? raw.trim() : 'screenshots';
  const resolved = path.isAbsolute(dir) ? dir : path.join(getRuntimeRoot(), dir);
  return path.resolve(resolved);
}

function normalizeSettings(input) {
  const settings = input && typeof input === 'object' ? input : structuredClone(DEFAULT_SETTINGS);
  if (!settings.preferences || typeof settings.preferences !== 'object') {
    settings.preferences = structuredClone(DEFAULT_SETTINGS.preferences);
  }

  const prefs = settings.preferences;
  const aiProvider = typeof prefs.aiProvider === 'string' && prefs.aiProvider.trim()
    ? prefs.aiProvider.trim().toLowerCase()
    : 'claude';
  prefs.aiProvider = ['claude', 'codex', 'gemini'].includes(aiProvider) ? aiProvider : 'claude';

  const aiModels = prefs.aiModels && typeof prefs.aiModels === 'object' && !Array.isArray(prefs.aiModels)
    ? { ...prefs.aiModels }
    : {};
  aiModels.claude = typeof aiModels.claude === 'string' ? aiModels.claude : '';
  aiModels.codex = typeof aiModels.codex === 'string' ? aiModels.codex : '';
  aiModels.gemini = typeof aiModels.gemini === 'string' ? aiModels.gemini : '';

  if (!aiModels.claude && typeof prefs.claudeModel === 'string' && prefs.claudeModel.trim()) {
    aiModels.claude = prefs.claudeModel.trim();
  }
  if (!aiModels.claude) {
    aiModels.claude = DEFAULT_SETTINGS.preferences.aiModels.claude;
  }

  prefs.aiModels = aiModels;
  prefs.claudeModel = aiModels.claude;

  return settings;
}

function isConfigured() {
  const profile = getSection('companyProfile');
  return !!(profile.companyName && profile.contactName && profile.email && profile.phone);
}

function getSignature() {
  const profile = getSection('companyProfile');
  const tmpl = getSection('messageTemplates');
  const style = getMessageStyle();
  const signatureFormat = style.signatureFormat || 'full';
  if (signatureFormat === 'none') return '';
  if (signatureFormat === 'minimal') {
    return [
      profile.companyName || '',
      profile.contactName || '',
      profile.email ? `MAIL: ${profile.email}` : '',
    ].filter(Boolean).join('\n');
  }
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

function getMessageStyle() {
  const tmpl = getSection('messageTemplates');
  return {
    ...(tmpl.style || {}),
  };
}

function getLetterTemplate() {
  const tmpl = getSection('messageTemplates');
  return {
    enabled: !!(tmpl.letterTemplate && tmpl.letterTemplate.enabled),
    header: tmpl.letterTemplate && typeof tmpl.letterTemplate.header === 'string' ? tmpl.letterTemplate.header : '',
    footer: tmpl.letterTemplate && typeof tmpl.letterTemplate.footer === 'string' ? tmpl.letterTemplate.footer : '',
    format: (tmpl.letterTemplate && tmpl.letterTemplate.format) || 'A4',
  };
}

function getApprovalBeforeSend() {
  return getSection('preferences').requireApprovalBeforeSend !== false;
}

function getAutoSendEligibleForms() {
  return getSection('preferences').autoSendEligibleForms === true;
}

function getFormFillTimeout() {
  const timeout = Number(getSection('preferences').formFillTimeout);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
}

function getAiProvider() {
  return (getSection('preferences').aiProvider || 'claude').trim() || 'claude';
}

function getAiModels() {
  return { ...(getSection('preferences').aiModels || {}) };
}

function getAiModel(providerId = 'claude') {
  const key = typeof providerId === 'string' ? providerId.trim().toLowerCase() : 'claude';
  const models = getAiModels();
  return typeof models[key] === 'string' ? models[key].trim() : '';
}

// --- Export ---

module.exports = {
  // Core
  load, save, getAll, getSection, updateSection, replaceSection, get, set,
  // Convenience
  getSender, getStrengths, getSuccessPatterns, getIndustryProfiles,
  getExcludeStatuses, getTargetListPath, getPort, getScreenshotDir,
  getHost, getRuntimeRoot,
  isConfigured, getSignature, getMessageStyle, getLetterTemplate,
  getApprovalBeforeSend, getAutoSendEligibleForms, getAutoSubmitPolicy, getFormFillTimeout, getActiveSettingsFile,
  getAiProvider, getAiModels, getAiModel,
  // Constants
  DEFAULT_SETTINGS, PROJECT_ROOT, SETTINGS_FILE, LEGACY_SETTINGS_FILE, SAMPLE_SETTINGS_FILE, STATIC_DATA_DIR,
};
