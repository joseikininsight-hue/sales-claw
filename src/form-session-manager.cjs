'use strict';

const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const settings = require('./settings-manager.cjs');

// WebContentsView bounds for the form review pane (right 55% of content area)
const HEADER_HEIGHT = 56;
const PANEL_LEFT_RATIO = 0.45; // dashboard left panel takes 45%
const MAX_SESSIONS = 30;
const ALLOWED_SCREENSHOT_SUFFIXES = new Set(['input', 'confirm', 'sent', 'error']);
const DNS_LOOKUP_TIMEOUT_MS = 5000;

function isBlockedIpv4(address) {
  const parts = String(address).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = String(address).toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return true;
    return isBlockedIpv4([
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join('.'));
  }
  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    (Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

function isBlockedIpAddress(address) {
  const bareAddress = String(address || '').replace(/^\[|\]$/g, '');
  const version = net.isIP(bareAddress);
  if (version === 4) return isBlockedIpv4(bareAddress);
  if (version === 6) return isBlockedIpv6(bareAddress);
  return true;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolvePublicAddresses(hostname) {
  const bareHost = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(bareHost)) return [{ address: bareHost }];
  const results = await withTimeout(
    dns.lookup(bareHost, { all: true, verbatim: true }),
    DNS_LOOKUP_TIMEOUT_MS,
    'DNS lookup timed out',
  );
  return Array.isArray(results) ? results : [];
}

async function validateFormUrlSafety(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'url_credentials_not_allowed' };
  const hostname = parsed.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) return { ok: false, reason: 'localhost_not_allowed' };
  if (/^\d+$/.test(bareHost) || /^0x[0-9a-f]+$/i.test(bareHost)) return { ok: false, reason: 'ambiguous_ip_literal' };
  if (!bareHost.includes('.') && !bareHost.includes(':')) return { ok: false, reason: 'dotless_host_not_allowed' };

  let addresses;
  try {
    addresses = await resolvePublicAddresses(bareHost);
  } catch (error) {
    return { ok: false, reason: `dns_lookup_failed: ${error.message}` };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_lookup_empty' };
  const blocked = addresses.find((entry) => isBlockedIpAddress(entry.address));
  if (blocked) return { ok: false, reason: `blocked_ip: ${blocked.address}` };

  return { ok: true, url: parsed.toString(), addresses: addresses.map((entry) => entry.address) };
}

async function assertSafeFormUrl(rawUrl) {
  const result = await validateFormUrlSafety(rawUrl);
  if (!result.ok) {
    throw new Error(`SSRF guard: 許可されていないURLです: ${rawUrl} (${result.reason})`);
  }
  return result.url;
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

class FormSessionManager {
  constructor(getMainWindow) {
    this._getMainWindow = getMainWindow;
    // sessionId → { id, view, formUrl, companyNo, status, screenshotPath }
    this._sessions = new Map();
    this._activeSessionId = null;
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  async createSession(formUrl, companyNo) {
    const safeFormUrl = await assertSafeFormUrl(formUrl);

    let WebContentsView;
    try {
      ({ WebContentsView } = require('electron'));
    } catch {
      throw new Error('WebContentsView はElectronモードでのみ利用できます');
    }

    // セッション上限: 古いものから自動破棄
    if (this._sessions.size >= MAX_SESSIONS) {
      const oldest = this._sessions.keys().next().value;
      this.destroySession(oldest);
    }

    const id = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `form-session-${id}`,
      },
    });
    this._installRequestGuards(view, id);

    this._sessions.set(id, {
      id,
      view,
      formUrl: safeFormUrl,
      companyNo: String(companyNo),
      status: 'loading',
      screenshotPath: null,
      blockedUrl: null,
      blockedReason: null,
    });

    view.webContents.loadURL(safeFormUrl).catch((error) => {
      const session = this._sessions.get(id);
      if (session && session.status === 'loading') {
        session.status = 'load_failed';
        session.blockedReason = error.message;
      }
    });

    // Wait for DOM ready (with timeout)
    await this._waitForLoad(id, 20000);
    return id;
  }

  async _waitForLoad(sessionId, timeout = 20000) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return new Promise((resolve) => {
      const onReady = () => {
        clearTimeout(timer);
        session.view.webContents.removeListener('dom-ready', onReady);
        if (session.status === 'loading') session.status = 'loaded';
        resolve();
      };

      const timer = setTimeout(() => {
        session.view.webContents.removeListener('dom-ready', onReady);
        if (session.status === 'loading') session.status = 'load_timeout';
        resolve(); // timeout はエラーにせず続行（部分ロードでも構造取得を試みる）
      }, timeout);

      if (!session.view.webContents.isLoading()) {
        onReady();
      } else {
        session.view.webContents.once('dom-ready', onReady);
      }
    });
  }

  destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    this._removeFromWindow(sessionId);

    try { session.view.webContents.close(); } catch (_) {}

    this._sessions.delete(sessionId);
    if (this._activeSessionId === sessionId) this._activeSessionId = null;
  }

  _installRequestGuards(view, sessionId) {
    const markBlocked = (url, reason) => {
      const session = this._sessions.get(sessionId);
      if (!session) return;
      session.status = 'blocked_url';
      session.blockedUrl = url;
      session.blockedReason = reason;
    };

    view.webContents.setWindowOpenHandler(({ url }) => {
      markBlocked(url, 'popup_blocked');
      return { action: 'deny' };
    });

    view.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        validateFormUrlSafety(details.url)
          .then((result) => {
            if (!result.ok) {
              markBlocked(details.url, result.reason);
              callback({ cancel: true });
              return;
            }
            callback({ cancel: false });
          })
          .catch((error) => {
            markBlocked(details.url, error.message);
            callback({ cancel: true });
          });
      },
    );
  }

  // ── Form inspection ─────────────────────────────────────────────────

  async getFormStructure(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const structure = await session.view.webContents.executeJavaScript(`
      (function () {
        const escapeCSS = (str) => str.replace(/([!"#$%&'()*+,./:;<=>?@[\\]^{|}~])/g, '\\\\$1');
        const fields = [];
        const inputs = document.querySelectorAll('input, textarea, select');

        inputs.forEach((el) => {
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) return;
          if (el.offsetParent === null && el.type !== 'radio' && el.type !== 'checkbox') return; // hidden element

          let label = '';
          if (el.id) {
            const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (lbl) label = lbl.textContent.trim();
          }
          if (!label) {
            const parent = el.closest('.form-group, .form-field, .field, .input-wrap, li, p, div');
            if (parent) {
              const lbl = parent.querySelector('label, .label, .form-label');
              if (lbl && lbl !== el) label = lbl.textContent.trim();
            }
          }

          const selector = el.id
            ? '#' + CSS.escape(el.id)
            : el.name
            ? '[name="' + el.name + '"]'
            : null;
          if (!selector) return;

          const field = {
            selector,
            id: el.id || null,
            name: el.name || null,
            type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text'),
            label: label || el.placeholder || el.name || el.id || '',
            placeholder: el.placeholder || '',
            required: el.required,
          };

          if (el.tagName === 'SELECT') {
            field.options = Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() }));
          }

          fields.push(field);
        });

        return fields;
      })()
    `);

    return structure;
  }

  // ── Form filling ─────────────────────────────────────────────────────

  async fillForm(sessionId, mappings) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const results = [];

    for (const { selector, value, type } of mappings) {
      if (!selector || value == null) continue;

      const script = type === 'select'
        ? `(function(){
            const el=document.querySelector(${JSON.stringify(selector)});
            if(!el)return{ok:false,reason:'not_found'};
            el.value=${JSON.stringify(String(value))};
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return{ok:true};
          })()`
        : `(function(){
            const el=document.querySelector(${JSON.stringify(selector)});
            if(!el)return{ok:false,reason:'not_found'};
            const tag=el.tagName;
            const proto=tag==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
            const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
            if(setter)setter.call(el,${JSON.stringify(String(value))});
            else el.value=${JSON.stringify(String(value))};
            el.dispatchEvent(new Event('focus',{bubbles:true}));
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            el.dispatchEvent(new Event('blur',{bubbles:true}));
            return{ok:true};
          })()`;

      let result;
      try {
        result = await session.view.webContents.executeJavaScript(script);
      } catch (e) {
        result = { ok: false, reason: e.message };
      }
      results.push({ selector, ...result });
    }

    session.status = 'filled';
    return results;
  }

  // ── Screenshot ───────────────────────────────────────────────────────

  async captureScreenshot(sessionId, savePath) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const basename = path.basename(savePath);
    const suffixMatch = basename.match(/^ss-[a-zA-Z0-9_-]+-([a-zA-Z]+)\.png$/);
    if (!suffixMatch || !ALLOWED_SCREENSHOT_SUFFIXES.has(suffixMatch[1])) {
      throw new Error(`許可されていないスクリーンショット名: ${basename}`);
    }
    const normalizedPath = path.resolve(savePath);
    const screenshotDir = path.resolve(settings.getScreenshotDir());
    if (!isPathInsideDirectory(screenshotDir, normalizedPath)) {
      throw new Error(`パストラバーサル検出: screenshotDir 外への書き込みは禁止です`);
    }

    const dir = path.dirname(normalizedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const image = await session.view.webContents.capturePage();
    fs.writeFileSync(normalizedPath, image.toPNG());
    session.screenshotPath = normalizedPath;

    return normalizedPath;
  }

  // ── View display ─────────────────────────────────────────────────────

  showSession(sessionId) {
    if (this._activeSessionId && this._activeSessionId !== sessionId) {
      this._removeFromWindow(this._activeSessionId);
    }
    this._activeSessionId = sessionId;
    this._positionView(sessionId);
  }

  hideCurrentSession() {
    if (this._activeSessionId) {
      this._removeFromWindow(this._activeSessionId);
      this._activeSessionId = null;
    }
  }

  // Called by electron-main on window resize
  onWindowResize() {
    if (this._activeSessionId) this._positionView(this._activeSessionId);
  }

  _positionView(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const win = this._getMainWindow();
    if (!win || win.isDestroyed()) return;

    const [winW, winH] = win.getContentSize();
    const x = Math.floor(winW * PANEL_LEFT_RATIO);
    const y = HEADER_HEIGHT;
    const w = winW - x;
    const h = winH - y;

    const cv = win.contentView;
    if (!cv.children.includes(session.view)) cv.addChildView(session.view);
    session.view.setBounds({ x, y, width: w, height: h });
  }

  _removeFromWindow(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const win = this._getMainWindow();
    if (!win || win.isDestroyed()) return;
    try { win.contentView.removeChildView(session.view); } catch (_) {}
  }

  // ── Query ────────────────────────────────────────────────────────────

  getSession(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      companyNo: s.companyNo,
      formUrl: s.formUrl,
      status: s.status,
      screenshotPath: s.screenshotPath,
      blockedUrl: s.blockedUrl,
      blockedReason: s.blockedReason,
      isActive: this._activeSessionId === s.id,
    };
  }

  listSessions() {
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      companyNo: s.companyNo,
      formUrl: s.formUrl,
      status: s.status,
      blockedUrl: s.blockedUrl,
      blockedReason: s.blockedReason,
      isActive: this._activeSessionId === s.id,
    }));
  }

  get activeSessionId() {
    return this._activeSessionId;
  }
}

module.exports = { FormSessionManager };
