#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownPath = fileURLToPath(import.meta.url);
const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".zip", ".exe", ".dll"]);
const skippedDirectoryNames = new Set([".git", "node_modules"]);
const personalAccountPattern = new RegExp(["np", "hu"].join(""), "i");
const privateThreadPattern = new RegExp(["019f", "ffcf-80da-7e11-a318-c47c59e64026"].join(""), "i");
const userProfilePathPattern = /[a-z]:\\users\\[^\\\r\n"']+/i;
const driveAbsolutePathPattern = /(?:^|["'`(\s])[a-z]:\\[^\r\n"'`]+/im;
const unixHomePathPattern = /\/(?:users|home)\/[^/\s"']+/i;
const screenshotNamePattern = /(^|[\\/])(?:screenshot|screen-shot|真实截图)[^\\/]*\.(?:png|jpe?g|webp)$/i;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const secretLiteralPatterns = [
  { kind: "github-classic-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { kind: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/ },
  { kind: "openai-api-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
];
const allowedSyntheticUuids = new Set([
  "00000000-0000-4000-8000-000000000000",
  "00000000-0000-4000-8000-000000000001",
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
]);
const productionProvenancePaths = new Set([
  "extension/extension.json",
  "extension/server.mjs",
  "installer/scripts/common.ps1",
  "installer/scripts/register-self.mjs",
  "extension.json",
  "server.mjs",
  "scripts/common.ps1",
  "scripts/register-self.mjs",
]);

function swapUtf16Bytes(buffer) {
  const length = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped;
}

function decodeText(buffer) {
  if (buffer.length === 0) return "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16Bytes(buffer.subarray(2)).toString("utf16le");
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  const pairs = Math.max(1, Math.floor(sample.length / 2));
  if (oddNulls > pairs / 4 && evenNulls < pairs / 32) return buffer.toString("utf16le");
  if (evenNulls > pairs / 4 && oddNulls < pairs / 32) return swapUtf16Bytes(buffer).toString("utf16le");
  if (sample.includes(0)) return null;
  return buffer.toString("utf8");
}

function listFiles(root, { sourceMode = false } = {}) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (sourceMode && skippedDirectoryNames.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`privacy scan rejects links: ${path.join(directory, entry.name)}`);
      if (entry.isDirectory()) {
        if (skippedDirectoryNames.has(entry.name)) continue;
        if (sourceMode && entry.name === "dist" && path.resolve(directory) === path.resolve(root)) continue;
        stack.push(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  return files.sort();
}

export function scanTree(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const findings = [];
  for (const file of listFiles(resolvedRoot, options)) {
    const relative = path.relative(resolvedRoot, file).replaceAll(path.sep, "/");
    const normalizedRelative = relative.toLowerCase();
    if (screenshotNamePattern.test(relative)) findings.push({ file: relative, rule: "real-screenshot-file" });
    if (binaryExtensions.has(path.extname(file).toLowerCase())) continue;
    const text = decodeText(fs.readFileSync(file));
    if (text === null) continue;
    if (file !== ownPath && personalAccountPattern.test(text)) findings.push({ file: relative, rule: "personal-account" });
    if (file !== ownPath && privateThreadPattern.test(text)) findings.push({ file: relative, rule: "private-thread-id" });
    if (userProfilePathPattern.test(text)) findings.push({ file: relative, rule: "windows-user-profile-path" });
    if (file !== ownPath && driveAbsolutePathPattern.test(text)) findings.push({ file: relative, rule: "drive-absolute-path" });
    if (unixHomePathPattern.test(text)) findings.push({ file: relative, rule: "unix-user-profile-path" });
    for (const { kind, regex } of secretLiteralPatterns) {
      if (regex.test(text)) findings.push({ file: relative, rule: "secret-literal", kind });
    }
    for (const match of text.matchAll(uuidPattern)) {
      const uuid = match[0].toLowerCase();
      if (productionProvenancePaths.has(normalizedRelative) && allowedSyntheticUuids.has(uuid)) {
        findings.push({ file: relative, rule: "production-synthetic-uuid", value: uuid });
      } else if (!allowedSyntheticUuids.has(uuid)) {
        findings.push({ file: relative, rule: "non-synthetic-uuid", value: uuid });
      }
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  const target = path.resolve(process.argv[2] || path.resolve(path.dirname(ownPath), ".."));
  const findings = scanTree(target, { sourceMode: process.argv.includes("--source") });
  if (findings.length) {
    for (const finding of findings) process.stderr.write(`PRIVACY_SCAN_FAIL ${finding.rule} ${finding.file}${finding.value ? ` ${finding.value}` : ""}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PRIVACY_SCAN_OK files under ${target}\n`);
  }
}
