#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCodexOutputScanner } from "./codex-output-scanner.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(scriptsDir, "..", "server.mjs");
const extensionRoot = path.dirname(serverPath);
const registerSelfPath = path.join(scriptsDir, "register-self.mjs");
const explorerHelperPath = path.join(scriptsDir, "open-explorer-location.ps1");
const scannerFixtureParent = process.env.OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT
  ? path.resolve(process.env.OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT)
  : path.resolve(path.dirname(serverPath), "..");
if (!fs.existsSync(scannerFixtureParent) || !fs.statSync(scannerFixtureParent).isDirectory()) {
  throw new Error("OUTPUT_ITEMS_SELF_TEST_FIXTURE_PARENT must be an existing directory");
}
const ROOT_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const GUARDIAN_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const DELETED_ONLY_THREAD_ID = "44444444-4444-4444-8444-444444444444";
const MISSING_CATALOG_THREAD_ID = "55555555-5555-4555-8555-555555555555";
const SQLITE_NAME_THREAD_ID = "66666666-6666-4666-8666-666666666666";

function appendJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function scannedTreeBytes(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) return total;
    return total + scannedTreeBytes(path.join(target, entry.name));
  }, 0);
}

function renameStableSnapshot(item) {
  const snapshot = JSON.parse(JSON.stringify(item));
  if (snapshot.taskGroup && typeof snapshot.taskGroup === "object") {
    delete snapshot.taskGroup.title;
    delete snapshot.taskGroup.titleSyncedAt;
  }
  return snapshot;
}

async function runSelfRegistration({ dataRoot, codexRoot, codexThreadId = "", explicitThreadId = "" }) {
  const child = spawn(process.execPath, [registerSelfPath], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      OUTPUT_ITEMS_DATA_DIR: dataRoot,
      OUTPUT_ITEMS_CODEX_HOME: codexRoot,
      CODEX_THREAD_ID: codexThreadId,
      OUTPUT_ITEMS_SOURCE_THREAD_ID: explicitThreadId,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("register-self fixture timed out")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, `register-self fixture failed: ${stderr || stdout}`);
  assert.match(stdout, /REGISTERED_OUTPUT_ITEMS_VERSION=/);
  return JSON.parse(fs.readFileSync(path.join(dataRoot, "data", "items.json"), "utf8"));
}

async function runRawInternalSelfRegistration({ dataRoot, codexRoot, codexThreadId = "", explicitThreadId = "", requestedThreadId = "" }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      OUTPUT_ITEMS_DATA_DIR: dataRoot,
      OUTPUT_ITEMS_CODEX_HOME: codexRoot,
      CODEX_THREAD_ID: codexThreadId,
      OUTPUT_ITEMS_SOURCE_THREAD_ID: explicitThreadId,
    },
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
    params: { threadId: requestedThreadId, task: "原始 RPC 优先级测试" },
  })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("raw register-self fixture timed out")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, `raw register-self fixture failed: ${stderr || stdout}`);
  const response = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.id === 1);
  assert.ok(response?.result?.item, `raw register-self fixture returned no item: ${stdout}`);
  return response.result.item;
}

async function makeScannerFixture() {
  const fixtureParent = scannerFixtureParent;
  const codexRoot = fs.mkdtempSync(path.join(fixtureParent, ".scanner-codex-fixture-"));
  const workspace = fs.mkdtempSync(path.join(fixtureParent, ".scanner-workspace-fixture-"));
  const project = path.join(workspace, "outputs", "demo-app");
  const projectSource = path.join(project, "src");
  const delivery = path.join(workspace, "deliverables", "bundle.zip");
  const generatedFolder = path.join(codexRoot, "generated_images", ROOT_THREAD_ID);
  const generatedImage = path.join(generatedFolder, "dashboard.png");
  const rootRollout = path.join(codexRoot, "sessions", "2026", "01", "01", `rollout-${ROOT_THREAD_ID}.jsonl`);
  const childRollout = path.join(codexRoot, "sessions", "2026", "01", "01", `rollout-${CHILD_THREAD_ID}.jsonl`);
  const guardianRollout = path.join(codexRoot, "archived_sessions", `rollout-${GUARDIAN_THREAD_ID}.jsonl`);
  fs.mkdirSync(projectSource, { recursive: true });
  fs.mkdirSync(path.dirname(delivery), { recursive: true });
  fs.mkdirSync(generatedFolder, { recursive: true });
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"demo-app"}\n');
  fs.writeFileSync(path.join(projectSource, "app.js"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(projectSource, "child.js"), "export const child = true;\n");
  fs.writeFileSync(path.join(projectSource, "中文, 文件.js"), "export const localized = true;\n");
  fs.writeFileSync(path.join(project, "preview.md"), "# 安全预览\n\n这是一段 UTF-8 文本。\n");
  fs.writeFileSync(path.join(project, "preview.html"), "<script>globalThis.__outputItemsPreviewExecuted = true</script>\n");
  fs.writeFileSync(path.join(project, "preview.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"globalThis.__outputItemsPreviewExecuted=true\"></svg>\n");
  fs.writeFileSync(path.join(project, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("UTF-16 安全预览\n", "utf16le")]));
  fs.writeFileSync(path.join(project, "binary.txt"), Buffer.from([0x41, 0x00, 0x42, 0x00]));
  fs.writeFileSync(path.join(project, "long.txt"), "行\n".repeat(5_001));
  fs.writeFileSync(path.join(project, "large-text.log"), "x".repeat(512 * 1024 + 32));
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(path.join(project, "pixel.png"), onePixelPng);
  fs.writeFileSync(path.join(project, "fake.png"), "this is not a png\n");
  const oversizedDimensionPng = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedDimensionPng, 0);
  oversizedDimensionPng.write("IHDR", 12, "ascii");
  oversizedDimensionPng.writeUInt32BE(20_000, 16);
  oversizedDimensionPng.writeUInt32BE(20_000, 20);
  fs.writeFileSync(path.join(project, "oversized-dimensions.png"), oversizedDimensionPng);
  const oversizedImage = path.join(project, "oversized-bytes.png");
  fs.writeFileSync(oversizedImage, onePixelPng);
  fs.truncateSync(oversizedImage, 12 * 1024 * 1024 + 1);
  fs.writeFileSync(delivery, "fixture zip");
  fs.writeFileSync(generatedImage, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const sessionIndexFile = path.join(codexRoot, "session_index.jsonl");
  appendJsonl(sessionIndexFile, [
    { id: ROOT_THREAD_ID, thread_name: "自动抓取旧标题", updated_at: "2025-12-31T23:59:00.000Z" },
    { id: ROOT_THREAD_ID, thread_name: "自动抓取测试", updated_at: "2026-01-01T00:00:00.000Z" },
    { id: ROOT_THREAD_ID, thread_name: "不应覆盖的新行旧标题", updated_at: "2025-12-31T23:59:30.000Z" },
    { id: ROOT_THREAD_ID, thread_name: "   ", updated_at: "2026-12-31T23:59:59.000Z" },
    { id: DELETED_ONLY_THREAD_ID, thread_name: "归档全删旧标题", updated_at: "2026-01-01T00:00:00.000Z" },
  ]);

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path.join(codexRoot, "state_5.sqlite"));
  database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, thread_source TEXT, agent_role TEXT, agent_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);");
  const insertThread = database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertThread.run(ROOT_THREAD_ID, "这个 SQLite 标题不应覆盖 session_index 的短标题", "这个 SQLite name 也不应覆盖 session_index", workspace, "user", null, null);
  insertThread.run(CHILD_THREAD_ID, "子代理旧标题", "子代理", workspace, "subagent", "worker", "scanner/worker");
  insertThread.run(GUARDIAN_THREAD_ID, "守护代理旧标题", "守护代理", workspace, "subagent", "guardian", "guardian");
  insertThread.run(SQLITE_NAME_THREAD_ID, "SQLite title 旧值", "SQLite name 新值", workspace, "user", null, null);
  database.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run(ROOT_THREAD_ID, CHILD_THREAD_ID);
  database.close();

  const session = (id, timestamp, source = "user") => ({
    timestamp, type: "session_meta", payload: {
      id, session_id: id === ROOT_THREAD_ID ? ROOT_THREAD_ID : ROOT_THREAD_ID, cwd: workspace,
      source: source === "user" ? "cli" : { subagent: source === "guardian" ? { other: "guardian" } : { thread_spawn: { parent_thread_id: ROOT_THREAD_ID, agent_path: "scanner/worker" } } },
    },
  });
  const turn = (timestamp, turnId) => ({ timestamp, type: "turn_context", payload: { cwd: workspace, turn_id: turnId } });
  const patchCall = (timestamp, callId, turnId) => ({
    timestamp, type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: callId, turn_id: turnId, input: "await tools.apply_patch('*** Begin Patch\\n*** End Patch')" },
  });
  const patchEnd = (timestamp, callId, turnId, changes) => ({
    timestamp, type: "event_msg", payload: { type: "patch_apply_end", call_id: callId, turn_id: turnId, success: true, status: "completed", changes },
  });
  const rootRecords = [
    session(ROOT_THREAD_ID, "2026-01-01T00:00:00.000Z"),
    turn("2026-01-01T00:00:01.000Z", "turn-root"),
    patchCall("2026-01-01T00:00:02.000Z", "call-root-add", "turn-root"),
    patchEnd("2026-01-01T00:00:03.000Z", "call-root-add", "turn-root", {
      [path.join(project, "package.json")]: { type: "add" },
      [path.join(projectSource, "app.js")]: { type: "add" },
    }),
    patchCall("2026-01-01T00:00:04.000Z", "call-root-delete", "turn-root"),
    patchEnd("2026-01-01T00:00:05.000Z", "call-root-delete", "turn-root", {
      [path.join(projectSource, "obsolete.js")]: { type: "delete" },
    }),
    { timestamp: "2026-01-01T00:00:06.000Z", type: "event_msg", payload: { type: "image_generation_end", status: "completed", call_id: "call-image", saved_path: generatedImage, result: "small-fixture" } },
    { timestamp: "2026-01-01T00:00:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", id: "final-root", content: [{ type: "output_text", text: `[交付包](${delivery}) [临时截图](${path.join(os.tmpdir(), "ignored.png")})` }] } },
    '{"timestamp":"2026-01-01T00:00:08.000Z","type":"event_msg","payload":{"type":"patch_apply_end" BROKEN',
  ];
  appendJsonl(rootRollout, rootRecords);

  appendJsonl(childRollout, [
    session(CHILD_THREAD_ID, "2026-01-01T00:01:00.000Z", "child"),
    turn("2026-01-01T00:00:01.000Z", "turn-root"),
    patchCall("2026-01-01T00:00:02.000Z", "call-root-add", "turn-root"),
    patchEnd("2026-01-01T00:00:03.000Z", "call-root-add", "turn-root", { [path.join(projectSource, "app.js")]: { type: "add" } }),
    turn("2026-01-01T00:01:01.000Z", "turn-child"),
    patchCall("2026-01-01T00:01:02.000Z", "call-child-add", "turn-child"),
    patchEnd("2026-01-01T00:01:03.000Z", "call-child-add", "turn-child", { [path.join(projectSource, "child.js")]: { type: "add" } }),
  ]);

  const guardianProject = path.join(workspace, "outputs", "guardian-only");
  fs.mkdirSync(guardianProject, { recursive: true });
  fs.writeFileSync(path.join(guardianProject, "package.json"), '{"name":"guardian-only"}\n');
  appendJsonl(guardianRollout, [
    session(GUARDIAN_THREAD_ID, "2026-01-01T00:02:00.000Z", "guardian"),
    turn("2026-01-01T00:02:01.000Z", "turn-guardian"),
    patchCall("2026-01-01T00:02:02.000Z", "call-guardian", "turn-guardian"),
    patchEnd("2026-01-01T00:02:03.000Z", "call-guardian", "turn-guardian", { [path.join(guardianProject, "package.json")]: { type: "add" } }),
  ]);
  return { codexRoot, workspace, project, projectSource, delivery, generatedFolder, rootRollout, sessionIndexFile };
}

async function waitForScan(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("api/scan-status", baseUrl));
    assert.equal(response.status, 200);
    const { scan } = await response.json();
    assert.ok(["idle", "running", "complete", "error"].includes(scan.state));
    if (scan.state === "error") throw new Error(scan.message);
    if (scan.state === "complete") return scan;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("scanner self-test timed out");
}

const emptyCodexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-empty-codex-"));
const testDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-self-test-"));
const child = spawn(process.execPath, [serverPath], {
  cwd: path.dirname(serverPath),
  env: {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    OUTPUT_ITEMS_DATA_DIR: testDataRoot,
    OUTPUT_ITEMS_CODEX_HOME: emptyCodexRoot,
    CODEX_THREAD_ID: "",
    OUTPUT_ITEMS_SOURCE_THREAD_ID: "",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "self-test", version: "1.0.0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "open_output_items", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "resources/list", params: {} },
  { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "ui://output-items/dashboard.html" } },
  { jsonrpc: "2.0", id: 7, method: "prompts/list", params: {} },
  { jsonrpc: "2.0", id: 8, method: "resources/templates/list", params: {} },
  { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "detect_output_item", arguments: { id: "output-items-local-extension", mode: "full" } } },
  { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "mark_output_item", arguments: { id: "output-items-local-extension", mark: "需要修复", note: "自测" } } },
  { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "register_output_item", arguments: { path: serverPath, title: "server.mjs", project: "self-test", task: "验证登记", threadId: ROOT_THREAD_ID, version: "v1" } } },
  { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "list_output_items", arguments: {} } },
  { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "register_output_item", arguments: { path: serverPath, title: "server.mjs", project: "self-test", task: "验证同路径升级", threadId: ROOT_THREAD_ID, version: "v2" } } },
  { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_output_items", arguments: {} } },
  { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "scan_output_items", arguments: { force: true } } },
  { jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "preview_output_item_file", arguments: { id: "output-items-local-extension", relativePath: "README.md" } } },
  { jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "register_output_item", arguments: { path: serverPath, title: "missing-thread", project: "self-test", task: "缺失来源任务" } } },
  { jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "register_output_item", arguments: { path: serverPath, title: "invalid-thread", project: "self-test", task: "无效来源任务", threadId: "not-a-uuid" } } },
];

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
  if (request.id === undefined) continue;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const received = stdout.trim().split(/\r?\n/).filter(Boolean).some((line) => {
      try { return JSON.parse(line).id === request.id; } catch { return false; }
    });
    if (received) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(stdout.trim().split(/\r?\n/).filter(Boolean).some((line) => {
    try { return JSON.parse(line).id === request.id; } catch { return false; }
  }), `MCP server did not answer request ${request.id} before the next dependent request`);
}
child.stdin.end();

try {
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP server self-test timed out")); }, 8000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, `server exited with ${exitCode}; stderr=${stderr}`);
  assert.equal(stderr, "", `server wrote non-protocol diagnostics: ${stderr}`);
  const messages = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages.length, 18, "initialized notification must not receive a response");
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (let id = 1; id <= 16; id += 1) {
    assert.ok(byId.has(id), `missing JSON-RPC response ${id}`);
    assert.ok(!byId.get(id).error, `response ${id} failed: ${JSON.stringify(byId.get(id).error)}`);
  }
  assert.match(byId.get(17).error?.message || "", /来源任务 ID 必须是有效 UUID/);
  assert.match(byId.get(18).error?.message || "", /来源任务 ID 必须是有效 UUID/);
  assert.equal(byId.get(1).result.serverInfo.title, "产出项");
  assert.equal(byId.get(1).result.serverInfo.version, "1.0.0");
  assert.deepEqual(byId.get(2).result, {});
  const tools = byId.get(3).result.tools;
  assert.equal(tools.length, 19);
  assert.ok(tools.some((tool) => tool.name === "scan_output_items"));
  assert.equal(tools.some((tool) => tool.name === "output-items/register-self"), false, "internal self-registration must not be advertised as a public tool");
  assert.ok(tools.find((tool) => tool.name === "register_output_item").inputSchema.required.includes("threadId"), "public registration must continue requiring a real thread UUID");
  assert.equal(tools.find((tool) => tool.name === "delete_output_item").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "batch_delete_output_items").annotations.destructiveHint, true);
  assert.ok(tools.some((tool) => tool.name === "open_output_item_location"));
  const previewTool = tools.find((tool) => tool.name === "preview_output_item_file");
  assert.ok(previewTool);
  assert.deepEqual(previewTool._meta.ui.visibility, ["app"], "file preview must be visible to the app only, not the model");
  assert.deepEqual(previewTool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.ok(tools.some((tool) => tool.name === "set_output_item_priority"));
  assert.ok(tools.some((tool) => tool.name === "get_github_upload_context"));
  assert.equal(tools.find((tool) => tool.name === "preflight_github_upload").annotations.readOnlyHint, false);
  assert.equal(tools.find((tool) => tool.name === "preflight_github_upload").annotations.idempotentHint, false);
  assert.equal(tools.find((tool) => tool.name === "start_github_upload").annotations.openWorldHint, true);
  assert.equal(tools.find((tool) => tool.name === "start_github_upload").annotations.destructiveHint, true);
  assert.equal(tools.find((tool) => tool.name === "cancel_github_upload").annotations.idempotentHint, false);
  assert.equal(tools.find((tool) => tool.name === "cancel_github_upload").annotations.openWorldHint, false);
  const entryTool = tools.find((tool) => tool.name === "open_output_items");
  assert.equal(entryTool.title, "产出项");
  assert.equal(entryTool._meta.ui.resourceUri, "ui://output-items/dashboard.html");
  assert.deepEqual(entryTool._meta.ui.visibility, ["app", "model"]);
  assert.deepEqual(entryTool._meta["openai/ui"].entrypoints, [{ type: "global" }]);
  assert.ok(byId.get(4).result.structuredContent.items.length >= 1);
  const freshSeed = byId.get(4).result.structuredContent.items.find((item) => item.id === "output-items-local-extension");
  assert.equal(freshSeed.source.threadId, null, "a seed without real task context must not invent a UUID");
  assert.deepEqual(freshSeed.taskGroup, {
    key: "local-install",
    rootThreadId: null,
    title: "本地安装",
    project: "local-install",
    projectKind: "unknown",
    hostId: null,
    workspacePath: null,
    unknown: true,
  });
  assert.equal(byId.get(5).result.resources[0].uri, "ui://output-items/dashboard.html");
  const [resource] = byId.get(6).result.contents;
  assert.match(resource.mimeType, /^text\/html/);
  assert.match(resource.text, /<title>产出项<\/title>/);
  assert.match(resource.text, /<style>/);
  assert.doesNotMatch(resource.text, /src="\/assets\//);
  assert.deepEqual(byId.get(7).result.prompts, []);
  assert.deepEqual(byId.get(8).result.resourceTemplates, []);
  assert.equal(byId.get(9).result.structuredContent.result.source, "real");
  assert.equal(byId.get(10).result.structuredContent.item.mark, "需要修复");
  assert.equal(byId.get(11).result.structuredContent.item.title, "server.mjs");
  assert.equal(byId.get(11).result.structuredContent.item.sizeBytes, fs.statSync(serverPath).size, "manual registration must persist the exact item byte size");
  assert.equal(byId.get(11).result.structuredContent.item.sizeAggregationComplete, true);
  assert.deepEqual(byId.get(11).result.structuredContent.item.taskGroup, {
    key: `thread:${ROOT_THREAD_ID}`,
    rootThreadId: ROOT_THREAD_ID,
    title: "验证登记",
    project: "self-test",
    projectKind: "manual",
    hostId: null,
    workspacePath: null,
    unknown: false,
  }, "manual registration must return a complete task-group contract");
  assert.equal(byId.get(12).result.structuredContent.items.length, 2);
  assert.equal(byId.get(12).result.structuredContent.items.find((item) => item.title === "server.mjs").taskGroup.key, `thread:${ROOT_THREAD_ID}`);
  assert.equal(byId.get(13).result.structuredContent.item.version, "v2");
  assert.deepEqual(byId.get(13).result.structuredContent.item.versions.map((entry) => entry.version), ["v2", "v1"]);
  assert.equal(byId.get(14).result.structuredContent.items.length, 2, "same path must update one item instead of creating a duplicate");
  assert.equal(byId.get(15).result.structuredContent.scan.state, "running");
  assert.equal(byId.get(16).result.structuredContent.preview.kind, "text");
  assert.equal(byId.get(16).result.structuredContent.preview.renderMode, "plain-text");
  assert.match(byId.get(16).result.structuredContent.preview.text, /^# (?:Codex )?产出项/m);
  assert.equal(byId.get(16).result.structuredContent.preview.bytesBase64, undefined, "text previews must not be returned as executable data URLs");
  process.stdout.write("PASS output-items local MCP server (16 request/response checks)\n");
} finally {
  fs.rmSync(testDataRoot, { recursive: true, force: true });
  fs.rmSync(emptyCodexRoot, { recursive: true, force: true });
}

const selfRegistrationCodexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-register-self-codex-"));
const selfRegistrationRoots = [];
const makeSelfRegistrationDataRoot = (label) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `output-items-register-self-${label}-`));
  selfRegistrationRoots.push(dataRoot);
  return dataRoot;
};
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "extension.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest.provenance || {}, "threadId"), false, "production manifest must not pin a task UUID");
  const commonSource = fs.readFileSync(path.join(scriptsDir, "common.ps1"), "utf8");
  assert.doesNotMatch(commonSource, /manifest\.provenance\.threadId/);
  assert.doesNotMatch(commonSource, /--env\s+"OUTPUT_ITEMS_SOURCE_THREAD_ID=/, "installer registration must not persist a fixed source task");
  assert.ok((commonSource.match(/Suspend-OutputItemsTaskContext/g) || []).length >= 3, "HTTP and companion process launches must suspend task context");
  assert.ok((commonSource.match(/Restore-OutputItemsTaskContext/g) || []).length >= 3, "HTTP and companion process launches must restore task context");

  const preferredItems = await runSelfRegistration({
    dataRoot: makeSelfRegistrationDataRoot("preferred"),
    codexRoot: selfRegistrationCodexRoot,
    codexThreadId: ROOT_THREAD_ID,
    explicitThreadId: CHILD_THREAD_ID,
  });
  assert.equal(preferredItems.length, 1, "fresh seed and self-registration must collapse to one path record");
  assert.equal(preferredItems[0].source.threadId, ROOT_THREAD_ID, "valid CODEX_THREAD_ID must take precedence");
  assert.equal(preferredItems[0].taskGroup.key, `thread:${ROOT_THREAD_ID}`);

  const rawPriorityItem = await runRawInternalSelfRegistration({
    dataRoot: makeSelfRegistrationDataRoot("raw-priority"),
    codexRoot: selfRegistrationCodexRoot,
    codexThreadId: ROOT_THREAD_ID,
    explicitThreadId: GUARDIAN_THREAD_ID,
    requestedThreadId: CHILD_THREAD_ID,
  });
  assert.equal(rawPriorityItem.source.threadId, ROOT_THREAD_ID, "the server must not let raw RPC arguments override CODEX_THREAD_ID");
  assert.equal(rawPriorityItem.taskGroup.key, `thread:${ROOT_THREAD_ID}`);

  const explicitFallbackItems = await runSelfRegistration({
    dataRoot: makeSelfRegistrationDataRoot("explicit"),
    codexRoot: selfRegistrationCodexRoot,
    codexThreadId: "not-a-uuid",
    explicitThreadId: CHILD_THREAD_ID,
  });
  assert.equal(explicitFallbackItems[0].source.threadId, CHILD_THREAD_ID, "invalid CODEX_THREAD_ID must fall back to an explicitly valid source UUID");
  assert.equal(explicitFallbackItems[0].taskGroup.key, `thread:${CHILD_THREAD_ID}`);

  const unknownItems = await runSelfRegistration({
    dataRoot: makeSelfRegistrationDataRoot("unknown"),
    codexRoot: selfRegistrationCodexRoot,
  });
  assert.equal(unknownItems.length, 1);
  assert.deepEqual(unknownItems[0].source, {
    project: "local-install",
    task: "本地安装",
    threadId: null,
    origin: "local-install",
    created: unknownItems[0].source.created,
  });
  assert.deepEqual(unknownItems[0].taskGroup, {
    key: "local-install",
    rootThreadId: null,
    title: "本地安装",
    project: "local-install",
    projectKind: "unknown",
    hostId: null,
    workspacePath: null,
    unknown: true,
  });

  const legacyFakeThreadId = "00000000-0000-4000-8000-000000000001";
  const migrationDataRoot = makeSelfRegistrationDataRoot("migration");
  fs.mkdirSync(path.join(migrationDataRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(migrationDataRoot, "data", "items.json"), JSON.stringify([{
    id: "output-items-local-extension",
    title: "产出项本地扩展",
    path: extensionRoot,
    version: "v0.9.9",
    source: { project: "synthetic", task: "不存在任务", threadId: legacyFakeThreadId, created: "2026-01-01 00:00" },
    taskGroup: {
      key: `thread:${legacyFakeThreadId}`,
      rootThreadId: legacyFakeThreadId,
      title: "不存在任务",
      project: "synthetic",
      projectKind: "manual",
      hostId: null,
      workspacePath: null,
      unknown: false,
    },
    versions: [{ version: "v0.9.9", current: true, source: { project: "synthetic", task: "不存在任务", threadId: legacyFakeThreadId } }],
    activity: [],
    files: [],
  }], null, 2));
  const migratedItems = await runSelfRegistration({
    dataRoot: migrationDataRoot,
    codexRoot: selfRegistrationCodexRoot,
    codexThreadId: ROOT_THREAD_ID,
  });
  assert.equal(migratedItems.length, 1, "same-path legacy seed must be replaced rather than duplicated");
  assert.equal(migratedItems[0].source.threadId, ROOT_THREAD_ID);
  assert.equal(migratedItems[0].taskGroup.key, `thread:${ROOT_THREAD_ID}`);
  assert.equal(migratedItems[0].taskGroup.rootThreadId, ROOT_THREAD_ID);
  assert.notEqual(migratedItems[0].taskGroup.key, `thread:${legacyFakeThreadId}`);

  const localMigrationDataRoot = makeSelfRegistrationDataRoot("local-migration");
  fs.mkdirSync(path.join(localMigrationDataRoot, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(localMigrationDataRoot, "data", "items.json"),
    fs.readFileSync(path.join(migrationDataRoot, "data", "items.json"), "utf8")
      .replaceAll(ROOT_THREAD_ID, legacyFakeThreadId)
      .replace(`thread:${ROOT_THREAD_ID}`, `thread:${legacyFakeThreadId}`),
  );
  const localMigratedItems = await runSelfRegistration({
    dataRoot: localMigrationDataRoot,
    codexRoot: selfRegistrationCodexRoot,
  });
  assert.equal(localMigratedItems.length, 1);
  assert.equal(localMigratedItems[0].source.threadId, null, "a legacy fake source without current task context must migrate to local-install");
  assert.equal(localMigratedItems[0].taskGroup.key, "local-install");
  assert.equal(localMigratedItems[0].taskGroup.unknown, true);

  const launcherSafety = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(scriptsDir, "launcher-safety-self-test.ps1"),
  ], { encoding: "utf8", windowsHide: true, shell: false, timeout: 30_000 });
  assert.equal(launcherSafety.status, 0, `launcher safety fixture failed: ${launcherSafety.stderr || launcherSafety.stdout}`);
  const launcherSafetyResult = JSON.parse(String(launcherSafety.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(launcherSafetyResult.taskContextChildSanitized, true);
  assert.equal(launcherSafetyResult.taskContextRestored, true);
  process.stdout.write("PASS output-items self-registration provenance (real env, explicit env, unknown and legacy migration checks)\n");
} finally {
  for (const dataRoot of selfRegistrationRoots) fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(selfRegistrationCodexRoot, { recursive: true, force: true });
}

const httpDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-http-self-test-"));
const itemsDataPath = path.join(httpDataRoot, "data", "items.json");
const scannerFixture = await makeScannerFixture();
const explorerFocusFixture = path.join(httpDataRoot, "explorer-focus, 中文");
fs.mkdirSync(explorerFocusFixture, { recursive: true });
const runExplorerFixture = (windows) => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", explorerHelperPath,
    "-LiteralDirectory", explorerFocusFixture,
    "-FixtureWindowsJson", JSON.stringify(windows),
  ], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 0, `Explorer helper fixture failed: ${result.stderr}`);
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length, "Explorer helper fixture must return JSON");
  return JSON.parse(lines.at(-1));
};
const exactExplorerFixture = runExplorerFixture([
  { hwnd: 101, directory: `${explorerFocusFixture}-similar-title` },
  { hwnd: 202, directory: `${explorerFocusFixture.toUpperCase()}${path.sep}` },
  { hwnd: 303, directory: path.dirname(explorerFocusFixture) },
]);
assert.equal(exactExplorerFixture.matched, true, "foreground helper must use an exact normalized directory match");
assert.equal(exactExplorerFixture.matchedHwnd, "202", "foreground helper must not select a prefix/similar-path window");
assert.equal(exactExplorerFixture.foreground, false, "fixture mode must never claim a real foreground change");
assert.equal(exactExplorerFixture.foregroundAttempted, false);
assert.equal(exactExplorerFixture.windowMutationAttempted, false, "fixture mode must not call Show/Restore/Foreground APIs");
const missingExplorerFixture = runExplorerFixture([
  { hwnd: 404, directory: `${explorerFocusFixture}-similar-title` },
]);
assert.equal(missingExplorerFixture.matched, false);
assert.equal(missingExplorerFixture.errorCode, "no-exact-window");
assert.equal(missingExplorerFixture.windowMutationAttempted, false);
const explorerInteropProbeProcess = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", explorerHelperPath,
  "-LiteralDirectory", explorerFocusFixture,
  "-ValidateInteropOnly",
], { encoding: "utf8", windowsHide: true, shell: false, timeout: 5000 });
assert.equal(explorerInteropProbeProcess.status, 0, `Explorer interop probe failed: ${explorerInteropProbeProcess.stderr}`);
const explorerInteropProbeLines = String(explorerInteropProbeProcess.stdout || "").trim().split(/\r?\n/).filter(Boolean);
const explorerInteropProbe = JSON.parse(explorerInteropProbeLines.at(-1));
assert.equal(explorerInteropProbe.foreground, false);
assert.equal(explorerInteropProbe.matched, false);
assert.equal(explorerInteropProbe.errorCode, null);
assert.equal(explorerInteropProbe.interopValidated, true, "PowerShell 5.1 must compile every Shell foreground interop declaration");
assert.equal(explorerInteropProbe.windowMutationAttempted, false, "interop validation must not enumerate or change any desktop window");
const resolverScanner = createCodexOutputScanner({
  codexDataRoot: scannerFixture.codexRoot,
  stateFile: path.join(httpDataRoot, "resolver-scanner.json"),
  applyArtifacts: async () => ({ added: 0, updated: 0, unchanged: 0, missing: 0 }),
});
const resolvedChildTaskGroup = await resolverScanner.resolveTaskGroup({
  threadId: CHILD_THREAD_ID,
  title: "子代理任务",
  project: "self-test",
  projectKind: "manual",
});
assert.deepEqual(resolvedChildTaskGroup, {
  key: `thread:${ROOT_THREAD_ID}`,
  rootThreadId: ROOT_THREAD_ID,
  title: "自动抓取测试",
  project: "self-test",
  projectKind: "manual",
  hostId: null,
  workspacePath: scannerFixture.workspace,
  unknown: false,
}, "manual subagent registration must resolve through the scanner catalog to its root user task");
const resolvedSqliteNameTaskGroup = await resolverScanner.resolveTaskGroup({
  threadId: SQLITE_NAME_THREAD_ID,
  title: "调用方兜底标题",
  project: "self-test",
  projectKind: "manual",
});
assert.equal(resolvedSqliteNameTaskGroup.title, "SQLite name 新值", "SQLite name must win over title when session_index has no non-empty task name");
const titleOnlyCodexRoot = fs.mkdtempSync(path.join(scannerFixtureParent, ".scanner-title-only-fixture-"));
try {
  const { DatabaseSync } = await import("node:sqlite");
  const titleOnlyDatabase = new DatabaseSync(path.join(titleOnlyCodexRoot, "state_1.sqlite"));
  titleOnlyDatabase.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, thread_source TEXT, agent_role TEXT, agent_path TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT);");
  titleOnlyDatabase.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)")
    .run(SQLITE_NAME_THREAD_ID, "仅 title 架构回退", scannerFixture.workspace, "user", null, null);
  titleOnlyDatabase.close();
  const titleOnlyScanner = createCodexOutputScanner({
    codexDataRoot: titleOnlyCodexRoot,
    stateFile: path.join(httpDataRoot, "title-only-scanner.json"),
    applyArtifacts: async () => ({ added: 0, updated: 0, unchanged: 0, missing: 0 }),
  });
  const resolvedTitleOnlyTaskGroup = await titleOnlyScanner.resolveTaskGroup({
    threadId: SQLITE_NAME_THREAD_ID,
    title: "调用方兜底标题",
    project: "self-test",
  });
  assert.equal(resolvedTitleOnlyTaskGroup.title, "仅 title 架构回退", "catalog probing must not query a missing SQLite name column");
} finally {
  fs.rmSync(titleOnlyCodexRoot, { recursive: true, force: true });
}
const explorerRecordFile = path.join(httpDataRoot, "explorer.ndjson");
const httpChild = spawn(process.execPath, [serverPath, "--http"], {
  cwd: path.dirname(serverPath),
  env: {
    ...process.env,
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
    OUTPUT_ITEMS_DATA_DIR: httpDataRoot,
    OUTPUT_ITEMS_CODEX_HOME: scannerFixture.codexRoot,
    OUTPUT_ITEMS_DELETE_MODE: "fixture-recycle",
    OUTPUT_ITEMS_TEST_DELETE_ROOT: scannerFixture.workspace,
    OUTPUT_ITEMS_EXPLORER_MODE: "record",
    OUTPUT_ITEMS_EXPLORER_RECORD_FILE: explorerRecordFile,
    OUTPUT_ITEMS_GITHUB_ADAPTER: "fake",
    OUTPUT_ITEMS_GITHUB_FAKE_LOGIN: "fixture-user",
    CODEX_THREAD_ID: "",
    OUTPUT_ITEMS_SOURCE_THREAD_ID: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let httpStdout = "";
let httpStderr = "";
httpChild.stdout.setEncoding("utf8");
httpChild.stderr.setEncoding("utf8");
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });

try {
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server startup timed out; stdout=${httpStdout}; stderr=${httpStderr}`)), 8000);
    httpChild.once("error", (error) => { clearTimeout(timer); reject(error); });
    httpChild.once("close", (code) => { clearTimeout(timer); reject(new Error(`HTTP server exited early with ${code}; stderr=${httpStderr}`)); });
    httpChild.stdout.on("data", (chunk) => {
      httpStdout += chunk;
      const match = /^OUTPUT_ITEMS_URL=(http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(httpStdout);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });

  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(Number(url.port) > 0);

  const statePath = path.join(httpDataRoot, "run", "server.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.url, baseUrl);
  assert.equal(state.pid, httpChild.pid);
  const companionUrl = new URL(state.companionUrl);
  assert.equal(companionUrl.origin, url.origin);
  assert.equal(companionUrl.searchParams.get("embedded"), "1");
  assert.equal(companionUrl.searchParams.get("host"), "codex-companion");
  assert.match(companionUrl.searchParams.get("token") || "", /^[A-Za-z0-9_-]{24,}$/);

  const healthResponse = await fetch(new URL("health", baseUrl));
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.instanceId, state.instanceId);
  const initialScan = await waitForScan(baseUrl);
  assert.equal(initialScan.state, "complete");
  assert.equal(initialScan.scannedTasks, 3);
  assert.ok(initialScan.imported >= 3);
  assert.equal(typeof initialScan.finishedAt, "string");
  assert.equal(typeof initialScan.skipped, "number");

  const indexResponse = await fetch(baseUrl);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type"), /^text\/html/);
  assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
  assert.match(await indexResponse.text(), /<title>产出项<\/title>/);

  const companionResponse = await fetch(companionUrl);
  assert.equal(companionResponse.status, 200);
  assert.equal(companionResponse.headers.get("x-frame-options"), null);
  assert.match(companionResponse.headers.get("content-security-policy") || "", /object-src 'none'/);
  assert.match(await companionResponse.text(), /<title>产出项<\/title>/);

  const invalidCompanionUrl = new URL(companionUrl);
  invalidCompanionUrl.searchParams.set("token", "invalid");
  assert.equal((await fetch(invalidCompanionUrl)).status, 403);

  const listResponse = await fetch(new URL("api/items", baseUrl));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.ok(Array.isArray(list.items) && list.items.length >= 1);
  assert.ok(["running", "complete"].includes(list.scan.state));
  const demoItem = list.items.find((item) => path.resolve(item.path) === path.resolve(scannerFixture.project));
  const imageItem = list.items.find((item) => path.resolve(item.path) === path.resolve(scannerFixture.generatedFolder));
  const deliveryItem = list.items.find((item) => path.resolve(item.path) === path.resolve(scannerFixture.delivery));
  const extensionItem = list.items.find((item) => item.id === "output-items-local-extension");
  assert.ok(demoItem, "project files must be grouped into one canonical folder item");
  assert.ok(imageItem, "generated images must be grouped by task folder");
  assert.ok(deliveryItem, "final-answer file link must be imported");
  assert.equal(demoItem.deletable, true, "trusted workspace output must expose deletion capability");
  assert.equal(imageItem.deletable, true, "trusted Codex-managed output must expose deletion capability");
  assert.equal(extensionItem?.deletable, false, "the extension must never expose deletion capability for itself");
  assert.equal(demoItem.source.threadId, ROOT_THREAD_ID, "child output must roll up to the user task");
  assert.equal(demoItem.source.task, "自动抓取测试", "short session_index title must win over SQLite fallback title");
  assert.equal(demoItem.source.scanner.producerThreadId, CHILD_THREAD_ID);
  assert.deepEqual(demoItem.taskGroup, {
    key: `thread:${ROOT_THREAD_ID}`,
    rootThreadId: ROOT_THREAD_ID,
    title: "自动抓取测试",
    project: path.basename(scannerFixture.workspace),
    projectKind: "workspace",
    hostId: null,
    workspacePath: scannerFixture.workspace,
    unknown: false,
  }, "scanner items must expose their root task as a stable group");
  assert.equal(imageItem.taskGroup.key, demoItem.taskGroup.key, "all artifacts from one task must share a group key");
  assert.equal(deliveryItem.taskGroup.key, demoItem.taskGroup.key, "standalone deliveries must stay in their task group");
  assert.equal(imageItem.taskGroup.projectKind, "codex-managed");
  assert.equal(deliveryItem.taskGroup.projectKind, "workspace");
  const demoTaskGroupKey = demoItem.taskGroup.key;
  assert.equal(demoItem.mark, "待确认");
  assert.equal(demoItem.status, "部分文件已删除");
  assert.ok(demoItem.files.some((file) => file.name === "obsolete.js" && file.status === "已删除"));
  assert.equal(demoItem.fileMetadataVersion, 2);
  assert.equal(demoItem.sizeBytes, scannedTreeBytes(scannerFixture.project), "item size must equal the complete recursive scan total");
  assert.equal(demoItem.sizeAggregationComplete, true, "a readable complete tree must expose an exact size contract");
  for (const file of demoItem.files) {
    assert.ok(Object.hasOwn(file, "sizeBytes"), `${file.relativePath} must include sizeBytes`);
    assert.ok(Object.hasOwn(file, "directChildCount"), `${file.relativePath} must include directChildCount`);
    assert.ok(Object.hasOwn(file, "descendantCount"), `${file.relativePath} must include descendantCount`);
    assert.equal(typeof file.aggregationComplete, "boolean", `${file.relativePath} must include aggregationComplete`);
  }
  const localizedRelativePath = path.join("src", "中文, 文件.js");
  const localizedFileRecord = demoItem.files.find((file) => file.relativePath === localizedRelativePath);
  assert.equal(localizedFileRecord.sizeBytes, fs.statSync(path.join(scannerFixture.project, localizedRelativePath)).size, "Unicode nested file size must be exact bytes");
  assert.equal(localizedFileRecord.directChildCount, 0);
  assert.equal(localizedFileRecord.descendantCount, 0);
  const sourceFolderRecord = demoItem.files.find((file) => file.relativePath === "src");
  const initialSourceFilePaths = ["app.js", "child.js", "中文, 文件.js"].map((name) => path.join(scannerFixture.projectSource, name));
  assert.equal(sourceFolderRecord.sizeBytes, initialSourceFilePaths.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0), "folder size must aggregate descendant file bytes");
  assert.equal(sourceFolderRecord.directChildCount, 3);
  assert.equal(sourceFolderRecord.descendantCount, 3);
  assert.equal(sourceFolderRecord.aggregationComplete, true);
  assert.equal(demoItem.files.find((file) => file.name === "obsolete.js").sizeBytes, null, "missing legacy evidence has unknown size");
  assert.ok(!list.items.some((item) => String(item.path).includes("guardian-only")), "guardian output must be ignored");
  assert.ok(!list.items.some((item) => String(item.path).includes("ignored.png")), "temporary attachments must be ignored");
  const initialDemoVersionCount = demoItem.versions.length;
  const itemId = demoItem.id;

  const frameToken = companionUrl.searchParams.get("token");
  const opaqueListUrl = new URL("api/items", baseUrl);
  const opaqueHeaders = { origin: "null" };
  const missingTokenResponse = await fetch(opaqueListUrl, { headers: opaqueHeaders });
  assert.equal(missingTokenResponse.status, 403, "opaque API request without token must be rejected");
  assert.equal(missingTokenResponse.headers.get("access-control-allow-origin"), null);
  opaqueListUrl.searchParams.set("frameToken", "invalid");
  const wrongTokenResponse = await fetch(opaqueListUrl, { headers: opaqueHeaders });
  assert.equal(wrongTokenResponse.status, 403, "opaque API request with wrong token must be rejected");
  assert.equal(wrongTokenResponse.headers.get("access-control-allow-origin"), null);
  opaqueListUrl.searchParams.set("frameToken", frameToken);
  const opaqueListResponse = await fetch(opaqueListUrl, { headers: opaqueHeaders });
  assert.equal(opaqueListResponse.status, 200);
  assert.equal(opaqueListResponse.headers.get("access-control-allow-origin"), "null");
  assert.equal(opaqueListResponse.headers.get("vary"), "Origin");
  assert.notEqual(opaqueListResponse.headers.get("access-control-allow-origin"), "*");
  assert.ok(Array.isArray((await opaqueListResponse.json()).items));

  const invalidPreflightUrl = new URL("api/items", baseUrl);
  const preflightHeaders = {
    origin: "null",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, accept",
  };
  const missingPreflightTokenResponse = await fetch(invalidPreflightUrl, { method: "OPTIONS", headers: preflightHeaders });
  assert.equal(missingPreflightTokenResponse.status, 403);
  assert.equal(missingPreflightTokenResponse.headers.get("access-control-allow-origin"), null);
  invalidPreflightUrl.searchParams.set("frameToken", "invalid");
  const wrongPreflightTokenResponse = await fetch(invalidPreflightUrl, { method: "OPTIONS", headers: preflightHeaders });
  assert.equal(wrongPreflightTokenResponse.status, 403);
  assert.equal(wrongPreflightTokenResponse.headers.get("access-control-allow-origin"), null);
  const opaquePreflightUrl = new URL("api/items", baseUrl);
  opaquePreflightUrl.searchParams.set("frameToken", frameToken);
  const opaquePreflightResponse = await fetch(opaquePreflightUrl, { method: "OPTIONS", headers: preflightHeaders });
  assert.equal(opaquePreflightResponse.status, 204);
  assert.equal(opaquePreflightResponse.headers.get("access-control-allow-origin"), "null");
  assert.equal(opaquePreflightResponse.headers.get("vary"), "Origin");
  assert.equal(opaquePreflightResponse.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(opaquePreflightResponse.headers.get("access-control-allow-headers"), "Content-Type, Accept");
  assert.notEqual(opaquePreflightResponse.headers.get("access-control-allow-origin"), "*");

  const sameOriginHeaders = { "content-type": "application/json", origin: url.origin };

  const previewUrl = new URL(`api/items/${encodeURIComponent(itemId)}/preview`, baseUrl);
  const requestPreview = (relativePath, { headers = sameOriginHeaders, requestUrl = previewUrl } = {}) => fetch(requestUrl, {
    method: "POST", headers, body: JSON.stringify({ relativePath }),
  });
  const textPreviewResponse = await requestPreview("preview.md");
  assert.equal(textPreviewResponse.status, 200);
  const textPreview = (await textPreviewResponse.json()).preview;
  assert.deepEqual({ kind: textPreview.kind, mimeType: textPreview.mimeType, renderMode: textPreview.renderMode }, {
    kind: "text", mimeType: "text/plain; charset=utf-8", renderMode: "plain-text",
  });
  assert.equal(textPreview.encoding, "utf-8");
  assert.equal(textPreview.truncated, false);
  assert.match(textPreview.text, /安全预览/);
  assert.equal(textPreview.bytesBase64, undefined);

  for (const inertFile of ["preview.html", "preview.svg", path.join("src", "app.js")]) {
    const response = await requestPreview(inertFile);
    assert.equal(response.status, 200, `${inertFile} must be readable only as inert text`);
    const preview = (await response.json()).preview;
    assert.equal(preview.kind, "text");
    assert.equal(preview.mimeType, "text/plain; charset=utf-8");
    assert.equal(preview.renderMode, "plain-text");
    assert.equal(preview.inert, true, `${inertFile} must carry the inert rendering contract`);
    assert.equal(preview.bytesBase64, undefined);
  }

  const utf16Preview = (await (await requestPreview("utf16.txt")).json()).preview;
  assert.equal(utf16Preview.encoding, "utf-16le");
  assert.match(utf16Preview.text, /UTF-16 安全预览/);
  const longPreview = (await (await requestPreview("long.txt")).json()).preview;
  assert.equal(longPreview.truncated, true);
  assert.equal(longPreview.lineCount, 5_000);
  const largeTextPreview = (await (await requestPreview("large-text.log")).json()).preview;
  assert.equal(largeTextPreview.truncated, true);
  assert.equal(Buffer.byteLength(largeTextPreview.text, "utf8"), 512 * 1024);

  const imagePreviewResponse = await requestPreview("pixel.png");
  assert.equal(imagePreviewResponse.status, 200);
  const imagePreview = (await imagePreviewResponse.json()).preview;
  assert.equal(imagePreview.kind, "image");
  assert.equal(imagePreview.mimeType, "image/png");
  assert.deepEqual({ width: imagePreview.width, height: imagePreview.height }, { width: 1, height: 1 });
  assert.match(imagePreview.bytesBase64, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(imagePreview.text, undefined);

  assert.equal((await requestPreview("binary.txt")).status, 415, "binary data disguised as text must be rejected");
  assert.equal((await requestPreview("fake.png")).status, 415, "image extensions must pass magic validation");
  assert.equal((await requestPreview("oversized-dimensions.png")).status, 413, "image dimensions must be bounded");
  assert.equal((await requestPreview("oversized-bytes.png")).status, 413, "image bytes must be bounded");
  const unsupportedPreviewUrl = new URL(`api/items/${encodeURIComponent(deliveryItem.id)}/preview`, baseUrl);
  assert.equal((await requestPreview(".", { requestUrl: unsupportedPreviewUrl })).status, 415, "archives and other binaries must not be embedded");

  const unregisteredPath = path.join(scannerFixture.project, "unregistered.txt");
  fs.writeFileSync(unregisteredPath, "not yet registered\n");
  assert.equal((await requestPreview("unregistered.txt")).status, 400, "existing but unregistered files must not be readable");
  assert.equal((await requestPreview(path.join("..", "unregistered.txt"))).status, 400, "path traversal must be rejected");
  assert.equal((await requestPreview(unregisteredPath)).status, 400, "absolute paths must be rejected");
  const previewCrossOrigin = await requestPreview("preview.md", { headers: { "content-type": "application/json", origin: "https://example.invalid" } });
  assert.equal(previewCrossOrigin.status, 403);
  assert.equal((await requestPreview("preview.md", { headers: { "content-type": "application/json" } })).status, 403);
  const opaquePreviewUrl = new URL(previewUrl);
  opaquePreviewUrl.searchParams.set("frameToken", frameToken);
  const opaquePreviewResponse = await requestPreview("preview.md", {
    requestUrl: opaquePreviewUrl,
    headers: { "content-type": "application/json", origin: "null", "sec-fetch-site": "cross-site" },
  });
  assert.equal(opaquePreviewResponse.status, 200);
  assert.equal(opaquePreviewResponse.headers.get("access-control-allow-origin"), "null");

  const githubContextResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload/context`, baseUrl));
  assert.equal(githubContextResponse.status, 200);
  const githubContext = await githubContextResponse.json();
  assert.equal(githubContext.ghAvailable, true);
  assert.equal(githubContext.authenticated, true);
  assert.equal(githubContext.account.login, "fixture-user");
  assert.equal(githubContext.capabilities.storesToken, false);
  assert.equal(githubContext.capabilities.collaboratorsGranted, false);

  const githubConfig = {
    destination: { mode: "new", owner: "fixture-user", repo: "http-fixture", visibility: "public" },
    upload: { scope: "whole" }, publishMode: "branch-pr", branch: "codex-output/http-fixture",
    license: "mit", generateReadme: true, protectMain: true, description: "HTTP fake adapter fixture",
  };
  const githubPreflightResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload/preflight`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify(githubConfig),
  });
  assert.equal(githubPreflightResponse.status, 200);
  const githubPreflight = await githubPreflightResponse.json();
  assert.equal(githubPreflight.ok, true, JSON.stringify(githubPreflight.blockers));
  assert.ok(githubPreflight.warnings.some((entry) => entry.code === "PUBLIC_VISIBILITY"));
  assert.equal(typeof githubPreflight.summary.includedBytes, "number");
  assert.ok(Array.isArray(githubPreflight.files));
  assert.ok(Array.isArray(githubPreflight.excluded));

  const githubUnconfirmedResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ preflightId: githubPreflight.preflightId, confirm: false, config: githubConfig }),
  });
  assert.equal(githubUnconfirmedResponse.status, 400);

  const githubStartResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ preflightId: githubPreflight.preflightId, confirm: true, config: githubConfig }),
  });
  assert.equal(githubStartResponse.status, 202);
  const githubStart = await githubStartResponse.json();
  assert.match(githubStart.jobId, /^[0-9a-f-]{36}$/i);
  let githubJob;
  const githubDeadline = Date.now() + 5000;
  while (Date.now() < githubDeadline) {
    const response = await fetch(new URL(`api/github-upload/jobs/${githubStart.jobId}`, baseUrl));
    assert.equal(response.status, 200);
    githubJob = await response.json();
    if (["success", "failed", "cancelled"].includes(githubJob.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(githubJob.state, "success", JSON.stringify(githubJob));
  assert.equal(githubJob.result.repository, "fixture-user/http-fixture");
  assert.match(githubJob.result.pullRequestUrl, /\/pull\/1$/);
  const afterGithubUpload = await (await fetch(new URL("api/items", baseUrl))).json();
  const publishedDemo = afterGithubUpload.items.find((entry) => entry.id === itemId);
  assert.equal(publishedDemo.githubPublication.repository, "fixture-user/http-fixture");
  assert.deepEqual(publishedDemo.githubPublication.branchProtection, { requested: true, applied: true, warning: null });
  assert.deepEqual(publishedDemo.githubPublication.warnings, []);
  assert.match(publishedDemo.activity[0].title, /GitHub/);

  const githubInjectionResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload/preflight`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ...githubConfig, destination: { ...githubConfig.destination, repo: "bad;repo" } }),
  });
  assert.equal(githubInjectionResponse.status, 400);
  const githubCrossOriginResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/github-upload/preflight`, baseUrl), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" }, body: JSON.stringify(githubConfig),
  });
  assert.equal(githubCrossOriginResponse.status, 403);

  const extensionDeleteResponse = await fetch(new URL("api/items/output-items-local-extension/delete-project", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(extensionDeleteResponse.status, 400, "extension files must never be self-deletable");
  assert.equal(fs.existsSync(serverPath), true, "extension server must remain present");

  const openDirectoryResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/open-location`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(openDirectoryResponse.status, 200);
  const openDirectoryResult = await openDirectoryResponse.json();
  assert.equal(openDirectoryResult.opened.action, "open");
  assert.equal(openDirectoryResult.ok, false, "record mode must not misreport an unverified foreground transition");
  assert.equal(openDirectoryResult.opened.launched, true);
  assert.equal(openDirectoryResult.opened.foreground, false);
  assert.equal(openDirectoryResult.opened.foregroundAttempted, false);
  assert.match(openDirectoryResult.error, /测试记录模式/);
  const openFileResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/open-location`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: "package.json" }),
  });
  assert.equal(openFileResponse.status, 200);
  const openFileResult = await openFileResponse.json();
  assert.equal(openFileResult.opened.action, "select");
  assert.equal(openFileResult.ok, false);
  const nestedRelativePath = path.join("src", "中文, 文件.js");
  const openNestedFileResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/open-location`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: nestedRelativePath }),
  });
  assert.equal(openNestedFileResponse.status, 200);
  const openNestedFileResult = await openNestedFileResponse.json();
  assert.equal(openNestedFileResult.opened.action, "select");
  assert.equal(openNestedFileResult.ok, false);
  const explorerRecords = fs.readFileSync(explorerRecordFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(explorerRecords.length, 3);
  assert.equal(path.resolve(explorerRecords[0].target), path.resolve(scannerFixture.project));
  assert.equal(path.resolve(explorerRecords[1].target), path.resolve(scannerFixture.project, "package.json"));
  assert.equal(path.resolve(explorerRecords[2].target), path.resolve(scannerFixture.project, nestedRelativePath));
  assert.equal(path.resolve(explorerRecords[0].targetDirectory), path.resolve(scannerFixture.project));
  assert.equal(path.resolve(explorerRecords[1].targetDirectory), path.resolve(scannerFixture.project));
  assert.equal(path.resolve(explorerRecords[2].targetDirectory), path.resolve(scannerFixture.projectSource));
  assert.ok(explorerRecords.every((record) => record.windowMutationAttempted === false), "record-mode location tests must not change desktop windows");
  const arbitraryOpenResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/open-location`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: "..\\outside.txt" }),
  });
  assert.equal(arbitraryOpenResponse.status, 400, "unregistered paths must never reach Explorer");
  assert.equal(fs.readFileSync(explorerRecordFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length, 3, "rejected paths must not invoke the Explorer adapter");

  const priorityResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/priority`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ priority: "critical" }),
  });
  assert.equal(priorityResponse.status, 200);
  assert.equal((await priorityResponse.json()).item.priority, "critical");
  const batchPriorityResponse = await fetch(new URL("api/items/batch/priority", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ids: [deliveryItem.id, imageItem.id], priority: "low" }),
  });
  assert.equal(batchPriorityResponse.status, 200);
  assert.equal((await batchPriorityResponse.json()).succeeded, 2);
  const priorityList = await (await fetch(new URL("api/items", baseUrl))).json();
  assert.ok(priorityList.items.findIndex((item) => item.id === itemId) < priorityList.items.findIndex((item) => item.id === deliveryItem.id));
  assert.equal(priorityList.items.find((item) => item.id === itemId).taskGroup.key, demoTaskGroupKey, "priority sorting must not change task membership");

  const batchDetectResponse = await fetch(new URL("api/items/batch/detect", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ids: [itemId, "missing-item"], mode: "quick" }),
  });
  assert.equal(batchDetectResponse.status, 200);
  const batchDetectResult = await batchDetectResponse.json();
  assert.equal(batchDetectResult.succeeded, 1);
  assert.equal(batchDetectResult.failed, 1);
  assert.equal(batchDetectResult.results.find((result) => result.id === "missing-item").ok, false);
  const oversizedBatchResponse = await fetch(new URL("api/items/batch/detect", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ids: Array.from({ length: 51 }, (_, index) => `item-${index}`) }),
  });
  assert.equal(oversizedBatchResponse.status, 400);

  const detectResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/detect`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ mode: "full" }),
  });
  assert.equal(detectResponse.status, 200);
  assert.equal((await detectResponse.json()).result.source, "real");

  const markResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ mark: "需要修复", note: "HTTP 自测" }),
  });
  assert.equal(markResponse.status, 200);
  assert.equal((await markResponse.json()).item.mark, "需要修复");

  const opaqueMarkUrl = new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl);
  opaqueMarkUrl.searchParams.set("frameToken", frameToken);
  const opaqueMarkResponse = await fetch(opaqueMarkUrl, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "null", "sec-fetch-site": "cross-site" },
    body: JSON.stringify({ mark: "使用中", note: "opaque iframe HTTP 自测" }),
  });
  assert.equal(opaqueMarkResponse.status, 200);
  assert.equal(opaqueMarkResponse.headers.get("access-control-allow-origin"), "null");
  assert.equal(opaqueMarkResponse.headers.get("vary"), "Origin");
  assert.equal((await opaqueMarkResponse.json()).item.mark, "使用中");

  const renamedTaskTitle = "自动抓取测试（已重命名）";
  const renameTargetIds = [itemId, imageItem.id, deliveryItem.id];
  const beforeRenameItems = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  const beforeRenameSnapshots = new Map(renameTargetIds.map((id) => {
    const item = beforeRenameItems.find((entry) => entry.id === id);
    assert.ok(item, `rename fixture item ${id} must exist`);
    return [id, renameStableSnapshot(item)];
  }));
  appendJsonl(scannerFixture.sessionIndexFile, [{
    id: ROOT_THREAD_ID,
    thread_name: renamedTaskTitle,
    updated_at: "2026-02-01T00:00:00.000Z",
  }]);
  const renameScanResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(renameScanResponse.status, 202);
  const renameScan = await waitForScan(baseUrl);
  assert.equal(renameScan.observations, 0, "task-title refresh must run even when incremental rollouts contain no new observations");
  const afterRenameItems = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  let sharedTitleSyncedAt = null;
  for (const id of renameTargetIds) {
    const item = afterRenameItems.find((entry) => entry.id === id);
    assert.equal(item.taskGroup.key, demoTaskGroupKey, "renamed subagent outputs must remain grouped under the root task");
    assert.equal(item.taskGroup.rootThreadId, ROOT_THREAD_ID);
    assert.equal(item.taskGroup.title, renamedTaskTitle, "every output from the renamed task must receive the latest title");
    assert.ok(Number.isFinite(Date.parse(item.taskGroup.titleSyncedAt)), "a changed task title must record titleSyncedAt");
    sharedTitleSyncedAt ||= item.taskGroup.titleSyncedAt;
    assert.equal(item.taskGroup.titleSyncedAt, sharedTitleSyncedAt, "one metadata reconcile must use one synchronization timestamp");
    assert.deepEqual(renameStableSnapshot(item), beforeRenameSnapshots.get(id), "pure task rename must not alter item ordering metadata, source evidence, activity, or version history");
  }
  assert.equal(afterRenameItems.find((entry) => entry.id === itemId).source.scanner.producerThreadId, CHILD_THREAD_ID, "producer evidence must remain attached to the child agent");
  assert.equal(afterRenameItems.find((entry) => entry.id === itemId).source.task, "自动抓取测试", "pure rename must not rewrite historical source metadata");

  const noChangeContents = fs.readFileSync(itemsDataPath, "utf8");
  const noChangeMtime = fs.statSync(itemsDataPath, { bigint: true }).mtimeNs;
  const noChangeScanResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(noChangeScanResponse.status, 202);
  const noChangeScan = await waitForScan(baseUrl);
  assert.equal(noChangeScan.observations, 0);
  assert.equal(fs.readFileSync(itemsDataPath, "utf8"), noChangeContents, "an unchanged task catalog must not rewrite items.json contents");
  assert.equal(fs.statSync(itemsDataPath, { bigint: true }).mtimeNs, noChangeMtime, "an unchanged task catalog must not touch items.json");

  const forceScanResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ force: true }),
  });
  assert.equal(forceScanResponse.status, 202);
  assert.equal((await forceScanResponse.json()).scan.state, "running");
  await waitForScan(baseUrl);
  let rescannedList = await (await fetch(new URL("api/items", baseUrl))).json();
  let rescannedDemo = rescannedList.items.find((item) => item.id === itemId);
  assert.equal(rescannedDemo.mark, "使用中", "automatic scan must preserve the manual mark");
  assert.equal(rescannedDemo.versions.length, initialDemoVersionCount, "forced rescans must be idempotent");
  assert.equal(rescannedDemo.sizeBytes, scannedTreeBytes(scannerFixture.project), "scanner merge must persist a changed total even without a new history version");
  assert.equal(rescannedDemo.sizeAggregationComplete, true);

  const incrementalFile = path.join(scannerFixture.projectSource, "incremental.js");
  fs.writeFileSync(incrementalFile, "export const incremental = true;\n");
  appendJsonl(scannerFixture.rootRollout, [
    { timestamp: "2026-01-01T00:03:00.000Z", type: "turn_context", payload: { cwd: scannerFixture.workspace, turn_id: "turn-incremental" } },
    { timestamp: "2026-01-01T00:03:01.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call-incremental", turn_id: "turn-incremental", input: "await tools.apply_patch('*** Begin Patch\\n*** End Patch')" } },
    { timestamp: "2026-01-01T00:03:02.000Z", type: "event_msg", payload: { type: "patch_apply_end", call_id: "call-incremental", turn_id: "turn-incremental", success: true, status: "completed", changes: { [incrementalFile]: { type: "add" } } } },
  ]);
  const incrementalScanResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(incrementalScanResponse.status, 202);
  await waitForScan(baseUrl);
  rescannedList = await (await fetch(new URL("api/items", baseUrl))).json();
  rescannedDemo = rescannedList.items.find((item) => item.id === itemId);
  assert.equal(rescannedDemo.versions.length, initialDemoVersionCount + 1, "new task turn must append one history version");
  assert.equal(rescannedDemo.mark, "使用中");
  assert.equal(rescannedDemo.priority, "critical", "automatic scan must preserve priority");
  assert.equal(rescannedDemo.taskGroup.key, demoTaskGroupKey, "incremental versions must remain in the root task group");
  assert.equal(rescannedDemo.sizeBytes, scannedTreeBytes(scannerFixture.project));

  const unconfirmedFileDelete = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/delete-file`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: "package.json", confirm: false }),
  });
  assert.equal(unconfirmedFileDelete.status, 400);
  const packageFile = path.join(scannerFixture.project, "package.json");
  assert.equal(fs.existsSync(packageFile), true, "delete must require explicit confirmation");
  const nestedFile = path.join(scannerFixture.project, "src", "app.js");
  const nestedFileSize = fs.statSync(nestedFile).size;
  const nestedDeleteResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/delete-file`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: path.join("src", "app.js"), confirm: true }),
  });
  const nestedDeleteResult = await nestedDeleteResponse.json();
  assert.equal(nestedDeleteResponse.status, 200, JSON.stringify(nestedDeleteResult));
  assert.equal(fs.existsSync(nestedFile), false, "nested project file must be individually deletable");
  const deletedNestedRecord = nestedDeleteResult.item.files.find((file) => file.relativePath === path.join("src", "app.js"));
  assert.equal(deletedNestedRecord.status, "已删除");
  assert.equal(deletedNestedRecord.sizeBytes, nestedFileSize, "deleted file must retain its last known byte size in history");
  assert.equal(nestedDeleteResult.item.sizeBytes, scannedTreeBytes(scannerFixture.project), "file deletion must persist the refreshed item total");
  assert.equal(nestedDeleteResult.item.sizeAggregationComplete, true);
  const refreshedSourceFolder = nestedDeleteResult.item.files.find((file) => file.relativePath === "src");
  const remainingSourcePaths = ["child.js", "中文, 文件.js", "incremental.js"].map((name) => path.join(scannerFixture.projectSource, name));
  assert.equal(refreshedSourceFolder.sizeBytes, remainingSourcePaths.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0), "delete must refresh folder aggregate size");
  assert.equal(refreshedSourceFolder.directChildCount, 3);
  assert.equal(refreshedSourceFolder.descendantCount, 3);
  const fileDeleteResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/delete-file`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: "package.json", confirm: true }),
  });
  const fileDeleteResult = await fileDeleteResponse.json();
  assert.equal(fileDeleteResponse.status, 200, JSON.stringify(fileDeleteResult));
  assert.equal(fs.existsSync(packageFile), false, "confirmed file delete must change the fixture filesystem");
  assert.equal(fileDeleteResult.item.status, "部分文件已删除");
  assert.equal(fileDeleteResult.item.files.find((file) => file.name === "package.json").status, "已删除");
  assert.match(fileDeleteResult.item.activity[0].title, /删除文件/);

  const markDeliveryResponse = await fetch(new URL(`api/items/${encodeURIComponent(deliveryItem.id)}/mark`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ mark: "已定稿" }),
  });
  assert.equal(markDeliveryResponse.status, 200);
  const projectDeleteResponse = await fetch(new URL(`api/items/${encodeURIComponent(deliveryItem.id)}/delete-project`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(projectDeleteResponse.status, 200);
  const projectDeleteResult = await projectDeleteResponse.json();
  assert.equal(projectDeleteResult.item.status, "已删除");
  assert.equal(projectDeleteResult.item.sizeBytes, null, "a missing project must expose unknown current size");
  assert.equal(projectDeleteResult.item.sizeAggregationComplete, false);
  assert.equal(fs.existsSync(scannerFixture.delivery), false, "delete project must change the fixture filesystem");
  const missingScanResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(missingScanResponse.status, 202);
  await waitForScan(baseUrl);
  const afterMissing = await (await fetch(new URL("api/items", baseUrl))).json();
  const missingDelivery = afterMissing.items.find((item) => item.id === deliveryItem.id);
  assert.equal(missingDelivery.status, "已删除");
  assert.equal(missingDelivery.mark, "已定稿", "missing-path reconciliation must preserve manual mark");

  await waitForScan(baseUrl);
  const archivedSource = {
    project: "self-test",
    task: "归档全删旧标题",
    threadId: DELETED_ONLY_THREAD_ID,
    cwd: scannerFixture.workspace,
    pathScope: "workspace",
    created: "2026-01-01 10:00",
    scanner: { producerThreadId: DELETED_ONLY_THREAD_ID, producerThreadIds: [DELETED_ONLY_THREAD_ID], agentPaths: [] },
  };
  const hiddenDeletedItem = {
    id: "rename-hidden-deleted-only",
    title: "隐藏全删会话产出",
    type: "普通文件",
    category: "文档",
    version: "v1",
    meta: "路径缺失",
    time: "2026-01-01 10:00",
    updatedAt: "2026-01-01 10:00",
    description: "任务标题同步 fixture",
    path: path.join(scannerFixture.workspace, "missing-archived-output.txt"),
    status: "已删除",
    statusTone: "warning",
    statusDetail: "fixture 路径已删除",
    mark: "已归档",
    priority: "critical",
    source: archivedSource,
    taskGroup: {
      key: `thread:${DELETED_ONLY_THREAD_ID}`,
      rootThreadId: DELETED_ONLY_THREAD_ID,
      title: "归档全删旧标题",
      project: "self-test",
      projectKind: "workspace",
      hostId: null,
      workspacePath: scannerFixture.workspace,
      unknown: false,
    },
    fileMetadataVersion: 2,
    sizeBytes: null,
    sizeAggregationComplete: false,
    files: [],
    versions: [{
      version: "v1",
      current: true,
      time: "2026-01-01 10:00",
      status: "仅保留记录",
      source: archivedSource,
      scanner: { key: "rename-hidden-deleted-only", automatic: true, evidenceIds: [], evidencePaths: [], kinds: ["fixture"] },
    }],
    activity: [{ time: "2026-01-01 10:00", title: "历史记录", detail: "fixture", tone: "neutral", source: archivedSource }],
    discovery: { mode: "codex-session-scan", automatic: true, firstSeenAt: "2026-01-01T10:00:00.000Z", lastSeenAt: "2026-01-01T10:00:00.000Z" },
  };
  const missingCatalogSource = { ...archivedSource, task: "已归档且索引缺失", threadId: MISSING_CATALOG_THREAD_ID };
  const missingCatalogItem = {
    ...hiddenDeletedItem,
    id: "rename-missing-catalog",
    title: "索引缺失会话产出",
    path: path.join(scannerFixture.workspace, "missing-catalog-output.txt"),
    priority: "none",
    source: missingCatalogSource,
    taskGroup: {
      ...hiddenDeletedItem.taskGroup,
      key: `thread:${MISSING_CATALOG_THREAD_ID}`,
      rootThreadId: MISSING_CATALOG_THREAD_ID,
      title: "已归档且索引缺失",
    },
    versions: [{ ...hiddenDeletedItem.versions[0], source: missingCatalogSource }],
    activity: [{ ...hiddenDeletedItem.activity[0], source: missingCatalogSource }],
  };
  const unknownFallbackItem = {
    ...hiddenDeletedItem,
    id: "rename-unknown-fallback",
    title: "未知来源兜底产出",
    path: path.join(scannerFixture.workspace, "missing-unknown-output.txt"),
    priority: "none",
    source: undefined,
    taskGroup: {
      key: "unknown",
      rootThreadId: null,
      title: "来源任务未知",
      project: "未知项目",
      projectKind: "unknown",
      hostId: null,
      workspacePath: null,
      unknown: true,
    },
    versions: [],
    activity: [],
  };
  const titleRefreshItems = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  titleRefreshItems.push(hiddenDeletedItem, missingCatalogItem, unknownFallbackItem);
  fs.writeFileSync(itemsDataPath, `${JSON.stringify(titleRefreshItems, null, 2)}\n`, "utf8");

  const secondRenamedTaskTitle = "自动抓取测试（再次重命名）";
  const renamedArchivedTitle = "归档全删会话（已重命名）";
  const beforeSecondRename = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  const secondRenameIds = [...renameTargetIds, hiddenDeletedItem.id, missingCatalogItem.id, unknownFallbackItem.id];
  const beforeSecondRenameSnapshots = new Map(secondRenameIds.map((id) => {
    const item = beforeSecondRename.find((entry) => entry.id === id);
    return [id, renameStableSnapshot(item)];
  }));
  appendJsonl(scannerFixture.sessionIndexFile, [
    { id: ROOT_THREAD_ID, thread_name: secondRenamedTaskTitle, updated_at: "2026-03-01T00:00:00.000Z" },
    { id: DELETED_ONLY_THREAD_ID, thread_name: renamedArchivedTitle, updated_at: "2026-03-01T00:00:00.000Z" },
  ]);
  const secondRenameResponse = await fetch(new URL("api/scan", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({}),
  });
  assert.equal(secondRenameResponse.status, 202);
  const secondRenameScan = await waitForScan(baseUrl);
  assert.equal(secondRenameScan.observations, 0, "deleted and archived title refresh must not require new rollout evidence");
  const afterSecondRename = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  for (const id of renameTargetIds) {
    const item = afterSecondRename.find((entry) => entry.id === id);
    assert.equal(item.taskGroup.title, secondRenamedTaskTitle);
    assert.deepEqual(renameStableSnapshot(item), beforeSecondRenameSnapshots.get(id), "a second pure rename must preserve item and version ordering metadata");
  }
  const renamedDeletedDelivery = afterSecondRename.find((entry) => entry.id === deliveryItem.id);
  assert.equal(renamedDeletedDelivery.status, "已删除", "deleted outputs must remain deleted while their task title refreshes");
  assert.equal(renamedDeletedDelivery.updatedAt, beforeSecondRename.find((entry) => entry.id === deliveryItem.id).updatedAt, "title refresh must not make a deleted item look newly modified");
  const renamedHiddenDeletedItem = afterSecondRename.find((entry) => entry.id === hiddenDeletedItem.id);
  assert.equal(renamedHiddenDeletedItem.taskGroup.title, renamedArchivedTitle, "a session_index-only archived task must refresh even when its entire group is deleted and hidden");
  assert.ok(Number.isFinite(Date.parse(renamedHiddenDeletedItem.taskGroup.titleSyncedAt)));
  assert.deepEqual(renameStableSnapshot(renamedHiddenDeletedItem), beforeSecondRenameSnapshots.get(hiddenDeletedItem.id), "hidden deleted-group refresh must preserve historical sources and versions");
  const preservedMissingCatalog = afterSecondRename.find((entry) => entry.id === missingCatalogItem.id);
  assert.equal(preservedMissingCatalog.taskGroup.title, "已归档且索引缺失", "missing catalog metadata must preserve the last known title");
  assert.deepEqual(renameStableSnapshot(preservedMissingCatalog), beforeSecondRenameSnapshots.get(missingCatalogItem.id));
  const preservedUnknown = afterSecondRename.find((entry) => entry.id === unknownFallbackItem.id);
  assert.deepEqual(preservedUnknown.taskGroup, unknownFallbackItem.taskGroup, "unknown-source items must retain the explicit fallback group");
  assert.deepEqual(renameStableSnapshot(preservedUnknown), beforeSecondRenameSnapshots.get(unknownFallbackItem.id));

  const batchParentPath = path.join(scannerFixture.workspace, "batch-delete-tree");
  const batchChildPath = path.join(batchParentPath, "child-project");
  fs.mkdirSync(batchChildPath, { recursive: true });
  fs.writeFileSync(path.join(batchChildPath, "file.txt"), "batch fixture\n");
  const directItems = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  const fixtureSource = {
    project: "self-test", task: "批量删除 fixture", threadId: ROOT_THREAD_ID,
    cwd: scannerFixture.workspace, pathScope: "workspace", created: "2026-01-01 10:00",
    scanner: { producerThreadId: ROOT_THREAD_ID, producerThreadIds: [ROOT_THREAD_ID], agentPaths: [] },
  };
  const fixtureVersion = (key) => ({
    version: "v1", current: true, time: "2026-01-01 10:00", status: "快照可用", source: fixtureSource,
    scanner: { key, automatic: true, evidenceIds: [key], evidencePaths: [], kinds: ["fixture"] },
  });
  const manualPath = path.join(scannerFixture.workspace, "manual-untrusted");
  fs.mkdirSync(manualPath, { recursive: true });
  fs.writeFileSync(path.join(manualPath, "keep.txt"), "must survive\n");
  const lastFileProjectPath = path.join(scannerFixture.workspace, "last-file-project");
  const lastFilePath = path.join(lastFileProjectPath, "only.txt");
  fs.mkdirSync(lastFileProjectPath, { recursive: true });
  fs.writeFileSync(lastFilePath, "last file fixture\n");
  const ancestorPath = path.dirname(scannerFixture.workspace);
  const junctionTarget = path.join(scannerFixture.workspace, "junction-target");
  const junctionPath = path.join(scannerFixture.workspace, "junction-output");
  fs.mkdirSync(junctionTarget, { recursive: true });
  fs.writeFileSync(path.join(junctionTarget, "keep.txt"), "junction target\n");
  let junctionCreated = false;
  try { fs.symlinkSync(junctionTarget, junctionPath, "junction"); junctionCreated = true; } catch { }
  directItems.push(
    {
      id: "batch-parent", title: "批量父项目", type: "程序文件夹", category: "程序", version: "v1", path: batchParentPath,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
      files: [{ name: "child-project", relativePath: "child-project", kind: "folder", status: "未检测", statusTone: "neutral" }], versions: [fixtureVersion("batch-parent")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
    },
    {
      id: "batch-child", title: "批量子项目", type: "程序文件夹", category: "程序", version: "v1", path: batchChildPath,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
      files: [{ name: "file.txt", relativePath: "file.txt", kind: "text", status: "未检测", statusTone: "neutral" }], versions: [fixtureVersion("batch-child")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
    },
    {
      id: "workspace-root-item", title: "受保护工作区根", type: "程序文件夹", category: "程序", version: "v1", path: scannerFixture.workspace,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
      files: [], versions: [fixtureVersion("workspace-root")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
    },
    {
      id: "manual-untrusted", title: "手工登记但未授权", type: "程序文件夹", category: "程序", version: "v1", path: manualPath,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: { ...fixtureSource, pathScope: undefined, scanner: undefined },
      files: [
        { name: "keep.txt", relativePath: "keep.txt", kind: "text", status: "未检测", statusTone: "neutral" },
        { name: "gone.txt", relativePath: "gone.txt", kind: "text", status: "已删除", statusTone: "warning" },
      ], versions: [], activity: [],
    },
    {
      id: "workspace-ancestor", title: "工作区祖先", type: "程序文件夹", category: "程序", version: "v1", path: ancestorPath,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
      files: [], versions: [fixtureVersion("workspace-ancestor")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
    },
    {
      id: "system-untrusted", title: "系统目录伪登记", type: "程序文件夹", category: "程序", version: "v1", path: process.env.SystemRoot || path.join(path.parse(process.execPath).root, "Windows"),
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: { project: "self-test", task: "伪登记", threadId: ROOT_THREAD_ID },
      files: [], versions: [], activity: [],
    },
    {
      id: "legacy-unknown-source", title: "旧版未知来源", type: "普通文件", category: "文档", version: "v1", path: path.join(scannerFixture.workspace, "missing-legacy.txt"),
      status: "已删除", statusTone: "warning", mark: "待确认", priority: "none",
      files: [], versions: [], activity: [], fileMetadataVersion: 1,
    },
    {
      id: "incomplete-size-contract", title: "不完整大小契约", type: "普通文件", category: "文档", version: "v1", path: path.join(scannerFixture.workspace, "missing-incomplete.txt"),
      status: "已删除", statusTone: "warning", mark: "待确认", priority: "none", source: fixtureSource,
      files: [], versions: [], activity: [], fileMetadataVersion: 2, sizeBytes: 999, sizeAggregationComplete: false,
    },
    {
      id: "deleted-known-size-contract", title: "已删除旧大小契约", type: "普通文件", category: "文档", version: "v1", path: path.join(scannerFixture.workspace, "missing-known-size.txt"),
      status: "已删除", statusTone: "warning", mark: "待确认", priority: "none", source: fixtureSource,
      files: [{
        name: "historical.bin", relativePath: ".", kind: "code", status: "已删除", statusTone: "warning",
        sizeBytes: 999, directChildCount: 0, descendantCount: 0, aggregationComplete: true,
      }],
      versions: [], activity: [], fileMetadataVersion: 2, sizeBytes: 999, sizeAggregationComplete: true,
    },
    {
      id: "last-file-project", title: "最后文件删除契约", type: "程序文件夹", category: "程序", version: "v1", path: lastFileProjectPath,
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
      files: [{ name: "only.txt", relativePath: "only.txt", kind: "text", status: "未检测", statusTone: "neutral" }],
      versions: [fixtureVersion("last-file-project")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
    },
    {
      id: "sort-normal-low-old", title: "排序正常项", type: "普通文件", category: "文档", version: "v1", path: path.join(scannerFixture.workspace, "sort-normal-missing.txt"),
      status: "未检测", statusTone: "neutral", mark: "待确认", priority: "low", updatedAt: "2020-01-01 00:00", source: fixtureSource,
      files: [], versions: [], activity: [], fileMetadataVersion: 2, sizeBytes: null, sizeAggregationComplete: false,
    },
    {
      id: "sort-deleted-critical-new", title: "排序已删除项", type: "普通文件", category: "文档", version: "v1", path: path.join(scannerFixture.workspace, "sort-deleted-missing.txt"),
      status: "已删除", statusTone: "warning", mark: "待确认", priority: "critical", updatedAt: "2099-01-01 00:00", source: fixtureSource,
      files: [], versions: [], activity: [], fileMetadataVersion: 2, sizeBytes: null, sizeAggregationComplete: false,
    },
  );
  if (junctionCreated) directItems.push({
    id: "junction-output", title: "目录联接产出", type: "程序文件夹", category: "程序", version: "v1", path: junctionPath,
    status: "未检测", statusTone: "neutral", mark: "待确认", priority: "none", source: fixtureSource,
    files: [{ name: "keep.txt", relativePath: "keep.txt", kind: "text", status: "未检测", statusTone: "neutral" }],
    versions: [fixtureVersion("junction-output")], activity: [], discovery: { mode: "codex-session-scan", automatic: true },
  });
  fs.writeFileSync(itemsDataPath, `${JSON.stringify(directItems, null, 2)}\n`, "utf8");

  const migratedLegacyList = await (await fetch(new URL("api/items", baseUrl))).json();
  const migratedManualItem = migratedLegacyList.items.find((item) => item.id === "manual-untrusted");
  assert.equal(migratedManualItem.fileMetadataVersion, 2, "legacy items must be migrated on first load");
  assert.equal(migratedManualItem.taskGroup.key, `thread:${ROOT_THREAD_ID}`, "legacy source fields must derive a compatible task group");
  assert.equal(migratedManualItem.taskGroup.projectKind, "manual");
  assert.equal(migratedManualItem.files.find((file) => file.name === "keep.txt").sizeBytes, fs.statSync(path.join(manualPath, "keep.txt")).size);
  assert.equal(migratedManualItem.files.find((file) => file.name === "gone.txt").sizeBytes, null, "missing legacy file size must remain explicitly unknown");
  assert.equal(migratedManualItem.sizeBytes, scannedTreeBytes(manualPath), "one-time migration must persist an exact item total when readable");
  assert.equal(migratedManualItem.sizeAggregationComplete, true);
  const migratedBatchParent = migratedLegacyList.items.find((item) => item.id === "batch-parent");
  const migratedChildFolder = migratedBatchParent.files.find((file) => file.relativePath === "child-project");
  assert.equal(migratedChildFolder.sizeBytes, fs.statSync(path.join(batchChildPath, "file.txt")).size);
  assert.equal(migratedChildFolder.directChildCount, 1);
  assert.equal(migratedChildFolder.descendantCount, 1);
  assert.deepEqual(migratedLegacyList.items.find((item) => item.id === "legacy-unknown-source").taskGroup, {
    key: "unknown",
    rootThreadId: null,
    title: "来源任务未知",
    project: "未知项目",
    projectKind: "unknown",
    hostId: null,
    workspacePath: null,
    unknown: true,
  }, "legacy records without source evidence must share the explicit unknown group");
  const migratedMissingItem = migratedLegacyList.items.find((item) => item.id === "legacy-unknown-source");
  assert.equal(migratedMissingItem.sizeBytes, null, "missing paths must expose unknown item size");
  assert.equal(migratedMissingItem.sizeAggregationComplete, false);
  const migratedIncompleteItem = migratedLegacyList.items.find((item) => item.id === "incomplete-size-contract");
  assert.equal(migratedIncompleteItem.sizeBytes, null, "incomplete aggregates must not expose a misleading numeric size");
  assert.equal(migratedIncompleteItem.sizeAggregationComplete, false);
  const migratedDeletedKnownItem = migratedLegacyList.items.find((item) => item.id === "deleted-known-size-contract");
  assert.equal(migratedDeletedKnownItem.sizeBytes, null, "deleted v2 records must discard a previously complete item size");
  assert.equal(migratedDeletedKnownItem.sizeAggregationComplete, false);
  assert.ok(
    migratedLegacyList.items.findIndex((item) => item.id === "sort-normal-low-old")
      < migratedLegacyList.items.findIndex((item) => item.id === "sort-deleted-critical-new"),
    "a freshly updated critical deleted item must remain below a lower-priority older normal item in the same task",
  );
  const persistedAfterMigration = JSON.parse(fs.readFileSync(itemsDataPath, "utf8"));
  assert.equal(persistedAfterMigration.find((item) => item.id === "manual-untrusted").fileMetadataVersion, 2, "legacy migration must be persisted once");
  assert.ok(persistedAfterMigration.find((item) => item.id === "manual-untrusted").files.every((file) => Object.hasOwn(file, "sizeBytes")));
  assert.equal(persistedAfterMigration.find((item) => item.id === "manual-untrusted").sizeBytes, migratedManualItem.sizeBytes);
  assert.equal(persistedAfterMigration.find((item) => item.id === "legacy-unknown-source").taskGroup.unknown, true, "task-group compatibility migration must persist in fixture data");
  assert.equal(persistedAfterMigration.find((item) => item.id === "deleted-known-size-contract").sizeBytes, null, "deleted-size normalization must persist once");
  fs.appendFileSync(path.join(manualPath, "keep.txt"), "changed after migration\n", "utf8");
  const repeatedList = await (await fetch(new URL("api/items", baseUrl))).json();
  assert.equal(
    repeatedList.items.find((item) => item.id === "manual-untrusted").sizeBytes,
    migratedManualItem.sizeBytes,
    "ordinary list GETs must use persisted item size instead of rescanning the tree",
  );
  const lastFileDeleteResponse = await fetch(new URL("api/items/last-file-project/delete-file", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ relativePath: "only.txt", confirm: true }),
  });
  const lastFileDeleteResult = await lastFileDeleteResponse.json();
  assert.equal(lastFileDeleteResponse.status, 200, JSON.stringify(lastFileDeleteResult));
  assert.equal(fs.existsSync(lastFilePath), false, "the final recorded file must be moved to the fixture recycle bin");
  assert.equal(fs.existsSync(lastFileProjectPath), true, "deleting the final file must preserve its empty parent folder");
  assert.equal(lastFileDeleteResult.item.status, "已删除");
  assert.equal(lastFileDeleteResult.item.sizeBytes, null, "an item whose final file was deleted must expose unknown size, not zero bytes");
  assert.equal(lastFileDeleteResult.item.sizeAggregationComplete, false);
  if (junctionCreated) {
    const junctionPreviewUrl = new URL("api/items/junction-output/preview", baseUrl);
    const junctionPreviewResponse = await requestPreview("keep.txt", { requestUrl: junctionPreviewUrl });
    assert.equal(junctionPreviewResponse.status, 400, "registered junction paths must not escape preview containment");
  }

  const protectedRootDeleteResponse = await fetch(new URL("api/items/workspace-root-item/delete-project", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(protectedRootDeleteResponse.status, 400);
  assert.equal(fs.existsSync(scannerFixture.workspace), true, "workspace root safety guard must preserve the root");
  for (const unsafeId of ["manual-untrusted", "workspace-ancestor", "system-untrusted", ...(junctionCreated ? ["junction-output"] : [])]) {
    const unsafeDeleteResponse = await fetch(new URL(`api/items/${unsafeId}/delete-project`, baseUrl), {
      method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(unsafeDeleteResponse.status, 400, `${unsafeId} must not receive deletion authority`);
  }
  assert.equal(fs.existsSync(path.join(manualPath, "keep.txt")), true, "manual registration must not grant deletion authority");
  assert.equal(fs.existsSync(process.env.SystemRoot || path.join(path.parse(process.execPath).root, "Windows")), true, "system path must remain untouched");
  const unconfirmedBatchDelete = await fetch(new URL("api/items/batch/delete", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ids: ["batch-parent"], confirm: false }),
  });
  assert.equal(unconfirmedBatchDelete.status, 400);
  assert.equal(fs.existsSync(batchParentPath), true);
  const batchDeleteResponse = await fetch(new URL("api/items/batch/delete", baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ ids: ["batch-child", "batch-parent", "missing-item"], confirm: true }),
  });
  assert.equal(batchDeleteResponse.status, 200);
  const batchDeleteResult = await batchDeleteResponse.json();
  assert.equal(batchDeleteResult.succeeded, 2);
  assert.equal(batchDeleteResult.failed, 1);
  assert.equal(batchDeleteResult.results.find((result) => result.id === "batch-child").coveredBy, "batch-parent");
  assert.equal(fs.existsSync(batchParentPath), false, "overlapping project paths must be deleted once by the selected parent");
  const afterBatchDelete = await (await fetch(new URL("api/items", baseUrl))).json();
  assert.equal(afterBatchDelete.items.find((item) => item.id === "batch-parent").status, "已删除");
  assert.equal(afterBatchDelete.items.find((item) => item.id === "batch-child").status, "已删除");

  const crossOriginResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" }, body: JSON.stringify({ mark: "使用中" }),
  });
  assert.equal(crossOriginResponse.status, 403);
  const missingOriginMutation = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mark: "使用中" }),
  });
  assert.equal(missingOriginMutation.status, 403, "mutating HTTP requests require same-origin proof or an opaque frame token");

  const crossOriginListUrl = new URL("api/items", baseUrl);
  crossOriginListUrl.searchParams.set("frameToken", frameToken);
  const crossOriginListResponse = await fetch(crossOriginListUrl, { headers: { origin: "https://example.invalid" } });
  assert.equal(crossOriginListResponse.status, 403);
  assert.equal(crossOriginListResponse.headers.get("access-control-allow-origin"), null);

  const contentTypeResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl), {
    method: "POST", headers: { "content-type": "text/plain", origin: url.origin }, body: "{}",
  });
  assert.equal(contentTypeResponse.status, 415);

  const oversizedResponse = await fetch(new URL(`api/items/${encodeURIComponent(itemId)}/mark`, baseUrl), {
    method: "POST", headers: sameOriginHeaders, body: JSON.stringify({ mark: "使用中", note: "x".repeat(70 * 1024) }),
  });
  assert.equal(oversizedResponse.status, 413);

  const traversalResponse = await fetch(`${baseUrl}%2e%2e%5cserver.mjs`);
  assert.ok([400, 403, 404].includes(traversalResponse.status));
  assert.doesNotMatch(await traversalResponse.text(), /output-items-local-extension/);

  process.stdout.write("PASS output-items loopback HTTP server (startup/state/static/API/security checks)\n");
} finally {
  if (httpChild.exitCode === null) httpChild.kill();
  await new Promise((resolve) => {
    if (httpChild.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(resolve, 3000);
    httpChild.once("close", () => { clearTimeout(timer); resolve(); });
  });
  fs.rmSync(httpDataRoot, { recursive: true, force: true });
  fs.rmSync(scannerFixture.codexRoot, { recursive: true, force: true });
  fs.rmSync(scannerFixture.workspace, { recursive: true, force: true });
}
