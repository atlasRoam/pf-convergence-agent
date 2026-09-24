import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const WSL_PATH_VARIABLES = [
  "AGENTCORE_AGENT_DIR",
  "AGENTCORE_SESSION_DIR",
  "AGENTCORE_RUNTIME_CWD",
  "TSX_TSCONFIG_PATH",
  "PFSAA_PYTHON",
] as const;

export function mergeWslPathEnvironment(
  environment: NodeJS.ProcessEnv,
  variableNames: readonly string[] = WSL_PATH_VARIABLES,
): NodeJS.ProcessEnv {
  const pathVariableNames = variableNames.filter((name) => Boolean(environment[name]?.trim()));
  if (pathVariableNames.length === 0) return { ...environment };

  const configuredNames = new Set(pathVariableNames.map((name) => name.toLowerCase()));
  const retainedEntries = (environment.WSLENV ?? "")
    .split(":")
    .filter((entry) => {
      const name = entry.split("/", 1)[0]?.trim();
      return Boolean(name) && !configuredNames.has(name.toLowerCase());
    });

  return {
    ...environment,
    WSLENV: [...retainedEntries, ...pathVariableNames.map((name) => `${name}/p`)].join(":"),
  };
}

function configuredProjectRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment.PFSAA_PROJECT_ROOT || environment.PFCA_PROJECT_ROOT;
}

export function pfsaaPaths(mainDirectory: string, projectRoot = configuredProjectRoot()) {
  const root = path.resolve(projectRoot || path.join(mainDirectory, "../../../../.."));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  const agentDir = path.join(runtime, ".agent");
  return {
    root,
    runtime,
    agentDir,
    sessionDir: path.join(agentDir, "sessions"),
    sdk: path.join(source, "packages/agentcore-cli/dist/index.js"),
    guard: path.join(source, "packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts"),
    router: path.join(source, ".agentcore/skills/compute-engine/SKILL.md"),
    adjustment: path.join(source, ".agentcore/skills/powerflow-manual-adjustment/SKILL.md"),
    tsconfig: path.join(source, "tsconfig.json"),
    python: path.join(runtime, "python", "pfnt-cli-3.11.14", "Scripts", "python.exe"),
  };
}

export function pfsaaHostEnvironment(mainDirectory: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const paths = pfsaaPaths(mainDirectory, configuredProjectRoot(environment));
  for (const [name, file] of Object.entries({ sdk: paths.sdk, guard: paths.guard, tsconfig: paths.tsconfig })) {
    if (!existsSync(file)) throw new Error(`PFSAA 运行组件缺失：${name} (${file})。请先完成 Windows 端 source 构建后再启动桌面端。`);
  }
  mkdirSync(paths.runtime, { recursive: true });
  if (!statSync(paths.runtime).isDirectory()) throw new Error(`PFSAA 运行工作区不是目录：${paths.runtime}`);
  const hostEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PFSAA_PROJECT_ROOT: paths.root,
    PFSAA_RUNTIME_MODULE: paths.sdk,
    PFSAA_WORKSPACE_CWD: paths.runtime,
    AGENTCORE_AGENT_DIR: paths.agentDir,
    AGENTCORE_SESSION_DIR: paths.sessionDir,
    AGENTCORE_RUNTIME_CWD: paths.runtime,
    AGENTCORE_OFFLINE: "1",
    AGENTCORE_TELEMETRY: "0",
    TSX_TSCONFIG_PATH: paths.tsconfig,
    // Required by the upstream compatibility dependency. AgentCore variables
    // above remain the authoritative product configuration.
    PI_CODING_AGENT_DIR: paths.agentDir,
  };
  const configuredPython = environment.PFSAA_PYTHON?.trim();
  if (configuredPython) hostEnvironment.PFSAA_PYTHON = configuredPython;
  else if (existsSync(paths.python)) hostEnvironment.PFSAA_PYTHON = paths.python;

  return process.platform === "win32"
    ? mergeWslPathEnvironment(hostEnvironment)
    : hostEnvironment;
}
