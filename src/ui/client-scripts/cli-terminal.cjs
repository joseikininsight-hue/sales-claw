'use strict';

/**
 * CLI Activity タブ内蔵ターミナル + 認証エラー時のアシスト UI。
 *
 * - Claude / Codex / Gemini ボタンクリックで POST /api/launch-ai
 * - 既存 WebSocket (/terminal) に接続し、PTY 出力を xterm.js に流す
 * - 「Please run /login」「API Error: 401」など認証失敗パターンを検出して
 *   親切な案内バナーを自動表示し、「/login を実行」ボタンで自動入力する
 * - dashboard-server.cjs の buildPage() が <script> 内で展開する
 */

const STYLE = [
  '.cli-term-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);margin-bottom:12px;overflow:hidden;color:var(--text-1)}',
  '.cli-term-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,rgba(37,99,235,.05) 0%,transparent 60%)}',
  '.cli-term-title{display:flex;align-items:center;gap:8px;font-size:.78rem;font-weight:700;color:var(--text-1);letter-spacing:.02em}',
  '.cli-term-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--radius-pill)!important;background:var(--primary-glow);color:var(--primary);font-size:.62rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
  '.cli-term-status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--text-3)}',
  '.cli-term-status-dot.on{background:var(--success);box-shadow:0 0 0 0 rgba(5,150,105,.5);animation:cliPulse 2s infinite}',
  '.cli-term-status-dot.err{background:var(--error)}',
  '@keyframes cliPulse{0%{box-shadow:0 0 0 0 rgba(5,150,105,.5)}70%{box-shadow:0 0 0 6px rgba(5,150,105,0)}100%{box-shadow:0 0 0 0 rgba(5,150,105,0)}}',
  '.cli-term-launchers{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.cli-term-launch{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:.74rem;font-weight:700;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-launch:hover{background:var(--bg-raised);border-color:var(--border-strong);transform:translateY(-1px);box-shadow:var(--shadow-xs)}',
  '.cli-term-launch.claude:hover{border-color:#CC785C;background:#fff7f3}',
  '.cli-term-launch.codex:hover{border-color:#10a37f;background:#f0fdf8}',
  '.cli-term-launch.gemini:hover{border-color:#4285F4;background:#f0f4ff}',
  '.cli-term-launch[disabled]{opacity:.5;cursor:not-allowed!important;pointer-events:none}',
  '.cli-term-launch.active{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
  '.cli-term-launch-icon{width:16px;height:16px;flex-shrink:0}',
  '.cli-term-stop{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;font-size:.74rem;font-weight:700;border:1px solid rgba(220,38,38,.4);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--error);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-stop:hover:not([disabled]){background:var(--error-dim);border-color:var(--error)}',
  '.cli-term-stop[disabled]{opacity:.4;cursor:not-allowed!important}',
  '.cli-term-empty{padding:36px 24px;text-align:center;background:var(--bg-surface)}',
  '.cli-term-empty-illust{display:flex;justify-content:center;margin-bottom:8px}',
  '.cli-term-empty-title{font-size:.86rem;font-weight:700;margin:0 0 6px;color:var(--text-1)}',
  '.cli-term-empty-sub{font-size:.74rem;color:var(--text-2);margin:0 0 4px;line-height:1.6}',
  '.cli-term-empty-hint{font-size:.68rem;color:var(--text-3);margin:0;font-style:italic}',
  '.cli-term-host{height:380px;background:#0b0e14;padding:8px;position:relative}',
  '.cli-term-host .xterm{height:100%;padding:0 4px}',
  '.cli-term-host .xterm-viewport{background-color:transparent!important}',
  '.cli-term-auth-help{display:flex;gap:14px;padding:14px 18px;background:linear-gradient(135deg,rgba(217,119,6,.08) 0%,rgba(217,119,6,.02) 70%);border-bottom:1px solid rgba(217,119,6,.25);animation:cliFade .18s ease}',
  '@keyframes cliFade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
  '.cli-term-auth-help-icon{width:36px;height:36px;border-radius:10px;background:var(--warning-dim);color:var(--warning);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.cli-term-auth-help-body{flex:1;min-width:0}',
  '.cli-term-auth-help-body h4{margin:0 0 4px;font-size:.86rem;font-weight:800;color:var(--warning)}',
  '.cli-term-auth-help-body p{margin:0 0 8px;font-size:.74rem;color:var(--text-2);line-height:1.6}',
  '.cli-term-auth-help-steps{margin:6px 0 10px;padding-left:22px;font-size:.72rem;color:var(--text-1);line-height:1.7}',
  '.cli-term-auth-help-steps li{margin-bottom:2px}',
  '.cli-term-auth-help-steps code{font-family:var(--font-mono);background:var(--bg-raised);padding:1px 6px;border-radius:4px;font-size:.7rem;color:var(--primary)}',
  '.cli-term-auth-help-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.cli-term-auth-help-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;font-size:.74rem;font-weight:700;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;text-decoration:none;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-auth-help-btn:hover{background:var(--bg-raised);border-color:var(--border-strong)}',
  '.cli-term-auth-help-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
  '.cli-term-auth-help-btn.primary:hover{background:var(--primary-dim);border-color:var(--primary-dim)}',
  '.cli-term-auth-help-btn.link{color:var(--primary);text-decoration:none}',
  '.cli-term-auth-help-btn.link:hover{background:var(--primary-glow)}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__cliTerminalInit) return;
  window.__cliTerminalInit = true;

  var STYLE_ID = 'cli-terminal-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }
  ensureStyle();

  // ---- DOM refs (available after DOMContentLoaded) ----
  var refs = {};
  function bindRefs() {
    refs.card     = document.getElementById('cliTerminalCard');
    refs.empty    = document.getElementById('cliTermEmpty');
    refs.host     = document.getElementById('cliTermHost');
    refs.badge    = document.getElementById('cliTermProviderBadge');
    refs.statusDot= document.getElementById('cliTermStatusDot');
    refs.stop     = refs.card && refs.card.querySelector('[data-cli-stop]');
    refs.help     = document.getElementById('cliTermAuthHelp');
    refs.helpTitle= document.getElementById('cliTermAuthHelpTitle');
    refs.helpDesc = document.getElementById('cliTermAuthHelpDesc');
    refs.launchers= refs.card ? refs.card.querySelectorAll('[data-cli-launch]') : [];
  }

  // ---- xterm runtime ----
  var term = null;
  var fitAddon = null;
  var ws = null;
  var currentProvider = null;
  var helpDismissed = false;
  var streamBuffer = '';

  var PROVIDER_LABELS = {
    claude: 'Claude',
    codex:  'Codex',
    gemini: 'Gemini'
  };

  function ensureTerm() {
    if (term) return term;
    if (!refs.host) return null;
    if (typeof window.Terminal !== 'function') {
      // xterm.js not loaded yet — defer a tick
      return null;
    }
    term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono","Fira Code",ui-monospace,monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      convertEol: true,
      theme: {
        background: '#0b0e14',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0b0e14',
        selectionBackground: 'rgba(88,166,255,.35)',
        black:'#0b0e14',red:'#ff7b72',green:'#7ee787',yellow:'#f2cc60',
        blue:'#79c0ff',magenta:'#d2a8ff',cyan:'#a5d6ff',white:'#c9d1d9',
        brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',
        brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
        brightCyan:'#a5d6ff',brightWhite:'#f0f6fc'
      }
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      try {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      } catch (_) {}
    }

    term.open(refs.host);
    setTimeout(function(){ try { fitAddon && fitAddon.fit(); } catch(_){} }, 60);

    term.onData(function(data) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: data }));
      }
    });
    term.onResize(function(size) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    var ro = new ResizeObserver(function(){
      try { fitAddon && fitAddon.fit(); } catch(_){}
    });
    ro.observe(refs.host);

    return term;
  }

  function setStatus(state, label) {
    if (!refs.statusDot) return;
    refs.statusDot.classList.remove('on','off','err');
    refs.statusDot.classList.add(state || 'off');
    refs.statusDot.title = label || '';
  }

  function showProviderBadge(provider) {
    if (!refs.badge) return;
    if (!provider) { refs.badge.style.display = 'none'; return; }
    refs.badge.textContent = PROVIDER_LABELS[provider] || provider;
    refs.badge.style.display = 'inline-flex';
  }

  function setLauncherActive(provider) {
    if (!refs.launchers) return;
    refs.launchers.forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-cli-launch') === provider);
    });
    if (refs.stop) refs.stop.disabled = !provider;
  }

  // ---- Auth-error detection ----
  // Pattern matches Claude Code and similar CLIs
  var AUTH_PATTERNS = [
    { re: new RegExp('Please run \\\\/login', 'i'),         title: 'Claude のログインが必要です',          desc: 'Claude Code がログイン期限切れを検出しました。下のボタンで自動入力できます。' },
    { re: new RegExp('API Error:\\\\s*401', 'i'),           title: 'API 認証エラー (401)',                 desc: 'API キー / OAuth トークンが無効か期限切れです。再ログインしてください。' },
    { re: new RegExp('authentication_error', 'i'),          title: '認証エラー',                            desc: 'CLI の認証に失敗しました。再ログインで解消します。' },
    { re: new RegExp('Invalid (?:API key|credentials?)', 'i'),title: '認証情報が無効です',                  desc: '保存されている認証情報が無効です。再ログインしてください。' },
    { re: new RegExp('token (?:has )?expired', 'i'),        title: 'トークン期限切れ',                      desc: 'OAuth トークンが期限切れです。再ログインで延長されます。' }
  ];

  function detectAuthError(chunk) {
    if (helpDismissed) return;
    streamBuffer += chunk;
    if (streamBuffer.length > 16000) streamBuffer = streamBuffer.slice(-8000);
    for (var i = 0; i < AUTH_PATTERNS.length; i++) {
      var p = AUTH_PATTERNS[i];
      if (p.re.test(streamBuffer)) {
        showAuthHelp(p.title, p.desc);
        return;
      }
    }
  }

  function showAuthHelp(title, desc) {
    if (!refs.help) return;
    if (refs.help.style.display !== 'none') return;
    if (refs.helpTitle && title) refs.helpTitle.textContent = title;
    if (refs.helpDesc && desc) refs.helpDesc.textContent = desc;
    refs.help.style.display = 'flex';
  }
  function hideAuthHelp() {
    if (refs.help) refs.help.style.display = 'none';
    helpDismissed = true;
  }

  // ---- WebSocket connection ----
  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return ws;
    var url;
    try {
      url = (typeof createSessionWebSocket === 'function')
        ? null  // use the helper directly below
        : null;
    } catch (_) {}
    try {
      ws = (typeof createSessionWebSocket === 'function')
        ? createSessionWebSocket('/terminal')
        : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal');
    } catch (e) {
      return null;
    }

    ws.addEventListener('open', function(){
      setStatus('on', 'WebSocket connected');
      try {
        if (term && fitAddon) {
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch(_){}
    });
    ws.addEventListener('close', function(){
      setStatus('off', 'WebSocket disconnected');
      setLauncherActive(null);
      currentProvider = null;
    });
    ws.addEventListener('error', function(){
      setStatus('err', 'WebSocket error');
    });
    ws.addEventListener('message', function(ev){
      try {
        var payload = JSON.parse(ev.data);
        var data = payload.data || payload.text || '';
        if (payload.type === 'data' || payload.type === 'pty' || (typeof data === 'string' && data)) {
          if (term && data) {
            term.write(data);
            detectAuthError(data);
          }
        } else if (payload.type === 'connected') {
          if (payload.running && payload.provider) {
            currentProvider = payload.provider;
            setLauncherActive(payload.provider);
            showProviderBadge(payload.provider);
          }
        } else if (payload.type === 'exit' || payload.type === 'closed') {
          setStatus('off', 'PTY exited');
          setLauncherActive(null);
          currentProvider = null;
          showProviderBadge(null);
          if (term) term.writeln('\\r\\n\\x1b[2m[session ended]\\x1b[0m');
        }
      } catch (_) {
        // raw text fallback
        if (term && typeof ev.data === 'string') {
          term.write(ev.data);
          detectAuthError(ev.data);
        }
      }
    });
    return ws;
  }

  // ---- Launch / stop ----
  async function launch(provider) {
    if (!provider) return;
    if (refs.empty) refs.empty.style.display = 'none';
    if (refs.host) refs.host.style.display = 'block';
    helpDismissed = false;
    streamBuffer = '';
    ensureTerm();
    if (!term) {
      // xterm not loaded yet — wait briefly and retry
      setTimeout(function(){ launch(provider); }, 120);
      return;
    }
    showProviderBadge(provider);
    setLauncherActive(provider);
    setStatus('on', 'launching ' + provider);
    term.focus();
    try {
      var res = await window.fetch('/api/launch-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider, mode: 'default' })
      });
      var json = await res.json().catch(function(){ return null; });
      if (!res.ok || (json && json.ok === false)) {
        var msg = (json && (json.error || json.message)) || ('HTTP ' + res.status);
        if (term) term.writeln('\\r\\n\\x1b[31m[launch failed] ' + msg + '\\x1b[0m');
        setStatus('err', 'launch failed');
        setLauncherActive(null);
        return;
      }
      currentProvider = provider;
      connectWs();
    } catch (e) {
      if (term) term.writeln('\\r\\n\\x1b[31m[launch failed] ' + (e && e.message || e) + '\\x1b[0m');
      setStatus('err', 'launch failed');
      setLauncherActive(null);
    }
  }

  async function stop() {
    try {
      await window.fetch('/api/stop-ai', { method: 'POST' });
    } catch (_) {}
    try { if (ws) ws.close(); } catch(_){}
    setLauncherActive(null);
    setStatus('off', 'stopped');
    showProviderBadge(null);
    currentProvider = null;
    if (term) term.writeln('\\r\\n\\x1b[2m[stop requested]\\x1b[0m');
  }

  function typeLogin() {
    if (!ws || ws.readyState !== 1) {
      // Re-launch claude first
      launch('claude').then(function(){
        setTimeout(function(){ typeLoginNow(); }, 800);
      });
      return;
    }
    typeLoginNow();
  }
  function typeLoginNow() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', data: '/login\\r' }));
    if (term) term.focus();
    hideAuthHelp();
  }

  // ---- Event delegation ----
  function bindEvents() {
    if (!refs.card) return;
    refs.card.addEventListener('click', function(ev){
      var launchBtn = ev.target.closest && ev.target.closest('[data-cli-launch]');
      if (launchBtn) {
        ev.preventDefault();
        launch(launchBtn.getAttribute('data-cli-launch'));
        return;
      }
      var stopBtn = ev.target.closest && ev.target.closest('[data-cli-stop]');
      if (stopBtn && !stopBtn.disabled) {
        ev.preventDefault();
        stop();
        return;
      }
      var actionEl = ev.target.closest && ev.target.closest('[data-cli-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-cli-action');
        if (action === 'type-login') {
          ev.preventDefault();
          typeLogin();
        } else if (action === 'dismiss-help') {
          ev.preventDefault();
          hideAuthHelp();
        }
      }
    });
  }

  function init() {
    bindRefs();
    if (!refs.card) return;
    setStatus('off', 'idle');
    bindEvents();

    // Detect existing running session — server sends {type:'connected', running:true, provider} once we connect
    // Lazily connect to surface that state.
    setTimeout(connectWs, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderCliTerminalScript() {
  return SCRIPT;
};
