'use strict';

/**
 * 確認待ちカードの新デザイン (送信内容の確認パネル)。
 *
 * - dashboard.cjs の awaitingCompanies.map() の冒頭フックで
 *   `window.renderAwaitingCardOverride(c)` が呼ばれる
 * - 写真の通りのレイアウト (ヘッダ + 2カラム + フッタ) を返す
 * - スクリーンショットの拡大/縮小、編集UI(将来用)、AI実行ログを含む
 *
 * 呼び出し側: dashboard-server.cjs の buildPage() が <script> 内で展開する。
 */

const STYLE = [
  /* card frame */
  '.aw2-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);margin-bottom:12px;overflow:hidden;color:var(--text-1)}',

  /* header — compact */
  '.aw2-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 16px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,rgba(37,99,235,.04) 0%,transparent 60%)}',
  '.aw2-head-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}',
  '.aw2-head-icon{width:30px;height:30px;border-radius:8px;background:rgba(37,99,235,.12);color:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.aw2-head-icon .material-symbols-outlined{font-size:18px}',
  '.aw2-head-title{font-size:.92rem;font-weight:800;color:var(--text-1);margin:0;letter-spacing:.01em;line-height:1.2}',
  '.aw2-head-sub{font-size:.66rem;color:var(--text-2);margin:1px 0 0;line-height:1.2}',
  '.aw2-head-right{display:flex;align-items:center;gap:10px;flex-shrink:0}',
  '.aw2-acquired{display:flex;align-items:center;gap:5px;font-size:.68rem;color:var(--text-2);font-family:var(--font-mono)}',
  '.aw2-acquired .material-symbols-outlined{font-size:13px}',
  '.aw2-status{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:var(--radius-pill)!important;font-size:.68rem;font-weight:700;background:var(--success-dim);color:var(--success);border:1px solid rgba(5,150,105,.25)}',
  '.aw2-status.warn{background:var(--warning-dim);color:var(--warning);border-color:rgba(217,119,6,.25)}',
  '.aw2-status.err{background:var(--error-dim);color:var(--error);border-color:rgba(220,38,38,.25)}',
  '.aw2-status .material-symbols-outlined{font-size:13px}',

  /* body — compact */
  '.aw2-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;border-top:1px solid var(--border-subtle)}',
  '.aw2-body > section{padding:12px 16px}',
  '.aw2-body > section:first-child{border-right:1px solid var(--border-subtle)}',
  '.aw2-section-title{display:flex;align-items:center;gap:6px;font-size:.7rem;font-weight:700;color:var(--text-2);margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase}',
  '.aw2-section-title .material-symbols-outlined{font-size:14px;color:var(--primary)}',

  /* screenshot viewer — compact */
  '.aw2-shot-frame{position:relative;width:100%;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-deep);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:180px;max-height:380px}',
  '.aw2-shot-scroll{width:100%;height:100%;max-height:380px;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:6px}',
  '.aw2-shot-img{display:block;max-width:100%;height:auto;transform-origin:top left;transition:transform .18s var(--ease-out-expo);cursor:zoom-in}',
  '.aw2-shot-empty{padding:28px 14px;font-size:.74rem;color:var(--text-3);text-align:center}',
  '.aw2-shot-tools{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
  '.aw2-zoom{display:inline-flex;align-items:center;gap:1px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-pill)!important;padding:2px 4px;box-shadow:var(--shadow-xs)}',
  '.aw2-zoom button{width:22px;height:22px;border:none;background:transparent;color:var(--text-2);font-size:.92rem;cursor:pointer;border-radius:50%!important;display:flex;align-items:center;justify-content:center;transition:background .12s}',
  '.aw2-zoom button:hover{background:var(--bg-hover);color:var(--text-1)}',
  '.aw2-zoom .aw2-zoom-val{min-width:40px;text-align:center;font-size:.7rem;font-weight:700;font-family:var(--font-mono);color:var(--text-1)}',
  '.aw2-open-tab{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font-size:.7rem;font-weight:600;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.aw2-open-tab:hover{background:var(--bg-raised);border-color:var(--border-strong)}',
  '.aw2-open-tab .material-symbols-outlined{font-size:13px}',

  /* timeline (used by sent card for contact history) — compact */
  '.aw2-log{margin-top:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important;padding:10px 12px;background:var(--bg-surface)}',
  '.aw2-log-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;position:relative}',
  '.aw2-log-list::before{content:"";position:absolute;left:8px;top:6px;bottom:6px;width:1px;background:var(--border-default)}',
  '.aw2-log-item{display:flex;align-items:center;gap:8px;font-size:.7rem;color:var(--text-1);position:relative}',
  '.aw2-log-dot{width:16px;height:16px;border-radius:50%!important;background:var(--success);color:#fff;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;z-index:1;border:2px solid var(--bg-surface)}',
  '.aw2-log-dot.pending{background:var(--bg-card);border-color:var(--border-default);color:var(--text-3)}',
  '.aw2-log-dot .material-symbols-outlined{font-size:11px}',
  '.aw2-log-label{flex:1 1 auto;font-weight:500}',
  '.aw2-log-time{font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)}',

  /* summary — compact */
  '.aw2-fields{display:flex;flex-direction:column;gap:5px}',
  '.aw2-field{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm)!important;background:var(--bg-card);transition:background .15s,border-color .15s}',
  '.aw2-field:hover{background:var(--bg-surface);border-color:var(--border-default)}',
  '.aw2-field-label{display:flex;align-items:center;gap:6px;font-size:.7rem;font-weight:600;color:var(--text-2)}',
  '.aw2-field-label .material-symbols-outlined{font-size:14px;color:var(--text-3)}',
  '.aw2-field-value{font-size:.76rem;color:var(--text-1);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.aw2-field-value.muted{color:var(--text-3);font-style:italic}',
  '.aw2-field.tall{grid-template-columns:150px minmax(0,1fr);align-items:flex-start}',
  '.aw2-field.tall .aw2-field-value{white-space:pre-wrap;max-height:200px;overflow-y:auto;line-height:1.55;padding-right:4px;font-size:.74rem}',

  /* footer — compact */
  '.aw2-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-surface)}',
  '.aw2-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;font-size:.74rem;font-weight:700;border-radius:var(--radius-sm)!important;cursor:pointer;border:1px solid transparent;transition:all .15s var(--ease-out-expo);font-family:var(--font-body)}',
  '.aw2-btn-cancel{background:var(--bg-card);color:var(--text-2);border-color:var(--border-default)}',
  '.aw2-btn-cancel:hover{background:var(--bg-raised);color:var(--text-1)}',
  '.aw2-btn-edit{background:var(--bg-card);color:var(--primary);border-color:rgba(37,99,235,.4)}',
  '.aw2-btn-edit:hover{background:var(--primary-glow);border-color:var(--primary)}',
  '.aw2-btn-edit .material-symbols-outlined{font-size:16px}',
  '.aw2-btn-send{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
  '.aw2-btn-send:hover{background:var(--primary-dim);border-color:var(--primary-dim);box-shadow:0 4px 14px rgba(37,99,235,.36)}',
  '.aw2-btn-send .material-symbols-outlined{font-size:16px}',
  '.aw2-btn[disabled]{opacity:.45;cursor:not-allowed!important;pointer-events:none}',
  '.aw2-foot-right{display:flex;align-items:center;gap:8px}',
  '.aw2-form-url{font-size:.7rem;color:var(--text-3);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',

  /* responsive */
  '@media (max-width:960px){.aw2-body{grid-template-columns:1fr}.aw2-body > section:first-child{border-right:none;border-bottom:1px solid var(--border-subtle)}.aw2-field{grid-template-columns:1fr;gap:4px}.aw2-field-value{white-space:normal}}'
].join('\n');

const SCRIPT = `(function(){
  var STYLE_ID = 'aw2-card-style';
  var SETTINGS_CACHE = null;
  var SETTINGS_PROMISE = null;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  function safeText(s) {
    s = (s == null ? '' : String(s));
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function jsArg(s) {
    return String(s == null ? '' : s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
  }

  function fmtDate(ms) {
    if (!ms) return '-';
    try {
      var lang = (typeof LANG === 'string' && LANG) ? LANG : 'ja';
      var tz = (typeof PREF_TZ === 'string' && PREF_TZ) ? PREF_TZ : undefined;
      return new Date(ms).toLocaleString(lang === 'ja' ? 'ja-JP' : undefined, tz ? { timeZone: tz } : undefined);
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }

  function loadSettings() {
    if (SETTINGS_PROMISE) return SETTINGS_PROMISE;
    SETTINGS_PROMISE = fetch('/api/settings').then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      SETTINGS_CACHE = (j && j.settings) ? j.settings : (j || null);
      // Update placeholder fields once data lands
      document.querySelectorAll('.aw2-card[data-pending="1"]').forEach(function(card){
        var no = card.getAttribute('data-no');
        applySettingsToCard(card);
      });
      return SETTINGS_CACHE;
    }).catch(function(){ SETTINGS_CACHE = null; return null; });
    return SETTINGS_PROMISE;
  }

  function senderProfile() {
    if (!SETTINGS_CACHE) return null;
    var s = SETTINGS_CACHE;
    return s.companyProfile || (s.sender ? s.sender : null);
  }

  function applySettingsToCard(card) {
    var p = senderProfile();
    if (!p) return;
    var map = {
      'aw2-fld-contact': p.contactName || p.name || '',
      'aw2-fld-email': p.email || '',
      'aw2-fld-phone': p.phone || ''
    };
    Object.keys(map).forEach(function(cls){
      var el = card.querySelector('.' + cls);
      if (!el) return;
      var v = map[cls];
      if (v) {
        el.textContent = v;
        el.classList.remove('muted');
      }
    });
    card.removeAttribute('data-pending');
  }

  function renderField(iconName, label, value, opts) {
    opts = opts || {};
    var muted = !value;
    var displayed = value || (opts.placeholder || '—');
    var cls = 'aw2-field' + (opts.tall ? ' tall' : '');
    var valueClass = 'aw2-field-value' + (muted ? ' muted' : '') + (opts.valueClass ? ' ' + opts.valueClass : '');
    var content = opts.html ? value : safeText(displayed);
    return '<div class="' + cls + '">'
      + '<div class="aw2-field-label"><span class="material-symbols-outlined">' + iconName + '</span>' + safeText(label) + '</div>'
      + '<div class="' + valueClass + '">' + content + '</div>'
    + '</div>';
  }

  function logSteps(c) {
    var ts = c.awaitingAt || Date.now();
    var formatted = fmtDate(ts);
    return [
      { icon: 'language',         label: 'フォームページにアクセス', time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'integration_instructions', label: 'フォーム要素を認識', time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'edit_note',        label: '情報を入力',                 time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'photo_camera',     label: 'スクリーンショット取得',    time: formatted, done: !!c.hasInputScreenshot || !!c.hasConfirmScreenshot }
    ];
  }

  function statusInfo(c) {
    if (c.hasConfirmScreenshot) {
      return { kind: 'ok', icon: 'check_circle', label: 'この内容で送信可能です' };
    }
    if (c.hasInputScreenshot) {
      return { kind: 'warn', icon: 'pending_actions', label: '入力スクリーンショット確認済み' };
    }
    return { kind: 'err', icon: 'error', label: 'スクリーンショット未取得' };
  }

  function screenshotSrc(c) {
    if (typeof DASHBOARD_SESSION_TOKEN === 'string' && DASHBOARD_SESSION_TOKEN) {
      var ver = Date.now();
      var which = c.hasConfirmScreenshot ? 'confirm' : (c.hasInputScreenshot ? 'input' : null);
      if (!which) return null;
      return '/screenshots/ss-' + c.no + '-' + which + '.png?v=' + ver + '&session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN);
    }
    return null;
  }

  function renderLogList(c) {
    var steps = logSteps(c);
    var items = steps.map(function(s){
      var dotCls = s.done ? '' : 'pending';
      var icon = s.done ? 'check' : 'pending';
      return '<li class="aw2-log-item">'
        + '<span class="aw2-log-dot ' + dotCls + '"><span class="material-symbols-outlined">' + icon + '</span></span>'
        + '<span class="aw2-log-label">' + safeText(s.label) + '</span>'
        + '<span class="aw2-log-time">' + safeText(s.time) + '</span>'
      + '</li>';
    }).join('');
    return '<div class="aw2-log">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">format_list_bulleted</span>AI の実行ログ</div>'
      + '<ul class="aw2-log-list">' + items + '</ul>'
    + '</div>';
  }

  function renderShot(src) {
    if (!src) {
      return '<div class="aw2-shot-frame"><div class="aw2-shot-empty">スクリーンショットがまだありません</div></div>';
    }
    return '<div class="aw2-shot-frame">'
      + '<div class="aw2-shot-scroll">'
      + '<img class="aw2-shot-img" src="' + safeText(src) + '" alt="送信前スクリーンショット" data-zoom="1">'
      + '</div>'
    + '</div>';
  }

  function renderHeader(c, status, dateStr) {
    return '<div class="aw2-head">'
      + '<div class="aw2-head-left">'
      + '<div class="aw2-head-icon"><span class="material-symbols-outlined">description</span></div>'
      + '<div>'
      + '<h3 class="aw2-head-title">送信内容の確認</h3>'
      + '<p class="aw2-head-sub">AI が入力した内容とスクリーンショットを確認してください</p>'
      + '</div>'
      + '</div>'
      + '<div class="aw2-head-right">'
      + '<span class="aw2-acquired"><span class="material-symbols-outlined">schedule</span>取得日時:&nbsp;' + safeText(dateStr) + '</span>'
      + '<span class="aw2-status ' + (status.kind === 'ok' ? '' : (status.kind === 'warn' ? 'warn' : 'err')) + '"><span class="material-symbols-outlined">' + status.icon + '</span>' + safeText(status.label) + '</span>'
      + '</div>'
    + '</div>';
  }

  function renderLeft(c, src) {
    return '<section class="aw2-col-left">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">image</span>スクリーンショットプレビュー</div>'
      + renderShot(src)
      + '<div class="aw2-shot-tools">'
      + '<div class="aw2-zoom" data-role="zoom">'
      +   '<button type="button" data-zoom-action="out" title="縮小">−</button>'
      +   '<span class="aw2-zoom-val">100%</span>'
      +   '<button type="button" data-zoom-action="in" title="拡大">+</button>'
      +   '<button type="button" data-zoom-action="reset" title="リセット" style="font-size:.7rem;width:auto;padding:0 8px">100%</button>'
      + '</div>'
      + (src ? '<button type="button" class="aw2-open-tab" data-action="open-tab"><span class="material-symbols-outlined">open_in_new</span>別タブで開く</button>' : '')
      + '</div>'
    + '</section>';
  }

  function renderRight(c) {
    var p = senderProfile();
    var industry = c.type || '';
    var inquiryType = (p && (p.defaultInquiryType || p.inquiryType)) || (industry || 'サービスについて');
    var contactName = p ? (p.contactName || p.name || '') : '';
    var email = p ? (p.email || '') : '';
    var phone = p ? (p.phone || '') : '';

    var fields = [
      renderField('help', 'お問い合わせ種別', inquiryType, { valueClass: 'aw2-fld-inquiry' }),
      renderField('domain', '会社名', c.name, { valueClass: 'aw2-fld-company' }),
      renderField('person', '担当者名', contactName, { valueClass: 'aw2-fld-contact', placeholder: '— (settings 取得中)' }),
      renderField('mail', 'メールアドレス', email, { valueClass: 'aw2-fld-email', placeholder: '— (settings 取得中)' }),
      renderField('call', '電話番号', phone, { valueClass: 'aw2-fld-phone', placeholder: '— (settings 取得中)' })
    ].join('');

    var msg = c.sentMessage || '';
    var msgField = renderField('article', 'お問い合わせ内容', msg, { tall: true, valueClass: 'aw2-fld-message' });

    return '<section class="aw2-col-right">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">checklist</span>入力内容のサマリー</div>'
      + '<div class="aw2-fields">' + fields + msgField + '</div>'
    + '</section>';
  }

  function renderFooter(c) {
    var nameArg = jsArg(c.name);
    var formUrl = c.formUrl ? safeText(c.formUrl) : '';
    var canSend = !!(c.hasInputScreenshot || c.hasConfirmScreenshot);
    return '<div class="aw2-foot">'
      + '<button type="button" class="aw2-btn aw2-btn-cancel" data-action="cancel">キャンセル</button>'
      + '<div class="aw2-foot-right">'
      + (formUrl ? '<span class="aw2-form-url" title="' + formUrl + '">' + formUrl + '</span>' : '')
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="edit"><span class="material-symbols-outlined">edit</span>編集して修正</button>'
      + '<button type="button" class="aw2-btn aw2-btn-send" data-action="send"' + (canSend ? '' : ' disabled') + '><span class="material-symbols-outlined">send</span>この内容で送信する</button>'
      + '</div>'
    + '</div>';
  }

  function renderCard(c) {
    ensureStyle();
    if (!SETTINGS_CACHE) loadSettings();

    var status = statusInfo(c);
    var dateStr = fmtDate(c.awaitingAt);
    var src = screenshotSrc(c);
    var pending = SETTINGS_CACHE ? '' : ' data-pending="1"';

    return '<div class="aw2-card awaiting-card" data-no="' + c.no + '" data-name="' + safeText(c.name) + '" data-state="' + safeText(c.lastAction || '') + '" data-has-input="' + (c.hasInputScreenshot ? '1' : '0') + '" data-has-confirm="' + (c.hasConfirmScreenshot ? '1' : '0') + '" data-has-any="' + (c.hasAnyScreenshot ? '1' : '0') + '" data-ready-approval="' + (c.readyForApproval ? '1' : '0') + '" data-form-url="' + safeText(c.formUrl || '') + '"' + pending + '>'
      + renderHeader(c, status, dateStr)
      + '<div class="aw2-body">'
      +   renderLeft(c, src)
      +   renderRight(c)
      + '</div>'
      + renderFooter(c)
    + '</div>';
  }

  // event delegation for buttons + zoom
  function bindGlobal() {
    if (window.__aw2Bound) return;
    window.__aw2Bound = true;

    document.addEventListener('click', function(ev){
      var card = ev.target.closest && ev.target.closest('.aw2-card');
      if (!card) return;
      var no = card.getAttribute('data-no');
      var name = card.getAttribute('data-name') || '';
      var actionEl = ev.target.closest('[data-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-action');
        if (action === 'send') {
          ev.preventDefault();
          if (typeof window.approveCompany === 'function') window.approveCompany(parseInt(no, 10), name, 'sent');
        } else if (action === 'cancel') {
          ev.preventDefault();
          if (typeof window.skipWithFeedback === 'function') window.skipWithFeedback(parseInt(no, 10), name);
        } else if (action === 'edit') {
          ev.preventDefault();
          if (typeof window.openAwaitingEditor === 'function') window.openAwaitingEditor(parseInt(no, 10), name, card);
          else if (typeof window.toast === 'function') window.toast('編集機能は近日対応', 'info');
          else alert('編集機能は近日対応');
        } else if (action === 'open-tab') {
          ev.preventDefault();
          var img = card.querySelector('.aw2-shot-img');
          if (img && img.src) window.open(img.src, '_blank');
        }
        return;
      }
      var zoomBtn = ev.target.closest('[data-zoom-action]');
      if (zoomBtn) {
        ev.preventDefault();
        var img = card.querySelector('.aw2-shot-img');
        if (!img) return;
        var current = parseInt(img.getAttribute('data-zoom') || '1', 10) || 1;
        var z = current;
        var which = zoomBtn.getAttribute('data-zoom-action');
        if (which === 'in') z = Math.min(4, Math.round((current + 0.25) * 100) / 100);
        else if (which === 'out') z = Math.max(0.5, Math.round((current - 0.25) * 100) / 100);
        else if (which === 'reset') z = 1;
        img.setAttribute('data-zoom', String(z));
        img.style.transform = 'scale(' + z + ')';
        var label = card.querySelector('.aw2-zoom-val');
        if (label) label.textContent = Math.round(z * 100) + '%';
        return;
      }
    }, false);
  }

  bindGlobal();

  // expose render override consumed by dashboard.cjs
  window.renderAwaitingCardOverride = renderCard;
})();`;

module.exports = function renderAwaitingCardRedesignScript() {
  return SCRIPT;
};
