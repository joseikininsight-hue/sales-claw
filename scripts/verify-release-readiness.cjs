'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const CHECK_DIST = args.has('--dist');
const CHECK_INSTALLED = args.has('--installed');

const EXPECTED = {
  provider: 'github',
  owner: 'joseikininsight-hue',
  repo: 'sales-claw',
  channel: 'latest',
};

const REQUIRED_RUNTIME_DEPENDENCIES = [
  'electron-updater',
  'fs-extra',
  'universalify',
];

const failures = [];
const warnings = [];
const passes = [];

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readText(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function pass(message) {
  passes.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  failures.push(message);
}

function requireMatch(name, text, pattern, message) {
  if (pattern.test(text)) {
    pass(`${name}: ${message}`);
  } else {
    fail(`${name}: ${message}`);
  }
}

function requireContains(name, text, needle, message) {
  if (text.includes(needle)) {
    pass(`${name}: ${message}`);
  } else {
    fail(`${name}: ${message}`);
  }
}

function parseFlatYaml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('- ')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function parseLatestYaml(text) {
  const info = parseFlatYaml(text);
  const urls = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.match(/^\s*-\s+url:\s*(.+)\s*$/) || rawLine.match(/^\s+url:\s*(.+)\s*$/);
    if (match) urls.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return { info, urls };
}

function getPackageVersion() {
  const pkg = readJson('package.json');
  return pkg.version;
}

function checkSourceConfig() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const builder = readText('electron-builder.yml');
  const main = readText('electron-main.js');
  const workflow = readText('.github/workflows/release.yml');

  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    pass(`package.json: version ${pkg.version}`);
  } else {
    fail(`package.json: version must be semver, got ${pkg.version}`);
  }

  if (lock.version === pkg.version && lock.packages && lock.packages[''] && lock.packages[''].version === pkg.version) {
    pass('package-lock.json: root version matches package.json');
  } else {
    fail('package-lock.json: root version must match package.json');
  }

  if (pkg.build && pkg.build.extends === './electron-builder.yml') {
    pass('package.json: build extends electron-builder.yml');
  } else {
    fail('package.json: build.extends must be ./electron-builder.yml');
  }

  if (pkg.dependencies && pkg.dependencies['electron-updater']) {
    pass('package.json: electron-updater dependency is present');
  } else {
    fail('package.json: electron-updater dependency is required for desktop auto-update');
  }

  for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
    if (pkg.dependencies && pkg.dependencies[dependency]) {
      pass(`package.json: runtime dependency ${dependency} is declared`);
    } else {
      fail(`package.json: runtime dependency ${dependency} must be declared`);
    }
  }

  requireContains('electron-builder.yml', builder, 'provider: github', 'uses GitHub Releases provider');
  requireContains('electron-builder.yml', builder, `owner: ${EXPECTED.owner}`, `pins owner ${EXPECTED.owner}`);
  requireContains('electron-builder.yml', builder, `repo: ${EXPECTED.repo}`, `pins repo ${EXPECTED.repo}`);
  requireContains('electron-builder.yml', builder, `channel: ${EXPECTED.channel}`, `uses ${EXPECTED.channel} update channel`);
  requireContains('electron-builder.yml', builder, 'publishAutoUpdate: true', 'publishes auto-update metadata');
  requireContains('electron-builder.yml', builder, 'releaseType: release', 'uses non-draft release feed');
  requireContains('electron-builder.yml', builder, 'Sales-Claw-Setup-${version}.${ext}', 'Windows artifact name matches latest.yml references');

  for (const forbidden of ['${env.GH_OWNER}', '${env.GH_REPO}', 'owner: local-test', 'repo: local-test', 'your-org', 'your-username']) {
    if (builder.includes(forbidden)) {
      fail(`electron-builder.yml: forbidden placeholder/update feed remains: ${forbidden}`);
    }
  }

  for (const exclude of ['!dist/**', '!.claude/**', '!.electron-userdata/**', '!.aidesigner/**', '!.code-review-graph/**']) {
    requireContains('electron-builder.yml', builder, exclude, `excludes ${exclude} from packaged app`);
  }

  requireContains('electron-main.js', main, 'const { autoUpdater } = require(\'electron-updater\');', 'imports electron-updater');
  requireContains('electron-main.js', main, 'app-update.yml', 'reads packaged app-update.yml');
  requireContains('electron-main.js', main, 'checkForUpdates()', 'has automatic update check path');
  requireContains('electron-main.js', main, 'AUTO_UPDATE_ENABLED', 'guards update state explicitly');
  requireContains('electron-main.js', main, 'PLACEHOLDER_UPDATE_OWNERS', 'blocks local-test/placeholder update feeds');

  requireContains('.github/workflows/release.yml', workflow, 'npm ci', 'installs from lockfile');
  requireContains('.github/workflows/release.yml', workflow, 'dist/*.exe', 'uploads Windows installer');
  requireContains('.github/workflows/release.yml', workflow, 'dist/*.exe.blockmap', 'uploads Windows blockmap');
  requireContains('.github/workflows/release.yml', workflow, 'dist/latest*.yml', 'uploads latest update metadata');
  requireContains('.github/workflows/release.yml', workflow, 'softprops/action-gh-release', 'creates GitHub Release');
}

function checkDist() {
  const version = getPackageVersion();
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    fail('dist: directory does not exist; run npm run dist:win first');
    return;
  }

  const latestFiles = fs.readdirSync(distDir)
    .filter((name) => /^latest.*\.yml$/i.test(name))
    .map((name) => path.join(distDir, name));

  if (latestFiles.length === 0) {
    fail('dist: no latest*.yml update metadata was generated');
  }

  for (const latestPath of latestFiles) {
    const latest = parseLatestYaml(fs.readFileSync(latestPath, 'utf8'));
    const label = rel(latestPath);

    if (latest.info.version === version) {
      pass(`${label}: version matches package.json (${version})`);
    } else {
      fail(`${label}: version ${latest.info.version || '(missing)'} must match package.json ${version}`);
    }

    const referenced = new Set([latest.info.path, ...latest.urls].filter(Boolean));
    if (referenced.size === 0) {
      fail(`${label}: no artifact path/url found`);
    }

    for (const artifactName of referenced) {
      const artifactPath = path.join(distDir, artifactName);
      if (fs.existsSync(artifactPath)) {
        pass(`${label}: referenced artifact exists (${artifactName})`);
      } else {
        fail(`${label}: referenced artifact is missing (${artifactName})`);
      }

      if (/\.exe$/i.test(artifactName)) {
        const blockMapPath = `${artifactPath}.blockmap`;
        // electron-builder.yml で nsis.differentialPackage: false の場合 blockmap は生成されない。
        // その場合は blockmap 不存在を許容する。
        const builderYml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
        const differentialDisabled = /differentialPackage\s*:\s*false/i.test(builderYml);
        if (fs.existsSync(blockMapPath)) {
          pass(`${label}: Windows blockmap exists (${path.basename(blockMapPath)})`);
        } else if (differentialDisabled) {
          pass(`${label}: Windows blockmap intentionally absent (nsis.differentialPackage:false)`);
        } else {
          fail(`${label}: Windows blockmap is missing for ${artifactName}`);
        }
      }
    }
  }

  const winResources = path.join(distDir, 'win-unpacked', 'resources');
  if (fs.existsSync(winResources)) {
    const appUpdatePath = path.join(winResources, 'app-update.yml');
    if (!fs.existsSync(appUpdatePath)) {
      fail('dist/win-unpacked/resources/app-update.yml: missing packaged update feed');
    } else {
      const config = parseFlatYaml(fs.readFileSync(appUpdatePath, 'utf8'));
      checkUpdateFeedConfig(rel(appUpdatePath), config);
    }

    const packagedPackagePath = path.join(winResources, 'app', 'package.json');
    if (fs.existsSync(packagedPackagePath)) {
      const packagedPkg = JSON.parse(fs.readFileSync(packagedPackagePath, 'utf8'));
      if (packagedPkg.version === version) {
        pass(`${rel(packagedPackagePath)}: packaged version matches package.json`);
      } else {
        fail(`${rel(packagedPackagePath)}: packaged version ${packagedPkg.version} must match package.json ${version}`);
      }
    } else {
      fail(`${rel(packagedPackagePath)}: missing packaged package.json`);
    }

    for (const forbiddenDir of ['.claude', '.electron-userdata', '.aidesigner', '.code-review-graph', 'dist']) {
      const forbiddenPath = path.join(winResources, 'app', forbiddenDir);
      if (fs.existsSync(forbiddenPath)) {
        fail(`${rel(forbiddenPath)}: dev-only directory must not be packaged`);
      } else {
        pass(`${rel(forbiddenPath)}: dev-only directory is excluded`);
      }
    }

    for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
      const dependencyPath = path.join(winResources, 'app', 'node_modules', dependency, 'package.json');
      if (fs.existsSync(dependencyPath)) {
        const depPkg = JSON.parse(fs.readFileSync(dependencyPath, 'utf8'));
        pass(`${rel(dependencyPath)}: packaged runtime dependency ${dependency}@${depPkg.version} is present`);
      } else {
        fail(`${rel(dependencyPath)}: packaged runtime dependency ${dependency} is missing`);
      }
    }
  } else {
    warn('dist/win-unpacked/resources: not present; skipping Windows packaged app checks');
  }
}

function checkUpdateFeedConfig(label, config) {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    if (config[key] === expected) {
      pass(`${label}: ${key} is ${expected}`);
    } else {
      fail(`${label}: ${key} must be ${expected}, got ${config[key] || '(missing)'}`);
    }
  }

  if (config.owner === 'local-test' || config.repo === 'local-test') {
    fail(`${label}: local-test update feed disables auto-update`);
  }
}

function checkInstalled() {
  const expectedVersion = getPackageVersion();
  const installRoots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Sales Claw'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Sales Claw') : null,
  ].filter(Boolean);

  let found = false;
  for (const installRoot of installRoots) {
    const appUpdatePath = path.join(installRoot, 'resources', 'app-update.yml');
    const packagePath = path.join(installRoot, 'resources', 'app', 'package.json');
    if (!fs.existsSync(appUpdatePath) && !fs.existsSync(packagePath)) continue;
    found = true;

    if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (pkg.version === expectedVersion) {
        pass(`${packagePath}: installed version matches package.json (${pkg.version})`);
      } else {
        fail(`${packagePath}: installed version ${pkg.version} must match package.json ${expectedVersion}`);
      }
    } else {
      fail(`${packagePath}: missing installed package.json`);
    }

    if (fs.existsSync(appUpdatePath)) {
      const config = parseFlatYaml(fs.readFileSync(appUpdatePath, 'utf8'));
      checkUpdateFeedConfig(appUpdatePath, config);
    } else {
      fail(`${appUpdatePath}: missing installed update feed`);
    }

    for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
      const dependencyPath = path.join(installRoot, 'resources', 'app', 'node_modules', dependency, 'package.json');
      if (fs.existsSync(dependencyPath)) {
        const depPkg = JSON.parse(fs.readFileSync(dependencyPath, 'utf8'));
        pass(`${dependencyPath}: installed runtime dependency ${dependency}@${depPkg.version} is present`);
      } else {
        fail(`${dependencyPath}: installed runtime dependency ${dependency} is missing`);
      }
    }
  }

  if (!found) {
    warn('installed: Sales Claw installation was not found in standard locations');
  }
}

function printResults() {
  for (const message of passes) console.log(`OK   ${message}`);
  for (const message of warnings) console.warn(`WARN ${message}`);
  for (const message of failures) console.error(`FAIL ${message}`);

  if (failures.length > 0) {
    console.error(`\nRelease readiness failed: ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log(`\nRelease readiness passed (${passes.length} checks${warnings.length ? `, ${warnings.length} warning(s)` : ''}).`);
}

checkSourceConfig();
if (CHECK_DIST) checkDist();
if (CHECK_INSTALLED) checkInstalled();
printResults();
