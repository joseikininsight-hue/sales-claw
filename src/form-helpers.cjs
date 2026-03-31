// フォーム操作ヘルパー関数（共通）

/**
 * チェックボックスを確実にクリックする（複数パターン対応）
 * パターン1: 通常の visible checkbox → click
 * パターン2: CSS非表示（カスタムUI）→ label をクリック
 * パターン3: wpcf7-acceptance 等 → 親label/spanをクリック
 * パターン4: どれも失敗 → JS で直接 checked = true
 */
async function clickCheckbox(formPage, field) {
  const sel = field.name ? `input[name="${field.name}"]` : `#${field.id}`;

  // パターン1: 直接クリック
  try {
    await formPage.click(sel, { timeout: 2000 });
    return true;
  } catch (e) {}

  // パターン2: 親の label 要素をクリック
  try {
    const clicked = await formPage.evaluate((selector) => {
      const cb = document.querySelector(selector);
      if (!cb) return false;
      const label = cb.closest('label');
      if (label) { label.click(); return true; }
      return false;
    }, sel);
    if (clicked) return true;
  } catch (e) {}

  // パターン3: 隣接する label や span をクリック
  try {
    const clicked = await formPage.evaluate((selector) => {
      const cb = document.querySelector(selector);
      if (!cb) return false;
      const span = cb.parentElement?.querySelector('.wpcf7-list-item-label, .wpcf7-acceptance label, span');
      if (span) { span.click(); return cb.checked; }
      const next = cb.nextElementSibling;
      if (next && (next.tagName === 'LABEL' || next.tagName === 'SPAN')) { next.click(); return cb.checked; }
      return false;
    }, sel);
    if (clicked) return true;
  } catch (e) {}

  // パターン4: JS で直接チェック（最終手段）
  try {
    await formPage.evaluate((selector) => {
      const cb = document.querySelector(selector);
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
      }
    }, sel);
    const isChecked = await formPage.evaluate((selector) => {
      const cb = document.querySelector(selector);
      return cb ? cb.checked : false;
    }, sel);
    return isChecked;
  } catch (e) {}

  return false;
}

module.exports = { clickCheckbox };
