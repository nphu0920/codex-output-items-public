#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  process.stdout.write("SKIP recycle-path PowerShell self-test (Windows only)\n");
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const adjacentRecycleScript = path.join(scriptDirectory, "recycle-path.ps1");
const recycleScript = fs.existsSync(adjacentRecycleScript)
  ? adjacentRecycleScript
  : path.resolve(scriptDirectory, "..", "extension", "scripts", "recycle-path.ps1");
const extensionRoot = path.resolve(path.dirname(recycleScript), "..");
const powershellCwd = process.env.OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT
  ? path.resolve(process.env.OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT)
  : extensionRoot;
if (!fs.existsSync(powershellCwd) || !fs.statSync(powershellCwd).isDirectory()) {
  throw new Error("OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT must be an existing directory");
}
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-recycle-中文 空格,fixture-"));
const protectedFixtureRoot = path.join(fixtureRoot, "受保护 根,中文");
fs.mkdirSync(protectedFixtureRoot, { recursive: true });

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, {
      cwd: powershellCwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("recycle helper self-test timed out"));
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// The helper guard is exercised with a dedicated protected root. The package
// directory is protected by the server self-test separately and may inherit
// restrictive ACLs when a Release verifier extracts it beneath Windows Temp.
const protectedRootsJson = JSON.stringify([
  protectedFixtureRoot,
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexOutputItems"),
  process.env.SystemRoot,
  process.env.WINDIR,
  process.env.ProgramData,
  process.env.ProgramFiles,
  process.env["ProgramFiles(x86)"],
  process.env.ProgramW6432,
].filter(Boolean));

function invokeRecycle(target, allowedRoot, protectedJson = protectedRootsJson) {
  return runPowerShell([
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", recycleScript,
    "-LiteralTarget", target,
    "-AllowedRoot", allowedRoot,
    "-ProtectedRootsJson", protectedJson,
  ]);
}

async function recycle(target, allowedRoot) {
  const result = await invokeRecycle(target, allowedRoot);
  assert.equal(result.code, 0, `recycle helper failed: ${result.stderr || result.stdout}`);
  assert.equal(fs.existsSync(target), false, `target still exists after recycle: ${target}`);
}

async function expectRejected(target, allowedRoot, expected, protectedJson = protectedRootsJson) {
  const result = await invokeRecycle(target, allowedRoot, protectedJson);
  assert.notEqual(result.code, 0, `unsafe recycle unexpectedly succeeded: ${target}`);
  assert.match(`${result.stderr}\n${result.stdout}`, expected);
  assert.equal(fs.existsSync(target), true, `rejected target was changed: ${target}`);
}

try {
  const helperSource = fs.readFileSync(recycleScript, "utf8");
  assert.match(helperSource, /RecycleOption\]::SendToRecycleBin/g);
  assert.doesNotMatch(helperSource, /\bRemove-Item\b|\[System\.IO\.(?:File|Directory)\]::Delete/);

  const protectedFile = path.join(protectedFixtureRoot, "必须 保留,中文.txt");
  fs.writeFileSync(protectedFile, "protected fixture\n", "utf8");
  await expectRejected(protectedFile, protectedFixtureRoot, /Protected system or extension path cannot be recycled/);

  const protectedAncestor = path.join(fixtureRoot, "包含受保护根,中文");
  const protectedDescendant = path.join(protectedAncestor, "不可连带删除,中文");
  fs.mkdirSync(protectedDescendant, { recursive: true });
  fs.writeFileSync(path.join(protectedDescendant, "保留.txt"), "protected descendant fixture\n", "utf8");
  const ancestorProtectedJson = JSON.stringify([protectedDescendant, ...JSON.parse(protectedRootsJson)]);
  await expectRejected(protectedAncestor, protectedAncestor, /Protected system or extension path cannot be recycled/, ancestorProtectedJson);

  const authorizedRoot = path.join(fixtureRoot, "授权 根,中文");
  const outsideTarget = path.join(fixtureRoot, "越界 文件,中文.txt");
  fs.mkdirSync(authorizedRoot, { recursive: true });
  fs.writeFileSync(outsideTarget, "outside fixture\n", "utf8");
  await expectRejected(outsideTarget, authorizedRoot, /Target escaped the authorized output root/);

  const malformedJsonTarget = path.join(authorizedRoot, "错误 JSON,保留.txt");
  fs.writeFileSync(malformedJsonTarget, "malformed JSON fixture\n", "utf8");
  await expectRejected(malformedJsonTarget, authorizedRoot, /ProtectedRootsJson must contain a JSON array/, JSON.stringify({ root: protectedFixtureRoot }));
  await expectRejected(malformedJsonTarget, authorizedRoot, /ProtectedRootsJson must contain a JSON array/, JSON.stringify(protectedFixtureRoot));
  await expectRejected(malformedJsonTarget, authorizedRoot, /Every protected root must be a string/, JSON.stringify([protectedFixtureRoot, 42]));
  await expectRejected(malformedJsonTarget, authorizedRoot, /At least one protected root is required/, "[]");

  const nestedRoot = path.join(fixtureRoot, "中文 空格,嵌套根");
  const nestedTarget = path.join(nestedRoot, "子 目录,一", "单个 文件,测试.txt");
  fs.mkdirSync(path.dirname(nestedTarget), { recursive: true });
  fs.writeFileSync(nestedTarget, "nested file fixture\n", "utf8");
  await recycle(nestedTarget, nestedRoot);

  const singleFile = path.join(fixtureRoot, "单文件 输出,中文.txt");
  fs.writeFileSync(singleFile, "single output fixture\n", "utf8");
  await recycle(singleFile, singleFile);

  const project = path.join(fixtureRoot, "项目 删除,中文");
  fs.mkdirSync(path.join(project, "内容 子目录,二"), { recursive: true });
  fs.writeFileSync(path.join(project, "内容 子目录,二", "文件.txt"), "project fixture\n", "utf8");
  await recycle(project, project);

  for (const name of ["批量 项目,甲", "批量 项目,乙"]) {
    const batchProject = path.join(fixtureRoot, name);
    fs.mkdirSync(batchProject, { recursive: true });
    fs.writeFileSync(path.join(batchProject, "文件,一.txt"), "batch fixture\n", "utf8");
    await recycle(batchProject, batchProject);
  }

  const linkTarget = path.join(fixtureRoot, "联接 真实目标,中文");
  const linkPath = path.join(fixtureRoot, "联接 路径,中文");
  fs.mkdirSync(linkTarget, { recursive: true });
  fs.writeFileSync(path.join(linkTarget, "必须 保留.txt"), "junction fixture\n", "utf8");
  try {
    fs.symlinkSync(linkTarget, linkPath, "junction");
    await expectRejected(linkPath, linkPath, /Reparse points are not allowed in a deletion path/);
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
  }

  process.stdout.write("PASS recycle-path PowerShell helper (guards + Unicode/space/comma file/project/batch)\n");
} finally {
  const resolvedFixture = path.resolve(fixtureRoot);
  const resolvedTemp = path.resolve(os.tmpdir());
  assert.ok(resolvedFixture !== resolvedTemp && resolvedFixture.startsWith(`${resolvedTemp}${path.sep}`));
  fs.rmSync(resolvedFixture, { recursive: true, force: true });
}
