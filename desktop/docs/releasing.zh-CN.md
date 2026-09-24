# PFSAA 发布维护指南

本文面向有仓库发布权限的维护者。普通用户请从 [GitHub Releases](https://github.com/atlasRoam/pf-convergence-agent/releases) 下载公开安装包。

## 1. 发布范围

当前发布工作流原生构建并汇总以下安装包：

| 平台 | Runner | 产物 |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15` arm64 | `PFSAA-VERSION-macos-arm64.dmg` |
| macOS Intel | `macos-15-intel` x64 | `PFSAA-VERSION-macos-x64.dmg` |
| Windows | `windows-2025` x64 | `PFSAA-VERSION-windows-x64-setup.exe` |

`macos-15` 是构建 Runner，不是安装包最低系统版本。两个 macOS 安装包当前都以 macOS 12 为最低目标。

## 2. 发布前检查

1. 更新根目录 `package.json` 的版本，并同步 `package-lock.json`。
2. 确认 AgentCore runtime、Electron 和文档中的兼容基线与锁文件一致。
3. 运行完整检查：

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

4. 检查工作区只包含计划发布的修改，并审阅 Release notes。

## 3. 签名与公证 Secrets

正式发行前，创建受保护的 GitHub Environment `release-signing`，设置 required reviewer 和只允许受保护版本 Tag 的部署规则，并在该 Environment 的 Secrets 中配置：

- macOS 签名：`MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`
- macOS 公证：`APPLE_API_KEY`（`.p8` 文件内容的 Base64）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`
- Windows Authenticode：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`

签名材料只会注入对应平台的 `electron-builder` 步骤；依赖安装和应用构建步骤无法读取这些 Secret。没有证书时工作流仍会生成未签名测试包，但不应在未明确标注的情况下作为可信正式版本发布。

## 4. 创建版本 Tag

Tag 必须是 `v<semver>`，且与根目录 `package.json` 完全一致：

```bash
VERSION=$(node -p 'require("./package.json").version')
npm run release:check -- "v$VERSION"
git tag "v$VERSION"
git push origin "v$VERSION"
```

Tag 会触发 `.github/workflows/release.yml`。工作流只接受真实 Tag 且要求对应提交已包含在 `main` 中，随后锁定该 commit SHA，重新执行依赖清单、lint、类型检查、回归测试和生产构建，再在三个原生 Runner 上打包，运行打包后 PfsaaHost smoke，从每个平台最终 `app.asar` 生成独立 CycloneDX SBOM 与 `SHA256SUMS.txt`，为发布资产创建 provenance attestation，并创建 GitHub Draft Release。

需要重建现有 Tag 时，可以手动运行 Release installers 工作流并填写已有 Tag。工作流只允许更新 Draft，不会覆盖已经公开发布的 Release 资产。

## 5. Draft 验收

发布 Draft 前至少完成：

- 三个安装包、三个对应平台的 CycloneDX SBOM 和 `SHA256SUMS.txt` 均存在，文件名和版本正确。
- GitHub Artifact Attestation 验证通过，安装包内包含 PFSAA 的 `LICENSE`、`THIRD_PARTY_NOTICES.txt`，以及 Electron/Chromium 运行时许可证文件。
- 在 Apple Silicon、Intel Mac 和 Windows x64 的真实或可信测试环境中完成安装与启动。
- 原生 Job 的打包后 PfsaaHost smoke 已通过：真实 `runtime.status` IPC 成功，且 `app.info` 报告内置 AgentCore runtime `0.85.1`。
- 能打开项目、创建或恢复 Session，并完成一次真实 Provider/模型调用。
- 外部 AgentCore runtime 场景下原生 `.node` 模块没有被 macOS Library Validation 拒绝。
- Release notes 明确标注签名、公证状态以及已知限制。

macOS 签名与公证检查示例：

```bash
codesign --verify --deep --strict --verbose=2 /Applications/PFSAA.app
spctl --assess --type execute --verbose=2 /Applications/PFSAA.app
xcrun stapler validate /Applications/PFSAA.app
```

Windows PowerShell 签名检查：

```powershell
Get-AuthenticodeSignature '.\PFSAA-VERSION-windows-x64-setup.exe' | Format-List
```

状态、签名主体和证书链必须符合本次发布预期。未签名测试包应保留在 Draft 或明确标记为测试用途。

## 6. 发布后检查

1. 手动发布验收通过的 Draft Release。
2. 稳定版确认 `/releases/latest` 指向新版本；Pre-release 确认对应 Tag 页面可见。README 的动态版本徽章应包含 Pre-release。
3. 从公开 Release 页面重新下载至少一个安装包，并核对 SHA-256。
4. 检查 CI/Release 工作流无失败或意外重跑。
5. 通过 GitHub CLI 或网页验证至少一个安装包的 Artifact Attestation。
6. 若发现发布资产有问题，优先撤回或新建修复版本，不直接静默替换已发布资产。

## 7. GitHub 仓库一次性设置

首次公开发布前，仓库所有者还需要在 GitHub 网页中完成以下设置；这些权限与 Secret 不能由仓库内文件代替：

- 将仓库可见性切换为 Public，并确认提交历史中的作者邮箱均可公开；如需清理历史，先单独评估并通知协作者再执行历史重写。
- 在 Settings → Actions → General 中保持默认 `GITHUB_TOKEN` 为只读；发布工作流已仅在发布 Job 中声明写权限。
- 为默认分支建立 Ruleset/Branch protection：要求 Pull Request、CI、CodeQL 与 Dependency Review 通过，禁止 force push 和删除分支。
- 为 `v*` 建立 Tag ruleset，限制 Tag 创建，禁止更新和删除已发布版本 Tag。
- 启用 Private vulnerability reporting、Dependabot alerts、secret scanning 与 push protection。
- 配置第 3 节列出的 `release-signing` Environment 与签名、公证 Secrets；不要把这些 Secret 放在仓库级别，也不要把证书或 API 私钥提交到仓库。
- 在 About 中设置简介、主页和 Topics，并启用 Issues；确认 Issue Forms、Pull Request 模板、行为准则和安全策略可正常显示。

完成设置后，以一个 Draft Tag 运行三平台工作流，并把实际签名、公证、安装和一次真实模型调用作为首次公开发布的最终验收。
