// フォーム送信を実行するワーカー
// ダッシュボードから指示を受けて、フォーム入力→送信→完了確認まで自動実行

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const settings = require('./settings-manager.cjs');
const config = require('./config.cjs');
const { logAction, getAllLogs } = require('./action-logger.cjs');
const { clickCheckbox } = require('./form-helpers.cjs');
const { recordContact, getHistory } = require('./contact-history.cjs');
const { findCompanyByNo } = require('./target-list.cjs');

const QUEUE_FILE = path.join(__dirname, '../data', 'ai-submit-queue.json');

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')); } catch { return []; }
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

function updateStatus(companyNo, status, detail) {
  const queue = loadQueue();
  const item = queue.find(q => q.companyNo === companyNo && q.status !== 'completed' && q.status !== 'user_required');
  if (item) {
    item.status = status;
    item.detail = detail || '';
    item.updatedAt = new Date().toISOString();
  }
  saveQueue(queue);
}

/**
 * 1社のフォーム送信を実行する
 */
async function submitOne(entry) {
  const { companyNo, companyName } = entry;
  const s = config.sender;
  const prefs = settings.getSection('preferences');
  const maxRetries = prefs.maxRetries || 3;

  // メッセージを取得（action-logから）
  const allLogs = getAllLogs();
  const draft = allLogs.filter(l => l.companyNo === companyNo && l.action === 'message_draft').pop();
  const message = draft ? draft.details : '';
  if (!message) {
    updateStatus(companyNo, 'user_required', 'メッセージが見つかりません');
    logAction(companyNo, companyName, 'error', '送信失敗: メッセージなし');
    return false;
  }

  // フォームURLを取得（Excelから）
  const targetLookup = findCompanyByNo(companyNo);
  if (!targetLookup.ok) {
    updateStatus(companyNo, 'user_required', 'ターゲットリストが設定されていません');
    logAction(companyNo, companyName, 'error', `送信失敗: ${targetLookup.error}`);
    return false;
  }

  const formUrl = targetLookup.company ? targetLookup.company.formUrl : null;
  if (!formUrl) {
    updateStatus(companyNo, 'user_required', 'フォームURLが見つかりません');
    logAction(companyNo, companyName, 'error', '送信失敗: フォームURLなし');
    return false;
  }

  console.log(`[${companyName}] 送信開始 → ${formUrl}`);
  updateStatus(companyNo, 'processing', 'ブラウザ起動中...');

  const browser = await chromium.launch({ headless: prefs.headless !== false });
  const page = await browser.newPage({
    userAgent: prefs.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: prefs.locale || 'ja-JP',
  });

  const screenshotDir = settings.getScreenshotDir();
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${companyName}] 試行 ${attempt}/${maxRetries}...`);
      updateStatus(companyNo, 'processing', `試行 ${attempt}/${maxRetries}: フォームにアクセス中...`);

      await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: prefs.pageTimeout || 20000 });
      await page.waitForTimeout(3000);

      // iframe検出
      let formPage = page;
      const iframes = await page.$$('iframe');
      for (const iframe of iframes) {
        const src = await iframe.evaluate(el => el.src);
        if (src && (src.includes('form') || src.includes('contact') || src.includes('inquiry'))) {
          const frame = await iframe.contentFrame();
          if (frame) { formPage = frame; break; }
        }
      }

      updateStatus(companyNo, 'processing', `試行 ${attempt}/${maxRetries}: フォーム入力中...`);

      // フォームフィールド検出＆入力
      const formInfo = await formPage.evaluate(() => {
        const forms = document.querySelectorAll('form');
        const result = [];
        forms.forEach(form => {
          const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
            tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
            id: el.id || '', placeholder: el.placeholder || '',
            nearby: (el.closest('tr, label, div, dl, dt, dd, .form-group') || {}).textContent?.trim().substring(0, 60) || '',
          }));
          result.push({ fieldCount: fields.length, fields });
        });
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => ({
          text: (b.value || b.textContent || '').trim(), type: b.type, name: b.name || '',
        }));
        return { forms: result, buttons };
      });

      if (formInfo.forms.length === 0) throw new Error('フォームが見つかりません');

      const form = formInfo.forms[0];
      let filledCount = 0;

      for (const field of form.fields) {
        if (field.type === 'hidden') continue;
        const key = (field.name + ' ' + field.id + ' ' + field.placeholder + ' ' + field.nearby).toLowerCase();
        const ph = (field.placeholder || '').toLowerCase();
        const sel = field.name
          ? (field.tag === 'textarea' ? `textarea[name="${field.name}"]` : field.tag === 'select' ? `select[name="${field.name}"]` : `input[name="${field.name}"]`)
          : (field.id ? `#${field.id}` : '');
        if (!sel) continue;

        try {
          if (field.type === 'checkbox') {
            if (key.match(/同意|agree|privacy|個人情報|プライバシー|acceptance|consent|policy/)) {
              await clickCheckbox(formPage, field);
              filledCount++;
            }
            continue;
          }
          if (field.type === 'radio') continue;
          if (field.tag === 'textarea') { await formPage.fill(sel, message); filledCount++; continue; }
          if (field.type === 'email') { await formPage.fill(sel, s.email); filledCount++; continue; }
          if (field.type === 'tel') { await formPage.fill(sel, s.phone); filledCount++; continue; }
          if (field.type === 'url') { await formPage.fill(sel, s.website); filledCount++; continue; }

          if (ph.match(/やまだ|ヤマダ|かな|kana/) || key.match(/ふりがな|フリガナ|kana|ruby|カナ/)) {
            await formPage.fill(sel, s.nameKana); filledCount++;
          } else if (ph.match(/山田|太郎/) && !key.includes('会社')) {
            await formPage.fill(sel, s.name); filledCount++;
          } else if (key.match(/部署|department|部門|所属/)) {
            await formPage.fill(sel, s.department || ''); filledCount++;
          } else if (key.match(/会社|organization|company|法人|貴社/) && !key.includes('名前')) {
            await formPage.fill(sel, s.companyName); filledCount++;
          } else if (key.match(/名前|氏名|name|担当/) && !key.match(/会社|ふりがな|フリガナ|kana/)) {
            await formPage.fill(sel, s.name); filledCount++;
          } else if (key.match(/メール|mail|email/) && !key.includes('fax')) {
            await formPage.fill(sel, s.email); filledCount++;
          } else if (key.match(/電話|tel|phone/) && !key.includes('fax')) {
            await formPage.fill(sel, s.phone); filledCount++;
          } else if (key.match(/住所|address|所在地/)) {
            await formPage.fill(sel, s.address); filledCount++;
          }
        } catch (e) { /* skip */ }
      }

      if (filledCount < 2) throw new Error(`入力数が少ない（${filledCount}フィールド）。フォーム構造が想定外`);

      // 送信ボタンを探して押す
      updateStatus(companyNo, 'processing', `試行 ${attempt}/${maxRetries}: 送信中...`);

      for (const btn of formInfo.buttons) {
        if (btn.text.includes('確認') || btn.text.includes('次へ') || btn.text.includes('入力内容')) {
          try {
            const btnSel = btn.name ? `[name="${btn.name}"]` : 'input[type="submit"], button[type="submit"]';
            await formPage.click(btnSel, { timeout: 5000 });
            await page.waitForTimeout(3000);
            break;
          } catch (e) { /* skip */ }
        }
      }

      const allSubmits = await formPage.$$('input[type="submit"], button[type="submit"]');
      let submitted = false;
      for (const btn of allSubmits) {
        const val = await btn.evaluate(el => (el.value || el.textContent || '').trim());
        if (val.includes('送信') || val.includes('submit') || val.includes('Submit') || val.includes('送る')) {
          await btn.click();
          submitted = true;
          break;
        }
      }
      if (!submitted && allSubmits.length > 0) {
        await allSubmits[allSubmits.length - 1].click();
        submitted = true;
      }

      if (!submitted) throw new Error('送信ボタンが見つかりません');

      await page.waitForTimeout(5000);

      await page.screenshot({ path: path.join(screenshotDir, `ss-${companyNo}-sent.png`), fullPage: true });

      const resultText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      const isSuccess = resultText.includes('ありがとう') || resultText.includes('完了') ||
                        resultText.includes('送信しました') || resultText.includes('受け付け') ||
                        resultText.includes('thank') || resultText.includes('Thank');

      if (isSuccess) {
        console.log(`[${companyName}] ✓ 送信完了`);
        updateStatus(companyNo, 'completed', '送信完了');
        logAction(companyNo, companyName, 'submitted', '自動送信完了');

        const existingHistory = getHistory(companyNo);
        const alreadyRecorded = existingHistory && existingHistory.contacts.length > 0 &&
          existingHistory.contacts.some(c => c.message === message);
        if (!alreadyRecorded) {
          recordContact(companyNo, companyName, { message, method: 'web_form', notes: '自動送信' });
        }

        await browser.close();
        return true;
      }

      console.log(`[${companyName}] ? 送信後ページが完了画面か不明`);
      updateStatus(companyNo, 'completed', '送信実行済み（完了画面の確認推奨）');
      logAction(companyNo, companyName, 'submitted', '送信実行済み（完了画面不明）');

      const existingHistory2 = getHistory(companyNo);
      const alreadyRecorded2 = existingHistory2 && existingHistory2.contacts.length > 0 &&
        existingHistory2.contacts.some(c => c.message === message);
      if (!alreadyRecorded2) {
        recordContact(companyNo, companyName, { message, method: 'web_form', notes: '送信（完了確認推奨）' });
      }

      await browser.close();
      return true;

    } catch (e) {
      lastError = e.message;
      console.log(`[${companyName}] ✗ 試行${attempt}失敗: ${e.message.substring(0, 80)}`);
      updateStatus(companyNo, 'processing', `試行 ${attempt}/${maxRetries} 失敗: ${e.message.substring(0, 40)}`);
      await page.screenshot({ path: path.join(screenshotDir, `ss-${companyNo}-error.png`), fullPage: true }).catch(() => {});

      if (attempt < maxRetries) {
        await page.waitForTimeout(2000);
      }
    }
  }

  console.log(`[${companyName}] ✗ ${maxRetries}回失敗 → ユーザーに手動対応を依頼`);
  updateStatus(companyNo, 'user_required', `${maxRetries}回失敗: ${lastError.substring(0, 60)}`);
  logAction(companyNo, companyName, 'error', `送信${maxRetries}回失敗。手動対応が必要: ${lastError.substring(0, 80)}`);
  await browser.close();
  return false;
}

// メイン: キューからpending項目を処理
async function main() {
  const queue = loadQueue();
  const pending = queue.filter(q => q.status === 'pending');

  if (pending.length === 0) {
    console.log('送信待ちはありません');
    return;
  }

  console.log(`=== 自動送信実行: ${pending.length}社 ===\n`);

  for (const entry of pending) {
    await submitOne(entry);
  }

  console.log('\n=== 完了 ===');
  const finalQueue = loadQueue();
  finalQueue.filter(q => q.companyNo && q.status).forEach(q => {
    const icon = q.status === 'completed' ? '✓' : q.status === 'user_required' ? '!' : '?';
    console.log(`  ${icon} No.${q.companyNo} ${q.companyName}: ${q.status} — ${q.detail || ''}`);
  });
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { submitOne };
