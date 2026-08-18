#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptsDirectory, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "extension.json"), "utf8"));
const serverPath = path.join(extensionRoot, "server.mjs");
const threadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sourceThreadId = [process.env.CODEX_THREAD_ID, process.env.OUTPUT_ITEMS_SOURCE_THREAD_ID]
  .map((value) => String(value || "").trim().toLowerCase())
  .find((value) => threadIdPattern.test(value)) || null;
const child = spawn(process.execPath, [serverPath], {
  cwd: extensionRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

child.stdin.end(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "output-items/register-self",
  params: {
    project: manifest.provenance?.project || "产出项",
    task: manifest.provenance?.task || "安装产出项本地扩展",
    ...(sourceThreadId ? { threadId: sourceThreadId } : {}),
    version: `v${manifest.version}`,
    description: "正式版支持 Codex 深浅外观同步、任务重命名同步、自动抓取、汇总大小、安全删除、文件预览和 GitHub 发布。",
  },
})}\n`);

const exitCode = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("登记扩展版本超时"));
  }, 10_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

if (exitCode !== 0) throw new Error(`登记扩展版本失败：${stderr || `exit ${exitCode}`}`);
const responseLine = stdout.trim().split(/\r?\n/).find(Boolean);
if (!responseLine) throw new Error("登记扩展版本没有返回响应");
const response = JSON.parse(responseLine);
if (response.error) throw new Error(response.error.message || "登记扩展版本失败");
if (response.result?.item?.version !== `v${manifest.version}`) {
  throw new Error("登记扩展版本的响应不符合预期");
}
process.stdout.write(`REGISTERED_OUTPUT_ITEMS_VERSION=v${manifest.version}\n`);
