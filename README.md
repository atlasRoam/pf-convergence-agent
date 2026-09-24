# 电力系统潮流计算调整智能体 (PFSAA)

本仓库包含 PFSAA 桌面应用和 AgentCore 通用运行时源码。产品层由 PFSAA
提供；Agent、模型、工具、资源和会话能力由 AgentCore 提供。

## 目录

- `desktop/` — Electron 桌面应用、Host 集成、界面测试与产品文档。
- `source/` — AgentCore 运行时、CLI/TUI、软件包和核心测试。

两部分各自的开发说明和命令见对应目录的 README 与 `package.json`。

## 发布边界

此快照仅包含通用核心和桌面产品源码，不包含项目专用 Skill、PFNT 引擎或算例、
本机运行时与会话、Provider 配置或密钥、用户验收材料及本机启动包装器。需要
专业计算能力时，请在本地按自己的授权配置相应资源；不要将凭据、会话或私有
算例提交到版本库。

## 许可

PFSAA 自有新增内容以 [Apache License 2.0](LICENSE) 开源，署名 AtlasRoam。
AgentCore 基于 Pi 的代码继续保留其 [MIT 许可和原作者声明](source/LICENSE)；
桌面端所沿用的开源实现继续保留其 [MIT 许可和原作者声明](desktop/LICENSE.upstream-MIT)。
各依赖遵守其各自许可，参见 [桌面端第三方声明](desktop/THIRD_PARTY_NOTICES.txt)。

## 开源致谢

感谢以下项目及贡献者提供的开源实现与设计启发（本项目不代表其官方立场）：

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Pi](https://github.com/earendil-works/pi)
- [PiDeck（现 PiCove）](https://github.com/Skitre/PiCove)
- [OpenAI Codex](https://github.com/openai/codex)
