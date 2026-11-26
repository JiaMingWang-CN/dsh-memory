# Memloom Code Signing Policy / 代码签名政策

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## 1. Scope & Covered Artifacts（签名范围）

This policy governs code signing for **Memloom Desktop** (`src/desktop/` and `desktop/`), the standalone Windows desktop client of `memloom`:

- Main application executable: `Memloom Desktop.exe`
- Windows NSIS installer: `memloom-desktop-<version>-win-x64-setup.exe`

DSH bundles (`.tgz`) and Antigravity plugin bundles (`dist/agy-plugin/`) are JavaScript/JSON packages distributed separately and are not Windows PE binaries.

## 2. Trusted Build System & Signing Flow（可信构建系统）

- All signed binaries are built exclusively on GitHub-hosted runners (`windows-latest`) via the public GitHub Actions workflow [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml).
- Local developer builds are never submitted for official signing.
- Signing uses `signpath/github-action-submit-signing-request@v3` in two stages so both the inner Electron application executable and the outer NSIS setup executable carry valid Authenticode signatures.
- Signed artifacts are published solely as GitHub Actions workflow artifacts and official [GitHub Releases](https://github.com/JiaMingWang-CN/memloom/releases) assets under the MIT License (`LICENSE`), free of charge.

## 3. Team Roles & Governance（团队角色与审批）

- **Committers & Maintainers**: Repository owners and authorized maintainers listed in `.github/CODEOWNERS` may push to `main` or trigger manual release workflows.
- **Reviewers & Approvers**: Signing requests against the `release-signing` policy require explicit release authorization and verification of the corresponding GitHub tag / workflow run.

## 4. Privacy & Security Guarantees（隐私与安全承诺）

- Memloom Desktop operates strictly locally on user memory stores (`memory.json`), collects no telemetry, and sends no user memories, prompts, or secrets to external servers (see [`docs/security.md`](security.md) and [`docs/desktop.md`](desktop.md)).
- All user-owned memory data and desktop state (`%APPDATA%/memloom-desktop/`) remain preserved across upgrades and uninstalls (`deleteAppDataOnUninstall: false`).
