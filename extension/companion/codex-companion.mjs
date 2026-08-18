#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const INJECTION_PATH = path.join(SCRIPT_DIRECTORY, "inject-output-items.user.js");
const LIFECYCLE_FIXTURE_PATH = path.join(SCRIPT_DIRECTORY, "lifecycle-fixture.html");
const FOREGROUND_HELPER_PATH = path.join(SCRIPT_DIRECTORY, "focus-managed-codex.ps1");
const UI_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..", "ui");
const DEFAULT_DATA_DIRECTORY = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "CodexOutputItems",
  "companion",
);
const DEFAULT_PROFILE_PATH = path.join(DEFAULT_DATA_DIRECTORY, "codex-profile");
const DEFAULT_RUN_FILE = path.join(DEFAULT_DATA_DIRECTORY, "companion.json");
const UUID_ROUTE_PATTERN = /initialRoute=%2F(?:global-dictation|avatar-overlay)/i;
const CONTROL_OPEN_TIMEOUT_MS = 45_000;
const MANAGED_OPEN_TIMEOUT_MS = 30_000;

function usage() {
  return [
    "产出项 Codex 伴生注入层",
    "",
    "用法:",
    "  node codex-companion.mjs --url <loopback-url> [--profile <dir>] [--run-file <json>] [--log <file>] [--codex-exe <ChatGPT.exe>] [--instance-nonce <base64url>] [--open]",
    "  node codex-companion.mjs --run-file <json> --activate",
    "  node codex-companion.mjs --run-file <json> --stop",
    "  node codex-companion.mjs --run-file <json> --ping",
    "  node codex-companion.mjs --self-test",
    "",
    "环境变量:",
    "  CODEX_OUTPUT_ITEMS_UI_URL",
    "  CODEX_OUTPUT_ITEMS_PROFILE",
    "  CODEX_OUTPUT_ITEMS_RUN_FILE",
    "  CODEX_OUTPUT_ITEMS_LOG",
    "  CODEX_OUTPUT_ITEMS_CODEX_EXE",
    "  CODEX_OUTPUT_ITEMS_INSTANCE_NONCE",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    url: process.env.CODEX_OUTPUT_ITEMS_UI_URL || "",
    profile: process.env.CODEX_OUTPUT_ITEMS_PROFILE || DEFAULT_PROFILE_PATH,
    runFile: process.env.CODEX_OUTPUT_ITEMS_RUN_FILE || DEFAULT_RUN_FILE,
    log: process.env.CODEX_OUTPUT_ITEMS_LOG || "",
    codexExe: process.env.CODEX_OUTPUT_ITEMS_CODEX_EXE || "",
    instanceNonce: process.env.CODEX_OUTPUT_ITEMS_INSTANCE_NONCE || "",
    open: false,
    activate: false,
    stop: false,
    ping: false,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--url" || argument === "--ui-url") options.url = argv[++index] || "";
    else if (argument === "--profile") options.profile = argv[++index] || "";
    else if (argument === "--run-file") options.runFile = argv[++index] || "";
    else if (argument === "--log") options.log = argv[++index] || "";
    else if (argument === "--codex-exe") options.codexExe = argv[++index] || "";
    else if (argument === "--instance-nonce") options.instanceNonce = argv[++index] || "";
    else if (argument === "--open") options.open = true;
    else if (argument === "--activate") options.activate = true;
    else if (argument === "--stop") options.stop = true;
    else if (argument === "--ping") options.ping = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数: ${argument}`);
  }
  options.profile = path.resolve(options.profile);
  options.runFile = path.resolve(options.runFile);
  if (options.log) options.log = path.resolve(options.log);
  if (options.codexExe) options.codexExe = path.resolve(options.codexExe);
  if (options.instanceNonce && !/^[A-Za-z0-9_-]{16,128}$/.test(options.instanceNonce)) {
    throw new Error("--instance-nonce 必须是 16-128 位 base64url 标识");
  }
  const controlActions = [options.open, options.activate, options.stop, options.ping]
    .filter(Boolean).length;
  if (controlActions > 1) {
    throw new Error("--open、--activate、--stop 和 --ping 不能同时使用");
  }
  if (options.selfTest && controlActions > 0) {
    throw new Error("--self-test 不能与控制命令同时使用");
  }
  return options;
}

function ensureDirectoryFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createLogger(logPath) {
  return (message, details = undefined) => {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    const line = `[${new Date().toISOString()}] ${message}${suffix}`;
    process.stdout.write(`${line}\n`);
    if (!logPath) return;
    try {
      ensureDirectoryFor(logPath);
      fs.appendFileSync(logPath, `${line}\n`, "utf8");
    } catch (_) {}
  };
}

function readRunFile(runFile) {
  try {
    const value = JSON.parse(fs.readFileSync(runFile, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (_) {
    return null;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isOwnedCompanionProcess(state) {
  if (!state || !processExists(state.pid) || !fs.existsSync(FOREGROUND_HELPER_PATH)) return false;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      FOREGROUND_HELPER_PATH,
      "-ValidateCompanion",
      "-CompanionProcessId",
      String(state.pid),
      "-CompanionScript",
      fileURLToPath(import.meta.url),
      ...(state.instanceNonce ? [
        "-ExpectedNonce",
        String(state.instanceNonce),
        ...(state.startedAt ? ["-ExpectedStartedAt", String(state.startedAt)] : []),
      ] : []),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const response = parseLastJsonLine(result.stdout);
  return !result.error && result.status === 0 && response?.ok === true && response?.identity === true;
}

function remainingDeadlineMilliseconds(deadline, minimum = 1) {
  if (!Number.isFinite(deadline)) return 30_000;
  const remaining = Math.floor(deadline - Date.now());
  if (remaining < minimum) throw new Error("产出项窗口激活已达到 30 秒处理期限");
  return remaining;
}

function waitForPromiseUntil(promise, deadline) {
  const timeoutMs = remainingDeadlineMilliseconds(deadline);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("产出项窗口激活已达到 30 秒处理期限")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function controlPipeFor(runFile) {
  const digest = crypto.createHash("sha256").update(path.resolve(runFile).toLowerCase()).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\codex-output-items-${digest}`;
}

function sendControlCommand(controlPipe, command, controlToken, timeoutMs = 5_000) {
  if (typeof controlToken !== "string" || controlToken.length < 32) {
    return Promise.reject(new Error("伴生运行状态缺少有效控制令牌"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = net.createConnection(controlPipe);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.unref();
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`控制命令 ${command} 超时`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify({ command, token: controlToken })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("控制管道在返回结果前关闭"));
    });
  });
}

function writeJsonLine(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeRunFile(runFile, state) {
  ensureDirectoryFor(runFile);
  const temporary = `${runFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, runFile);
}

function removeOwnedRunFile(runFile) {
  const current = readRunFile(runFile);
  if (current?.pid !== process.pid) return;
  try {
    fs.unlinkSync(runFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function resolveUiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error("--url 必须是有效 URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopbackHosts.has(url.hostname) || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("产出项 UI 仅允许使用 http(s) loopback URL");
  }
  if (!url.searchParams.has("embedded")) url.searchParams.set("embedded", "1");
  if (!url.searchParams.has("host")) url.searchParams.set("host", "codex-companion");
  return url;
}

function normalizeResolvedTheme(value) {
  return value === "light" || value === "dark" ? value : null;
}

function dashboardDocumentWithTheme(html, snapshot) {
  const theme = normalizeResolvedTheme(snapshot?.resolvedTheme);
  if (!theme) return html;
  return html.replace(/<html\b([^>]*)>/i, (_, attributes) => {
    const normalizedAttributes = attributes.replace(
      /\sdata-theme=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    );
    return `<html${normalizedAttributes} data-theme="${theme}">`;
  });
}

function buildDashboardDocument(uiUrl) {
  const frameToken = uiUrl.searchParams.get("token") || "";
  if (!frameToken) {
    throw new Error("伴生界面 URL 缺少启动令牌；请通过产出项启动器打开");
  }
  const indexPath = path.join(UI_DIRECTORY, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  const loadAsset = (reference) => {
    const relative = reference.replace(/^\/+/, "").replaceAll("/", path.sep);
    const resolved = path.resolve(UI_DIRECTORY, relative);
    if (!resolved.startsWith(`${UI_DIRECTORY}${path.sep}`)) {
      throw new Error("伴生界面资源路径越界");
    }
    return fs.readFileSync(resolved, "utf8");
  };
  const bootstrap = [
    "globalThis.__CODEX_OUTPUT_ITEMS_COMPANION__ = true;",
    `globalThis.__CODEX_OUTPUT_ITEMS_API_BASE__ = ${JSON.stringify(new URL("/", uiUrl).href)};`,
    `globalThis.__CODEX_OUTPUT_ITEMS_FRAME_TOKEN__ = ${JSON.stringify(frameToken)};`,
  ].join("\n");
  html = html.replace(
    /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/i,
    (_, href) => `<style>${loadAsset(href).replace(/<\/style/gi, "<\\/style")}</style>`,
  );
  html = html.replace(
    /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i,
    (_, src) => `<script>${bootstrap}</script><script type="module">${loadAsset(src).replace(/<\/script/gi, "<\\/script")}</script>`,
  );
  return html.replace("<title>Prototype</title>", "<title>产出项</title>");
}

function resolveCodexExecutable(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new Error(`找不到 Codex 可执行文件: ${explicitPath}`);
    return explicitPath;
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AppxPackage -Name OpenAI.Codex).InstallLocation",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("未找到 Microsoft Store 安装的官方 Codex App");
  }
  const candidate = path.join(result.stdout.trim(), "app", "ChatGPT.exe");
  if (!fs.existsSync(candidate)) throw new Error(`官方 Codex App 中不存在 ChatGPT.exe: ${candidate}`);
  return candidate;
}

class CdpSession extends EventEmitter {
  constructor(browser, sessionId, targetId) {
    super();
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.closed = false;
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("CDP session 已关闭"));
    return this.browser.send(method, params, this.sessionId, timeoutMs);
  }

  markClosed(error = new Error("CDP session 已关闭")) {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed", error);
    this.removeAllListeners();
  }

  close() {
    if (this.closed) return;
    this.browser.detach(this.sessionId);
  }
}

class CdpPipeBrowser extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.sequence = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.output.on("data", (chunk) => this.receive(chunk));
    this.output.once("error", (error) => this.fail(error));
    this.output.once("end", () => this.fail(new Error("Codex CDP pipe 已结束")));
    this.output.once("close", () => this.fail(new Error("Codex CDP pipe 已关闭")));
    this.input.once("error", (error) => this.fail(error));
  }

  async open(deadline = Number.POSITIVE_INFINITY) {
    await this.send("Browser.getVersion", {}, undefined, remainingDeadlineMilliseconds(deadline));
    await this.send("Target.setDiscoverTargets", { discover: true }, undefined, remainingDeadlineMilliseconds(deadline));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let boundary = this.buffer.indexOf(0); boundary !== -1; boundary = this.buffer.indexOf(0)) {
      const source = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!source) continue;
      let message;
      try {
        message = JSON.parse(source);
      } catch (error) {
        this.fail(new Error(`无法解析 CDP 消息: ${error.message}`));
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        continue;
      }
      if (message.sessionId) {
        this.sessions.get(message.sessionId)?.emit(message.method, message.params);
        continue;
      }
      if (message.method === "Target.detachedFromTarget") {
        const session = this.sessions.get(message.params?.sessionId);
        this.sessions.delete(message.params?.sessionId);
        session?.markClosed(new Error("Codex renderer target 已分离"));
      }
      this.emit(message.method, message.params);
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("CDP pipe 已关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, Math.max(1, Math.min(30_000, timeoutMs)));
      this.pending.set(id, { resolve, reject, timer });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.input.write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async targets(timeoutMs = 30_000) {
    const result = await this.send("Target.getTargets", {}, undefined, timeoutMs);
    return result.targetInfos || [];
  }

  async attach(targetId, timeoutMs = 30_000) {
    const result = await this.send("Target.attachToTarget", { targetId, flatten: true }, undefined, timeoutMs);
    const session = new CdpSession(this, result.sessionId, targetId);
    this.sessions.set(result.sessionId, session);
    return session;
  }

  detach(sessionId) {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    session?.markClosed();
    if (!this.closed) this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.markClosed(error);
    this.sessions.clear();
    this.emit("closed", error);
  }

  close() {
    if (this.closed) return;
    this.input.destroy();
    this.output.destroy();
    this.fail(new Error("CDP pipe 已由伴生进程关闭"));
  }
}

class InjectionManager {
  constructor(browser, source, dashboardDocument, log) {
    this.browser = browser;
    this.source = source;
    this.dashboardDocument = dashboardDocument;
    this.log = log;
    this.records = new Map();
    this.scanInFlight = null;
    this.scanTimer = null;
    this.stopped = false;
    this.scheduleScan = this.scheduleScan.bind(this);
  }

  isCodexRenderer(target) {
    if (target.type !== "page" || UUID_ROUTE_PATTERN.test(target.url || "")) return false;
    return String(target.url || "").startsWith("app://") || /\bCodex\b/i.test(String(target.title || ""));
  }

  async start({ deadline = Number.POSITIVE_INFINITY } = {}) {
    this.browser.on("Target.targetCreated", this.scheduleScan);
    this.browser.on("Target.targetInfoChanged", this.scheduleScan);
    this.browser.on("Target.targetDestroyed", (params) => this.forgetTarget(params?.targetId));
    await this.scan({ deadline });
    this.scanTimer = setInterval(() => this.scan().catch((error) => {
      this.log("renderer scan failed", { error: error.message });
    }), 500);
  }

  scheduleScan() {
    setTimeout(() => this.scan().catch((error) => {
      this.log("renderer discovery failed", { error: error.message });
    }), 50);
  }

  forgetTarget(targetId) {
    const record = this.records.get(targetId);
    if (!record) return;
    record.session.close();
    this.records.delete(targetId);
  }

  async scan({ deadline = Number.POSITIVE_INFINITY } = {}) {
    if (this.stopped || this.browser.closed) return;
    if (this.scanInFlight) {
      return Number.isFinite(deadline)
        ? waitForPromiseUntil(this.scanInFlight, deadline)
        : this.scanInFlight;
    }
    this.scanInFlight = (async () => {
      const targets = (await this.browser.targets(remainingDeadlineMilliseconds(deadline))).filter((target) => this.isCodexRenderer(target));
      const liveIds = new Set(targets.map((target) => target.targetId));
      for (const [targetId, record] of this.records) {
        if (!liveIds.has(targetId) || record.session.closed) this.records.delete(targetId);
      }
      for (const target of targets) {
        if (!this.records.has(target.targetId)) await this.inject(target, { deadline });
      }
      for (const [targetId, record] of this.records) {
        if (!record.session.closed) await this.ensurePendingFrame(targetId, record, { deadline });
      }
    })();
    try {
      await this.scanInFlight;
    } finally {
      this.scanInFlight = null;
    }
  }

  async inject(target, { deadline = Number.POSITIVE_INFINITY } = {}) {
    const session = await this.browser.attach(target.targetId, remainingDeadlineMilliseconds(deadline));
    const record = {
      session,
      scriptIdentifier: null,
      loadedFrameName: null,
      loadedFrameId: null,
    };
    this.records.set(target.targetId, record);
    session.once("closed", () => this.records.delete(target.targetId));
    try {
      await session.send("Page.enable", {}, remainingDeadlineMilliseconds(deadline));
      await session.send("Runtime.enable", {}, remainingDeadlineMilliseconds(deadline));
      await session.send("Page.setBypassCSP", { enabled: true }, remainingDeadlineMilliseconds(deadline));
      const registration = await session.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `${this.source}\n//# sourceURL=codex-output-items.inject.js`,
      }, remainingDeadlineMilliseconds(deadline));
      record.scriptIdentifier = registration.identifier;
      const evaluation = await session.send("Runtime.evaluate", {
        expression: this.source,
        awaitPromise: true,
        returnByValue: true,
      }, remainingDeadlineMilliseconds(deadline));
      if (evaluation.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description || "产出项注入脚本执行失败",
        );
      }
      this.log("renderer injected", {
        targetId: target.targetId,
        title: target.title,
        url: target.url,
      });
    } catch (error) {
      this.records.delete(target.targetId);
      session.close();
      throw error;
    }
  }

  findFrameByName(frameTree, frameName) {
    if (!frameTree || !frameName) return null;
    if (frameTree.frame?.name === frameName) return frameTree.frame;
    for (const child of frameTree.childFrames || []) {
      const match = this.findFrameByName(child, frameName);
      if (match) return match;
    }
    return null;
  }

  async loadFrameDocument(targetId, record, frameName, { deadline = Number.POSITIVE_INFINITY } = {}) {
    if (!frameName) return false;
    const { frameTree } = await record.session.send("Page.getFrameTree", {}, remainingDeadlineMilliseconds(deadline));
    const targetFrame = this.findFrameByName(frameTree, frameName);
    if (!targetFrame?.id) return false;
    if (
      record.loadedFrameName === frameName
      && record.loadedFrameId === targetFrame.id
    ) return true;
    let hostTheme = null;
    try {
      const themeResult = await record.session.send("Runtime.evaluate", {
        expression: "window.__codexOutputItemsInjection__?.themeSnapshot?.() ?? null",
        returnByValue: true,
      }, remainingDeadlineMilliseconds(deadline));
      if (!themeResult.exceptionDetails) hostTheme = themeResult.result?.value || null;
    } catch (error) {
      this.log("host theme snapshot unavailable", { targetId, error: error.message });
    }
    await record.session.send("Page.setDocumentContent", {
      frameId: targetFrame.id,
      html: dashboardDocumentWithTheme(this.dashboardDocument, hostTheme),
    }, remainingDeadlineMilliseconds(deadline));
    record.loadedFrameName = frameName;
    record.loadedFrameId = targetFrame.id;
    this.log("output items frame content loaded", {
      targetId,
      frameName,
      theme: normalizeResolvedTheme(hostTheme?.resolvedTheme),
    });
    return true;
  }

  async ensurePendingFrame(targetId, record, { deadline = Number.POSITIVE_INFINITY } = {}) {
    const result = await record.session.send("Runtime.evaluate", {
      expression: "window.__codexOutputItemsInjection__?.frameRequest?.() ?? null",
      returnByValue: true,
    }, remainingDeadlineMilliseconds(deadline));
    if (result.exceptionDetails) return false;
    const request = result.result?.value;
    if (!request?.frameName) return false;
    return this.loadFrameDocument(targetId, record, request.frameName, { deadline });
  }

  async waitForFrame(targetId, record, frameName, timeoutMs = 2_000, operationDeadline = Number.POSITIVE_INFINITY) {
    const deadline = Math.min(Date.now() + timeoutMs, operationDeadline);
    while (Date.now() < deadline) {
      if (await this.loadFrameDocument(targetId, record, frameName, { deadline })) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    remainingDeadlineMilliseconds(deadline);
    return this.loadFrameDocument(targetId, record, frameName, { deadline });
  }

  async activate({ deadline = Number.POSITIVE_INFINITY } = {}) {
    let lastError = "";
    for (const [targetId, record] of this.records) {
      if (record.session.closed) continue;
      try {
        const result = await record.session.send("Runtime.evaluate", {
          expression: "window.__codexOutputItemsInjection__?.open?.() ?? null",
          returnByValue: true,
        }, remainingDeadlineMilliseconds(deadline));
        const activation = result.result?.value;
        if (!activation?.opened || !activation.frameName) continue;
        const frameLoaded = await this.waitForFrame(
          targetId,
          record,
          activation.frameName,
          2_000,
          deadline,
        );
        if (!frameLoaded) {
          this.log("output items frame not ready", { targetId, frameName: activation.frameName });
          continue;
        }
        await record.session.send("Page.bringToFront", {}, remainingDeadlineMilliseconds(deadline));
        this.log("output items activated", { targetId });
        return { opened: true, frameLoaded: true, targetId };
      } catch (error) {
        lastError = error.message;
        this.log("renderer activation failed", { targetId, error: error.message });
      }
    }
    return { opened: false, queued: true, ...(lastError ? { lastError } : {}) };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    for (const [targetId, record] of this.records) {
      const { session, scriptIdentifier } = record;
      if (session.closed) continue;
      try {
        await session.send("Runtime.evaluate", {
          expression: "window.__codexOutputItemsInjection__?.destroy()",
          awaitPromise: true,
          returnByValue: true,
        });
      } catch (error) {
        this.log("renderer DOM cleanup failed", { targetId, error: error.message });
      }
      if (scriptIdentifier) {
        try {
          await session.send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: scriptIdentifier,
          });
        } catch (error) {
          this.log("renderer registration cleanup failed", { targetId, error: error.message });
        }
      }
      try {
        await session.send("Page.setBypassCSP", { enabled: false });
      } catch (_) {}
      session.close();
    }
    this.records.clear();
  }
}

function buildInjectionSource(uiUrl) {
  const script = fs.readFileSync(INJECTION_PATH, "utf8");
  return `window.__CODEX_OUTPUT_ITEMS_UI_URL__ = ${JSON.stringify(uiUrl.href)};\n${script}`;
}

function startControlServer(controlPipe, controlToken, handlers, log) {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 4096) {
        handled = true;
        socket.end(`${JSON.stringify({ ok: false, error: "控制消息过大" })}\n`);
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch (_) {
        socket.end(`${JSON.stringify({ ok: false, error: "控制消息不是有效 JSON" })}\n`);
        return;
      }
      const suppliedToken = typeof request?.token === "string" ? request.token : "";
      const expected = Buffer.from(controlToken);
      const supplied = Buffer.from(suppliedToken);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        socket.end(`${JSON.stringify({ ok: false, error: "控制令牌无效" })}\n`);
        return;
      }
      const command = String(request?.command || "").trim().toLowerCase();
      Promise.resolve()
        .then(async () => {
          if (command === "open" || command === "activate") return handlers.open();
          if (command === "stop") {
            setImmediate(handlers.stop);
            return { stopping: true };
          }
          if (command === "ping") return { running: true };
          throw new Error(`未知控制命令: ${command}`);
        })
        .then((result) => socket.end(`${JSON.stringify({ ok: true, ...result })}\n`))
        .catch((error) => socket.end(`${JSON.stringify({ ok: false, error: error.message })}\n`));
    });
  });
  server.on("error", (error) => log("control pipe error", { error: error.message }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlPipe, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function terminateCodex(child, log) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill("SIGTERM");
  } catch (_) {}
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (graceful || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    log("forcing managed Codex process tree to stop", { pid: child.pid });
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch (_) {}
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function restoreCdpWindow(browser, targetId, log, deadline) {
  try {
    const window = await browser.send(
      "Browser.getWindowForTarget",
      { targetId },
      undefined,
      remainingDeadlineMilliseconds(deadline),
    );
    const priorState = String(window.bounds?.windowState || "normal");
    if (priorState === "minimized") {
      await browser.send("Browser.setWindowBounds", {
        windowId: window.windowId,
        bounds: { windowState: "normal" },
      }, undefined, remainingDeadlineMilliseconds(deadline));
    }
    return {
      windowId: window.windowId,
      priorState,
      restored: priorState === "minimized",
    };
  } catch (error) {
    // The native helper remains authoritative for visibility and focus. Keep
    // this CDP step best-effort because Electron versions differ in which
    // Browser window APIs they expose over --remote-debugging-pipe.
    log("CDP window restore unavailable", { targetId, error: error.message });
    return { restored: false, error: error.message };
  }
}

function parseLastJsonLine(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch (_) {
    return null;
  }
}

function focusManagedCodexWindow({ managedProcessId, profilePath, codexExecutable, log, deadline }) {
  if (!fs.existsSync(FOREGROUND_HELPER_PATH)) {
    throw new Error(`窗口前台恢复组件缺失: ${FOREGROUND_HELPER_PATH}`);
  }
  const remaining = remainingDeadlineMilliseconds(deadline, 500);
  const helperTimeout = Math.max(250, Math.min(8_000, remaining - 250));
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      FOREGROUND_HELPER_PATH,
      "-ManagedProcessId",
      String(managedProcessId),
      "-ProfilePath",
      profilePath,
      "-CodexExecutable",
      codexExecutable,
      "-TimeoutMilliseconds",
      String(helperTimeout),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: remaining,
      maxBuffer: 1024 * 1024,
    },
  );
  const response = parseLastJsonLine(result.stdout);
  if (result.error) {
    throw new Error(`Windows 窗口恢复组件执行失败: ${result.error.message}`);
  }
  if (result.status !== 0 || response?.ok !== true || response?.focused !== true) {
    const diagnostic = response?.error
      || String(result.stderr || "").trim()
      || `窗口恢复组件退出码 ${result.status}`;
    throw new Error(diagnostic);
  }
  log("managed Codex window focused", response);
  return response;
}

async function activateManagedOutputItems({
  manager,
  browser,
  managedProcessId,
  profilePath,
  codexExecutable,
  log,
  timeoutMs = MANAGED_OPEN_TIMEOUT_MS,
  absoluteDeadline = undefined,
}) {
  const deadline = absoluteDeadline ?? (Date.now() + timeoutMs);
  let lastActivation = null;
  while (Date.now() < deadline) {
    await manager.scan({ deadline });
    remainingDeadlineMilliseconds(deadline);
    lastActivation = await manager.activate({ deadline });
    remainingDeadlineMilliseconds(deadline);
    if (lastActivation.opened) {
      const cdpWindow = await restoreCdpWindow(browser, lastActivation.targetId, log, deadline);
      remainingDeadlineMilliseconds(deadline);
      const nativeWindow = focusManagedCodexWindow({
        managedProcessId,
        profilePath,
        codexExecutable,
        log,
        deadline,
      });
      return {
        ...lastActivation,
        focused: true,
        cdpWindow,
        nativeWindow,
      };
    }
    await delay(100);
  }
  const detail = lastActivation?.lastError ? `：${lastActivation.lastError}` : "";
  throw new Error(`产出项页面未能在 ${Math.ceil(timeoutMs / 1000)} 秒内激活${detail}`);
}

async function run(options) {
  const log = createLogger(options.log);
  const openControlDeadline = (options.activate || options.open)
    ? Date.now() + CONTROL_OPEN_TIMEOUT_MS
    : null;
  const existing = readRunFile(options.runFile);
  const existingOwned = isOwnedCompanionProcess(existing);
  const startingClaim = Boolean(
    options.instanceNonce
    && existing?.status === "starting"
    && existing?.instanceNonce === options.instanceNonce
  );
  if (options.ping) {
    if (!existingOwned || typeof existing.controlPipe !== "string") {
      await writeJsonLine({
        ok: false,
        running: false,
        reason: "not-running",
      });
      process.exitCode = 1;
      return "control";
    }
    try {
      const result = await sendControlCommand(existing.controlPipe, "ping", existing.controlToken);
      const healthy = result?.ok === true && result?.running === true;
      await writeJsonLine({
        ...result,
        running: healthy,
        pid: existing.pid,
        codexPid: existing.codexPid ?? null,
      });
      if (!healthy) process.exitCode = 1;
    } catch (error) {
      await writeJsonLine({
        ok: false,
        running: false,
        pid: existing.pid,
        error: error.message,
      });
      process.exitCode = 1;
    }
    return "control";
  }
  if (existingOwned && typeof existing.controlPipe === "string") {
    if (options.stop) {
      const result = await sendControlCommand(existing.controlPipe, "stop", existing.controlToken);
      await writeJsonLine(result);
      if (result?.ok !== true) process.exitCode = 1;
      return "control";
    }
    if (options.activate || options.open) {
      const controlRemaining = Math.max(1, openControlDeadline - Date.now());
      const result = await sendControlCommand(
        existing.controlPipe,
        "open",
        existing.controlToken,
        controlRemaining,
      );
      await writeJsonLine(result);
      if (result?.ok !== true || result?.focused !== true) process.exitCode = 1;
      return "control";
    }
    throw new Error(`产出项伴生进程已经运行 (PID ${existing.pid})`);
  }
  if (existing && !existingOwned && !startingClaim) {
    try {
      fs.unlinkSync(options.runFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (options.stop) {
    await writeJsonLine({ ok: true, stopping: false, reason: "not-running" });
    return "control";
  }
  if (options.activate) throw new Error("产出项伴生进程尚未运行");
  if (!options.url) throw new Error("缺少 --url 或 CODEX_OUTPUT_ITEMS_UI_URL");
  if (process.platform !== "win32") throw new Error("当前伴生启动层仅支持 Windows Codex Desktop");

  const uiUrl = resolveUiUrl(options.url);
  const instanceNonce = options.instanceNonce || crypto.randomBytes(24).toString("base64url");
  const startedAt = new Date(Date.now() - (process.uptime() * 1000)).toISOString();
  const createdAt = startingClaim && existing?.createdAt ? existing.createdAt : startedAt;
  writeRunFile(options.runFile, {
    schemaVersion: 2,
    pid: process.pid,
    codexPid: null,
    startedAt,
    createdAt,
    url: uiUrl.href,
    profilePath: options.profile,
    codexExe: options.codexExe || null,
    instanceNonce,
    status: "starting",
  });
  let codexExe;
  try {
    codexExe = resolveCodexExecutable(options.codexExe);
  } catch (error) {
    removeOwnedRunFile(options.runFile);
    throw error;
  }
  fs.mkdirSync(options.profile, { recursive: true });
  const controlPipe = controlPipeFor(options.runFile);
  const controlToken = crypto.randomBytes(32).toString("base64url");
  writeRunFile(options.runFile, {
    schemaVersion: 2,
    pid: process.pid,
    codexPid: null,
    startedAt,
    createdAt,
    url: uiUrl.href,
    profilePath: options.profile,
    codexExe,
    controlPipe,
    controlToken,
    instanceNonce,
    status: "starting",
  });
  const source = buildInjectionSource(uiUrl);
  const dashboardDocument = buildDashboardDocument(uiUrl);
  const child = spawn(
    codexExe,
    [
      `--user-data-dir=${options.profile}`,
      "--remote-debugging-pipe",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    },
  );
  const browser = new CdpPipeBrowser(child);
  const manager = new InjectionManager(browser, source, dashboardDocument, log);
  let controlServer = null;
  let shutdownPromise = null;
  let requestShutdown;
  const stopped = new Promise((resolve) => {
    requestShutdown = resolve;
  });

  const shutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      log("companion stopping", { reason });
      try {
        await manager.stop();
      } catch (error) {
        log("injection cleanup failed", { error: error.message });
      }
      if (controlServer) {
        await new Promise((resolve) => controlServer.close(resolve));
        controlServer = null;
      }
      browser.close();
      await terminateCodex(child, log);
      try {
        removeOwnedRunFile(options.runFile);
      } catch (error) {
        log("run file cleanup failed", { error: error.message });
      }
      log("companion stopped", { reason });
      requestShutdown();
    })();
    return shutdownPromise;
  };

  const onSignal = (signal) => {
    shutdown(signal).catch((error) => {
      log("shutdown failed", { error: error.message });
      requestShutdown();
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  child.once("exit", (code, signal) => {
    if (!shutdownPromise) shutdown(`codex-exit:${signal || code}`).catch(() => requestShutdown());
  });
  child.once("error", (error) => {
    if (!shutdownPromise) shutdown(`codex-error:${error.message}`).catch(() => requestShutdown());
  });
  browser.once("closed", (error) => {
    if (!shutdownPromise) shutdown(`cdp-closed:${error.message}`).catch(() => requestShutdown());
  });

  try {
    const startupDeadline = Date.now() + MANAGED_OPEN_TIMEOUT_MS;
    await browser.open(startupDeadline);
    await manager.start({ deadline: startupDeadline });
    let openInFlight = null;
    const openManagedWindow = (absoluteDeadline = undefined) => {
      if (openInFlight) return openInFlight;
      openInFlight = activateManagedOutputItems({
        manager,
        browser,
        managedProcessId: child.pid,
        profilePath: options.profile,
        codexExecutable: codexExe,
        log,
        absoluteDeadline,
      }).finally(() => {
        openInFlight = null;
      });
      return openInFlight;
    };
    if (options.open) await openManagedWindow(startupDeadline);
    controlServer = await startControlServer(controlPipe, controlToken, {
      open: openManagedWindow,
      stop: () => shutdown("control-stop"),
    }, log);
    const state = {
      schemaVersion: 2,
      pid: process.pid,
      codexPid: child.pid,
      startedAt,
      createdAt,
      url: uiUrl.href,
      profilePath: options.profile,
      codexExe,
      controlPipe,
      controlToken,
      instanceNonce,
      status: "running",
    };
    writeRunFile(options.runFile, state);
    log("companion ready", state);
    await stopped;
    return "resident";
  } catch (error) {
    await shutdown(`startup-error:${error.message}`);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.selfTest) {
    const injection = fs.readFileSync(INJECTION_PATH, "utf8");
    if (!injection.includes("__codexOutputItemsInjection__")) {
      throw new Error("注入脚本缺少预期的运行时标识");
    }
    if (!injection.includes('nextFrame.src = "about:blank"')) {
      throw new Error("注入脚本没有使用隔离的 about:blank iframe");
    }
    if (/allow-same-origin/.test(injection)) {
      throw new Error("伴生 iframe 不得启用 allow-same-origin");
    }
    if (
      !injection.includes('const THEME_MESSAGE = "output-items:theme"')
      || !injection.includes("themeSnapshot,")
      || !injection.includes("syncFrameTheme(true)")
    ) {
      throw new Error("注入脚本缺少主题快照或 iframe 热切换消息");
    }
    if (!injection.includes('document.querySelectorAll("[data-app-shell-application-menu-bar]")')) {
      throw new Error("注入脚本缺少 Codex 宿主标题栏作用域");
    }
    if (!injection.includes("app-shell-header-context-menu-surface")) {
      throw new Error("注入脚本缺少宿主上下文标题栏定位器");
    }
    if (!injection.includes('[class*="home-mode-toggle"]')) {
      throw new Error("注入脚本缺少居中模式按钮定位器");
    }
    if (
      !injection.includes('[data-test-id="header-shell-slot"]')
      || !injection.includes('[data-testid="header-shell-slot"]')
    ) {
      throw new Error("注入脚本必须兼容 data-test-id/data-testid 尾部标题栏插槽");
    }
    if (!injection.includes("structuralAnchor.compareDocumentPosition(slotRoot)")) {
      throw new Error("注入脚本没有将隐藏范围限制在上下文节点之后的尾部插槽");
    }
    if (!injection.includes('html[data-codex-output-items-open="true"]')) {
      throw new Error("宿主标题栏隐藏样式没有限制在产出项激活状态");
    }
    if (!injection.includes("node.removeAttribute(HEADER_HIDDEN)")) {
      throw new Error("注入脚本缺少宿主标题栏恢复逻辑");
    }
    if (
      !injection.includes("let activeSurface = null")
      || !injection.includes("surface !== activeSurface")
      || !injection.includes("page.parentElement !== activeSurface")
      || !injection.includes("currentRouteKey() !== activeRouteKey")
    ) {
      throw new Error("注入脚本缺少路由与宿主 surface 生命周期守卫");
    }
    if (
      !injection.includes("hiddenNativeNodes.forEach")
      || !injection.includes("hiddenHeaderNodes.forEach")
      || !injection.includes("hostSurfaceNodes.forEach")
    ) {
      throw new Error("注入脚本必须恢复已断开宿主节点上的隐藏标记");
    }
    const activeMountSection = injection.slice(
      injection.indexOf("function mountActivePage()"),
      injection.indexOf("function openOutputItems()"),
    );
    if (!activeMountSection || activeMountSection.includes("appendChild(page)")) {
      throw new Error("激活中的产出项不得迁移 iframe 到新的宿主 surface");
    }
    if (
      !injection.includes("function isHostInteraction(target)")
      || !injection.includes("[role='menuitem']")
      || !injection.includes("page.contains(clickable)")
      || !injection.includes("isHostInteraction(event.target)")
    ) {
      throw new Error("注入脚本缺少非产出项宿主交互关闭守卫");
    }
    const lifecycleFixture = fs.readFileSync(LIFECYCLE_FIXTURE_PATH, "utf8");
    for (const fixtureMarker of [
      'id="settings-entry" role="menuitem"',
      'data-test-id="header-shell-slot"',
      'data-testid="header-shell-slot"',
      'id="arm-replacement"',
      'id="replacement-surface"',
      'id="theme-dark"',
      'id="theme-light"',
      'id="theme-system"',
      'data-resolved-theme="dark"',
    ]) {
      if (!lifecycleFixture.includes(fixtureMarker)) {
        throw new Error(`伴生生命周期 DOM fixture 缺少场景: ${fixtureMarker}`);
      }
    }
    const companionSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    if (!companionSource.includes('session.send("Page.setDocumentContent"')) {
      throw new Error("伴生进程缺少 iframe 文档注入能力");
    }
    if (!companionSource.includes("dashboardDocumentWithTheme(this.dashboardDocument, hostTheme)")) {
      throw new Error("伴生进程缺少 iframe 首屏主题快照注入");
    }
    if (!companionSource.includes('shell: false')) {
      throw new Error("Windows 窗口恢复组件必须使用参数化且禁用 shell 的调用方式");
    }
    if (!(MANAGED_OPEN_TIMEOUT_MS < CONTROL_OPEN_TIMEOUT_MS && CONTROL_OPEN_TIMEOUT_MS < 50_000)) {
      throw new Error("窗口激活、管道与 PowerShell 控制器超时层级无效");
    }
    const deadlineStartedAt = Date.now();
    let deadlineRejected = false;
    try {
      await waitForPromiseUntil(delay(100), Date.now() + 20);
    } catch (error) {
      deadlineRejected = /处理期限/.test(error.message);
    }
    if (!deadlineRejected || Date.now() - deadlineStartedAt >= 90) {
      throw new Error("绝对 deadline fixture 未按时中止等待");
    }
    const foregroundTest = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        FOREGROUND_HELPER_PATH,
        "-SelfTest",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const foregroundResult = parseLastJsonLine(foregroundTest.stdout);
    if (foregroundTest.error || foregroundTest.status !== 0 || foregroundResult?.ok !== true) {
      throw new Error(
        foregroundResult?.error
        || String(foregroundTest.stderr || "").trim()
        || foregroundTest.error?.message
        || "Windows 窗口恢复组件隔离测试失败",
      );
    }
    if (foregroundResult.windowMutation !== false) {
      throw new Error("Windows 窗口恢复组件自测不得操作真实窗口");
    }
    const companionIdentityTest = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        FOREGROUND_HELPER_PATH,
        "-ValidateCompanion",
        "-CompanionProcessId",
        String(process.pid),
        "-CompanionScript",
        fileURLToPath(import.meta.url),
        ...(options.instanceNonce ? ["-ExpectedNonce", options.instanceNonce] : []),
        "-ExpectedStartedAt",
        new Date(Date.now() - (process.uptime() * 1000)).toISOString(),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const companionIdentity = parseLastJsonLine(companionIdentityTest.stdout);
    if (
      companionIdentityTest.error
      || companionIdentityTest.status !== 0
      || companionIdentity?.ok !== true
      || companionIdentity?.identity !== true
    ) {
      throw new Error(
        companionIdentity?.error
        || String(companionIdentityTest.stderr || "").trim()
        || companionIdentityTest.error?.message
        || "伴生进程身份隔离测试失败",
      );
    }
    const dashboardDocument = buildDashboardDocument(new URL(
      "http://127.0.0.1:41234/?embedded=1&host=codex-companion&token=self-test-token",
    ));
    if (!dashboardDocument.includes("__CODEX_OUTPUT_ITEMS_API_BASE__")) {
      throw new Error("伴生文档缺少本地 API 配置");
    }
    if (!dashboardDocument.includes("self-test-token")) {
      throw new Error("伴生文档缺少 iframe API 令牌");
    }
    if (/<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"/i.test(dashboardDocument)) {
      throw new Error("伴生文档仍依赖外部脚本或样式资源");
    }
    const themedDashboardDocument = dashboardDocumentWithTheme(dashboardDocument, {
      mode: "light",
      resolvedTheme: "light",
    });
    if (!/<html\b[^>]*\bdata-theme="light"/i.test(themedDashboardDocument)) {
      throw new Error("伴生文档没有在首屏解析前写入浅色主题");
    }
    if (dashboardDocumentWithTheme(dashboardDocument, { resolvedTheme: "invalid" }) !== dashboardDocument) {
      throw new Error("伴生文档接受了无效的主题快照");
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      injectionPath: INJECTION_PATH,
      lifecycleFixturePath: LIFECYCLE_FIXTURE_PATH,
      injectionBytes: Buffer.byteLength(injection),
      dashboardBytes: Buffer.byteLength(dashboardDocument),
      frameTransport: "about:blank+Page.setDocumentContent",
      foregroundHelper: foregroundResult,
      companionIdentity: {
        ok: true,
        identity: true,
        windowMutation: false,
      },
      deadlineFixture: {
        handlerMilliseconds: MANAGED_OPEN_TIMEOUT_MS,
        controlClientMilliseconds: CONTROL_OPEN_TIMEOUT_MS,
        controllerMilliseconds: 50_000,
        absoluteDeadline: true,
      },
    })}\n`);
    return;
  }
  const mode = await run(options);
  if (mode === "control") process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  process.stderr.write(`产出项伴生进程失败: ${error.message}\n`, () => process.exit(1));
});
