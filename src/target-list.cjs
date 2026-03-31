'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const settings = require('./settings-manager.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const IMPORT_DIR = path.join(DATA_DIR, 'imports');
const DEFAULT_TARGET_FILE = path.join(DATA_DIR, 'manual-targets.csv');

const TARGET_FIELDS = ['no', 'status', 'companyName', 'type', 'url', 'formUrl', 'notes', 'captcha', 'progress'];

const HEADER_LABELS = {
  no: 'No.',
  status: 'Status',
  companyName: 'Company Name',
  type: 'Type',
  url: 'Website URL',
  formUrl: 'Form URL',
  notes: 'Notes',
  captcha: 'CAPTCHA',
  progress: 'Progress',
};

const HEADER_HINTS = {
  no: ['no', 'no.', 'number', 'id', '番号', '管理番号'],
  status: ['status', 'ステータス', '判定'],
  companyName: ['companyname', 'company', 'company_name', '企業名', '会社名', '法人名', '名称'],
  type: ['type', 'category', 'kind', '種別', '業種', 'カテゴリ', '分類'],
  url: ['websiteurl', 'website', 'siteurl', 'site', 'weburl', 'url', 'web', 'homepage', 'hp', 'webサイト', 'ホームページ'],
  formUrl: ['formurl', 'contacturl', 'inquiryurl', '問い合わせフォームurl', 'お問い合わせフォームurl', '問い合わせurl', 'お問い合わせurl', 'form', 'contact', 'inquiry', 'toiawase'],
  notes: ['notes', 'note', 'memo', '備考', 'メモ', 'コメント'],
  captcha: ['captcha', 'recaptcha', 're-captcha'],
  progress: ['progress', '進捗', '対応状況'],
};

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeHeader(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[ \t\r\n_\-./\\:：()[\]{}<>「」『』【】・]/g, '');
}

function normalizeCompanyNo(value) {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  const text = normalizeValue(value);
  return text === '' ? null : text;
}

function getColumnMapping() {
  const targetList = settings.getSection('targetList');
  return {
    no: 0,
    status: 1,
    companyName: 2,
    type: 3,
    url: 4,
    formUrl: 5,
    notes: 6,
    captcha: 8,
    progress: 10,
    ...(targetList.columnMapping || {}),
  };
}

function getFileTypeFromPath(targetPath, fallback = 'xlsx') {
  const ext = path.extname(targetPath || '').toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.xlsx') return 'xlsx';
  return fallback === 'csv' ? 'csv' : 'xlsx';
}

function toRelativeProjectPath(targetPath) {
  if (!targetPath) return '';
  const relativePath = path.relative(PROJECT_ROOT, targetPath);
  if (!relativePath || relativePath.startsWith('..')) return targetPath;
  return relativePath;
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function buildDefaultHeaders(columnMapping) {
  const length = Math.max(...Object.values(columnMapping)) + 1;
  const headers = Array.from({ length }, () => '');
  Object.entries(columnMapping).forEach(([field, index]) => {
    headers[index] = HEADER_LABELS[field] || field;
  });
  return headers;
}

function createEmptyWorkbookBundle(targetPath, fileType, columnMapping, sheetName = 'Targets') {
  const workbook = XLSX.utils.book_new();
  const rows = [buildDefaultHeaders(columnMapping)];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  writeWorkbookBundle({ workbook, targetPath, fileType });
  return {
    workbook,
    rows,
    headers: rows[0],
    sheetName,
    targetPath,
    fileType,
    columnMapping,
  };
}

function writeWorkbookBundle({ workbook, targetPath, fileType }) {
  ensureDirectory(path.dirname(targetPath));
  if (fileType === 'csv') {
    XLSX.writeFile(workbook, targetPath, { bookType: 'csv' });
    return;
  }
  XLSX.writeFile(workbook, targetPath);
}

function readWorkbookBundle(targetPath, options = {}) {
  const targetList = settings.getSection('targetList');
  const fileType = getFileTypeFromPath(targetPath, options.fileType || targetList.fileType || 'xlsx');
  const columnMapping = options.columnMapping || getColumnMapping();
  const sheetIndex = Number.isInteger(options.sheetIndex) ? options.sheetIndex : (targetList.sheetIndex || 0);

  if (!targetPath) {
    return { ok: false, error: 'Target list file is not configured.' };
  }

  if (!fs.existsSync(targetPath)) {
    if (!options.createIfMissing) {
      return { ok: false, error: `Target list file not found: ${targetPath}`, targetPath };
    }
    return {
      ok: true,
      ...createEmptyWorkbookBundle(targetPath, fileType, columnMapping),
    };
  }

  try {
    const workbook = XLSX.readFile(targetPath, { raw: false, defval: '' });
    const sheetNames = workbook.SheetNames || [];
    const sheetName = sheetNames[sheetIndex] || sheetNames[0] || 'Targets';

    if (!workbook.Sheets[sheetName]) {
      workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet([buildDefaultHeaders(columnMapping)]);
      if (!sheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const normalizedRows = rows.length > 0 ? rows : [buildDefaultHeaders(columnMapping)];

    return {
      ok: true,
      workbook,
      rows: normalizedRows,
      headers: normalizedRows[0] || [],
      sheetName,
      targetPath,
      fileType,
      columnMapping,
    };
  } catch (error) {
    return { ok: false, error: error.message, targetPath };
  }
}

function mapRow(row, columnMapping, rowIndex) {
  return {
    no: normalizeCompanyNo(row[columnMapping.no]),
    status: normalizeValue(row[columnMapping.status]),
    companyName: normalizeValue(row[columnMapping.companyName]),
    type: normalizeValue(row[columnMapping.type]),
    url: normalizeValue(row[columnMapping.url]),
    formUrl: normalizeValue(row[columnMapping.formUrl]),
    notes: normalizeValue(row[columnMapping.notes]),
    captcha: normalizeValue(row[columnMapping.captcha]),
    progress: normalizeValue(row[columnMapping.progress]),
    rowIndex,
    raw: row,
  };
}

function readTargetList() {
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) return workbookData;

  const dataRows = workbookData.rows.slice(1);
  const companies = dataRows
    .map((row, index) => mapRow(row, workbookData.columnMapping, index + 1))
    .filter((row) => row.no !== null || row.companyName || row.url || row.formUrl);

  return {
    ok: true,
    columnMapping: workbookData.columnMapping,
    companies,
    headers: workbookData.headers,
    rows: dataRows,
    sheetName: workbookData.sheetName,
    targetPath: workbookData.targetPath,
    fileType: workbookData.fileType,
  };
}

function getTargetPreview(limit = 10) {
  const data = readTargetList();
  if (!data.ok) return data;
  return {
    ok: true,
    headers: data.headers,
    rows: data.rows.slice(0, limit),
    sheetName: data.sheetName,
    targetPath: data.targetPath,
  };
}

function findCompanyByNo(companyNo) {
  const data = readTargetList();
  if (!data.ok) return data;

  const wanted = normalizeCompanyNo(companyNo);
  const company = data.companies.find((entry) => String(entry.no) === String(wanted));
  return {
    ...data,
    company: company || null,
  };
}

function findCompaniesByNos(companyNos) {
  const data = readTargetList();
  if (!data.ok) return data;

  const wanted = new Set((companyNos || []).map((value) => String(normalizeCompanyNo(value))));
  return {
    ...data,
    companies: data.companies.filter((entry) => wanted.has(String(entry.no))),
  };
}

function detectColumnMapping(headers) {
  const detected = {};
  (headers || []).forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;

    TARGET_FIELDS.forEach((field) => {
      if (detected[field] !== undefined) return;
      const matched = (HEADER_HINTS[field] || []).some((hint) => normalized.includes(normalizeHeader(hint)));
      if (matched) detected[field] = index;
    });
  });
  return detected;
}

function sanitizeImportFileName(fileName) {
  const baseName = path.basename(fileName || 'target-list.xlsx');
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

function getNextCompanyNo(companies) {
  const numericIds = (companies || [])
    .map((company) => Number(company.no))
    .filter((value) => Number.isFinite(value));
  return numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
}

function buildCompanyRow(companyData, columnMapping, currentLength) {
  const rowLength = Math.max(currentLength || 0, Math.max(...Object.values(columnMapping)) + 1);
  const row = Array.from({ length: rowLength }, () => '');
  const values = {
    no: companyData.no,
    status: companyData.status || '',
    companyName: companyData.companyName || '',
    type: companyData.type || '',
    url: companyData.url || '',
    formUrl: companyData.formUrl || '',
    notes: companyData.notes || '',
    captcha: companyData.captcha || '',
    progress: companyData.progress || '',
  };

  Object.entries(values).forEach(([field, value]) => {
    row[columnMapping[field]] = value === undefined || value === null ? '' : value;
  });

  return row;
}

function saveRows(workbookData, rows) {
  const workbook = workbookData.workbook || XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  workbook.Sheets[workbookData.sheetName] = worksheet;
  if (!workbook.SheetNames.includes(workbookData.sheetName)) {
    workbook.SheetNames.push(workbookData.sheetName);
  }
  writeWorkbookBundle({
    workbook,
    targetPath: workbookData.targetPath,
    fileType: workbookData.fileType,
  });
}

function ensureEditableTargetList() {
  const targetList = settings.getSection('targetList');
  let targetPath = settings.getTargetListPath();
  let fileType = getFileTypeFromPath(targetPath, targetList.fileType || 'csv');

  if (!targetPath) {
    targetPath = DEFAULT_TARGET_FILE;
    fileType = 'csv';
    settings.updateSection('targetList', {
      filePath: toRelativeProjectPath(targetPath),
      fileType,
      sheetIndex: 0,
      columnMapping: getColumnMapping(),
    });
  }

  return readWorkbookBundle(targetPath, { createIfMissing: true, fileType });
}

function appendCompany(companyData) {
  const companyName = normalizeValue(companyData.companyName);
  if (!companyName) {
    return { ok: false, error: 'companyName is required.' };
  }

  const workbookData = ensureEditableTargetList();
  if (!workbookData.ok) return workbookData;

  const dataRows = workbookData.rows.slice(1);
  const existingCompanies = dataRows.map((row, index) => mapRow(row, workbookData.columnMapping, index + 1));
  const nextNo = normalizeCompanyNo(companyData.no) || getNextCompanyNo(existingCompanies);
  const row = buildCompanyRow({
    ...companyData,
    no: nextNo,
  }, workbookData.columnMapping, workbookData.headers.length);

  workbookData.rows.push(row);
  saveRows(workbookData, workbookData.rows);

  return {
    ok: true,
    company: mapRow(row, workbookData.columnMapping, workbookData.rows.length - 1),
    targetPath: workbookData.targetPath,
  };
}

function updateCompany(companyNo, patch) {
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) return workbookData;

  const wanted = String(normalizeCompanyNo(companyNo));
  const rowIndex = workbookData.rows.findIndex((row, index) => {
    if (index === 0) return false;
    return String(mapRow(row, workbookData.columnMapping, index).no) === wanted;
  });

  if (rowIndex === -1) {
    return { ok: false, error: `Company not found: ${companyNo}` };
  }

  const current = mapRow(workbookData.rows[rowIndex], workbookData.columnMapping, rowIndex);
  const nextCompany = { ...current, ...patch, no: current.no };
  const nextRow = buildCompanyRow(nextCompany, workbookData.columnMapping, workbookData.rows[rowIndex].length);
  workbookData.rows[rowIndex] = nextRow;
  saveRows(workbookData, workbookData.rows);

  return {
    ok: true,
    company: mapRow(nextRow, workbookData.columnMapping, rowIndex),
    targetPath: workbookData.targetPath,
  };
}

function importTargetList({ fileName, buffer }) {
  const safeName = sanitizeImportFileName(fileName);
  const ext = path.extname(safeName).toLowerCase();
  if (!['.xlsx', '.csv'].includes(ext)) {
    return { ok: false, error: 'Only .xlsx and .csv files are supported.' };
  }

  ensureDirectory(IMPORT_DIR);
  const storedPath = path.join(IMPORT_DIR, `${Date.now()}-${safeName}`);
  fs.writeFileSync(storedPath, buffer);

  const fileType = ext === '.csv' ? 'csv' : 'xlsx';
  const imported = readWorkbookBundle(storedPath, {
    fileType,
    sheetIndex: 0,
    columnMapping: getColumnMapping(),
  });
  if (!imported.ok) return imported;

  const detectedMapping = detectColumnMapping(imported.headers);
  const nextMapping = {
    ...getColumnMapping(),
    ...detectedMapping,
  };

  settings.updateSection('targetList', {
    filePath: toRelativeProjectPath(storedPath),
    fileType,
    sheetIndex: 0,
    columnMapping: nextMapping,
  });

  const data = readTargetList();
  return {
    ok: !!data.ok,
    filePath: toRelativeProjectPath(storedPath),
    targetPath: storedPath,
    fileType,
    detectedMapping: nextMapping,
    headers: imported.headers,
    companyCount: data.ok ? data.companies.length : 0,
    error: data.ok ? null : data.error,
  };
}

module.exports = {
  TARGET_FIELDS,
  appendCompany,
  detectColumnMapping,
  findCompaniesByNos,
  findCompanyByNo,
  getColumnMapping,
  getTargetPreview,
  importTargetList,
  normalizeCompanyNo,
  readTargetList,
  toRelativeProjectPath,
  updateCompany,
};
