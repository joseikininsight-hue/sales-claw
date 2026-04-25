Run the Sales Claw release parity and auto-update workflow for $ARGUMENTS.

Rules:
1. Read `docs/release-parity-and-autoupdate.md`.
2. If desktop users must receive the change, make sure `package.json` and `package-lock.json` have a bumped version.
3. Run `npm run verify:release` before packaging.
4. Build Windows with `npm run dist:win -- --publish never`.
5. Run `npm run verify:dist` and do not claim the desktop build is ready unless it passes.
6. For local installation, run `npm run install:win`; use `scripts/install-latest-win.ps1 -AllUsers` only from elevated PowerShell.
7. Never manually patch installed app files to fake a release. The packaged `app-update.yml`, `latest.yml`, installer, and blockmap must agree.
8. If any check fails, fix the source config or build output, then rerun the check.
