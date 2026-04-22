'use strict';

const fs = require('fs');
const crypto = require('crypto');

// WebContentsView bounds for the form review pane (right 55% of content area)
const HEADER_HEIGHT = 56;
const PANEL_LEFT_RATIO = 0.45; // dashboard left panel takes 45%

class FormSessionManager {
  constructor(getMainWindow) {
    this._getMainWindow = getMainWindow;
    // sessionId → { id, view, formUrl, companyNo, status, screenshotPath }
    this._sessions = new Map();
    this._activeSessionId = null;
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  async createSession(formUrl, companyNo) {
    let WebContentsView;
    try {
      ({ WebContentsView } = require('electron'));
    } catch {
      throw new Error('WebContentsView はElectronモードでのみ利用できます');
    }

    const id = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    this._sessions.set(id, {
      id,
      view,
      formUrl,
      companyNo: String(companyNo),
      status: 'loading',
      screenshotPath: null,
    });

    view.webContents.loadURL(formUrl);

    // Wait for DOM ready (with timeout)
    await this._waitForLoad(id, 20000);
    return id;
  }

  async _waitForLoad(sessionId, timeout = 20000) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.status = 'load_timeout';
        resolve(); // timeout はエラーにせず続行（部分ロードでも構造取得を試みる）
      }, timeout);

      const onReady = () => {
        clearTimeout(timer);
        session.status = 'loaded';
        resolve();
      };

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

    const dir = require('path').dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const image = await session.view.webContents.capturePage();
    fs.writeFileSync(savePath, image.toPNG());
    session.screenshotPath = savePath;

    return savePath;
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
      isActive: this._activeSessionId === s.id,
    };
  }

  listSessions() {
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      companyNo: s.companyNo,
      formUrl: s.formUrl,
      status: s.status,
      isActive: this._activeSessionId === s.id,
    }));
  }

  get activeSessionId() {
    return this._activeSessionId;
  }
}

module.exports = { FormSessionManager };
