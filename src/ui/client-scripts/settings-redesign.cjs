'use strict';

/**
 * 設定タブの新デザイン (写真リファレンスに準拠)。
 *
 * 既存のフォームフィールド ID / 保存ロジックには触れず、DOM 装飾と
 * 補助 UI (ステップインジケータ / 進捗ヘッダ / プレビューパネル / 保存して次へ)
 * だけを差し込む non-invasive アプローチ。
 */

const STYLE = [
  /* ---------- Sidebar ---------- */
  '.settings-sidebar{width:230px;padding:12px 8px;background:var(--bg-card);border-right:1px solid var(--border-subtle)}',
  '.set2-side-title{font-size:.6rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);padding:6px 12px;margin-bottom:4px}',
  '.settings-sidebar-btn{display:flex!important;align-items:flex-start!important;gap:11px;padding:10px 12px!important;border:1px solid transparent;border-radius:var(--radius-md)!important;background:transparent;color:var(--text-1);text-align:left;cursor:pointer;transition:all .15s var(--ease-out-expo);width:100%;margin-bottom:4px;font-weight:600!important;text-transform:none!important;letter-spacing:0!important}',
  '.settings-sidebar-btn:hover{background:var(--bg-hover);border-color:transparent}',
  '.settings-sidebar-btn.active{background:var(--primary-glow);border-color:rgba(37,99,235,.18);color:var(--primary)}',
  '.settings-sidebar-btn.active .set2-side-icon{background:var(--primary);color:#fff}',
  '.set2-side-icon{width:32px;height:32px;border-radius:9px!important;background:var(--bg-raised);color:var(--text-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s}',
  '.set2-side-icon .material-symbols-outlined{font-size:18px}',
  '.set2-side-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
  '.set2-side-name{font-size:.78rem;font-weight:700;color:var(--text-1);line-height:1.2}',
  '.settings-sidebar-btn.active .set2-side-name{color:var(--primary)}',
  '.set2-side-sub{font-size:.66rem;color:var(--text-3);line-height:1.3;font-weight:500}',
  '.settings-sidebar-status{display:none!important}',
  '.settings-sidebar-label{display:none!important}',

  /* ---------- Hide legacy setup guide once redesign loads ---------- */
  '.set2-active .settings-setup-guide{display:none!important}',

  /* ---------- Section header ---------- */
  '.set2-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px 22px 14px;border-bottom:1px solid var(--border-subtle);background:var(--bg-card)}',
  '.set2-header-text h2{font-size:1.32rem;font-weight:800;margin:0 0 4px;color:var(--text-1);letter-spacing:.005em}',
  '.set2-header-text p{font-size:.78rem;color:var(--text-2);margin:0;line-height:1.6}',
  '.set2-progress{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;min-width:200px}',
  '.set2-progress-label{font-size:.74rem;color:var(--text-2);font-weight:600}',
  '.set2-progress-label b{color:var(--primary);font-weight:800}',
  '.set2-progress-track{width:200px;height:6px;background:var(--bg-raised);border-radius:3px!important;overflow:hidden}',
  '.set2-progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--primary) 0%,#60a5fa 100%);width:0;transition:width .3s ease;border-radius:3px!important}',

  /* ---------- Step indicator ---------- */
  '.set2-stepper{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:14px 18px 18px;background:var(--bg-card);position:relative}',
  '.set2-step{display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;padding:0 8px;cursor:pointer;text-align:center}',
  '.set2-step::before,.set2-step::after{content:"";position:absolute;top:14px;height:2px;background:var(--border-default);z-index:0}',
  '.set2-step::before{left:0;right:50%}',
  '.set2-step::after{left:50%;right:0}',
  '.set2-step:first-child::before{display:none}',
  '.set2-step:last-child::after{display:none}',
  '.set2-step.done::before,.set2-step.done::after,.set2-step.active::before{background:var(--primary)}',
  '.set2-step-dot{width:30px;height:30px;border-radius:50%!important;display:flex;align-items:center;justify-content:center;background:var(--bg-card);border:2px solid var(--border-default);color:var(--text-3);position:relative;z-index:1;transition:all .2s var(--ease-out-expo)}',
  '.set2-step-dot .material-symbols-outlined{font-size:15px}',
  '.set2-step.done .set2-step-dot{background:var(--primary);border-color:var(--primary);color:#fff}',
  '.set2-step.active .set2-step-dot{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.15)}',
  '.set2-step-name{font-size:.72rem;font-weight:700;color:var(--text-3);line-height:1.2}',
  '.set2-step.active .set2-step-name,.set2-step.done .set2-step-name{color:var(--text-1)}',
  '.set2-step-sub{font-size:.62rem;color:var(--text-3);line-height:1.3}',

  /* ---------- Section body wrapper ---------- */
  '.set2-section-shell{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px;padding:14px 22px 0}',
  '.set2-section-shell.no-preview{grid-template-columns:minmax(0,1fr)}',
  '.set2-form-wrap{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);padding:16px 18px}',
  '.set2-form-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-subtle)}',
  '.set2-form-title{font-size:.96rem;font-weight:800;color:var(--text-1);margin:0;letter-spacing:.01em}',
  '.set2-form-actions{display:flex;align-items:center;gap:6px}',
  '.set2-form-actions .btn-picker{padding:5px 11px;font-size:.72rem;font-weight:600}',

  /* ---------- Right preview column ---------- */
  '.set2-preview{position:sticky;top:14px;align-self:flex-start;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);padding:14px 16px}',
  '.set2-preview h4{margin:0 0 10px;font-size:.78rem;font-weight:800;color:var(--text-2);letter-spacing:.05em;text-transform:uppercase}',
  '.set2-preview-name{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.92rem;font-weight:800;color:var(--text-1);padding:8px 10px;background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border-subtle);margin-bottom:14px}',
  '.set2-preview-tag{font-size:.6rem;font-weight:700;background:var(--primary-glow);color:var(--primary);padding:2px 7px;border-radius:var(--radius-pill)!important}',
  '.set2-preview-list{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}',
  '.set2-preview-row{display:flex;align-items:center;gap:8px;font-size:.74rem;color:var(--text-1);min-width:0}',
  '.set2-preview-row .material-symbols-outlined{font-size:14px;color:var(--text-3);flex-shrink:0}',
  '.set2-preview-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.set2-preview-row.muted{color:var(--text-3)}',
  '.set2-preview-section{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-default)}',
  '.set2-preview-section-title{font-size:.7rem;font-weight:700;color:var(--text-2);margin-bottom:5px;letter-spacing:.04em}',
  '.set2-preview-desc{font-size:.7rem;color:var(--text-2);line-height:1.55;background:var(--bg-surface);border:1px dashed var(--border-default);border-radius:var(--radius-sm);padding:8px 10px}',
  '.set2-preview-hint{display:flex;align-items:flex-start;gap:6px;margin-top:10px;padding:8px 10px;background:var(--primary-glow);border:1px dashed rgba(37,99,235,.3);border-radius:var(--radius-sm);font-size:.66rem;color:var(--primary);line-height:1.55}',
  '.set2-preview-hint .material-symbols-outlined{font-size:14px;flex-shrink:0;margin-top:1px}',

  /* ---------- Hint card + Save next bar ---------- */
  '.set2-bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 22px 22px;flex-wrap:wrap}',
  '.set2-hint-card{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important;font-size:.74rem;color:var(--text-2);box-shadow:var(--shadow-xs);max-width:380px}',
  '.set2-hint-icon{width:28px;height:28px;border-radius:8px!important;background:var(--info-dim);color:var(--info);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.set2-hint-icon .material-symbols-outlined{font-size:16px}',
  '.set2-hint-body{display:flex;flex-direction:column;gap:2px}',
  '.set2-hint-title{font-size:.74rem;font-weight:700;color:var(--text-1);line-height:1.2}',
  '.set2-hint-link{font-size:.66rem;color:var(--primary);font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:3px;margin-top:1px}',
  '.set2-hint-link:hover{text-decoration:underline}',
  '.set2-save-next{display:inline-flex;align-items:center;gap:7px;padding:11px 24px;font-size:.86rem;font-weight:800;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-md)!important;cursor:pointer;box-shadow:var(--shadow-cta);transition:all .15s var(--ease-out-expo);font-family:var(--font-body)}',
  '.set2-save-next:hover{background:var(--primary-dim);box-shadow:0 6px 20px rgba(37,99,235,.4);transform:translateY(-1px)}',
  '.set2-save-next:disabled{opacity:.55;cursor:not-allowed!important;transform:none!important}',
  '.set2-save-next .material-symbols-outlined{font-size:18px}',

  /* hide legacy save-bar inside redesigned sections (we rebuild in bottom row) */
  '.set2-active .save-bar{display:none!important}',

  '@media (max-width:1100px){.set2-section-shell{grid-template-columns:minmax(0,1fr)}.set2-preview{position:static;order:-1}}',
  '@media (max-width:840px){.set2-stepper{grid-template-columns:repeat(5,minmax(56px,1fr));overflow-x:auto;padding:14px 12px}.set2-step-sub{display:none}.set2-header{flex-direction:column}.set2-progress{align-items:flex-start;width:100%}.set2-progress-track{width:100%}}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__set2Init) return;
  window.__set2Init = true;

  var STYLE_ID = 'set2-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  // Section metadata
  var SECTIONS = [
    { id: 'companyProfile',    icon: 'apartment',     name: '会社プロフィール',     sub: '基本情報や連絡先を設定',         desc: '企業への連絡に使用する自社情報を設定してください。',           stepName: '会社プロフィール',     stepSub: '基本情報を入力',  inStepper: true },
    { id: 'valuePropositions', icon: 'lightbulb',     name: '提供価値',             sub: '自社の強みや提供価値を設定',     desc: '自社の強み・実績・業種別の見せ方を整理してメッセージ品質を上げます。', stepName: '提供価値',             stepSub: '自社の強みを設定', inStepper: true },
    { id: 'targetList',        icon: 'groups',        name: 'ターゲットリスト',     sub: '対象となる企業や条件を設定',     desc: 'アプローチ対象の企業リスト/カラム/ファイル形式を設定します。',         stepName: 'ターゲットリスト',     stepSub: '対象企業を定義',   inStepper: true },
    { id: 'exclusionRules',    icon: 'block',         name: '除外ルール',           sub: '除外する条件やルールを設定',     desc: '営業対象外の業種・キーワード・カスタムルールを定義します (任意)。',     stepName: null,                   stepSub: null,               inStepper: false },
    { id: 'messageTemplates',  icon: 'edit_note',     name: 'メッセージテンプレート', sub: '送信するメッセージのテンプレートを設定', desc: '挨拶・締め・署名・CTA・営業方針などメッセージ全体の骨格を整えます。',  stepName: 'メッセージテンプレート', stepSub: '送信内容を設計',   inStepper: true },
    { id: 'preferences',       icon: 'tune',          name: '環境設定',             sub: 'モデルや保存先などの環境設定',   desc: 'AI Provider・スクリーンショット保存先・データ保存先などを設定します。', stepName: '環境設定',             stepSub: '実行環境を設定',   inStepper: true }
  ];
  var SECTION_BY_ID = {};
  SECTIONS.forEach(function(s){ SECTION_BY_ID[s.id] = s; });
  var STEPPER = SECTIONS.filter(function(s){ return s.inStepper; });

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ---- Sidebar transform ----
  function decorateSidebar() {
    $$('.settings-sidebar-btn').forEach(function(btn){
      if (btn.dataset.set2Decorated === '1') return;
      var section = btn.getAttribute('data-section');
      var meta = SECTION_BY_ID[section];
      if (!meta) return;
      btn.dataset.set2Decorated = '1';

      var icon = document.createElement('div');
      icon.className = 'set2-side-icon';
      icon.innerHTML = '<span class="material-symbols-outlined">' + meta.icon + '</span>';

      var text = document.createElement('div');
      text.className = 'set2-side-text';
      var name = document.createElement('div');
      name.className = 'set2-side-name';
      name.textContent = meta.name;
      var sub = document.createElement('div');
      sub.className = 'set2-side-sub';
      sub.textContent = meta.sub;
      text.appendChild(name);
      text.appendChild(sub);

      btn.insertBefore(text, btn.firstChild);
      btn.insertBefore(icon, btn.firstChild);
    });
    // Add a 設定メニュー title at top of sidebar
    var sidebar = $('.settings-sidebar');
    if (sidebar && !sidebar.querySelector('.set2-side-title')) {
      var t = document.createElement('div');
      t.className = 'set2-side-title';
      t.textContent = '設定メニュー';
      sidebar.insertBefore(t, sidebar.firstChild);
    }
  }

  // ---- Section header / stepper / footer injection ----
  function activeSectionId() {
    var btn = document.querySelector('.settings-sidebar-btn.active');
    return btn ? (btn.getAttribute('data-section') || 'companyProfile') : 'companyProfile';
  }

  function isSectionDone(id) {
    var chip = document.getElementById('settingsSidebarStatus-' + id);
    return chip && chip.classList.contains('ready');
  }

  function computeProgress() {
    var done = 0, total = 0;
    STEPPER.forEach(function(s){
      total++;
      if (isSectionDone(s.id)) done++;
    });
    return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function renderHeader(meta, prog) {
    return '<div class="set2-header">'
      + '<div class="set2-header-text">'
      + '<h2>' + escapeHtml(meta.name) + '</h2>'
      + '<p>' + escapeHtml(meta.desc) + '</p>'
      + '</div>'
      + '<div class="set2-progress">'
      + '<div class="set2-progress-label">設定の完了率 <b>' + prog.pct + '%</b> (' + prog.done + '/' + prog.total + ')</div>'
      + '<div class="set2-progress-track"><span style="width:' + prog.pct + '%"></span></div>'
      + '</div>'
      + '</div>';
  }

  function renderStepper(activeId) {
    var activeIdx = -1;
    STEPPER.forEach(function(s, i){ if (s.id === activeId) activeIdx = i; });
    var html = '<div class="set2-stepper">';
    STEPPER.forEach(function(s, i){
      var cls = 'set2-step';
      if (i < activeIdx || isSectionDone(s.id)) cls += ' done';
      if (i === activeIdx) cls += ' active';
      var iconText = (i < activeIdx || (isSectionDone(s.id) && i !== activeIdx)) ? 'check' : (i + 1).toString();
      html += '<div class="' + cls + '" data-step-target="' + s.id + '">'
        +   '<div class="set2-step-dot">'
        +     (iconText === 'check' ? '<span class="material-symbols-outlined">check</span>' : '<span style="font-size:.78rem;font-weight:800">' + iconText + '</span>')
        +   '</div>'
        +   '<div class="set2-step-name">' + escapeHtml(s.stepName) + '</div>'
        +   '<div class="set2-step-sub">' + escapeHtml(s.stepSub) + '</div>'
        + '</div>';
    });
    html += '</div>';
    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function readFieldValue(name) {
    var el = document.getElementById('cp-' + name) || document.querySelector('[name="' + name + '"]');
    return el ? (el.value || '').trim() : '';
  }

  function renderPreviewForCompany() {
    var name = readFieldValue('companyName') || readFieldValue('cp-companyName') || (function(){
      var n = document.querySelector('#cp-companyName, [name=companyName]');
      return n ? n.value.trim() : '';
    })();
    var contactName = readFieldValue('contactName') || (function(){ var n = document.querySelector('#cp-contactName, [name=contactName]'); return n ? n.value.trim() : ''; })();
    var email = readFieldValue('email') || (function(){ var n = document.querySelector('#cp-email, [name=email]'); return n ? n.value.trim() : ''; })();
    var phone = readFieldValue('phone') || (function(){ var n = document.querySelector('#cp-phone, [name=phone]'); return n ? n.value.trim() : ''; })();
    var website = readFieldValue('website') || (function(){ var n = document.querySelector('#cp-website, [name=website]'); return n ? n.value.trim() : ''; })();
    var desc = readFieldValue('businessDescription') || (function(){ var n = document.querySelector('#cp-businessDescription, [name=businessDescription]'); return n ? n.value.trim() : ''; })();

    var html = '<aside class="set2-preview">'
      + '<h4>プレビュー</h4>'
      + '<div class="set2-preview-name"><span>' + escapeHtml(name || '— 会社名 —') + '</span><span class="set2-preview-tag">プレビュー</span></div>'
      + '<div class="set2-preview-section-title">連絡先</div>'
      + '<div class="set2-preview-list">'
      +   '<div class="set2-preview-row' + (contactName ? '' : ' muted') + '"><span class="material-symbols-outlined">person</span><span>' + escapeHtml(contactName || '— 担当者名 —') + '</span></div>'
      +   '<div class="set2-preview-row' + (email ? '' : ' muted') + '"><span class="material-symbols-outlined">mail</span><span>' + escapeHtml(email || '— メール —') + '</span></div>'
      +   '<div class="set2-preview-row' + (phone ? '' : ' muted') + '"><span class="material-symbols-outlined">call</span><span>' + escapeHtml(phone || '— 電話 —') + '</span></div>'
      +   '<div class="set2-preview-row' + (website ? '' : ' muted') + '"><span class="material-symbols-outlined">language</span><span>' + escapeHtml(website || '— Web —') + '</span></div>'
      + '</div>'
      + '<div class="set2-preview-section">'
      +   '<div class="set2-preview-section-title">会社概要</div>'
      +   '<div class="set2-preview-desc">' + escapeHtml(desc || 'AI が生成した会社プロフィールのプレビューがここに表示されます。') + '</div>'
      + '</div>'
      + '<div class="set2-preview-hint"><span class="material-symbols-outlined">auto_awesome</span><span>入力内容に基づき、AI が最適な表現でプロフィールを自動生成します。</span></div>'
    + '</aside>';
    return html;
  }

  function renderBottom() {
    return '<div class="set2-bottom">'
      + '<div class="set2-hint-card">'
      +   '<div class="set2-hint-icon"><span class="material-symbols-outlined">tips_and_updates</span></div>'
      +   '<div class="set2-hint-body">'
      +     '<div class="set2-hint-title">設定のヒント</div>'
      +     '<a href="https://github.com/joseikininsight-hue/sales-claw#readme" target="_blank" rel="noopener" class="set2-hint-link">詳細ガイドを見る <span class="material-symbols-outlined" style="font-size:12px">open_in_new</span></a>'
      +   '</div>'
      + '</div>'
      + '<button type="button" class="set2-save-next" data-set2-save-next="1"><span>保存して次へ</span><span class="material-symbols-outlined">arrow_forward</span></button>'
    + '</div>';
  }

  function findActiveLegacySection() {
    return document.querySelector('.settings-section.active');
  }

  function rebuildShell() {
    var main = document.getElementById('settingsMain');
    if (!main) return;
    main.classList.add('set2-active');

    var activeId = activeSectionId();
    var meta = SECTION_BY_ID[activeId];
    if (!meta) return;
    var prog = computeProgress();

    // remove previous redesign elements
    $$('.set2-header, .set2-stepper, .set2-section-shell, .set2-bottom, .set2-preview', main).forEach(function(el){ el.remove(); });

    // header + stepper at top
    var headerWrap = document.createElement('div');
    headerWrap.innerHTML = renderHeader(meta, prog) + renderStepper(activeId);
    while (headerWrap.firstChild) main.insertBefore(headerWrap.firstChild, main.firstChild.nextSibling || null);
    // actually we want them BEFORE the legacy guide (which is hidden) but AT TOP of main
    var legacyGuide = main.querySelector('.settings-setup-guide');
    var stepperEl = main.querySelector('.set2-stepper');
    var headerEl = main.querySelector('.set2-header');
    if (legacyGuide && headerEl) main.insertBefore(headerEl, legacyGuide);
    if (legacyGuide && stepperEl) main.insertBefore(stepperEl, legacyGuide);

    // wrap the active section into shell with preview
    var section = findActiveLegacySection();
    if (section) {
      var shell = document.createElement('div');
      shell.className = 'set2-section-shell' + (activeId === 'companyProfile' ? '' : ' no-preview');
      var formWrap = document.createElement('div');
      formWrap.className = 'set2-form-wrap';
      // move the section's children into formWrap (preserve all original IDs/handlers)
      while (section.firstChild) formWrap.appendChild(section.firstChild);
      shell.appendChild(formWrap);
      if (activeId === 'companyProfile') {
        var preview = document.createElement('div');
        preview.innerHTML = renderPreviewForCompany();
        shell.appendChild(preview.firstChild);
      }
      // place shell BEFORE the now-empty section
      section.parentNode.insertBefore(shell, section);
    }

    // Bottom: hint + save next
    var bottom = document.createElement('div');
    bottom.innerHTML = renderBottom();
    main.appendChild(bottom.firstChild);
  }

  // ---- Save & next ----
  function saveAndNext() {
    var activeId = activeSectionId();
    // find legacy save button within this section's original wrap
    var section = findActiveLegacySection();
    if (!section) return;
    var saveBtn = section.querySelector('.btn-save, [data-action="save-section"], button.save, button[onclick*="saveSection"]');
    if (saveBtn) {
      saveBtn.click();
    }
    // open next stepper section after a small delay
    setTimeout(function(){
      var idx = STEPPER.findIndex(function(s){ return s.id === activeId; });
      var next = idx >= 0 && idx < STEPPER.length - 1 ? STEPPER[idx + 1] : null;
      if (next && typeof window.openSettingsSection === 'function') {
        window.openSettingsSection(next.id);
      } else if (typeof window.showToast === 'function') {
        window.showToast('保存しました', 'success');
      }
    }, 250);
  }

  // ---- Live preview update for company profile ----
  function bindLivePreview() {
    document.addEventListener('input', function(ev){
      if (!document.getElementById('settingsMain') || !document.getElementById('settingsMain').classList.contains('set2-active')) return;
      if (activeSectionId() !== 'companyProfile') return;
      var el = ev.target;
      if (!el || !el.matches) return;
      var n = (el.id || el.name || '').replace(/^cp-/, '');
      if (['companyName','contactName','email','phone','website','businessDescription'].indexOf(n) === -1) return;
      var preview = document.querySelector('.set2-preview');
      if (!preview) return;
      var holder = document.createElement('div');
      holder.innerHTML = renderPreviewForCompany();
      preview.replaceWith(holder.firstChild);
    });
  }

  // ---- Watch for active section / settings tab changes ----
  function attachClickHandlers() {
    document.addEventListener('click', function(ev){
      // tab switch to settings
      var tabBtn = ev.target.closest && ev.target.closest('.tab-btn[data-tab="settings"]');
      if (tabBtn) {
        setTimeout(rebuildShell, 60);
      }
      // sidebar nav
      var sideBtn = ev.target.closest && ev.target.closest('.settings-sidebar-btn');
      if (sideBtn) {
        setTimeout(rebuildShell, 60);
      }
      // step navigation
      var step = ev.target.closest && ev.target.closest('[data-step-target]');
      if (step) {
        ev.preventDefault();
        var target = step.getAttribute('data-step-target');
        if (typeof window.openSettingsSection === 'function') window.openSettingsSection(target);
        setTimeout(rebuildShell, 60);
      }
      // save & next
      var saveNext = ev.target.closest && ev.target.closest('[data-set2-save-next]');
      if (saveNext) {
        ev.preventDefault();
        saveAndNext();
      }
    }, true);
  }

  // ---- Observe settings tab visibility ----
  function watchSettingsTab() {
    var tab = document.getElementById('tab-settings');
    if (!tab) return;
    var obs = new MutationObserver(function(){
      if (tab.classList.contains('active')) {
        decorateSidebar();
        rebuildShell();
      }
    });
    obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    ensureStyle();
    decorateSidebar();
    attachClickHandlers();
    watchSettingsTab();
    bindLivePreview();
    // initial rebuild if settings tab is already active
    if (document.getElementById('tab-settings') && document.getElementById('tab-settings').classList.contains('active')) {
      setTimeout(rebuildShell, 100);
    }
    // also re-run after data load (settings often re-render)
    setTimeout(rebuildShell, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderSettingsRedesignScript() {
  return SCRIPT;
};
