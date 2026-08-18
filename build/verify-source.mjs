#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "./privacy-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const version = "1.0.0";
const rootPackage = readJson("package.json");
const runtimePackage = readJson("build/runtime-package.json");
const webPackage = readJson("web/package.json");
const webLock = readJson("web/package-lock.json");
const extensionManifest = readJson("extension/extension.json");
const releaseFiles = readJson("build/release-files.json");

for (const [name, value] of Object.entries({
  root: rootPackage.version,
  runtime: runtimePackage.version,
  web: webPackage.version,
  webLock: webLock.version,
  extension: extensionManifest.version,
  releaseFiles: releaseFiles.version,
})) assert.equal(value, version, `${name} version must be ${version}`);

assert.equal(extensionManifest.id, "local.codex-output-items");
assert.equal(Object.hasOwn(extensionManifest.provenance || {}, "threadId"), false, "production manifest must not pin a source task UUID");
const serverSource = fs.readFileSync(path.join(root, "extension/server.mjs"), "utf8");
const commonSource = fs.readFileSync(path.join(root, "installer/scripts/common.ps1"), "utf8");
const registerSelfSource = fs.readFileSync(path.join(root, "installer/scripts/register-self.mjs"), "utf8");
assert.match(serverSource, /version:\s*"1\.0\.0"/);
assert.match(serverSource, /const SOURCE_THREAD_ID = RUNTIME_CODEX_THREAD_ID \|\| RUNTIME_EXPLICIT_THREAD_ID \|\| null;/, "fresh seed must prefer the runtime Codex task");
assert.match(serverSource, /const requestedThreadId = RUNTIME_CODEX_THREAD_ID\s*\|\| normalizedRuntimeThreadId\(args\.threadId\)\s*\|\| RUNTIME_EXPLICIT_THREAD_ID\s*\|\| null;/, "internal self-registration must not let request arguments override CODEX_THREAD_ID");
assert.match(serverSource, /case "output-items\/register-self"/, "server must expose the internal self-registration method");
assert.doesNotMatch(serverSource, /00000000-0000-4000-8000-000000000001/, "server runtime must not contain the legacy synthetic source UUID");
assert.doesNotMatch(commonSource, /manifest\.provenance\.threadId/);
assert.doesNotMatch(commonSource, /--env\s+"OUTPUT_ITEMS_SOURCE_THREAD_ID=/, "installer must not persist a synthetic source task");
assert.match(commonSource, /function Suspend-OutputItemsTaskContext/);
assert.match(commonSource, /function Restore-OutputItemsTaskContext/);
assert.match(commonSource, /function Start-OutputItemsHttpService[\s\S]*?Suspend-OutputItemsTaskContext[\s\S]*?Start-Process[\s\S]*?finally[\s\S]*?Restore-OutputItemsTaskContext/, "long-lived HTTP service must not inherit one-shot task context");
assert.match(commonSource, /function Start-OutputItemsCompanionProcess[\s\S]*?Suspend-OutputItemsTaskContext[\s\S]*?Start-Process[\s\S]*?finally[\s\S]*?Restore-OutputItemsTaskContext/, "companion and managed Codex must not inherit one-shot task context");
assert.match(registerSelfSource, /\[process\.env\.CODEX_THREAD_ID, process\.env\.OUTPUT_ITEMS_SOURCE_THREAD_ID\]/);
assert.doesNotMatch(registerSelfSource, /00000000-0000-4000-8000-000000000001/);
assert.match(fs.readFileSync(path.join(root, "extension/companion/inject-output-items.user.js"), "utf8"), /VERSION\s*=\s*"1\.0\.0"/);

const targets = new Set();
for (const entry of releaseFiles.files) {
  assert.ok(entry.source && entry.target, "release file entries require source and target");
  assert.ok(!path.isAbsolute(entry.source) && !path.isAbsolute(entry.target));
  assert.ok(!entry.source.split(/[\\/]/).includes("..") && !entry.target.split(/[\\/]/).includes(".."));
  assert.ok(fs.statSync(path.join(root, entry.source)).isFile(), `missing release source: ${entry.source}`);
  const normalizedTarget = entry.target.replaceAll("\\", "/").toLowerCase();
  assert.ok(!targets.has(normalizedTarget), `duplicate release target: ${entry.target}`);
  targets.add(normalizedTarget);
}

const findings = scanTree(root, { sourceMode: true });
assert.deepEqual(findings, [], `privacy scan findings:\n${findings.map((item) => JSON.stringify(item)).join("\n")}`);
process.stdout.write("VERIFY_SOURCE_OK version=1.0.0\n");
