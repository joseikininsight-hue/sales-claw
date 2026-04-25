'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const settings = require('./settings-manager.cjs');
const { getProvider, normalizeProviderId } = require('./ai-providers.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

function getRuntimeRoot() {
  return typeof settings.getRuntimeRoot === 'function'
    ? settings.getRuntimeRoot()
    : path.join(os.homedir(), '.sales-claw');
}

function getToolchainRoot() {
  return path.join(getRuntimeRoot(), 'tools');
}

function getBinDir() {
  return path.join(getToolchainRoot(), 'bin');
}

function getNpmProjectDir() {
  return path.join(getToolchainRoot(), 'npm-project');
}

function getNpmBinDir() {
  return path.join(getNpmProjectDir(), 'node_modules', '.bin');
}

function getNpmCacheDir() {
  return path.join(getToolchainRoot(), 'npm-cache');
}

function getPlaywrightBrowsersDir() {
  return path.join(getToolchainRoot(), 'browsers');
}

function packageRoot(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function getNpmCliPath() {
  return path.join(packageRoot('npm'), 'bin', 'npm-cli.js');
}

function getNpxCliPath() {
  return path.join(packageRoot('npm'), 'bin', 'npx-cli.js');
}

function getPlaywrightMcpCliPath() {
  return path.join(packageRoot('@playwright/mcp'), 'cli.js');
}

function quoteCmdPath(value) {
  return String(value || '').replace(/"/g, '""');
}

function writeFileIfChanged(filePath, content, mode) {
  let current = null;
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (current !== content) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  if (mode && process.platform !== 'win32') {
    try { fs.chmodSync(filePath, mode); } catch (_) {}
  }
}

function getNodeShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'node.cmd' : 'node');
}

function getNpmShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

function getNpxShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'npx.cmd' : 'npx');
}

function getPlaywrightMcpWrapperPath() {
  return path.join(getBinDir(), 'playwright-mcp-wrapper.cjs');
}

function getPlaywrightMcpCommandPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'playwright-mcp.cmd' : 'playwright-mcp');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureNpmProject() {
  const projectDir = getNpmProjectDir();
  ensureDir(projectDir);
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify({
      private: true,
      name: 'sales-claw-local-tools',
      description: 'Sales Claw managed CLI toolchain. Do not edit manually.',
      version: '1.0.0',
      dependencies: {},
    }, null, 2), 'utf8');
  }
}

function buildPlaywrightWrapperScript() {
  return `'use strict';

const fs = require('fs');
const path = require('path');

const browsersPath = ${JSON.stringify(getPlaywrightBrowsersDir())};
const mcpCliPath = ${JSON.stringify(getPlaywrightMcpCliPath())};

function findChromiumExecutable(root) {
  const subpaths = process.platform === 'win32'
    ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin'
      ? [['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((entryPath) => /(?:^|[\\\\/])chromium-|(?:^|[\\\\/])chrome-for-testing-/.test(entryPath));
  } catch (_) {
    entries = [];
  }
  entries.sort().reverse();
  for (const entry of entries) {
    for (const parts of subpaths) {
      const candidate = path.join(entry, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || browsersPath;
process.env.PLAYWRIGHT_MCP_BROWSER = process.env.PLAYWRIGHT_MCP_BROWSER || 'chromium';
process.env.PWMCP_PROFILES_DIR_FOR_TEST = process.env.PWMCP_PROFILES_DIR_FOR_TEST || path.join(browsersPath, '..', 'mcp-profiles');

if (!process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH) {
  const executable = findChromiumExecutable(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (executable) process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = executable;
}

process.argv = [process.execPath, mcpCliPath, ...process.argv.slice(2)];
require(mcpCliPath);
`;
}

function ensureToolchainFiles() {
  const binDir = getBinDir();
  ensureDir(binDir);
  ensureDir(getNpmCacheDir());
  ensureDir(getPlaywrightBrowsersDir());
  ensureNpmProject();

  const electronNode = quoteCmdPath(process.execPath);
  const npmCli = quoteCmdPath(getNpmCliPath());
  const npxCli = quoteCmdPath(getNpxCliPath());
  const wrapperPath = quoteCmdPath(getPlaywrightMcpWrapperPath());

  if (process.platform === 'win32') {
    writeFileIfChanged(getNodeShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_ELECTRON_NODE=${electronNode}"`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%SALES_CLAW_ELECTRON_NODE%" %*',
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getNpmShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_NPM_CLI=${npmCli}"`,
      `call "%~dp0node.cmd" "%SALES_CLAW_NPM_CLI%" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getNpxShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_NPX_CLI=${npxCli}"`,
      `call "%~dp0node.cmd" "%SALES_CLAW_NPX_CLI%" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getPlaywrightMcpCommandPath(), [
      '@echo off',
      'setlocal',
      `set "PLAYWRIGHT_BROWSERS_PATH=${quoteCmdPath(getPlaywrightBrowsersDir())}"`,
      'set "PLAYWRIGHT_MCP_BROWSER=chromium"',
      `call "%~dp0node.cmd" "${wrapperPath}" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
  } else {
    const escapedExecPath = String(process.execPath).replace(/'/g, `'\\''`);
    writeFileIfChanged(getNodeShimPath(), [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      `exec '${escapedExecPath}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getNpmShimPath(), [
      '#!/bin/sh',
      `exec "${getNodeShimPath()}" '${getNpmCliPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getNpxShimPath(), [
      '#!/bin/sh',
      `exec "${getNodeShimPath()}" '${getNpxCliPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getPlaywrightMcpCommandPath(), [
      '#!/bin/sh',
      `export PLAYWRIGHT_BROWSERS_PATH='${getPlaywrightBrowsersDir().replace(/'/g, `'\\''`)}'`,
      'export PLAYWRIGHT_MCP_BROWSER="${PLAYWRIGHT_MCP_BROWSER:-chromium}"',
      `exec "${getNodeShimPath()}" '${getPlaywrightMcpWrapperPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
  }

  writeFileIfChanged(getPlaywrightMcpWrapperPath(), buildPlaywrightWrapperScript());

  return {
    root: getToolchainRoot(),
    binDir,
    npmProjectDir: getNpmProjectDir(),
    npmBinDir: getNpmBinDir(),
    npmCacheDir: getNpmCacheDir(),
    browsersDir: getPlaywrightBrowsersDir(),
    nodeShim: getNodeShimPath(),
    npmShim: getNpmShimPath(),
    npxShim: getNpxShimPath(),
    playwrightMcpCommand: getPlaywrightMcpCommandPath(),
  };
}

function pathKeyForEnv(env) {
  return Object.keys(env || {}).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prependPath(env, entries) {
  const key = pathKeyForEnv(env);
  const delimiter = path.delimiter;
  const current = String(env[key] || '');
  const cleanEntries = entries.filter(Boolean);
  env[key] = [...cleanEntries, current].filter(Boolean).join(delimiter);
  if (process.platform === 'win32' && key !== 'Path') {
    env.Path = env[key];
  }
  return env;
}

function buildToolEnv(baseEnv = process.env) {
  const files = ensureToolchainFiles();
  const env = { ...(baseEnv || {}) };
  env.SALES_CLAW_TOOLCHAIN_ROOT = files.root;
  env.SALES_CLAW_ELECTRON_NODE = process.execPath;
  env.PLAYWRIGHT_BROWSERS_PATH = files.browsersDir;
  env.NPM_CONFIG_CACHE = files.npmCacheDir;
  env.NPM_CONFIG_PREFIX = files.npmProjectDir;
  env.npm_config_cache = files.npmCacheDir;
  env.npm_config_prefix = files.npmProjectDir;
  prependPath(env, [files.binDir, files.npmBinDir]);
  return env;
}

function runProcess(command, args = [], options = {}) {
  const timeoutMs = options.timeout || PROCESS_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer || 4 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: options.env || process.env,
      shell: false,
      windowsHide: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr,
        error: timedOut ? new Error(`Process timed out after ${timeoutMs}ms`) : null,
        timedOut,
      });
    });
  });
}

function buildEmbeddedNodeEnv(extraEnv = {}) {
  const env = buildToolEnv({ ...process.env, ...(extraEnv || {}) });
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function runEmbeddedNode(args = [], options = {}) {
  return runProcess(process.execPath, args, {
    ...options,
    env: buildEmbeddedNodeEnv(options.env),
  });
}

async function runEmbeddedNpm(args = [], options = {}) {
  ensureToolchainFiles();
  return runEmbeddedNode([getNpmCliPath(), ...args], options);
}

async function probeEmbeddedNpmStatus() {
  try {
    ensureToolchainFiles();
    if (!fs.existsSync(getNpmCliPath())) {
      return {
        available: false,
        source: 'embedded',
        version: null,
        error: 'Bundled npm package is missing from the application.',
        command: getNpmShimPath(),
      };
    }
    const result = await runEmbeddedNpm(['--version'], { timeout: 15000 });
    const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].trim();
    return {
      available: result.ok && !!version,
      source: 'embedded',
      version: version || null,
      error: result.ok && version ? null : String(result.stderr || result.stdout || result.error?.message || 'Bundled npm did not respond.').trim(),
      command: getNpmShimPath(),
    };
  } catch (error) {
    return {
      available: false,
      source: 'embedded',
      version: null,
      error: error.message,
      command: getNpmShimPath(),
    };
  }
}

function findChromiumExecutable(root = getPlaywrightBrowsersDir()) {
  const subpaths = process.platform === 'win32'
    ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin'
      ? [['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((entryPath) => /(?:^|[\\/])chromium-|(?:^|[\\/])chrome-for-testing-/.test(entryPath));
  } catch (_) {
    entries = [];
  }
  entries.sort().reverse();
  for (const entry of entries) {
    for (const parts of subpaths) {
      const candidate = path.join(entry, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function installPlaywrightChromium(options = {}) {
  ensureToolchainFiles();
  const existing = findChromiumExecutable();
  if (existing && !options.force) {
    return {
      ok: true,
      reused: true,
      browser: 'chromium',
      executablePath: existing,
      browsersDir: getPlaywrightBrowsersDir(),
      command: 'bundled @playwright/mcp install-browser chromium',
    };
  }

  const result = await runEmbeddedNode([getPlaywrightMcpCliPath(), 'install-browser', 'chromium'], {
    timeout: options.timeout || PROCESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const executablePath = findChromiumExecutable();
  return {
    ok: result.ok && !!executablePath,
    reused: false,
    browser: 'chromium',
    executablePath,
    browsersDir: getPlaywrightBrowsersDir(),
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok && executablePath ? null : String(result.stderr || result.stdout || result.error?.message || 'Chromium installation did not complete.').trim(),
    command: 'bundled @playwright/mcp install-browser chromium',
  };
}

async function probePlaywrightMcpStatus() {
  try {
    ensureToolchainFiles();
    const result = await runEmbeddedNode([getPlaywrightMcpWrapperPath(), '--help'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const output = String(result.stdout || result.stderr || '').trim();
    const available = result.ok && /Usage: Playwright MCP/i.test(output);
    const executablePath = findChromiumExecutable();
    return {
      available,
      browserInstalled: !!executablePath,
      executablePath,
      browsersDir: getPlaywrightBrowsersDir(),
      command: getPlaywrightMcpCommandPath(),
      source: 'bundled',
      error: available ? null : (output || String(result.error?.message || 'Playwright MCP bootstrap check failed.').trim()),
    };
  } catch (error) {
    return {
      available: false,
      browserInstalled: false,
      executablePath: null,
      browsersDir: getPlaywrightBrowsersDir(),
      command: getPlaywrightMcpCommandPath(),
      source: 'bundled',
      error: error.message,
    };
  }
}

function getPlaywrightMcpCommandSpec() {
  ensureToolchainFiles();
  return {
    command: getPlaywrightMcpCommandPath(),
    args: [],
    env: {
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersDir(),
      PLAYWRIGHT_MCP_BROWSER: 'chromium',
    },
  };
}

function getProviderExecutableCandidates(providerId) {
  const provider = getProvider(normalizeProviderId(providerId));
  ensureToolchainFiles();
  const binDir = getNpmBinDir();
  const names = new Set();
  for (const executableName of provider.executableNames || []) {
    names.add(executableName);
    names.add(path.parse(executableName).name);
  }
  names.add(provider.id);

  const candidates = [];
  for (const name of names) {
    if (!name) continue;
    candidates.push(path.join(binDir, name));
    if (process.platform === 'win32' && !/\.(cmd|exe|ps1)$/i.test(name)) {
      candidates.push(path.join(binDir, `${name}.cmd`));
      candidates.push(path.join(binDir, `${name}.exe`));
      candidates.push(path.join(binDir, `${name}.ps1`));
    }
  }
  return Array.from(new Set(candidates.map((entry) => path.resolve(entry))));
}

async function installProviderCli(providerId, options = {}) {
  const provider = getProvider(normalizeProviderId(providerId));
  ensureToolchainFiles();
  const npmStatus = await probeEmbeddedNpmStatus();
  if (!npmStatus.available) {
    return {
      ok: false,
      provider: provider.id,
      providerLabel: provider.displayName,
      error: npmStatus.error || 'Bundled npm is unavailable.',
      command: getProviderInstallCommand(provider.id),
    };
  }

  const args = [
    'install',
    '--prefix', getNpmProjectDir(),
    '--cache', getNpmCacheDir(),
    '--no-audit',
    '--no-fund',
    '--save-exact',
    provider.installPackage,
  ];
  const result = await runEmbeddedNpm(args, {
    timeout: options.timeout || PROCESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const candidates = getProviderExecutableCandidates(provider.id).filter((entry) => fs.existsSync(entry));
  return {
    ok: result.ok && candidates.length > 0,
    provider: provider.id,
    providerLabel: provider.displayName,
    packageName: provider.installPackage,
    executablePath: candidates[0] || null,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok && candidates.length > 0
      ? null
      : String(result.stderr || result.stdout || result.error?.message || `${provider.cliLabel} was not detected after installation.`).trim(),
    command: getProviderInstallCommand(provider.id),
  };
}

function getProviderInstallCommand(providerId) {
  const provider = getProvider(normalizeProviderId(providerId));
  return `Sales Claw embedded npm install ${provider.installPackage}`;
}

async function installAiRuntime(providerId, options = {}) {
  const provider = getProvider(normalizeProviderId(providerId));
  const cli = await installProviderCli(provider.id, options);
  if (!cli.ok) return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli };

  const playwright = await installPlaywrightChromium(options);
  if (!playwright.ok) return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli, playwright };

  return {
    ok: true,
    provider: provider.id,
    providerLabel: provider.displayName,
    cli,
    playwright,
  };
}

module.exports = {
  buildToolEnv,
  ensureToolchainFiles,
  findChromiumExecutable,
  getBinDir,
  getNpmBinDir,
  getNpmCacheDir,
  getNpmProjectDir,
  getPlaywrightBrowsersDir,
  getPlaywrightMcpCommandSpec,
  getPlaywrightMcpCommandPath,
  getProviderExecutableCandidates,
  getProviderInstallCommand,
  getToolchainRoot,
  installAiRuntime,
  installPlaywrightChromium,
  installProviderCli,
  probeEmbeddedNpmStatus,
  probePlaywrightMcpStatus,
  runEmbeddedNode,
  runEmbeddedNpm,
};
