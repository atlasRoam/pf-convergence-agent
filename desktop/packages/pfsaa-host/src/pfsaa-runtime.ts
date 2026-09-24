import { existsSync } from "node:fs";
import path from "node:path";

export function pfsaaRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const projectRoot = environment.PFSAA_PROJECT_ROOT || environment.PFCA_PROJECT_ROOT;
  if (!projectRoot) return undefined;
  const root = path.resolve(projectRoot);
  const runtime = path.join(root, "runtime");
  const agentDir = path.join(runtime, ".agent");
  const skills = [
    path.join(root, "source/.agentcore/skills/compute-engine/SKILL.md"),
    path.join(root, "source/.agentcore/skills/powerflow-manual-adjustment/SKILL.md"),
  ].filter(existsSync);
  return {
    runtime,
    agentDir,
    sessionDir: path.join(agentDir, "sessions"),
    guard: path.join(root, "source/packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts"),
    skills,
  };
}

export function assertPfsaaCwd(cwd: unknown, runtime: ReturnType<typeof pfsaaRuntime>): void {
  if (!runtime || cwd === undefined) return;
  const expected = path.resolve(runtime.runtime);
  const actual = typeof cwd === "string" ? path.resolve(cwd) : "";
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(actual) !== normalize(expected)) throw new Error("PFSAA only supports its configured runtime workspace.");
}

export function pfsaaResourceOptions(runtime: NonNullable<ReturnType<typeof pfsaaRuntime>>, cwd: string, agentDir: string, settingsManager: any) {
  assertPfsaaCwd(cwd, runtime);
  return {
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [runtime.guard], additionalSkillPaths: runtime.skills,
    extensionFactories: [],
  };
}
