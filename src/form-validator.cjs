// フォームページの事前検証
// 問い合わせフォームとして有効かどうかを判定し、無効なら理由を返す
// 使い方: const result = await validateFormPage(url);

const { chromium } = require('playwright');

/**
 * URLにアクセスして問い合わせフォームとして有効かを判定する
 * @param {string} url - 問い合わせフォームURL
 * @returns {Object} { valid, reason, formType, actualFormUrl, fields }
 */
async function validateFormPage(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'ja-JP',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // --- 判定1: メインページのフォーム ---
    const mainFormInfo = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      const validForms = [];

      forms.forEach(form => {
        const inputs = form.querySelectorAll('input, textarea, select');
        const textInputs = Array.from(inputs).filter(el => {
          const t = el.type || '';
          return ['text', 'email', 'tel', 'url', ''].includes(t) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
        });
        const isSearchForm = Array.from(inputs).some(el =>
          (el.name || '').toLowerCase().match(/^(q|query|search|keyword|s)$/) ||
          (el.placeholder || '').includes('検索') ||
          (el.placeholder || '').includes('search')
        );

        if (textInputs.length >= 2 && !isSearchForm) {
          validForms.push({
            action: form.action,
            method: form.method,
            fieldCount: textInputs.length,
            hasTextarea: Array.from(inputs).some(el => el.tagName === 'TEXTAREA'),
            hasEmailField: Array.from(inputs).some(el => el.type === 'email' || (el.name || '').toLowerCase().includes('mail')),
          });
        }
      });

      return validForms;
    });

    if (mainFormInfo.length > 0) {
      const best = mainFormInfo[0];
      await browser.close();
      return {
        valid: true,
        reason: '入力可能なフォームを検出',
        formType: 'self_hosted',
        actualFormUrl: url,
        fieldCount: best.fieldCount,
        hasTextarea: best.hasTextarea,
        hasEmailField: best.hasEmailField,
      };
    }

    // --- 判定2: iframe埋め込みフォーム ---
    const iframeInfo = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      return Array.from(iframes)
        .map(f => ({ src: f.src, width: f.width, height: f.height }))
        .filter(f => f.src && (
          f.src.includes('form') || f.src.includes('contact') ||
          f.src.includes('inquiry') || f.src.includes('hsforms') ||
          f.src.includes('formrun') || f.src.includes('form.run') ||
          f.src.includes('formmailer') || f.src.includes('movabletype')
        ));
    });

    if (iframeInfo.length > 0) {
      // iframe内のフォームを検証
      const iframe = await page.$('iframe[src*="form"], iframe[src*="contact"], iframe[src*="inquiry"], iframe[src*="hsforms"], iframe[src*="formrun"], iframe[src*="form.run"], iframe[src*="movabletype"]');
      if (iframe) {
        const frame = await iframe.contentFrame();
        if (frame) {
          const iframeFormInfo = await frame.evaluate(() => {
            const forms = document.querySelectorAll('form');
            if (forms.length === 0) return null;
            const inputs = forms[0].querySelectorAll('input, textarea, select');
            const textInputs = Array.from(inputs).filter(el => {
              const t = el.type || '';
              return ['text', 'email', 'tel', 'url', ''].includes(t) || el.tagName === 'TEXTAREA';
            });
            return { fieldCount: textInputs.length, hasTextarea: Array.from(inputs).some(el => el.tagName === 'TEXTAREA') };
          });

          if (iframeFormInfo && iframeFormInfo.fieldCount >= 2) {
            await browser.close();
            return {
              valid: true,
              reason: 'iframe埋め込みフォームを検出（' + iframeInfo[0].src.substring(0, 60) + '）',
              formType: 'iframe_embedded',
              actualFormUrl: url,
              fieldCount: iframeFormInfo.fieldCount,
              hasTextarea: iframeFormInfo.hasTextarea,
            };
          }
        }
      }
    }

    // --- 判定3: メールアドレスのみ / 振り分けページ ---
    const pageAnalysis = await page.evaluate(() => {
      const text = document.body.innerText;
      const html = document.body.innerHTML;

      // mailto: リンクの検出
      const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
        .map(a => a.href.replace('mailto:', ''));

      // 電話番号パターン
      const phonePattern = text.match(/\d{2,4}-\d{2,4}-\d{3,4}/g) || [];

      // フォームへのリンクを検出（振り分けページ対応）
      const formLinks = Array.from(document.querySelectorAll('a'))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim() }))
        .filter(l => {
          const t = (l.text + ' ' + l.href).toLowerCase();
          return (t.includes('問い合わせ') || t.includes('お問合') || t.includes('フォーム') ||
                  t.includes('contact') || t.includes('inquiry') || t.includes('form')) &&
                 l.href.startsWith('http') && l.text.length > 0 && l.text.length < 40 &&
                 l.href !== location.href;
        });

      // 「営業お断り」チェック
      const rejectSales = text.includes('営業のメールはこちらでは承ることはできません') ||
                          text.includes('営業目的のお問い合わせはご遠慮') ||
                          text.includes('セールス・勧誘はお断り') ||
                          text.includes('営業・売り込みはご遠慮');

      return { mailtoLinks, phoneCount: phonePattern.length, formLinks, rejectSales, textLength: text.length };
    });

    // 営業お断り
    if (pageAnalysis.rejectSales) {
      await browser.close();
      return {
        valid: false,
        reason: '営業お断りの記載あり',
        formType: 'rejected',
        actualFormUrl: null,
      };
    }

    // 振り分けページ → フォームへのリンクがある
    if (pageAnalysis.formLinks.length > 0) {
      // 「その他」「一般」「パートナー」「協業」リンクを優先
      const priorityKeywords = ['その他', '一般', 'パートナー', '協業', '協力', '提携', 'ビジネス'];
      let bestLink = pageAnalysis.formLinks[0];
      for (const link of pageAnalysis.formLinks) {
        if (priorityKeywords.some(k => link.text.includes(k))) {
          bestLink = link;
          break;
        }
      }

      await browser.close();
      return {
        valid: false,
        reason: '振り分けページ。フォームへのリンクあり',
        formType: 'redirect_page',
        actualFormUrl: bestLink.href,
        suggestedLinks: pageAnalysis.formLinks.slice(0, 5),
      };
    }

    // メールアドレスのみ
    if (pageAnalysis.mailtoLinks.length > 0) {
      await browser.close();
      return {
        valid: false,
        reason: 'メールアドレスのみ（Webフォームなし）',
        formType: 'email_only',
        emails: pageAnalysis.mailtoLinks,
        actualFormUrl: null,
      };
    }

    // どれにも該当しない
    await browser.close();
    return {
      valid: false,
      reason: '入力可能なフォームが見つからない',
      formType: 'unknown',
      actualFormUrl: null,
    };

  } catch (e) {
    await browser.close();
    return {
      valid: false,
      reason: 'アクセスエラー: ' + e.message.substring(0, 80),
      formType: 'error',
      actualFormUrl: null,
    };
  }
}

module.exports = { validateFormPage };

// CLI実行
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node form-validator.cjs <url>');
    process.exit(1);
  }
  validateFormPage(url).then(r => console.log(JSON.stringify(r, null, 2)));
}
