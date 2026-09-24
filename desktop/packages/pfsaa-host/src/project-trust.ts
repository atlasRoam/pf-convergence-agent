import { realpathSync } from "node:fs";
import path from "node:path";
import type { ProjectTrustStatus } from "@pfsaa/contracts";
import type { AgentCoreSdk } from "@pfsaa/agentcore-adapter";

export function canonicalProjectPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathKey(value: string): string {
  const resolved = canonicalProjectPath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function defaultPolicy(value: unknown): ProjectTrustStatus["defaultPolicy"] {
  return value === "always" || value === "never" ? value : "ask";
}

export function readProjectTrustStatus(sdk: AgentCoreSdk, cwd: string, agentDir: string): ProjectTrustStatus {
  if (!sdk.SettingsManager || !sdk.ProjectTrustStore || !sdk.hasTrustRequiringProjectResources) {
    throw new Error("Project trust is not available in this runtime");
  }
  const resolvedCwd = canonicalProjectPath(cwd);
  const bootstrapSettings = sdk.SettingsManager.create(resolvedCwd, agentDir, { projectTrusted: false });
  const policy = defaultPolicy(bootstrapSettings.getDefaultProjectTrust?.());
  const hasTrustRequiringResources = sdk.hasTrustRequiringProjectResources(resolvedCwd);
  const entry = new sdk.ProjectTrustStore(agentDir).getEntry(resolvedCwd);
  if (entry) {
    return {
      cwd: resolvedCwd,
      hasTrustRequiringResources,
      trusted: entry.decision,
      source: pathKey(entry.path) === pathKey(resolvedCwd) ? "saved" : "inherited",
      sourcePath: entry.path,
      defaultPolicy: policy,
    };
  }

  if (!hasTrustRequiringResources) {
    return {
      cwd: resolvedCwd,
      hasTrustRequiringResources: false,
      trusted: policy === "always",
      source: "not-required",
      defaultPolicy: policy,
    };
  }

  return {
    cwd: resolvedCwd,
    hasTrustRequiringResources: true,
    trusted: policy === "always",
    source: "default",
    defaultPolicy: policy,
  };
}

export function createTrustAwareSettingsManager(sdk: AgentCoreSdk, cwd: string, agentDir: string): { settingsManager: any; trustStatus: ProjectTrustStatus } {
  const trustStatus = readProjectTrustStatus(sdk, cwd, agentDir);
  if (!sdk.SettingsManager) throw new Error("Settings are not available in this runtime");
  return {
    settingsManager: sdk.SettingsManager.create(trustStatus.cwd, agentDir, { projectTrusted: trustStatus.trusted }),
    trustStatus,
  };
}
