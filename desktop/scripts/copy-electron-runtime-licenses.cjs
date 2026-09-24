const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_LICENSES = [
  { sources: ["LICENSE.electron.txt", "LICENSE"], target: "LICENSE.electron.txt" },
  { sources: ["LICENSES.chromium.html"], target: "LICENSES.chromium.html" },
];

function runtimeResourcesDirectory(context) {
  if (["darwin", "mas"].includes(context.electronPlatformName)) {
    const electronAppName = context.packager?.info?.framework?.distMacOsAppName;
    if (!electronAppName) {
      throw new Error("Could not determine the extracted Electron macOS app name");
    }
    return path.join(context.appOutDir, electronAppName, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

async function copyElectronRuntimeLicenses(context) {
  const resourcesDirectory = runtimeResourcesDirectory(context);
  await fs.promises.mkdir(resourcesDirectory, { recursive: true });

  for (const license of RUNTIME_LICENSES) {
    const target = path.join(resourcesDirectory, license.target);
    if (fs.existsSync(target)) continue;

    const source = license.sources
      .map((filename) => path.join(context.appOutDir, filename))
      .find((candidate) => fs.existsSync(candidate));
    if (!source) {
      throw new Error(
        `Missing Electron runtime license after extraction: ${license.sources.join(" or ")}`,
      );
    }
    await fs.promises.copyFile(source, target);
  }
}

module.exports = { copyElectronRuntimeLicenses, runtimeResourcesDirectory };
