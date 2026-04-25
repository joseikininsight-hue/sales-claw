'use strict';

/**
 * 送信済みカードの新デザイン (送信済み内容の確認パネル)。
 *
 * - dashboard.cjs の sentCompanies.map() の冒頭フックで
 *   `window.renderSentCardOverride(c)` が呼ばれる
 * - 確認待ち redesign と同じ .aw2-* スタイルを再利用
 * - 「AI 実行ログ」の代わりに「連絡履歴 (contactHistory)」を時系列表示
 * - フッタは情報主体: フォームURL + 返信を記録(将来用stub) + 編集して再送(将来用stub)
 */

const SCRIPT = `(function(){
  function safeText(s) {
    s = (s == null ? '' : String(s));
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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

  // settings cache shared by awaiting redesign — fall back to local fetch if not yet present
  var SETTINGS_CACHE = null;
  var SETTINGS_PROMISE = null;
  function loadSettings() {
    if (SETTINGS_PROMISE) return SETTINGS_PROMISE;
    SETTINGS_PROMISE = fetch('/api/settings').then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      SETTINGS_CACHE = (j && j.settings) ? j.settings : (j || null);
      document.querySelectorAll('.aw2-card.sent[data-pending="1"]').forEach(function(card){
        applySettingsToCard(card);
      });
      return SETTINGS_CACHE;
    }).catch(function(){ return null; });
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
    return '<div class="' + cls + '">'
      + '<div class="aw2-field-label"><span class="material-symbols-outlined">' + iconName + '</span>' + safeText(label) + '</div>'
      + '<div class="' + valueClass + '">' + safeText(displayed) + '</div>'
    + '</div>';
  }

  function screenshotSrc(c) {
    if (typeof DASHBOARD_SESSION_TOKEN !== 'string' || !DASHBOARD_SESSION_TOKEN) return null;
    var ver = Date.now();
    var which = c.hasConfirmScreenshot ? 'confirm' : (c.hasInputScreenshot ? 'input' : (c.hasSentScreenshot ? 'sent' : null));
    if (!which) return null;
    return '/screenshots/ss-' + c.no + '-' + which + '.png?v=' + ver + '&session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN);
  }

  function renderShot(src) {
    if (!src) {
      return '<div class="aw2-shot-frame"><div class="aw2-shot-empty">スクリーンショットがありません</div></div>';
    }
    return '<div class="aw2-shot-frame">'
      + '<div class="aw2-shot-scroll">'
      + '<img class="aw2-shot-img" src="' + safeText(src) + '" alt="送信時スクリーンショット" data-zoom="1">'
      + '</div>'
    + '</div>';
  }

  function statusInfo(c) {
    var history = Array.isArray(c.contactHistory) ? c.contactHistory : [];
    var latest = history.length ? history[history.length - 1] : null;
    var resp = latest ? String(latest.response || '') : '';
    if (/replied|返信あり/i.test(resp)) return { kind: 'ok', icon: 'mark_email_read', label: '返信あり' };
    if (/meeting|商談/i.test(resp)) return { kind: 'ok', icon: 'event_available', label: '商談設定' };
    if (resp) return { kind: 'warn', icon: 'forum', label: resp };
    return { kind: 'ok', icon: 'check_circle', label: '送信済み' };
  }

  function renderHistoryTimeline(c) {
    var history = Array.isArray(c.contactHistory) ? c.contactHistory : [];
    if (history.length === 0) {
      return '<div class="aw2-log">'
        + '<div class="aw2-section-title"><span class="material-symbols-outlined">timeline</span>連絡履歴</div>'
        + '<div style="font-size:.74rem;color:var(--text-3);padding:6px 4px">この企業への連絡は本件のみです。</div>'
      + '</div>';
    }
    var items = history.map(function(h){
      var resp = String(h.response || '').trim();
      var dot;
      var dotIcon = 'check';
      if (/replied|返信あり/i.test(resp)) { dot = ''; dotIcon = 'mark_email_read'; }
      else if (/meeting|商談/i.test(resp)) { dot = ''; dotIcon = 'event_available'; }
      else if (resp) { dot = ' pending'; dotIcon = 'pending'; }
      else { dot = ' pending'; dotIcon = 'schedule'; }
      var d = h.date ? fmtDate(h.date) : '-';
      var preview = h.message ? safeText(String(h.message).substring(0, 80)) : '';
      var respChip = resp ? '<span style="font-size:.62rem;font-weight:700;padding:1px 7px;border-radius:var(--radius-pill);background:var(--bg-raised);color:var(--text-2);margin-right:6px">' + safeText(resp) + '</span>' : '';
      return '<li class="aw2-log-item">'
        + '<span class="aw2-log-dot' + dot + '"><span class="material-symbols-outlined">' + dotIcon + '</span></span>'
        + '<span class="aw2-log-label" style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto">'
        +   '<span style="display:flex;align-items:center;gap:6px;font-size:.74rem;font-weight:600">' + respChip + '<span style="color:var(--text-3);font-family:var(--font-mono);font-size:.7rem">' + safeText(d) + '</span></span>'
        +   (preview ? '<span style="font-size:.7rem;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + preview + '</span>' : '')
        + '</span>'
      + '</li>';
    }).join('');
    return '<div class="aw2-log">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">timeline</span>連絡履歴 (' + history.length + ')</div>'
      + '<ul class="aw2-log-list">' + items + '</ul>'
    + '</div>';
  }

  function renderHeader(c, status, dateStr) {
    var count = c.contactCount || 1;
    var countBadge = count >= 2
      ? '<span class="aw2-status warn" style="margin-left:6px"><span class="material-symbols-outlined">repeat</span>' + count + '回目の連絡</span>'
      : '';
    return '<div class="aw2-head">'
      + '<div class="aw2-head-left">'
      + '<div class="aw2-head-icon" style="background:var(--success-dim);color:var(--success)"><span class="material-symbols-outlined">mark_email_read</span></div>'
      + '<div>'
      + '<h3 class="aw2-head-title">送信済みの内容</h3>'
      + '<p class="aw2-head-sub">送信済みフォームの入力内容と連絡履歴を確認できます</p>'
      + '</div>'
      + '</div>'
      + '<div class="aw2-head-right">'
      + '<span class="aw2-acquired"><span class="material-symbols-outlined">schedule</span>送信日時:&nbsp;' + safeText(dateStr) + '</span>'
      + '<span class="aw2-status ' + (status.kind === 'ok' ? '' : (status.kind === 'warn' ? 'warn' : 'err')) + '"><span class="material-symbols-outlined">' + status.icon + '</span>' + safeText(status.label) + '</span>'
      + countBadge
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
      + renderHistoryTimeline(c)
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
    var msgField = renderField('article', '送信した本文', msg, { tall: true, valueClass: 'aw2-fld-message' });

    return '<section class="aw2-col-right">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">checklist</span>送信内容のサマリー</div>'
      + '<div class="aw2-fields">' + fields + msgField + '</div>'
    + '</section>';
  }

  function renderFooter(c) {
    var formUrl = c.formUrl ? safeText(c.formUrl) : '';
    return '<div class="aw2-foot">'
      + (formUrl ? '<a class="aw2-form-url" href="' + formUrl + '" target="_blank" rel="noopener" title="' + formUrl + '" style="text-decoration:none">' + formUrl + '</a>' : '<span></span>')
      + '<div class="aw2-foot-right">'
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="record-reply"><span class="material-symbols-outlined">forum</span>返信を記録</button>'
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="resend"><span class="material-symbols-outlined">replay</span>編集して再送</button>'
      + '</div>'
    + '</div>';
  }

  function renderCard(c) {
    if (!SETTINGS_CACHE) loadSettings();
    var status = statusInfo(c);
    var dateStr = fmtDate(c.sentAt);
    var src = screenshotSrc(c);
    var pending = SETTINGS_CACHE ? '' : ' data-pending="1"';

    return '<div class="aw2-card sent sent-card" data-no="' + c.no + '" data-name="' + safeText(c.name) + '" data-sn="' + safeText((c.name + ' ' + c.type + ' ' + (c.sentMessage || '') + ' ' + (c.formUrl || '')).toLowerCase()) + '" data-sc="' + (c.contactCount || 1) + '" data-type-exact="' + safeText(String(c.type || '').trim().toLowerCase()) + '"' + pending + '>'
      + renderHeader(c, status, dateStr)
      + '<div class="aw2-body">'
      +   renderLeft(c, src)
      +   renderRight(c)
      + '</div>'
      + renderFooter(c)
    + '</div>';
  }

  function bindGlobal() {
    if (window.__aw2SentBound) return;
    window.__aw2SentBound = true;

    document.addEventListener('click', function(ev){
      var card = ev.target.closest && ev.target.closest('.aw2-card.sent');
      if (!card) return;
      var actionEl = ev.target.closest('[data-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');
      if (action === 'record-reply') {
        ev.preventDefault();
        if (typeof window.openReplyRecorder === 'function') {
          var no = parseInt(card.getAttribute('data-no'), 10);
          window.openReplyRecorder(no, card.getAttribute('data-name') || '');
        } else if (typeof window.toast === 'function') {
          window.toast('返信記録機能は近日対応', 'info');
        } else {
          alert('返信記録機能は近日対応');
        }
      } else if (action === 'resend') {
        ev.preventDefault();
        if (typeof window.openResendEditor === 'function') {
          var no2 = parseInt(card.getAttribute('data-no'), 10);
          window.openResendEditor(no2, card.getAttribute('data-name') || '');
        } else if (typeof window.toast === 'function') {
          window.toast('再送機能は近日対応', 'info');
        } else {
          alert('再送機能は近日対応');
        }
      }
    }, false);
  }

  bindGlobal();
  window.renderSentCardOverride = renderCard;
})();`;

module.exports = function renderSentCardRedesignScript() {
  return SCRIPT;
};
