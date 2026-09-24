# Skill

Skill 是带有 `SKILL.md` 的本地目录，引用的相对路径以该文件所在目录为基准。直接包入口可按受信任配置发现资源，也可用 `--skill <文件或目录>` 显式加载；`--no-skills` 禁止自动发现，但不阻止显式 `--skill`。

根包装器始终传 `--no-skills`，仅显式加载 `source/.agentcore/skills/compute-engine/SKILL.md` 与 `source/.agentcore/skills/powerflow-manual-adjustment/SKILL.md`。路由器按明确 engine ID 再加载独立引擎 Skill；旁边的其他 Skill 不会因目录共存而自动加载。PFNT 4.6 的真实运算和私有文件仍处于运行边界，不因读取 Skill 而获得额外权限。参见 [安全](security.md)。
