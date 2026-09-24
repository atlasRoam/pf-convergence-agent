import { extractFile, listPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findAsarFiles(directory) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    const stat = statSync(candidate);
    if (stat.isDirectory()) results.push(...findAsarFiles(candidate));
    else if (entry === "app.asar") results.push(candidate);
  }
  return results;
}

function packagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function licenseEntries(license) {
  if (typeof license !== "string" || !license.trim()) return undefined;
  const value = license.trim();
  return /^[A-Za-z0-9-.+]+$/.test(value)
    ? [{ license: { id: value } }]
    : [{ license: { name: value } }];
}

function componentFromManifest(manifest, type = "library") {
  const component = {
    type,
    name: manifest.name,
    version: manifest.version,
    purl: packagePurl(manifest.name, manifest.version),
  };
  if (manifest.name.startsWith("@") && manifest.name.includes("/")) {
    [component.group, component.name] = manifest.name.split("/", 2);
  }
  const licenses = licenseEntries(manifest.license);
  if (licenses) component.licenses = licenses;
  return component;
}

export function electronRuntimeComponent(projectRoot = root) {
  const lock = JSON.parse(readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
  const lockedVersion = lock.packages?.["node_modules/electron"]?.version;
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, "node_modules", "electron", "package.json"), "utf8"));
  if (typeof lockedVersion !== "string" || manifest.version !== lockedVersion) {
    throw new Error(`Electron runtime mismatch: lockfile ${lockedVersion ?? "missing"}, installed ${manifest.version ?? "missing"}`);
  }
  return componentFromManifest(manifest, "framework");
}

export function packageManifestEntries(entries) {
  return entries
    .map((entry) => {
      const extractPath = entry.replace(/^[/\\]+/, "");
      return {
        extractPath,
        normalizedPath: extractPath.replaceAll("\\", "/"),
      };
    })
    .filter(({ normalizedPath }) =>
      normalizedPath === "package.json" || normalizedPath.endsWith("/package.json"));
}

function packagedComponents(asarPath, applicationName) {
  const components = new Map();
  const packageJsonEntries = packageManifestEntries(listPackage(asarPath));

  for (const { extractPath } of packageJsonEntries) {
    let manifest;
    try {
      // @electron/asar resolves archive paths with the host platform separator.
      // Keep the original separator for extraction; normalize only for matching.
      manifest = JSON.parse(extractFile(asarPath, extractPath).toString("utf8"));
    } catch {
      continue;
    }
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
    const key = `${manifest.name}@${manifest.version}`;
    if (components.has(key)) continue;
    const component = componentFromManifest(manifest, manifest.name === applicationName ? "application" : "library");
    components.set(key, component);
  }

  return [...components.values()].sort((left, right) =>
    `${left.group ?? ""}/${left.name}@${left.version}`.localeCompare(`${right.group ?? ""}/${right.name}@${right.version}`));
}

export function generatePackagedSbom(releaseRoot, outputPath, projectRoot = root) {
  const asarFiles = findAsarFiles(releaseRoot);
  if (asarFiles.length !== 1) {
    throw new Error(`Expected exactly one app.asar under ${releaseRoot}, found ${asarFiles.length}`);
  }

  const rootManifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const applicationPurl = packagePurl(rootManifest.name, rootManifest.version);
  const components = packagedComponents(asarFiles[0], rootManifest.name)
    .filter((component) => component.purl !== applicationPurl);
  components.push(electronRuntimeComponent(projectRoot));
  components.sort((left, right) =>
    `${left.group ?? ""}/${left.name}@${left.version}`.localeCompare(`${right.group ?? ""}/${right.name}@${right.version}`));
  const digest = createHash("sha256").update(JSON.stringify(components)).digest("hex");
  const serial = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: rootManifest.name,
        version: rootManifest.version,
        purl: applicationPurl,
      },
    },
    components,
  };

  writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`);
  return bom;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const releaseRoot = path.resolve(process.argv[2] ?? "release");
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
  if (!outputPath) throw new Error("Usage: npm run sbom:package -- <release-directory> <output.json>");
  const bom = generatePackagedSbom(releaseRoot, outputPath);
  process.stdout.write(`Wrote ${bom.components.length} packaged components to ${outputPath}\n`);
}
