# PFSAA Release Maintainer Guide

This guide is for maintainers with repository release access. End users should download public installers from [GitHub Releases](https://github.com/atlasRoam/pf-convergence-agent/releases).

## 1. Release targets

The current workflow builds and collects these installers on native runners:

| Platform | Runner | Artifact |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` arm64 | `PFSAA-VERSION-macos-arm64.dmg` |
| macOS Intel | `macos-15-intel` x64 | `PFSAA-VERSION-macos-x64.dmg` |
| Windows | `windows-2025` x64 | `PFSAA-VERSION-windows-x64-setup.exe` |

`macos-15` identifies the build runner, not the installer's minimum operating system. Both macOS installers currently target macOS 12 or later.

## 2. Pre-release checks

1. Update the root `package.json` version and synchronize `package-lock.json`.
2. Confirm that the AgentCore runtime, Electron, and documented compatibility baselines match the lockfile.
3. Run the complete checks:

```bash
npm ci
npm run notices:check
npm ls --all
npm run lint
npm run typecheck
npm run test:renderer
npm run build
npm run smoke:runtime
npm audit --omit=dev
```

4. Confirm the worktree contains only the intended release changes and review the release notes.

## 3. Signing and notarization secrets

Before a trusted public release, create a protected GitHub Environment named `release-signing`, require a reviewer, restrict deployment to protected version tags, and configure these Environment secrets:

- macOS signing: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`
- macOS notarization: `APPLE_API_KEY` (Base64-encoded `.p8` contents), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`
- Windows Authenticode: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

Certificate material is exposed only to the corresponding `electron-builder` step; dependency installation and application compilation cannot read these secrets. Without certificates the workflow still creates unsigned test installers, but they must not be presented as trusted public builds without an explicit warning.

## 4. Create the version tag

The tag must be `v<semver>` and exactly match the root `package.json`:

```bash
VERSION=$(node -p 'require("./package.json").version')
npm run release:check -- "v$VERSION"
git tag "v$VERSION"
git push origin "v$VERSION"
```

The tag starts `.github/workflows/release.yml`. The workflow accepts only a real tag whose commit is contained in `main`, pins that commit SHA, rechecks dependency notices, lint, types, regressions, and the production build; packages on three native runners; runs the packaged PfsaaHost smoke; generates a separate CycloneDX SBOM from each platform's final `app.asar` plus `SHA256SUMS.txt`; creates provenance attestations for release assets; and opens a draft GitHub Release.

To rebuild an existing tag, run the Release installers workflow manually and supply that tag. The workflow may update a draft, but it refuses to overwrite assets on a published Release.

## 5. Draft acceptance

Before publishing the draft, verify at least the following:

- All three installers, their three platform-specific CycloneDX SBOMs, and `SHA256SUMS.txt` exist with the correct versioned names.
- GitHub Artifact Attestations verify, and the application package contains PFSAA's `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and the Electron/Chromium runtime license files.
- Installation and startup succeed on Apple Silicon, Intel macOS, and Windows x64 hardware or trustworthy test environments.
- Each native job's packaged PfsaaHost smoke passes: a real `runtime.status` IPC succeeds and `app.info` reports bundled AgentCore runtime `0.85.1`.
- A project can be opened, a session can be created or restored, and one real provider/model request completes.
- macOS Library Validation does not reject external AgentCore runtime `.node` modules.
- Release notes clearly state signing/notarization status and known limitations.

Example macOS signing and notarization checks:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/PFSAA.app
spctl --assess --type execute --verbose=2 /Applications/PFSAA.app
xcrun stapler validate /Applications/PFSAA.app
```

Windows PowerShell signature check:

```powershell
Get-AuthenticodeSignature '.\PFSAA-VERSION-windows-x64-setup.exe' | Format-List
```

The status, signer, and certificate chain must match the release expectation. Keep unsigned test builds in draft form or label them explicitly as test-only.

## 6. Post-release checks

1. Manually publish the accepted draft Release.
2. For a stable release, confirm `/releases/latest` points to the new version. For a pre-release, confirm the tagged release page is visible. The README release badge should include pre-releases.
3. Download at least one installer again from the public Release page and verify its SHA-256.
4. Check that CI and Release workflows have no failures or unexpected reruns.
5. Verify the Artifact Attestation for at least one installer through GitHub CLI or the web interface.
6. If a published asset is defective, withdraw it or create a corrective release instead of silently replacing public assets.

## 7. One-time GitHub repository settings

Before the first public release, a repository owner must complete the following settings in GitHub. Repository files cannot substitute for these permissions and secrets:

- Change repository visibility to Public and confirm that author email addresses in commit history are safe to disclose. If history must be cleaned, assess the impact and notify collaborators before any rewrite.
- In Settings → Actions → General, keep the default `GITHUB_TOKEN` read-only. The release workflow declares write permissions only on its publishing job.
- Add a ruleset or branch protection for the default branch: require pull requests, CI, CodeQL, and Dependency Review; block force pushes and branch deletion.
- Add a `v*` tag ruleset that restricts tag creation and blocks updates or deletion of published version tags.
- Enable Private vulnerability reporting, Dependabot alerts, secret scanning, and push protection.
- Configure the `release-signing` Environment and its signing/notarization secrets from section 3. Do not keep these secrets at repository scope, and never commit certificates or API private keys.
- Set the About description, homepage, and topics; enable Issues; and confirm that the issue forms, pull request template, Code of Conduct, and security policy render correctly.

After configuring the repository, run the three-platform workflow from a draft tag. Treat real signing/notarization, installation, and one real model request as the final acceptance gate for the first public release.
