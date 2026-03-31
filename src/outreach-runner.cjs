'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config.cjs');
const settings = require('./settings-manager.cjs');
const { logAction } = require('./action-logger.cjs');
const cliLogger = require('./cli-logger.cjs');
const { analyzeCompany } = require('./company-analyzer.cjs');
const { findContactForm } = require('./form-finder.cjs');
const { validateFormPage } = require('./form-validator.cjs');
const { buildCustomMessage, buildMessage } = require('./message-builder.cjs');
const { clickCheckbox } = require('./form-helpers.cjs');
const { findCompanyByNo, updateCompany } = require('./target-list.cjs');
const { loadQueue, updateQueueStatus, RUNNER_LOCK_FILE } = require('./outreach-queue.cjs');

function escapeAttributeValue(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function escapeCssIdentifier(value) {
  return String(value || '').replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function buildFieldSelector(field) {
  if (field.name) {
    if (field.tag === 'textarea') return `textarea[name="${escapeAttributeValue(field.name)}"]`;
    if (field.tag === 'select') return `select[name="${escapeAttributeValue(field.name)}"]`;
    return `input[name="${escapeAttributeValue(field.name)}"]`;
  }
  if (field.id) return `#${escapeCssIdentifier(field.id)}`;
  return '';
}

function selectBestForm(forms) {
  return (forms || [])
    .slice()
    .sort((a, b) => (b.fieldCount || 0) - (a.fieldCount || 0))[0] || null;
}

function buildFieldKey(field) {
  return [field.name, field.id, field.placeholder, field.nearby].join(' ').toLowerCase();
}

async function detectCaptcha(page) {
  return page.evaluate(() => {
    return !!(
      document.querySelector('.g-recaptcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [id*="captcha"], [class*="captcha"]')
    );
  });
}

async function getFormContext(page) {
  let formPage = page;
  const iframes = await page.$$('iframe');
  for (const iframe of iframes) {
    try {
      const src = await iframe.evaluate((el) => el.src || '');
      if (src && (src.includes('form') || src.includes('contact') || src.includes('inquiry'))) {
        const frame = await iframe.contentFrame();
        if (frame) {
          formPage = frame;
          break;
        }
      }
    } catch (_) {}
  }

  const formInfo = await formPage.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form')).map((form) => {
      const fields = Array.from(form.querySelectorAll('input, textarea, select')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: (el.type || '').toLowerCase(),
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        nearby: (el.closest('tr, label, div, dl, dt, dd, .form-group, .field, .form-item') || {}).textContent?.trim().substring(0, 80) || '',
        options: el.tagName === 'SELECT'
          ? Array.from(el.options).slice(0, 30).map((option) => ({
              value: option.value,
              text: (option.textContent || '').trim(),
            }))
          : [],
      }));
      return { fieldCount: fields.length, fields };
    });

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((el) => ({
      text: (el.value || el.textContent || '').trim(),
      type: (el.type || '').toLowerCase(),
    }));

    return { forms, buttons };
  });

  return { formPage, formInfo };
}

function pickSelectOption(field, inquiryTypes) {
  const fieldKey = buildFieldKey(field);
  const options = field.options || [];

  if (fieldKey.match(/問い合わせ|種別|subject|category|inquiry|お問い合わせ/)) {
    for (const inquiryType of inquiryTypes || []) {
      const matched = options.find((option) => {
        const text = `${option.text} ${option.value}`.toLowerCase();
        return inquiryType && text.includes(String(inquiryType).toLowerCase());
      });
      if (matched) return matched.value;
    }
  }

  const generic = options.find((option) => {
    const text = `${option.text} ${option.value}`.toLowerCase();
    return text.includes('その他') || text.includes('一般') || text.includes('お問い合わせ') || text.includes('other');
  });
  if (generic) return generic.value;

  const fallback = options.find((option) => option.value !== '');
  return fallback ? fallback.value : null;
}

async function fillFormFields(formPage, fields, sender, message) {
  const inquiryTypes = config.inquiryTypes || [];
  let filledCount = 0;

  for (const field of fields || []) {
    if (field.type === 'hidden') continue;

    const selector = buildFieldSelector(field);
    if (!selector) continue;

    const fieldKey = buildFieldKey(field);
    const placeholder = (field.placeholder || '').toLowerCase();

    try {
      if (field.type === 'checkbox') {
        if (fieldKey.match(/同意|agree|privacy|個人情報|プライバシー|acceptance|consent|policy/)) {
          await clickCheckbox(formPage, field);
          filledCount += 1;
        }
        continue;
      }

      if (field.type === 'radio') continue;

      if (field.tag === 'select') {
        const value = pickSelectOption(field, inquiryTypes);
        if (value !== null && value !== undefined) {
          await formPage.selectOption(selector, value);
          filledCount += 1;
        }
        continue;
      }

      if (field.tag === 'textarea') {
        await formPage.fill(selector, message);
        filledCount += 1;
        continue;
      }

      if (field.type === 'email') {
        await formPage.fill(selector, sender.email || '');
        filledCount += 1;
        continue;
      }

      if (field.type === 'tel') {
        await formPage.fill(selector, sender.phone || '');
        filledCount += 1;
        continue;
      }

      if (field.type === 'url') {
        await formPage.fill(selector, sender.website || '');
        filledCount += 1;
        continue;
      }

      if (placeholder.match(/やまだ|ヤマダ|かな|kana/) || fieldKey.match(/ふりがな|フリガナ|kana|ruby|カナ/)) {
        await formPage.fill(selector, sender.nameKana || sender.name || '');
        filledCount += 1;
      } else if (fieldKey.match(/部署|department|部門|所属/)) {
        await formPage.fill(selector, sender.department || '');
        filledCount += 1;
      } else if (fieldKey.match(/役職|title|position/)) {
        await formPage.fill(selector, sender.title || '');
        filledCount += 1;
      } else if (fieldKey.match(/郵便|postal|zip/)) {
        await formPage.fill(selector, sender.postalCode || '');
        filledCount += 1;
      } else if (fieldKey.match(/住所|address|所在地/)) {
        await formPage.fill(selector, sender.address || '');
        filledCount += 1;
      } else if (fieldKey.match(/会社|organization|company|法人|貴社/) && !fieldKey.includes('名前')) {
        await formPage.fill(selector, sender.companyName || '');
        filledCount += 1;
      } else if (fieldKey.match(/名前|氏名|name|担当/) && !fieldKey.match(/会社|ふりがな|フリガナ|kana/)) {
        await formPage.fill(selector, sender.name || '');
        filledCount += 1;
      } else if (fieldKey.match(/メール|mail|email/) && !fieldKey.includes('fax')) {
        await formPage.fill(selector, sender.email || '');
        filledCount += 1;
      } else if (fieldKey.match(/電話|tel|phone/) && !fieldKey.includes('fax')) {
        await formPage.fill(selector, sender.phone || '');
        filledCount += 1;
      } else if (fieldKey.match(/fax/)) {
        await formPage.fill(selector, sender.fax || '');
        filledCount += 1;
      }
    } catch (_) {}
  }

  return filledCount;
}

async function clickConfirmIfPresent(formPage) {
  const buttons = await formPage.$$('button, input[type="submit"], input[type="button"]');
  for (const button of buttons) {
    try {
      const text = await button.evaluate((el) => (el.value || el.textContent || '').trim().toLowerCase());
      if (!text) continue;
      const isConfirm = text.includes('確認') || text.includes('次へ') || text.includes('入力内容') || text.includes('review') || text.includes('confirm');
      const isSubmit = text.includes('送信') || text.includes('submit') || text.includes('申し込');
      if (isConfirm && !isSubmit) {
        await button.click({ timeout: 5000 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function prepareFormForApproval(company, formUrl, message) {
  const sender = config.sender;
  const prefs = settings.getSection('preferences');
  const screenshotDir = settings.getScreenshotDir();
  ensureDirectory(screenshotDir);

  const inputScreenshot = path.join(screenshotDir, `ss-${company.no}-input.png`);
  const confirmScreenshot = path.join(screenshotDir, `ss-${company.no}-confirm.png`);
  const errorScreenshot = path.join(screenshotDir, `ss-${company.no}-error.png`);

  const browser = await chromium.launch({ headless: prefs.headless !== false });
  const page = await browser.newPage({
    userAgent: prefs.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: prefs.locale || 'ja-JP',
  });

  try {
    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: prefs.pageTimeout || 20000 });
    await page.waitForTimeout(2500);

    if (await detectCaptcha(page)) {
      throw new Error('CAPTCHA detected');
    }

    const { formPage, formInfo } = await getFormContext(page);
    const form = selectBestForm(formInfo.forms);
    if (!form) throw new Error('フォームが見つかりません');

    const filledCount = await fillFormFields(formPage, form.fields, sender, message);
    if (filledCount < 3) {
      throw new Error(`入力数が少なすぎます (${filledCount})`);
    }

    await page.screenshot({ path: inputScreenshot, fullPage: true });
    logAction(company.no, company.name, 'form_fill', `入力完了 (${filledCount} fields)`);

    const movedToConfirm = await clickConfirmIfPresent(formPage);
    if (movedToConfirm) {
      await page.waitForTimeout(3000);
      await page.screenshot({ path: confirmScreenshot, fullPage: true });
      logAction(company.no, company.name, 'confirm_reached', '確認画面へ移動');
      logAction(company.no, company.name, 'awaiting_approval', 'ダッシュボードで確認待ち');
      await browser.close();
      return { ok: true, detail: '確認待ちに追加しました' };
    }

    fs.copyFileSync(inputScreenshot, confirmScreenshot);
    logAction(company.no, company.name, 'confirm_reached', '確認画面なし。入力画面を確認用に保存');
    logAction(company.no, company.name, 'awaiting_approval', 'ダッシュボードで確認待ち');
    await browser.close();
    return { ok: true, detail: '入力画面を確認待ちに追加しました' };
  } catch (error) {
    await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
    await browser.close();
    return { ok: false, error: error.message };
  }
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function acquireLock() {
  ensureDirectory(path.dirname(RUNNER_LOCK_FILE));
  try {
    const handle = fs.openSync(RUNNER_LOCK_FILE, 'wx');
    fs.writeFileSync(handle, String(process.pid), 'utf8');
    return handle;
  } catch {
    try {
      const existingPid = Number(fs.readFileSync(RUNNER_LOCK_FILE, 'utf8'));
      if (Number.isFinite(existingPid)) {
        try {
          process.kill(existingPid, 0);
          return null;
        } catch (_) {
          fs.unlinkSync(RUNNER_LOCK_FILE);
        }
      }
      const handle = fs.openSync(RUNNER_LOCK_FILE, 'wx');
      fs.writeFileSync(handle, String(process.pid), 'utf8');
      return handle;
    } catch {
      return null;
    }
  }
}

function releaseLock(handle) {
  try {
    if (handle !== null) fs.closeSync(handle);
  } catch (_) {}
  try {
    if (fs.existsSync(RUNNER_LOCK_FILE)) fs.unlinkSync(RUNNER_LOCK_FILE);
  } catch (_) {}
}

async function processEntry(entry) {
  const lookup = findCompanyByNo(entry.companyNo);
  if (!lookup.ok || !lookup.company) {
    updateQueueStatus(entry.companyNo, 'error', lookup.error || 'Company not found');
    return;
  }

  const company = {
    no: lookup.company.no,
    name: lookup.company.companyName,
    type: lookup.company.type,
    url: lookup.company.url,
    formUrl: lookup.company.formUrl,
  };

  updateQueueStatus(company.no, 'processing', '企業情報を確認中');
  cliLogger.log(`[No.${company.no}] ${company.name}: 営業準備を開始`, 'step');

  try {
    let analysis = null;
    if (company.url) {
      updateQueueStatus(company.no, 'processing', '企業サイトを分析中');
      analysis = await analyzeCompany(company.url, company.name, company.type);
      logAction(company.no, company.name, 'site_analysis', JSON.stringify(analysis));
    }

    const message = analysis ? buildCustomMessage(analysis) : buildMessage(company.name, company.type);
    logAction(company.no, company.name, 'message_draft', message);

    let formUrl = company.formUrl;
    if (!formUrl && company.url) {
      updateQueueStatus(company.no, 'processing', 'フォームURLを探索中');
      const found = await findContactForm(company.url);
      if (!found.found || !found.formUrl) {
        throw new Error(found.reason || 'フォームURLが見つかりません');
      }
      formUrl = found.formUrl;
      updateCompany(company.no, { formUrl });
      cliLogger.log(`[No.${company.no}] ${company.name}: フォームURLを更新 ${formUrl}`, 'info');
    }

    if (!formUrl) {
      throw new Error('フォームURLが見つかりません');
    }

    updateQueueStatus(company.no, 'processing', 'フォームを検証中');
    let validation = await validateFormPage(formUrl);
    logAction(company.no, company.name, 'form_analysis', JSON.stringify(validation));

    if (!validation.valid && validation.actualFormUrl && validation.actualFormUrl !== formUrl) {
      formUrl = validation.actualFormUrl;
      updateCompany(company.no, { formUrl });
      validation = await validateFormPage(formUrl);
      logAction(company.no, company.name, 'form_analysis', JSON.stringify(validation));
    }

    if (!validation.valid) {
      throw new Error(validation.reason || 'フォーム検証に失敗しました');
    }

    const prepared = await prepareFormForApproval(company, formUrl, message);
    if (!prepared.ok) {
      throw new Error(prepared.error || 'フォーム入力に失敗しました');
    }

    updateQueueStatus(company.no, 'awaiting_approval', prepared.detail);
    cliLogger.log(`[No.${company.no}] ${company.name}: ${prepared.detail}`, 'action');
  } catch (error) {
    updateQueueStatus(company.no, 'error', error.message);
    logAction(company.no, company.name, 'error', error.message);
    cliLogger.log(`[No.${company.no}] ${company.name}: ${error.message}`, 'error');
  }
}

async function main() {
  const lockHandle = acquireLock();
  if (lockHandle === null) return;

  try {
    while (true) {
      const pending = loadQueue().filter((entry) => entry.status === 'pending');
      if (pending.length === 0) break;

      for (const entry of pending) {
        await processEntry(entry);
      }
    }
  } finally {
    releaseLock(lockHandle);
  }
}

if (require.main === module) {
  main().catch((error) => {
    cliLogger.log(`Outreach runner failed: ${error.message}`, 'error');
    process.exitCode = 1;
  });
}

module.exports = { main, prepareFormForApproval };
