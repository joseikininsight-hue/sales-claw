'use strict';

const fs = require('fs');
const XLSX = require('xlsx');
const settings = require('./settings-manager.cjs');

const TARGET_FIELDS = ['no', 'status', 'companyName', 'type', 'url', 'formUrl', 'notes', 'captcha', 'progress'];

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
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

function mapRow(row, columnMapping) {
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
    raw: row,
  };
}

function readTargetList() {
  const targetPath = settings.getTargetListPath();
  if (!targetPath) {
    return { ok: false, error: 'Target list file is not configured.' };
  }
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: `Target list file not found: ${targetPath}`, targetPath };
  }

  try {
    const workbook = XLSX.readFile(targetPath, { raw: false, defval: '' });
    const targetList = settings.getSection('targetList');
    const sheetNames = workbook.SheetNames || [];
    const sheetName = sheetNames[targetList.sheetIndex || 0] || sheetNames[0];
    if (!sheetName) {
      return { ok: false, error: 'Target list workbook does not contain any sheets.', targetPath };
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const headers = rows[0] || [];
    const dataRows = rows.slice(1);
    const columnMapping = getColumnMapping();
    const companies = dataRows
      .map((row) => mapRow(row, columnMapping))
      .filter((row) => row.no !== null || row.companyName || row.url || row.formUrl);

    return {
      ok: true,
      columnMapping,
      companies,
      headers,
      rows: dataRows,
      sheetName,
      targetPath,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      targetPath,
    };
  }
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

module.exports = {
  TARGET_FIELDS,
  findCompanyByNo,
  getColumnMapping,
  getTargetPreview,
  readTargetList,
};
