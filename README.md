# 电力系统潮流计算调整智能体 (PFSAA)

PFSAA 提供桌面界面，AgentCore 提供智能体运行时和命令行工具。两者使用同一份
`source/` 核心源码；桌面应用位于 `desktop/`。

## 从源码启动

需要 Node.js `>=22.19.0` 和 npm。从仓库根目录开始，先构建 AgentCore，
再启动桌面端。Windows 是当前项目的构建与交付验收环境；开发命令在 PowerShell
中执行。公开源码不提供项目根目录的启动脚本。

### 命令行（CLI）

```powershell
cd source
npm ci
npm run build:offline
node packages/agentcore-cli/dist/bundle/cli.js
```

该命令进入交互模式；在 `source/` 下运行同一入口并加 `--help` 可查看所有参数，
加 `--provider`、`--model` 可选择已配置的模型。直接启动 CLI 时，默认从用户目录
`~/.agentcore/agent/` 读取模型、认证、会话与用户 Skill；它**不会自动使用**桌面端的
`runtime/.agent/`，也不会自动注入桌面端的两个产品 Skill。

### 桌面端

完成上面的 `source/` 构建后，另开终端回到仓库根目录：

```powershell
cd desktop
npm ci
npm run dev
```

`npm run dev` 会构建桌面端依赖并打开 Electron 开发窗口，需要图形桌面环境。
桌面端使用仓库根目录的 `runtime/` 作为工作区，模型、认证和会话位于
`runtime/.agent/`；首次启动会创建所需的本地目录。可在软件的 Provider 认证页
配置服务商及模型，再选择模型开始会话。模型调用需要自行配置有效凭据。

如需让 CLI 使用桌面端已有的 Provider 配置和会话，先启动一次桌面端以创建
`runtime/`，再从仓库根目录运行（PowerShell）：

```powershell
$env:AGENTCORE_AGENT_DIR = Join-Path (Get-Location).Path "runtime/.agent"
$env:AGENTCORE_RUNTIME_CWD = Join-Path (Get-Location).Path "runtime"
node source/packages/agentcore-cli/dist/bundle/cli.js
```

这只共享模型、凭据和会话位置；CLI 若还需要桌面端约定的产品 Skill，须另外使用
`--skill` 显式指定文件。设置固定工作区后，相对 Skill 路径以 `runtime/` 为基准。

## 编写自己的 Skill

一个 Skill 通常是独立目录中的 `SKILL.md`，例如
`source/.agentcore/skills/my-skill/SKILL.md`。从 `source/` 启动的 CLI 在信任
该项目后可以发现此目录；也可以用 CLI 的 `--skill` 参数显式指定文件或目录。
个人通用 Skill 可放在 `~/.agentcore/agent/skills/<名称>/SKILL.md`；如果设置了
`AGENTCORE_AGENT_DIR`，则改放到该目录下的 `skills/`。

桌面端目前**只显式加载**下面两个路径（文件存在时）：

- `source/.agentcore/skills/compute-engine/SKILL.md`
- `source/.agentcore/skills/powerflow-manual-adjustment/SKILL.md`

因此，其他名称的 Skill 仅放进 `source/.agentcore/skills/` 或
`runtime/.agent/skills/` 不会被桌面端自动加载。需要增加桌面端的 Skill 入口时，应在
`desktop/packages/pfsaa-host/src/pfsaa-runtime.ts` 中显式配置路径并重新构建。
`source/.agentcore/` 和 `runtime/` 已被 Git 忽略，适合存放本地私有资源；
专业计算还需要自行准备相应引擎和工具，只有 Skill 文件并不能执行计算。

## 开发与检查

- `source/`：AgentCore 运行时和 CLI。依次运行 `npm ci`、`npm run build:offline`；
  修改核心后可运行 `npm test`，详见 [AgentCore 源码说明](source/README.md)。
- `desktop/`：Electron、Host 与界面。先构建同仓库的 `source/`，再在此目录运行
  `npm ci`、`npm run typecheck`、`npm run test:renderer`、`npm run test:pfsaa`
  和 `npm run build`，详见 [桌面端开发说明](desktop/README.md)。

两端涉及的源码与锁文件应作为同一版本同步；最终桌面端构建、启动和会话检查
以 Windows 环境为准。不要把本地凭据、运行会话或私有算例放进 Git。

## 开源致谢

感谢以下项目及贡献者提供的开源实现与设计启发（本项目不代表其官方立场）：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Pi](https://github.com/earendil-works/pi)
- [PiDeck（现 PiCove）](https://github.com/Skitre/PiCove)
- [OpenAI Codex](https://github.com/openai/codex)
