import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

const tag = process.argv[2];
if (!tag) {
  throw new Error("Usage: npm run release:check -- v<package-version>");
}

const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!match) {
  throw new Error(`Release tag must use v<semver>, received: ${tag}`);
}

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (match[1] !== manifest.version) {
  throw new Error(`Release tag ${tag} does not match package.json version ${manifest.version}`);
}

process.stdout.write(`Release version verified: ${tag}\n`);
