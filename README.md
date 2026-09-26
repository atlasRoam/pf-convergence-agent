# 电力系统潮流计算调整智能体 (PFSAA)

## 项目简介

PFSAA（Power-Flow Solving and Adjustment Agent）是面向电力系统潮流计算与
调整的智能体项目。它提供桌面界面和命令行入口，可结合本地配置的模型与工具，
辅助分析算例、执行调整并查看结果。

`source/` 包含 AgentCore 运行时与 CLI，负责模型、工具及会话；`desktop/` 是
基于 Electron 的桌面应用，通过 AgentCore 提供图形化交互。两种入口共用核心实现。

## 从源码启动

需要 Node.js `>=22.19.0` 和 npm。以下命令以 Windows PowerShell 为例，
均从仓库根目录开始执行；启动桌面端前须先构建 AgentCore。

### 命令行（CLI）

```powershell
cd source
npm ci
npm run build:offline
node packages/agentcore-cli/dist/bundle/cli.js
```

该命令进入交互模式；可在命令后加 `--help` 查看其他选项。

### 桌面端

完成上面的 `source/` 构建后，另开终端回到仓库根目录：

```powershell
cd desktop
npm ci
npm run dev
```

`npm run dev` 会打开 Electron 开发窗口，需要图形桌面环境。首次使用时，
可在桌面端的 Provider 认证页配置服务商和模型。

## 开源致谢

感谢以下项目及贡献者提供的开源实现与设计启发（本项目不代表其官方立场）：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Pi](https://github.com/earendil-works/pi)
- [PiDeck（现 PiCove）](https://github.com/Skitre/PiCove)
- [OpenAI Codex](https://github.com/openai/codex)
