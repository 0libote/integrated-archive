import { readFileSync, writeFileSync } from "node:fs";

const [, , command, expectedVersion] = process.argv;
const packagePath = "package.json";
const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const pkg = readJson(packagePath);
const manifest = readJson(manifestPath);
const versions = readJson(versionsPath);

if (command === "--check") {
  verifyVersion(expectedVersion ?? pkg.version);
} else {
  if (!command) throw new Error("Pass the new version, for example: bun run bump 0.2.0");
  assertVersion(command);
  pkg.version = command;
  manifest.version = command;
  versions[command] = manifest.minAppVersion;
  writeJson(packagePath, pkg);
  writeJson(manifestPath, manifest);
  writeJson(versionsPath, versions);
  verifyVersion(command);
}

function verifyVersion(version) {
  assertVersion(version);
  if (pkg.version !== version || manifest.version !== version || versions[version] !== manifest.minAppVersion) {
    throw new Error("package.json, manifest.json, and versions.json must use the same version and minimum app version");
  }
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`Invalid version: ${String(version)}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
