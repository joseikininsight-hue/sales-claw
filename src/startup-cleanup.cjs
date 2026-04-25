'use strict';

/**
 * 起動時クリーンアップユーティリティ
 *
 * data ディレクトリに残存する `.tmp.<PID>` / `.lock` ファイルのうち、
 * 一定時間以上古いものを削除する。並列書き込み失敗や異常終了で
 * 残ったゴミファイルを、アプリ起動時にまとめて掃除するために使う。
 *
 * - ログ出力はせず、結果オブジェクトを返すので、呼び出し側で
 *   出力制御する（console.log などは呼び出し側で）
 * - テスト容易性のため、オプションで `dataDir` / `maxAgeMs` / `now`
 *   を差し替え可能
 */

const fs = require('fs');
const path = require('path');
const { getDataDir, PROJECT_ROOT } = require('./data-paths.cjs');

/** デフォルトの「古い」閾値: 24 時間 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `foo.json.tmp.12345` のような一時書き込みファイル */
const TMP_PATTERN = /\.tmp\.\d+$/;

/** `foo.lock` のようなロックファイル */
const LOCK_PATTERN = /\.lock$/;

/**
 * 誤爆防止: これらの名前は古くても削除しない。
 * 稼働中プロセスが抱えているロックが 24h 以上生きていることは稀だが、
 * 保険として重要ロックを明示的に保護する。
 */
const PROTECTED_NAMES = new Set([
  'action-log.json.lock',
  'contact-history.json.lock',
  'live-monitor.json.lock',
  'settings.json.lock',
]);

/** サブディレクトリ再帰上限（recovery/ など 1 階層で十分） */
const MAX_SUBDIR_DEPTH = 2;

function isPathInsideRoot(target, root) {
  if (!root) return true; // PROJECT_ROOT 未設定環境は素通し
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * data ディレクトリ直下の古い tmp / lock ファイルを削除する。
 *
 * @param {Object} [options]
 * @param {string} [options.dataDir]  走査対象ディレクトリ（省略時は getDataDir()）
 * @param {number} [options.maxAgeMs] この ms より古いファイルを削除（省略時は 24h）
 * @param {number} [options.now]      現在時刻(ms)。テスト用に固定可能（省略時は Date.now()）
 * @returns {{ removed: Array<{path:string, ageMs:number, kind:'tmp'|'lock'}>,
 *            errors: Array<{path:string, error:string}>,
 *            scanned: number }}
 *   - removed: 削除したファイル
 *   - errors:  削除時に発生したエラー
 *   - scanned: パターンに一致して検査対象となったファイル数
 */
function cleanupStaleFiles(options = {}) {
  const dir = options.dataDir || getDataDir();
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const now = options.now || Date.now();
  const allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
    ? options.allowedRoots
    : [PROJECT_ROOT, getDataDir()].filter(Boolean);
  const result = { removed: [], errors: [], scanned: 0 };

  if (!fs.existsSync(dir)) return result;

  // 安全チェック: 走査対象が許可されたルート配下かを検証（任意パス走査を防止）
  const resolvedDir = path.resolve(dir);
  const isAllowed = allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedDir === resolvedRoot || isPathInsideRoot(resolvedDir, resolvedRoot);
  });
  if (!isAllowed) {
    result.errors.push({ path: resolvedDir, error: 'directory outside allowed roots; skipped' });
    return result;
  }

  walk(resolvedDir, 0, maxAgeMs, now, result);
  return result;
}

function walk(dir, depth, maxAgeMs, now, result) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({ path: dir, error: err.message });
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth + 1 <= MAX_SUBDIR_DEPTH) walk(full, depth + 1, maxAgeMs, now, result);
      continue;
    }
    if (!entry.isFile()) continue;

    const isTmp = TMP_PATTERN.test(entry.name);
    const isLock = LOCK_PATTERN.test(entry.name);
    if (!isTmp && !isLock) continue;
    if (PROTECTED_NAMES.has(entry.name)) continue;

    result.scanned += 1;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const age = now - stat.mtimeMs;
      if (age < maxAgeMs) continue;
      fs.unlinkSync(full);
      result.removed.push({ path: full, ageMs: age, kind: isLock ? 'lock' : 'tmp' });
    } catch (err) {
      result.errors.push({ path: full, error: err.message });
    }
  }
}

module.exports = { cleanupStaleFiles, DEFAULT_MAX_AGE_MS };
