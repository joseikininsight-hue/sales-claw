# Release Parity and Auto Update Guardrails

Sales Claw has four different runtime surfaces:

- preview dashboard: `npm run dashboard:preview` on `http://127.0.0.1:3480`
- development Electron: `npm start`
- landing/web development: `npm run lp:dev`
- installed desktop app: packaged files under `dist/` or the Windows install directory

The operational dashboard source of truth is `src/dashboard-server.cjs` plus `src/ui/**` and `src/routes/**`. The preview dashboard and Electron must start that same source. Do not treat a `.claude/worktrees/*` preview on port 3480 as released or desktop-ready until the code has been merged back to the repository root and `npm run verify:release` passes.

The installed desktop app never reads the working tree directly. Any UI, backend, or setting change that must reach desktop users needs a version bump, a packaged Electron build, and GitHub Releases update metadata.

## Mandatory Checks

Run these before saying the desktop app is latest:

```bash
npm run verify:release
npm run dist:win -- --publish never
npm run verify:dist
```

For local installation on Windows:

```powershell
npm run install:win
npm run verify:installed
```

`verify:installed` is strict. It checks both the current-user install and the all-users install. If an old all-users install remains under `C:\Program Files\Sales Claw`, clean it from an elevated PowerShell or reinstall with `scripts/install-latest-win.ps1 -AllUsers`.

For all-users installation, open an elevated PowerShell and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-latest-win.ps1 -AllUsers
```

## What The Gate Enforces

`scripts/verify-release-readiness.cjs` fails the build if:

- `package.json` and `package-lock.json` versions diverge
- `electron-builder.yml` does not point to `joseikininsight-hue/sales-claw`
- `publishAutoUpdate: true` or `channel: latest` is missing
- `local-test`, `${env.GH_OWNER}`, or `${env.GH_REPO}` remains in the update feed
- Release workflow does not upload the installer, `.blockmap`, and `latest*.yml`
- packaged `app-update.yml` does not point to the real GitHub Releases feed
- packaged `latest.yml` does not match the current package version
- dev-only directories such as `.claude`, `.electron-userdata`, `.aidesigner`, `.code-review-graph`, or `dist` are packaged into the desktop app

`scripts/verify-surface-parity.cjs` fails the build if:

- the operational dashboard no longer imports the shared UI bundles
- the dashboard theme toggle or dark theme tokens disappear
- preview stops loading `../src/dashboard-server.cjs`
- Electron stops using the root dashboard server
- local vendor assets are missing from the package filters

## Release Flow

1. Finish code changes.
2. Bump `package.json` with `npm version X.Y.Z --no-git-tag-version`.
3. Run `npm run verify:release`.
4. Run `npm run dist:win -- --publish never`.
5. Run `npm run verify:dist`.
6. Install locally with `npm run install:win` or elevated `scripts/install-latest-win.ps1 -AllUsers`.
7. Commit and tag `vX.Y.Z`.
8. Push the tag so `.github/workflows/release.yml` uploads:
   - `Sales-Claw-Setup-X.Y.Z.exe`
   - `Sales-Claw-Setup-X.Y.Z.exe.blockmap`
   - `latest.yml`

## Claude Code / Codex Rules

- Do not treat `npm start`, `dashboard:preview`, or `lp:dev` as proof that the installed desktop app is updated.
- Do not leave the latest operational dashboard in `.claude/worktrees/*`; merge it into the root `src/dashboard-server.cjs`, `src/ui/**`, and `src/routes/**`.
- Do not edit installed files under `C:\Program Files` or `%LOCALAPPDATA%\Programs\Sales Claw` by hand.
- Do not use `local-test` or env-substituted owner/repo values in `electron-builder.yml`.
- Do not tell the user auto-update is ready until `npm run verify:dist` passes.
- If the installed app is old, install the latest generated setup with `scripts/install-latest-win.ps1`; do not rely on an old `local-test` build to self-update.
