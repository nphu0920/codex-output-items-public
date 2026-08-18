#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { createCodexOutputScanner } from "./scripts/codex-output-scanner.mjs";
import { createFakeGitHubAdapter, createGitHubPublisher } from "./scripts/github-publisher.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.join(ROOT, "ui");
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const DATA_ROOT = process.env.OUTPUT_ITEMS_DATA_DIR || path.join(LOCAL_APP_DATA, "CodexOutputItems");
const DATA_FILE = path.join(DATA_ROOT, "data", "items.json");
const EVENT_LOG = path.join(DATA_ROOT, "logs", "events.ndjson");
const RUN_ROOT = path.join(DATA_ROOT, "run");
const SERVER_STATE_FILE = path.join(RUN_ROOT, "server.json");
const ITEMS_LOCK_FILE = path.join(RUN_ROOT, "items.lock");
const SCAN_STATE_FILE = path.join(DATA_ROOT, "data", "scanner.json");
const CODEX_DATA_ROOT = path.resolve(
  process.env.OUTPUT_ITEMS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
);
const RESOURCE_URI = "ui://output-items/dashboard.html";
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizedRuntimeThreadId = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return THREAD_ID_PATTERN.test(normalized) ? normalized : null;
};
const RUNTIME_CODEX_THREAD_ID = normalizedRuntimeThreadId(process.env.CODEX_THREAD_ID);
const RUNTIME_EXPLICIT_THREAD_ID = normalizedRuntimeThreadId(process.env.OUTPUT_ITEMS_SOURCE_THREAD_ID);
const SOURCE_THREAD_ID = RUNTIME_CODEX_THREAD_ID || RUNTIME_EXPLICIT_THREAD_ID || null;
const MARKS = new Set(["使用中", "待确认", "需要修复", "已定稿", "已归档", "已废弃"]);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_BATCH_ITEMS = 50;
const MAX_TRACKED_FILE_ROWS = 1500;
const MAX_SCANNED_FILE_NODES = 20_000;
const FILE_METADATA_VERSION = 2;
const MAX_IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_TEXT_PREVIEW_LINES = 5_000;
const MAX_IMAGE_PREVIEW_DIMENSION = 16_384;
const MAX_IMAGE_PREVIEW_PIXELS = 40_000_000;
const IMAGE_PREVIEW_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
]);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".text", ".md", ".markdown", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini",
  ".cfg", ".conf", ".properties", ".xml", ".html", ".htm", ".svg",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css", ".scss",
  ".less", ".py", ".ps1", ".bat", ".cmd", ".sh", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
]);
const INERT_TEXT_EXTENSIONS = new Set([
  ".html", ".htm", ".svg", ".js", ".jsx", ".mjs", ".cjs", ".ts",
  ".tsx", ".ps1", ".bat", ".cmd", ".sh", ".zsh", ".fish",
]);
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIORITIES = new Set(["critical", "high", "normal", "low", "none"]);
const PRIORITY_RANK = new Map([["critical", 5], ["high", 4], ["normal", 3], ["low", 2], ["none", 1]]);
const TASK_GROUP_PROJECT_KINDS = new Set(["workspace", "codex-managed", "external", "manual", "unknown"]);
const RECYCLE_SCRIPT = path.join(ROOT, "scripts", "recycle-path.ps1");
const OPEN_EXPLORER_SCRIPT = path.join(ROOT, "scripts", "open-explorer-location.ps1");

const SERVER_INFO = {
  name: "output-items-local-extension",
  title: "产出项",
  version: "1.0.0",
  description: "本地优先的 Codex 产出项工作台",
  icons: [{
    src: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2d292c"/><path d="M9 9h14v4H9zm0 7h14v7H9z" fill="none" stroke="#e7e3e6" stroke-width="2"/><path d="M12 19h8" stroke="#4387f4" stroke-width="2"/></svg>').toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["32x32"],
  }],
};

const ENTRY_UI_META = {
  ui: { resourceUri: RESOURCE_URI, visibility: ["app", "model"] },
  "openai/ui": {
    entrypoints: [{ type: "global" }],
    preferredModelDisplayMode: "fullscreen",
  },
  "openai/outputTemplate": RESOURCE_URI,
};

const APP_TOOL_META = { ui: { visibility: ["app"] } };
const APP_MODEL_TOOL_META = { ui: { visibility: ["app", "model"] } };

const TOOLS = [
  {
    name: "open_output_items",
    title: "产出项",
    description: "打开产出项工作台，查看 Codex 产出的文件、文件组、版本、来源任务和健康状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: ENTRY_UI_META,
  },
  {
    name: "list_output_items",
    title: "读取产出项",
    description: "读取本地登记的全部产出项。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "scan_output_items",
    title: "扫描 Codex 产出项",
    description: "在后台增量扫描 Codex 本地任务记录，自动汇总有可靠写入或交付证据的文件与文件夹。",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", default: false } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_MODEL_TOOL_META,
  },
  {
    name: "detect_output_item",
    title: "检测产出项状态",
    description: "检查已登记路径、读取权限和常见文件结构，并写回系统状态与文件级状态。不会执行程序。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["quick", "full", "custom"], default: "quick" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "mark_output_item",
    title: "标记产出项",
    description: "更新用户维护的产出项标记；自动检测不会覆盖它。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        mark: { type: "string", enum: [...MARKS] },
        note: { type: "string", maxLength: 500 },
      },
      required: ["id", "mark"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "register_output_item",
    title: "登记 Codex 产出项",
    description: "把 Codex 产出的单个文件或程序文件夹登记到产出项，并记录来源任务与版本。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        project: { type: "string", minLength: 1 },
        task: { type: "string", minLength: 1 },
        threadId: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" },
        version: { type: "string", minLength: 1 },
        description: { type: "string", maxLength: 1000 },
      },
      required: ["path", "title", "project", "task", "threadId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_MODEL_TOOL_META,
  },
  {
    name: "open_output_item_location",
    title: "打开产出项位置",
    description: "在 Windows 文件资源管理器中打开已登记目录，或精确选中已登记文件。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 }, relativePath: { type: "string", maxLength: 1024 } },
      required: ["id"], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "preview_output_item_file",
    title: "预览产出项文件",
    description: "读取已登记的图片或纯文本文件供产出项界面预览；不会执行 HTML、SVG 或脚本。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        relativePath: { type: "string", minLength: 1, maxLength: 1024 },
      },
      required: ["id", "relativePath"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "delete_output_item_file",
    title: "删除产出项文件",
    description: "把产出项中一个已登记文件实质移入 Windows 回收站；记录与历史版本仍保留。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 }, relativePath: { type: "string", maxLength: 1024 }, confirm: { type: "boolean" } },
      required: ["id", "relativePath", "confirm"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "delete_output_item",
    title: "删除产出项目",
    description: "把产出项登记的整个文件或文件夹实质移入 Windows 回收站；记录与历史版本仍保留。",
    inputSchema: {
      type: "object", properties: { id: { type: "string", minLength: 1 }, confirm: { type: "boolean" } },
      required: ["id", "confirm"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "set_output_item_priority",
    title: "设置产出项优先级",
    description: "设置单个产出项优先级，列表会优先按此字段排序。",
    inputSchema: {
      type: "object", properties: { id: { type: "string", minLength: 1 }, priority: { type: "string", enum: [...PRIORITIES] } },
      required: ["id", "priority"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "batch_set_output_item_priority",
    title: "批量设置产出项优先级",
    description: "为多个产出项设置相同优先级。",
    inputSchema: {
      type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: "string" } }, priority: { type: "string", enum: [...PRIORITIES] } },
      required: ["ids", "priority"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "batch_detect_output_items",
    title: "批量检测产出项",
    description: "逐项检测多个产出项，并返回每一项的成功或失败结果。",
    inputSchema: {
      type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: "string" } }, mode: { type: "string", enum: ["quick", "full", "custom"], default: "quick" } },
      required: ["ids"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "batch_delete_output_items",
    title: "批量删除产出项目",
    description: "把多个已登记项目实质移入 Windows 回收站；逐项返回结果并保留全部记录。",
    inputSchema: {
      type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: "string" } }, confirm: { type: "boolean" } },
      required: ["ids", "confirm"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
  {
    name: "get_github_upload_context",
    title: "读取 GitHub 上传环境",
    description: "检查本机 GitHub CLI、登录账号和当前账号拥有的仓库；不会读取或返回令牌。",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: APP_TOOL_META,
  },
  {
    name: "preflight_github_upload",
    title: "预检 GitHub 上传",
    description: "检查选择范围、敏感文件、凭据、文件大小和仓库权限；不会上传。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 }, config: { type: "object" }, destination: { type: "object" }, upload: { type: "object" },
        publishMode: { type: "string", enum: ["branch-pr", "direct"] }, branch: { type: "string" },
        license: { type: "string", enum: ["none", "mit", "apache-2.0", "gpl-3.0"] }, generateReadme: { type: "boolean" },
        protectMain: { type: "boolean" }, description: { type: "string", maxLength: 350 },
      },
      required: ["id"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: APP_TOOL_META,
  },
  {
    name: "start_github_upload",
    title: "开始上传个人 GitHub",
    description: "在独立临时目录中复制产出文件并提交到个人 GitHub；必须先预检并明确确认。",
    inputSchema: {
      type: "object", properties: { id: { type: "string", minLength: 1 }, preflightId: { type: "string", minLength: 1 }, confirm: { type: "boolean" }, config: { type: "object" } },
      required: ["id", "preflightId", "confirm"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: APP_TOOL_META,
  },
  {
    name: "get_github_upload_job",
    title: "读取 GitHub 上传进度",
    description: "读取异步上传任务的阶段、进度和结果。",
    inputSchema: { type: "object", properties: { jobId: { type: "string", minLength: 1 } }, required: ["jobId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: APP_TOOL_META,
  },
  {
    name: "cancel_github_upload",
    title: "取消 GitHub 上传",
    description: "仅在暂存、克隆或复制阶段取消；进入提交或推送阶段后不可取消。",
    inputSchema: { type: "object", properties: { jobId: { type: "string", minLength: 1 } }, required: ["jobId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: APP_TOOL_META,
  },
];

function ensureStorage() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(EVENT_LOG), { recursive: true });
}

function nowText() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date()).replaceAll("/", "-");
}

function dateText(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return nowText();
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date).replaceAll("/", "-");
}

function fileKind(name, isDirectory = false) {
  if (isDirectory) return "folder";
  const extension = path.extname(name).toLowerCase();
  if (IMAGE_PREVIEW_TYPES.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if ([".ppt", ".pptx"].includes(extension)) return "ppt";
  if ([".xls", ".xlsx", ".csv"].includes(extension)) return "xls";
  if ([".exe", ".msi"].includes(extension)) return "app";
  if (TEXT_PREVIEW_EXTENSIONS.has(extension) || [".doc", ".docx"].includes(extension)) return "text";
  return "code";
}

function scanOutputTree(target, { collectRows = true } = {}) {
  let rootStat;
  try {
    if (!fs.existsSync(target)) return { files: [], totalEntryCount: 0, totalSizeBytes: null, complete: false };
    rootStat = fs.statSync(target);
  } catch {
    return { files: [], totalEntryCount: 0, totalSizeBytes: null, complete: false };
  }
  if (!rootStat.isDirectory()) {
    const file = {
      name: path.basename(target), relativePath: ".", label: path.extname(target).slice(1).toUpperCase() || "文件",
      kind: fileKind(target), status: "未检测", statusTone: "neutral", updated: dateText(rootStat.mtime),
      sizeBytes: Number.isSafeInteger(rootStat.size) ? rootStat.size : null,
      directChildCount: 0,
      descendantCount: 0,
      aggregationComplete: Number.isSafeInteger(rootStat.size),
    };
    return {
      files: collectRows ? [file] : [],
      totalEntryCount: 1,
      totalSizeBytes: file.sizeBytes,
      complete: file.aggregationComplete,
    };
  }

  const records = [];
  let nodesVisited = 0;
  let scanLimitReached = false;
  const visit = (directory, relativeRoot = "") => {
    let children;
    try { children = fs.readdirSync(directory, { withFileTypes: true }); }
    catch {
      return {
        sizeBytes: null,
        directChildCount: null,
        descendantCount: null,
        aggregationComplete: false,
      };
    }
    children.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    let sizeBytes = 0;
    let directChildCount = 0;
    let directChildCountComplete = true;
    let descendantCount = 0;
    let descendantCountComplete = true;
    let aggregationComplete = true;
    for (const entry of children) {
      if (nodesVisited >= MAX_SCANNED_FILE_NODES) {
        scanLimitReached = true;
        directChildCountComplete = false;
        descendantCountComplete = false;
        aggregationComplete = false;
        break;
      }
      if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      nodesVisited += 1;
      directChildCount += 1;
      descendantCount += 1;
      const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const extensionLabel = path.extname(entry.name).slice(1).toUpperCase() || "文件";
      const parentLabel = path.dirname(relativePath) === "." ? "" : `${path.dirname(relativePath)} · `;
      let stat = null;
      try { stat = fs.statSync(absolutePath); } catch { }
      const updated = stat ? dateText(stat.mtime) : nowText();

      if (entry.isDirectory()) {
        let folderRecord = null;
        if (collectRows && records.length < MAX_TRACKED_FILE_ROWS) {
          folderRecord = {
            name: entry.name,
            relativePath,
            label: "文件夹",
            kind: "folder",
            status: "未检测",
            statusTone: "neutral",
            updated,
            sizeBytes: null,
            directChildCount: null,
            descendantCount: null,
            aggregationComplete: false,
          };
          records.push(folderRecord);
        }
        const summary = visit(absolutePath, relativePath);
        if (summary.descendantCount === null) descendantCountComplete = false;
        else descendantCount += summary.descendantCount;
        if (summary.sizeBytes === null || !Number.isSafeInteger(sizeBytes + summary.sizeBytes)) aggregationComplete = false;
        else sizeBytes += summary.sizeBytes;
        if (folderRecord) {
          Object.assign(folderRecord, {
            label: `文件夹 · ${summary.descendantCount ?? "?"} 项`,
            sizeBytes: summary.sizeBytes,
            directChildCount: summary.directChildCount,
            descendantCount: summary.descendantCount,
            aggregationComplete: summary.aggregationComplete,
          });
        }
        continue;
      }

      const fileSize = stat?.isFile() && Number.isSafeInteger(stat.size) ? stat.size : null;
      if (fileSize === null || !Number.isSafeInteger(sizeBytes + fileSize)) aggregationComplete = false;
      else sizeBytes += fileSize;
      if (collectRows && records.length < MAX_TRACKED_FILE_ROWS) {
        records.push({
          name: entry.name,
          relativePath,
          label: `${parentLabel}${extensionLabel}`,
          kind: fileKind(entry.name),
          status: "未检测",
          statusTone: "neutral",
          updated,
          sizeBytes: fileSize,
          directChildCount: 0,
          descendantCount: 0,
          aggregationComplete: fileSize !== null,
        });
      }
    }
    return {
      sizeBytes: aggregationComplete ? sizeBytes : null,
      directChildCount: directChildCountComplete ? directChildCount : null,
      descendantCount: descendantCountComplete ? descendantCount : null,
      aggregationComplete: aggregationComplete && descendantCountComplete,
    };
  };
  const summary = visit(target);
  if (!summary.aggregationComplete && records.length === 0 && collectRows) {
    records.push({
      name: path.basename(target), relativePath: ".", label: "读取受限", kind: "folder",
      status: "读取受限", statusTone: "warning", detail: "目录存在，但当前无法读取其内容", updated: dateText(rootStat.mtime),
      sizeBytes: null, directChildCount: null, descendantCount: null, aggregationComplete: false,
    });
  }
  return {
    files: records,
    totalEntryCount: summary.descendantCount ?? records.length,
    totalSizeBytes: summary.sizeBytes,
    complete: summary.aggregationComplete,
    truncated: scanLimitReached,
  };
}

function itemSizeMetadataFromScan(scanned) {
  const sizeBytes = scanned?.totalSizeBytes;
  const sizeAggregationComplete = scanned?.complete === true
    && Number.isSafeInteger(sizeBytes)
    && sizeBytes >= 0;
  return {
    sizeBytes: sizeAggregationComplete ? sizeBytes : null,
    sizeAggregationComplete,
  };
}

function hasCompleteItemSizeMetadata(item) {
  if (typeof item?.sizeAggregationComplete !== "boolean") return false;
  return item.sizeAggregationComplete
    ? Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0
    : item.sizeBytes === null;
}

function countFiles(target) {
  return scanOutputTree(target, { collectRows: false }).totalEntryCount;
}

function scanTopLevel(target) {
  return scanOutputTree(target).files;
}

function makeSeedItem() {
  const created = nowText();
  const scanned = scanOutputTree(ROOT);
  const files = scanned.files;
  const source = selfRegistrationSource(created);
  const taskGroup = taskGroupFromSource(source);
  return {
    id: "output-items-local-extension",
    title: "产出项本地扩展",
    type: "程序文件夹",
    category: "程序",
    version: "v1.0.0",
    meta: `${scanned.totalEntryCount} 个文件`,
    time: "刚刚",
    updatedAt: created,
    description: "独立于 Codex 安装目录运行的本地优先产出项工作台。",
    path: ROOT,
    status: "未检测",
    statusTone: "neutral",
    statusDetail: "点击“检测状态”检查路径、权限和结构",
    lastChecked: "—",
    mark: "使用中",
    priority: "normal",
    source,
    taskGroup,
    fileMetadataVersion: FILE_METADATA_VERSION,
    ...itemSizeMetadataFromScan(scanned),
    files,
    versions: [{
      version: "v1.0.0", current: true, time: created, note: "新增 Codex 外观主题同步、任务重命名同步、Explorer 精确前置和可复现正式发布包",
      status: "快照可用", source,
    }],
    activity: [{ time: created, title: "Codex 创建产出项", detail: "登记本地扩展及其来源任务。", tone: "accent", source }],
  };
}

function hasCompleteFileMetadata(file) {
  return Object.hasOwn(file || {}, "sizeBytes")
    && Object.hasOwn(file || {}, "directChildCount")
    && Object.hasOwn(file || {}, "descendantCount")
    && typeof file?.aggregationComplete === "boolean";
}

function legacyFileWithUnknownMetadata(file) {
  const isFolder = file?.kind === "folder";
  const existingSize = Number.isSafeInteger(file?.sizeBytes) && file.sizeBytes >= 0 ? file.sizeBytes : null;
  return {
    ...file,
    sizeBytes: existingSize,
    directChildCount: isFolder
      ? (Number.isSafeInteger(file?.directChildCount) && file.directChildCount >= 0 ? file.directChildCount : null)
      : 0,
    descendantCount: isFolder
      ? (Number.isSafeInteger(file?.descendantCount) && file.descendantCount >= 0 ? file.descendantCount : null)
      : 0,
    aggregationComplete: typeof file?.aggregationComplete === "boolean"
      ? file.aggregationComplete
      : existingSize !== null && !isFolder,
  };
}

function mergeMigratedFileRecord(scanned, previous) {
  if (!previous) return scanned;
  const merged = { ...previous, ...scanned };
  for (const field of ["status", "statusTone", "detail"]) {
    if (previous[field] !== undefined) merged[field] = previous[field];
  }
  return merged;
}

function migrateItemFileMetadata(item) {
  const previousFiles = Array.isArray(item.files) ? item.files : [];
  const deletedItemHasSize = item.status === "已删除"
    && (item.sizeBytes !== null || item.sizeAggregationComplete !== false);
  const needsMigration = item.fileMetadataVersion !== FILE_METADATA_VERSION
    || previousFiles.some((file) => !hasCompleteFileMetadata(file))
    || !hasCompleteItemSizeMetadata(item)
    || deletedItemHasSize;
  if (!needsMigration) return { item, changed: false };

  let files = previousFiles.map(legacyFileWithUnknownMetadata);
  let itemSizeMetadata = itemSizeMetadataFromScan(null);
  const canDiscoverCurrentFiles = item.status !== "已删除"
    && fs.existsSync(String(item.path || ""))
    && (previousFiles.length > 0
      || item.discovery?.automatic === true
      || trustedScannerSources(item).length > 0
      || item.id === "output-items-local-extension");
  if (canDiscoverCurrentFiles) {
    const scanned = scanOutputTree(item.path);
    const discovered = scanned.files;
    itemSizeMetadata = itemSizeMetadataFromScan(scanned);
    const previousByPath = new Map(previousFiles.map((file) => [normalizedRelativePath(file.relativePath || file.name), file]));
    const discoveredPaths = new Set(discovered.map((file) => normalizedRelativePath(file.relativePath || file.name)));
    files = [
      ...discovered.map((file) => mergeMigratedFileRecord(file, previousByPath.get(normalizedRelativePath(file.relativePath || file.name)))),
      ...previousFiles
        .filter((file) => !discoveredPaths.has(normalizedRelativePath(file.relativePath || file.name)))
        .map(legacyFileWithUnknownMetadata),
    ];
  }
  return {
    item: { ...item, fileMetadataVersion: FILE_METADATA_VERSION, ...itemSizeMetadata, files },
    changed: true,
  };
}

function unknownTaskGroup() {
  return {
    key: "unknown",
    rootThreadId: null,
    title: "来源任务未知",
    project: "未知项目",
    projectKind: "unknown",
    hostId: null,
    workspacePath: null,
    unknown: true,
  };
}

function localInstallTaskGroup() {
  return {
    key: "local-install",
    rootThreadId: null,
    title: "本地安装",
    project: "local-install",
    projectKind: "unknown",
    hostId: null,
    workspacePath: null,
    unknown: true,
  };
}

function selfRegistrationSource(created, { project = "codex-output-items", task = "维护“产出项”公开发行版", threadId = SOURCE_THREAD_ID } = {}) {
  const normalizedThreadId = String(threadId || "").trim().toLowerCase();
  if (THREAD_ID_PATTERN.test(normalizedThreadId)) {
    return { project, task, threadId: normalizedThreadId, created };
  }
  return { project: "local-install", task: "本地安装", threadId: null, origin: "local-install", created };
}

function taskSourceForItem(item) {
  if (item?.source && typeof item.source === "object") return item.source;
  const versions = Array.isArray(item?.versions) ? item.versions : [];
  return versions.find((entry) => entry?.current && entry?.source)?.source
    || versions.find((entry) => entry?.source)?.source
    || {};
}

function taskGroupFromSource(source, existing = null) {
  const sourceValue = source && typeof source === "object" ? source : {};
  const existingValue = existing && typeof existing === "object" ? existing : {};
  const sourceThreadId = String(sourceValue.threadId || "").trim().toLowerCase();
  const existingThreadId = String(existingValue.rootThreadId || "").trim().toLowerCase();
  const rootThreadId = THREAD_ID_PATTERN.test(sourceThreadId)
    ? sourceThreadId
    : THREAD_ID_PATTERN.test(existingThreadId)
      ? existingThreadId
      : null;
  if (!rootThreadId) {
    const localInstall = sourceValue.origin === "local-install"
      || sourceValue.project === "local-install"
      || existingValue.key === "local-install";
    return localInstall ? localInstallTaskGroup() : unknownTaskGroup();
  }
  const projectKind = TASK_GROUP_PROJECT_KINDS.has(existingValue.projectKind)
    ? existingValue.projectKind
    : TASK_GROUP_PROJECT_KINDS.has(sourceValue.pathScope)
      ? sourceValue.pathScope
      : "manual";
  const workspacePath = String(existingValue.workspacePath || sourceValue.cwd || "").trim() || null;
  const title = String(existingValue.title || sourceValue.task || `Codex 任务 ${rootThreadId.slice(0, 8)}`).trim();
  const project = String(existingValue.project || sourceValue.project || (workspacePath ? path.basename(path.resolve(workspacePath)) : "Codex")).trim();
  const hostId = String(existingValue.hostId || sourceValue.hostId || "").trim() || null;
  return {
    key: `thread:${rootThreadId}`,
    rootThreadId,
    title: (title || `Codex 任务 ${rootThreadId.slice(0, 8)}`).slice(0, 240),
    project: (project || "Codex").slice(0, 240),
    projectKind,
    hostId,
    workspacePath,
    unknown: false,
  };
}

function taskGroupForItem(item) {
  return taskGroupFromSource(taskSourceForItem(item), item?.taskGroup);
}

function catalogTaskTitleForItem(item, taskCatalog) {
  if (!(taskCatalog?.titles instanceof Map)) return null;
  const storedGroup = item?.taskGroup && typeof item.taskGroup === "object" ? item.taskGroup : null;
  if (storedGroup?.unknown === true || storedGroup?.key === "unknown") return null;
  const source = taskSourceForItem(item);
  const storedRoot = String(storedGroup?.rootThreadId || "").trim().toLowerCase();
  const sourceThreadId = String(source?.threadId || "").trim().toLowerCase();
  let rootThreadId = THREAD_ID_PATTERN.test(storedRoot)
    ? storedRoot
    : THREAD_ID_PATTERN.test(sourceThreadId)
      ? sourceThreadId
      : null;
  if (!rootThreadId) return null;

  const catalogRoot = typeof taskCatalog.rootFor === "function"
    ? taskCatalog.rootFor(rootThreadId, rootThreadId)
    : rootThreadId;
  if (THREAD_ID_PATTERN.test(String(catalogRoot || ""))) rootThreadId = String(catalogRoot).toLowerCase();
  else if (typeof taskCatalog.isUnrootedSubagent === "function" && taskCatalog.isUnrootedSubagent(rootThreadId)) return null;

  const title = String(taskCatalog.titles.get(rootThreadId) || "").trim().slice(0, 240);
  return title || null;
}

function syncTaskCatalogMetadata(items, taskCatalog) {
  if (!(taskCatalog?.titles instanceof Map) || taskCatalog.titles.size === 0) return 0;
  const titleSyncedAt = new Date().toISOString();
  let updated = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const title = catalogTaskTitleForItem(item, taskCatalog);
    if (!title) continue;
    const taskGroup = taskGroupForItem(item);
    if (taskGroup.unknown || taskGroup.title === title) continue;
    items[index] = {
      ...item,
      taskGroup: {
        ...(item.taskGroup && typeof item.taskGroup === "object" ? item.taskGroup : {}),
        ...taskGroup,
        title,
        titleSyncedAt,
      },
    };
    updated += 1;
  }
  return updated;
}

function sameTaskGroup(left, right) {
  return ["key", "rootThreadId", "title", "project", "projectKind", "hostId", "workspacePath", "unknown"]
    .every((field) => left?.[field] === right?.[field]);
}

let itemsLockDepth = 0;

function loadItems() {
  ensureStorage();
  if (!fs.existsSync(DATA_FILE)) {
    const initial = [makeSeedItem()];
    saveItems(initial);
    return initial;
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(value)) throw new Error("items.json 根值必须是数组");
  } catch (error) {
    let backupPath = "";
    try {
      const modified = fs.statSync(DATA_FILE).mtime.toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(path.dirname(DATA_FILE), `items.corrupt-${modified}.json`);
      if (!fs.existsSync(backupPath)) fs.copyFileSync(DATA_FILE, backupPath, fs.constants.COPYFILE_EXCL);
    } catch (backupError) {
      logEvent("storage-backup-error", { message: String(backupError) });
    }
    logEvent("storage-read-error", { message: String(error), backupPath });
    throw new Error(`产出项历史数据无法解析，已停止写入${backupPath ? `并保留备份：${backupPath}` : "以避免覆盖原文件"}`);
  }
  const migrated = value.map((item) => {
    const fileMigration = migrateItemFileMetadata(item);
    const taskGroup = taskGroupForItem(fileMigration.item);
    return {
      item: sameTaskGroup(fileMigration.item.taskGroup, taskGroup)
        ? fileMigration.item
        : { ...fileMigration.item, taskGroup },
      changed: fileMigration.changed || !sameTaskGroup(fileMigration.item.taskGroup, taskGroup),
    };
  });
  if (migrated.some((entry) => entry.changed)) {
    if (itemsLockDepth === 0) return withItemsLock(() => loadItems());
    value = migrated.map((entry) => entry.item);
    saveItems(value);
  }
  return value;
}

function saveItems(items) {
  ensureStorage();
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, DATA_FILE);
}

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function acquireItemsLock() {
  ensureStorage();
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const lockId = `${process.pid}-${crypto.randomUUID()}`;
  const deadline = Date.now() + 5000;
  let handle;

  while (handle === undefined) {
    try {
      handle = fs.openSync(ITEMS_LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ lockId, pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(ITEMS_LOCK_FILE).mtimeMs;
        let ownerAlive = true;
        try {
          const record = JSON.parse(fs.readFileSync(ITEMS_LOCK_FILE, "utf8"));
          const ownerPid = Number(record.pid);
          if (!Number.isInteger(ownerPid) || ownerPid <= 0) ownerAlive = false;
          else {
            try { process.kill(ownerPid, 0); }
            catch (processError) { ownerAlive = processError?.code === "EPERM"; }
          }
        } catch { ownerAlive = false; }
        if (age > 300_000 && !ownerAlive) {
          fs.rmSync(ITEMS_LOCK_FILE, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("产出项数据正被另一个进程占用，请稍后重试");
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 25);
    }
  }

  return { handle, lockId };
}

function releaseItemsLock({ handle, lockId }) {
  try { fs.closeSync(handle); } catch { }
  try {
    const record = JSON.parse(fs.readFileSync(ITEMS_LOCK_FILE, "utf8"));
    if (record.lockId === lockId) fs.rmSync(ITEMS_LOCK_FILE, { force: true });
  } catch { }
}

function withItemsLock(operation) {
  const lock = acquireItemsLock();
  itemsLockDepth += 1;
  try {
    return operation();
  } finally {
    itemsLockDepth -= 1;
    releaseItemsLock(lock);
  }
}

async function withItemsLockAsync(operation) {
  const lock = acquireItemsLock();
  itemsLockDepth += 1;
  try {
    return await operation();
  } finally {
    itemsLockDepth -= 1;
    releaseItemsLock(lock);
  }
}

function logEvent(type, details = {}) {
  ensureStorage();
  fs.appendFileSync(EVENT_LOG, `${JSON.stringify({ at: new Date().toISOString(), type, ...details })}\n`, "utf8");
}

function checkStructure(target) {
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return { ok: true };
  const extension = path.extname(target).toLowerCase();
  try {
    const size = fs.statSync(target).size;
    const head = Buffer.alloc(Math.min(8, size));
    const handle = fs.openSync(target, "r");
    fs.readSync(handle, head, 0, head.length, 0);
    fs.closeSync(handle);
    if (extension === ".pdf" && !head.toString("ascii").startsWith("%PDF-")) return { ok: false, detail: "PDF 文件头无效" };
    if ([".docx", ".xlsx", ".pptx"].includes(extension) && head.subarray(0, 2).toString("ascii") !== "PK") return { ok: false, detail: "Office 压缩结构无效" };
    if (extension === ".png" && !head.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ok: false, detail: "PNG 文件头无效" };
    if (extension === ".json" && size <= 5 * 1024 * 1024) JSON.parse(fs.readFileSync(target, "utf8"));
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `结构读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function detectItem(item, mode) {
  const checkedAt = nowText();
  if (!fs.existsSync(item.path)) {
    const files = item.files.map((file) => ({ ...file, status: "已删除", statusTone: "warning", updated: checkedAt }));
    return {
      item: {
        ...item, ...itemSizeMetadataFromScan(null), files, status: "已删除", statusTone: "warning", statusDetail: "登记路径已不存在；记录与历史版本仍保留",
        lastChecked: checkedAt,
        activity: [{ time: checkedAt, title: "检测发现路径已删除", detail: "登记路径不存在；未修改用户标记。", tone: "warning", source: item.source }, ...item.activity],
      },
      result: { source: "real", tone: "warning", passed: 0, warnings: 0, failed: Math.max(files.length, 1), title: "已删除", detail: "登记路径已不存在；未执行任何程序。", files },
    };
  }

  const rootStat = fs.statSync(item.path);
  const scanned = scanOutputTree(item.path);
  const scannedFiles = scanned.files;
  const previousFiles = Array.isArray(item.files) ? item.files : [];
  const previousByPath = new Map(previousFiles.map((file) => [file.relativePath || file.name, file]));
  const scannedPaths = new Set(scannedFiles.map((file) => file.relativePath || file.name));
  const currentFiles = [
    ...scannedFiles.map((file) => ({ ...(previousByPath.get(file.relativePath || file.name) || {}), ...file })),
    ...previousFiles.filter((file) => !scannedPaths.has(file.relativePath || file.name)),
  ];
  let passed = 0;
  let warnings = 0;
  let failed = 0;
  const files = currentFiles.map((file) => {
    const target = rootStat.isDirectory() ? path.join(item.path, file.relativePath || file.name) : item.path;
    if (!fs.existsSync(target)) {
      failed += 1;
      return { ...file, status: "已删除", statusTone: "warning", detail: "登记条目不存在", updated: checkedAt };
    }
    try {
      fs.accessSync(target, fs.constants.R_OK);
      const structure = mode === "quick" ? { ok: true } : checkStructure(target);
      if (!structure.ok) {
        failed += 1;
        return { ...file, status: "已破损", statusTone: "warning", detail: structure.detail, updated: checkedAt };
      }
      passed += 1;
      return { ...file, status: "正常", statusTone: "success", detail: mode === "full" ? "路径、权限与基础结构正常" : "路径与读取权限正常", updated: checkedAt };
    } catch (error) {
      warnings += 1;
      return { ...file, status: "已失效", statusTone: "warning", detail: String(error), updated: checkedAt };
    }
  });

  const tone = failed || warnings ? "warning" : "success";
  const status = failed ? "已破损" : warnings ? "部分失效" : item.category === "程序" ? "结构可读" : "文件可读";
  const statusDetail = failed
    ? `${failed} 个条目异常，${passed} 个条目通过`
    : warnings ? `${warnings} 个条目无法完整读取，${passed} 个条目通过`
      : item.category === "程序" ? `路径与 ${passed} 个登记条目可读；未执行程序启动验证` : "路径、读取权限与基础结构正常";
  const nextItem = {
    ...item,
    ...itemSizeMetadataFromScan(scanned),
    files,
    meta: `${scanned.totalEntryCount} 个文件`,
    status,
    statusTone: tone,
    statusDetail,
    lastChecked: checkedAt,
    activity: [{
      time: checkedAt, title: `${mode === "full" ? "完整" : mode === "custom" ? "自定义" : "快速"}检测完成`,
      detail: `${passed} 项通过，${warnings} 项警告，${failed} 项失败；未修改用户标记。`, tone, source: item.source,
    }, ...item.activity],
  };
  return { item: nextItem, result: { source: "real", tone, passed, warnings, failed, title: status, detail: statusDetail, files } };
}

function updateItem(id, updater) {
  const safeId = validateItemId(id);
  return withItemsLock(() => {
    const items = loadItems();
    const index = items.findIndex((item) => item.id === safeId);
    if (index < 0) throw new Error(`未找到产出项：${safeId}`);
    items[index] = updater(items[index]);
    saveItems(items);
    return items[index];
  });
}

function validateItemId(value) {
  const id = String(value || "").trim();
  if (!ITEM_ID_PATTERN.test(id)) throw new Error("产出项 ID 无效");
  return id;
}

function validateBatchIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("至少需要选择一个产出项");
  if (value.length > MAX_BATCH_ITEMS) throw new Error(`一次最多操作 ${MAX_BATCH_ITEMS} 个产出项`);
  return [...new Set(value.map(validateItemId))];
}

function validatePriority(value) {
  const priority = String(value || "");
  if (!PRIORITIES.has(priority)) throw new Error("不支持的优先级");
  return priority;
}

function itemUpdatedValue(item) {
  const candidates = [
    item.updatedAt,
    item.versions?.find((entry) => entry.current)?.time,
    item.versions?.[0]?.time,
    item.source?.created,
    item.time,
  ];
  return Math.max(0, ...candidates.map(sourceTimeValue));
}

function listItemsForDisplay() {
  return loadItems().map((item) => {
    let deletable = false;
    let deletionBlockedReason = "目标路径已不存在";
    if (fs.existsSync(item.path)) {
      try {
        assertSafeDeletionTarget(item, item.path);
        deletable = true;
        deletionBlockedReason = "";
      } catch (error) {
        deletionBlockedReason = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ...item,
      taskGroup: taskGroupForItem(item),
      priority: PRIORITIES.has(item.priority) ? item.priority : "none",
      deletable,
      deletionBlockedReason,
    };
  })
    .sort((left, right) => {
      const deletionBucketDifference = Number(left.status === "已删除") - Number(right.status === "已删除");
      if (deletionBucketDifference) return deletionBucketDifference;
      const priorityDifference = (PRIORITY_RANK.get(right.priority) || 0) - (PRIORITY_RANK.get(left.priority) || 0);
      if (priorityDifference) return priorityDifference;
      const timeDifference = itemUpdatedValue(right) - itemUpdatedValue(left);
      if (timeDifference) return timeDifference;
      return String(left.title || left.id).localeCompare(String(right.title || right.id), "zh-CN");
    });
}

function normalizedRelativePath(value) {
  return String(value || "").replaceAll("/", "\\").replace(/^\.\\/, "").replace(/[\\]+$/, "").toLowerCase();
}

function validateRecordedRelativePath(value, { allowDot = false } = {}) {
  const relativePath = String(value ?? "").trim();
  if (allowDot && relativePath === ".") return relativePath;
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes(":")) throw new Error("登记文件相对路径无效");
  if (relativePath.includes("\0")) throw new Error("登记文件相对路径无效");
  const segments = relativePath.replaceAll("/", "\\").split("\\");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("登记文件相对路径无效");
  return relativePath;
}

function findItemById(items, value) {
  const id = validateItemId(value);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`未找到产出项：${id}`);
  return item;
}

function resolveRecordedTarget(item, relativePath, { allowRoot = true, requireFile = false, requireExists = true } = {}) {
  const storedRoot = String(item.path || "");
  if (!storedRoot || !path.isAbsolute(storedRoot)) throw new Error("产出项登记路径无效");
  const root = path.resolve(storedRoot);
  let target = root;
  let fileRecord = null;

  if (relativePath !== undefined && relativePath !== null && relativePath !== "") {
    const safeRelative = validateRecordedRelativePath(relativePath, { allowDot: true });
    const requestedKey = normalizedRelativePath(safeRelative);
    fileRecord = (Array.isArray(item.files) ? item.files : []).find((file) => (
      normalizedRelativePath(file.relativePath || file.name) === requestedKey
    ));
    if (!fileRecord) throw new Error("该路径未登记在此产出项中");
    target = safeRelative === "." ? root : path.resolve(root, safeRelative);
    if (target !== root && !isInside(root, target)) throw new Error("登记文件路径越界");
  } else if (!allowRoot) {
    throw new Error("必须指定已登记的单个文件");
  }

  if (requireExists && !fs.existsSync(target)) throw new Error("目标已不存在；产出项记录仍保留");
  if (requireExists) {
    const stat = fs.lstatSync(target);
    if (requireFile && !stat.isFile()) throw new Error("“删除”只适用于单个文件；文件夹请使用“删除项目”");
  }
  return { root, target, fileRecord };
}

function assertNoSymlinkEscape(root, target) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) throw new Error("为防止符号链接越界，不能操作此登记路径");
  const relative = path.relative(root, target);
  if (relative && (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))) {
    throw new Error("登记文件路径越界");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("为防止符号链接越界，不能操作符号链接");
  }
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  if (realTarget !== realRoot && !isInside(realRoot, realTarget)) throw new Error("符号链接目标超出产出项范围");
}

function previewImageDimensions(extension, bytes) {
  const fail = () => { throw httpError(415, "图片内容与扩展名不匹配，已拒绝预览"); };
  if (extension === ".png") {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") fail();
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 3 < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) fail();
      if (startOfFrame.has(marker)) {
        if (segmentLength < 7) fail();
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
    fail();
  }
  if (extension === ".gif") {
    const header = bytes.toString("ascii", 0, 6);
    if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(header)) fail();
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (extension === ".bmp") {
    if (bytes.length < 26 || bytes.toString("ascii", 0, 2) !== "BM") fail();
    const dibSize = bytes.readUInt32LE(14);
    if (dibSize === 12) return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) };
    if (dibSize < 40 || bytes.length < 26) fail();
    return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  }
  if (extension === ".webp") {
    if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") fail();
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height };
    }
    if (chunk === "VP8L") {
      if (bytes[20] !== 0x2f) fail();
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
    if (chunk === "VP8 ") {
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) fail();
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    fail();
  }
  fail();
}

function assertPreviewImageDimensions(dimensions) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw httpError(415, "无法确认图片尺寸，已拒绝预览");
  }
  if (width > MAX_IMAGE_PREVIEW_DIMENSION || height > MAX_IMAGE_PREVIEW_DIMENSION || width * height > MAX_IMAGE_PREVIEW_PIXELS) {
    throw httpError(413, `图片尺寸超过安全预览限制（最大 ${MAX_IMAGE_PREVIEW_DIMENSION}px/边、${MAX_IMAGE_PREVIEW_PIXELS} 像素）`);
  }
}

function decodePreviewText(bytes, fileWasTruncated) {
  let encoding = "utf-8";
  let content = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    content = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    content = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    content = bytes.subarray(2);
  } else if (bytes.includes(0)) {
    throw httpError(415, "文件看起来是二进制内容，不能按纯文本预览");
  }

  let decoded = null;
  const maxBoundaryTrim = fileWasTruncated ? (encoding === "utf-8" ? 3 : 1) : 0;
  for (let trim = 0; trim <= maxBoundaryTrim; trim += 1) {
    const end = content.length - trim;
    if (end < 0 || (encoding !== "utf-8" && end % 2 !== 0)) continue;
    try {
      decoded = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(content.subarray(0, end));
      break;
    } catch { }
  }
  if (decoded === null || decoded.includes("\u0000")) {
    throw httpError(415, "文本编码不受支持；仅支持 UTF-8 与带 BOM 的 UTF-16LE/BE");
  }

  let truncated = fileWasTruncated;
  let lineCount = 1;
  let endIndex = decoded.length;
  for (let index = 0; index < decoded.length; index += 1) {
    if (decoded[index] !== "\n") continue;
    lineCount += 1;
    if (lineCount > MAX_TEXT_PREVIEW_LINES) {
      endIndex = index + 1;
      lineCount = MAX_TEXT_PREVIEW_LINES;
      truncated = true;
      break;
    }
  }
  return { text: decoded.slice(0, endIndex), encoding, truncated, lineCount };
}

function readPreviewBytes(fileHandle, byteCount) {
  const bytes = Buffer.alloc(byteCount);
  let offset = 0;
  while (offset < byteCount) {
    const count = fs.readSync(fileHandle, bytes, offset, byteCount - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return offset === byteCount ? bytes : bytes.subarray(0, offset);
}

function previewRecordedFile(id, relativePath) {
  const item = findItemById(loadItems(), id);
  if (item.status === "已删除") throw httpError(409, "产出项已删除，不能预览文件");

  let resolved;
  try {
    resolved = resolveRecordedTarget(item, relativePath, { allowRoot: false, requireFile: true, requireExists: true });
    if (resolved.fileRecord?.status === "已删除") throw httpError(409, "文件已删除，不能预览");
    assertNoSymlinkEscape(resolved.root, resolved.target);
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    const message = error instanceof Error ? error.message : "文件不可预览";
    if (message.includes("不存在")) throw httpError(404, "文件已不存在或无法读取");
    throw httpError(400, message);
  }

  const extension = path.extname(resolved.fileRecord?.name || resolved.target).toLowerCase();
  const imageMimeType = IMAGE_PREVIEW_TYPES.get(extension);
  const isText = TEXT_PREVIEW_EXTENSIONS.has(extension);
  if (!imageMimeType && !isText) throw httpError(415, "该文件格式暂不支持安全预览");

  let fileHandle;
  try {
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    fileHandle = fs.openSync(resolved.target, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fileHandle);
    if (!before.isFile()) throw httpError(415, "只有普通文件可以预览");
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw httpError(415, "无法确认文件大小");
    if (imageMimeType && before.size > MAX_IMAGE_PREVIEW_BYTES) {
      throw httpError(413, `图片超过 ${MAX_IMAGE_PREVIEW_BYTES / 1024 / 1024} MiB 安全预览限制`);
    }

    const bytesToRead = imageMimeType ? before.size : Math.min(before.size, MAX_TEXT_PREVIEW_BYTES);
    const bytes = readPreviewBytes(fileHandle, bytesToRead);
    const after = fs.fstatSync(fileHandle);
    assertNoSymlinkEscape(resolved.root, resolved.target);
    if (bytes.length !== bytesToRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== after.dev || before.ino !== after.ino) {
      throw httpError(409, "文件在读取过程中发生变化，请重新预览");
    }

    const common = {
      name: resolved.fileRecord?.name || path.basename(resolved.target),
      relativePath: resolved.fileRecord?.relativePath || relativePath,
      sizeBytes: before.size,
      modifiedAt: new Date(before.mtimeMs).toISOString(),
    };
    if (imageMimeType) {
      const dimensions = previewImageDimensions(extension, bytes);
      assertPreviewImageDimensions(dimensions);
      return {
        preview: {
          ...common,
          kind: "image",
          mimeType: imageMimeType,
          width: dimensions.width,
          height: dimensions.height,
          truncated: false,
          bytesBase64: bytes.toString("base64"),
        },
      };
    }

    const decoded = decodePreviewText(bytes, before.size > bytes.length);
    return {
      preview: {
        ...common,
        kind: "text",
        mimeType: "text/plain; charset=utf-8",
        renderMode: "plain-text",
        inert: INERT_TEXT_EXTENSIONS.has(extension),
        encoding: decoded.encoding,
        truncated: decoded.truncated,
        lineCount: decoded.lineCount,
        text: decoded.text,
      },
    };
  } catch (error) {
    if (Number.isInteger(error?.statusCode)) throw error;
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) throw httpError(404, "文件已不存在或无法读取");
    if (["EACCES", "EPERM"].includes(error?.code)) throw httpError(403, "没有读取此文件的权限");
    throw error;
  } finally {
    if (fileHandle !== undefined) fs.closeSync(fileHandle);
  }
}

function assertNoReparseAncestors(target) {
  const resolved = path.resolve(target);
  const parsedRoot = path.parse(resolved).root;
  let current = parsedRoot;
  const segments = path.relative(parsedRoot, resolved).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("安全保护：登记路径或其祖先包含符号链接/目录联接");
  }
}

function canonicalExistingPath(value) {
  const resolved = path.resolve(String(value || ""));
  return fs.existsSync(resolved) ? path.resolve(fs.realpathSync(resolved)) : resolved;
}

function trustedScannerSources(item) {
  const sources = [];
  for (const version of Array.isArray(item.versions) ? item.versions : []) {
    if (version?.scanner?.automatic === true && version.source) sources.push(version.source);
  }
  if (item.discovery?.mode === "codex-session-scan" && item.discovery?.automatic === true && item.source?.scanner) {
    sources.push(item.source);
  }
  return sources;
}

function assertTrustedDeletionScope(item, target) {
  const canonicalTarget = canonicalExistingPath(target);
  const sources = trustedScannerSources(item);
  const codexManagedRoots = [
    path.join(CODEX_DATA_ROOT, "generated_images"),
    path.join(CODEX_DATA_ROOT, "visualizations"),
  ].filter((entry) => fs.existsSync(entry)).map(canonicalExistingPath);

  for (const source of sources) {
    if (source.pathScope === "workspace" && source.cwd && fs.existsSync(source.cwd)) {
      assertNoReparseAncestors(source.cwd);
      const canonicalWorkspace = canonicalExistingPath(source.cwd);
      if (canonicalTarget !== canonicalWorkspace && isInside(canonicalWorkspace, canonicalTarget)) return;
    }
    if (source.pathScope === "codex-managed") {
      if (codexManagedRoots.some((root) => canonicalTarget !== root && isInside(root, canonicalTarget))) return;
    }
  }
  throw new Error("安全保护：只有自动扫描确认且位于可信产出范围内的路径可以删除");
}

function assertSafeDeletionTarget(item, target) {
  const rawTarget = String(target || "");
  if (/^\\\\[?.]\\/.test(rawTarget) || rawTarget.startsWith("\\\\")) {
    throw new Error("安全保护：网络共享和 Windows 设备路径不支持回收站删除");
  }
  const resolved = path.resolve(target);
  assertNoReparseAncestors(resolved);
  assertTrustedDeletionScope(item, resolved);
  const canonicalTarget = canonicalExistingPath(resolved);
  const managedOutputRoots = [
    path.join(CODEX_DATA_ROOT, "generated_images"),
    path.join(CODEX_DATA_ROOT, "visualizations"),
  ].filter((entry) => fs.existsSync(entry)).map(canonicalExistingPath);
  const hardProtectedSubtrees = [
    DATA_ROOT,
    ROOT,
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
  ].filter(Boolean).map(canonicalExistingPath);
  if (hardProtectedSubtrees.some((root) => recordedInsideOrSame(root, canonicalTarget))) {
    throw new Error("安全保护：系统目录、扩展目录和扩展数据目录内的内容不可删除");
  }
  const canonicalCodexRoot = canonicalExistingPath(CODEX_DATA_ROOT);
  if (recordedInsideOrSame(canonicalCodexRoot, canonicalTarget)
    && !managedOutputRoots.some((root) => canonicalTarget !== root && isInside(root, canonicalTarget))) {
    throw new Error("安全保护：Codex 数据目录内仅允许删除自动生成图片或可视化产出");
  }
  const protectedRoots = [
    path.parse(canonicalTarget).root,
    os.homedir(),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "Pictures"),
    path.join(os.homedir(), "Videos"),
    path.join(os.homedir(), "Music"),
    path.join(os.homedir(), "OneDrive"),
    path.join(os.homedir(), "Documents", "Codex"),
    CODEX_DATA_ROOT,
    DATA_ROOT,
    ROOT,
    item.source?.cwd,
    ...trustedScannerSources(item).map((source) => source.cwd),
    process.env.OUTPUT_ITEMS_WORKSPACE_ROOT,
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
  ].filter(Boolean).map(canonicalExistingPath);
  if (protectedRoots.some((entry) => recordedInsideOrSame(canonicalTarget, entry))) {
    throw new Error("安全保护：禁止删除驱动器根目录、用户目录、工作区根目录或扩展自身目录");
  }
  assertNoSymlinkEscape(path.resolve(item.path), resolved);
}

function runChildProcess(command, args, { timeoutMs = 120_000, detached = false, windowsHide = true } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"], detached, windowsHide, shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    if (detached) {
      const timer = setTimeout(() => reject(new Error(`${command} 启动超时`)), Math.min(timeoutMs, 5000));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("spawn", () => { clearTimeout(timer); child.unref(); resolve({ code: 0, stdout: "", stderr: "" }); });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { if (stdout.length < 32_768) stdout += chunk; });
    child.stderr?.on("data", (chunk) => { if (stderr.length < 32_768) stderr += chunk; });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      child.kill();
      reject(new Error(`${command} 操作超时`));
    }, timeoutMs) : null;
    child.once("error", (error) => { if (timer) clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} 退出码 ${code}`));
    });
  });
}

async function launchExplorer(target) {
  const targetStat = fs.statSync(target);
  const isDirectory = targetStat.isDirectory();
  const targetDirectory = path.resolve(fs.realpathSync(isDirectory ? target : path.dirname(target)));
  if (process.env.NODE_ENV === "test" && process.env.OUTPUT_ITEMS_EXPLORER_MODE === "record") {
    const recordFile = process.env.OUTPUT_ITEMS_EXPLORER_RECORD_FILE;
    if (!recordFile) throw new Error("测试资源管理器记录文件未配置");
    fs.appendFileSync(recordFile, `${JSON.stringify({ target, isDirectory, targetDirectory, windowMutationAttempted: false })}\n`, "utf8");
    return {
      launched: true,
      foreground: false,
      foregroundAttempted: false,
      error: "测试记录模式未操作桌面窗口",
    };
  }
  if (process.platform !== "win32") {
    return { launched: false, foreground: false, foregroundAttempted: false, error: "打开位置仅支持 Windows 文件资源管理器" };
  }
  if (!fs.existsSync(OPEN_EXPLORER_SCRIPT)) {
    return { launched: false, foreground: false, foregroundAttempted: false, error: "文件资源管理器前置辅助脚本不存在" };
  }
  const args = isDirectory ? [target] : ["/select,", target];
  try {
    await runChildProcess("explorer.exe", args, { detached: true, windowsHide: false, timeoutMs: 5000 });
  } catch (error) {
    return {
      launched: false,
      foreground: false,
      foregroundAttempted: false,
      error: `无法启动 Windows 文件资源管理器：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const focusProcess = await runChildProcess("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", OPEN_EXPLORER_SCRIPT,
      "-LiteralDirectory", targetDirectory,
      "-TimeoutMilliseconds", "5000",
    ], { timeoutMs: 8000, windowsHide: true });
    const lines = String(focusProcess.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    let focus = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { focus = JSON.parse(lines[index]); break; } catch { }
    }
    if (!focus || typeof focus !== "object") throw new Error("前置辅助脚本没有返回有效结果");
    if (focus.foreground === true) {
      return { launched: true, foreground: true, foregroundAttempted: true, error: null };
    }
    const helperDetail = String(focus.helperMessage || "").trim().slice(0, 500);
    const error = focus.errorCode === "foreground-denied"
      ? "文件资源管理器已打开，但 Windows 拒绝把精确匹配的窗口切到前台"
      : focus.errorCode === "no-exact-window"
        ? "文件资源管理器已启动，但未找到与目标目录精确匹配的窗口"
        : `文件资源管理器已打开，但前置辅助程序失败${helperDetail ? `：${helperDetail}` : ""}`;
    return {
      launched: true,
      foreground: false,
      foregroundAttempted: focus.foregroundAttempted === true,
      error,
    };
  } catch (error) {
    return {
      launched: true,
      foreground: false,
      foregroundAttempted: false,
      error: `文件资源管理器已打开，但无法确认窗口已前置：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function recyclePath(target, allowedRoot) {
  if (process.env.NODE_ENV === "test" && process.env.OUTPUT_ITEMS_DELETE_MODE === "fixture-recycle") {
    const fixtureRoot = path.resolve(String(process.env.OUTPUT_ITEMS_TEST_DELETE_ROOT || ""));
    const resolved = path.resolve(target);
    if (!process.env.OUTPUT_ITEMS_TEST_DELETE_ROOT || (resolved !== fixtureRoot && !isInside(fixtureRoot, resolved))) {
      throw new Error("测试删除目标不在显式临时 fixture 根目录内");
    }
    if (normalizedRecordedPath(resolved) === normalizedRecordedPath(fixtureRoot)) {
      throw new Error("测试删除不得移除 fixture 根目录本身");
    }
    const recycleRoot = path.join(fixtureRoot, ".output-items-test-recycle");
    if (resolved === recycleRoot || isInside(resolved, recycleRoot)) throw new Error("测试删除目标不能包含 fixture 回收目录");
    fs.mkdirSync(recycleRoot, { recursive: true });
    const destination = path.join(recycleRoot, `${Date.now()}-${crypto.randomUUID()}-${path.basename(resolved)}`);
    fs.renameSync(resolved, destination);
    return "test-fixture-recycle";
  }
  if (process.platform !== "win32") throw new Error("移入回收站功能仅支持 Windows");
  if (!fs.existsSync(RECYCLE_SCRIPT)) throw new Error("回收站辅助脚本不存在");
  const protectedRootsJson = JSON.stringify([
    ROOT,
    DATA_ROOT,
    process.env.SystemRoot,
    process.env.WINDIR,
    process.env.ProgramData,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
  ].filter(Boolean));
  await runChildProcess("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", RECYCLE_SCRIPT,
    "-LiteralTarget", target,
    "-AllowedRoot", allowedRoot,
    "-ProtectedRootsJson", protectedRootsJson,
  ], { timeoutMs: 0 });
  if (fs.existsSync(target)) throw new Error("系统未能把目标移入回收站");
  return "windows-recycle-bin";
}

function deletedProjectShape(item, deletedAt, detail = "项目已移入 Windows 回收站；记录与历史版本仍保留") {
  return {
    ...item,
    ...itemSizeMetadataFromScan(null),
    updatedAt: deletedAt,
    meta: "路径缺失",
    status: "已删除",
    statusTone: "warning",
    statusDetail: detail,
    lastChecked: deletedAt,
    files: (Array.isArray(item.files) ? item.files : []).map((file) => ({
      ...file, status: "已删除", statusTone: "warning", detail: "文件随项目移入回收站", updated: deletedAt,
    })),
    activity: [{ time: deletedAt, title: "用户删除项目", detail, tone: "warning", source: item.source }, ...(item.activity || [])],
  };
}

async function openRecordedLocation(id, relativePath) {
  const item = findItemById(loadItems(), id);
  const { root, target } = resolveRecordedTarget(item, relativePath, { allowRoot: true, requireExists: true });
  assertNoReparseAncestors(target);
  assertNoSymlinkEscape(root, target);
  const launch = await launchExplorer(target);
  const isDirectory = fs.statSync(target).isDirectory();
  logEvent("item-location-opened", {
    id: item.id,
    path: target,
    action: isDirectory ? "open" : "select",
    launched: launch.launched === true,
    foreground: launch.foreground === true,
    error: launch.error || null,
  });
  return {
    itemId: item.id,
    path: target,
    targetType: isDirectory ? "directory" : "file",
    action: isDirectory ? "open" : "select",
    launched: launch.launched === true,
    foreground: launch.foreground === true,
    foregroundAttempted: launch.foregroundAttempted === true,
    ok: launch.foreground === true,
    error: launch.error || null,
  };
}

async function deleteRecordedFile(id, relativePath, confirm) {
  if (confirm !== true) throw new Error("删除本地文件需要显式确认 confirm:true");
  return withItemsLockAsync(async () => {
    const items = loadItems();
    const item = findItemById(items, id);
    const index = items.indexOf(item);
    const { target, fileRecord } = resolveRecordedTarget(item, relativePath, { allowRoot: false, requireFile: true, requireExists: true });
    assertSafeDeletionTarget(item, target);
    const adapter = await recyclePath(target, item.path);
    const deletedAt = nowText();
    const targetKey = normalizedRelativePath(fileRecord.relativePath || fileRecord.name);
    const previousFiles = Array.isArray(item.files) ? item.files : [];
    const scanned = fs.existsSync(item.path) ? scanOutputTree(item.path) : null;
    const previousByPath = new Map(previousFiles.map((file) => [normalizedRelativePath(file.relativePath || file.name), file]));
    const scannedPaths = new Set((scanned?.files || []).map((file) => normalizedRelativePath(file.relativePath || file.name)));
    const refreshedFiles = [
      ...(scanned?.files || []).map((file) => mergeMigratedFileRecord(file, previousByPath.get(normalizedRelativePath(file.relativePath || file.name)))),
      ...previousFiles.filter((file) => !scannedPaths.has(normalizedRelativePath(file.relativePath || file.name))),
    ];
    const files = refreshedFiles.map((file) => (
      normalizedRelativePath(file.relativePath || file.name) === targetKey
        ? { ...file, status: "已删除", statusTone: "warning", detail: "用户已将文件移入回收站", updated: deletedAt }
        : file
    ));
    const remaining = files.filter((file) => file.status !== "已删除").length;
    const itemSizeMetadata = remaining
      ? itemSizeMetadataFromScan(scanned)
      : itemSizeMetadataFromScan(null);
    const nextItem = {
      ...item,
      ...itemSizeMetadata,
      updatedAt: deletedAt,
      fileMetadataVersion: FILE_METADATA_VERSION,
      files,
      meta: scanned ? `${scanned.totalEntryCount} 个文件` : "路径缺失",
      status: remaining ? "部分文件已删除" : "已删除",
      statusTone: "warning",
      statusDetail: remaining ? "部分登记文件已移入回收站；记录与历史版本仍保留" : "登记文件已移入回收站；记录与历史版本仍保留",
      lastChecked: deletedAt,
      activity: [{ time: deletedAt, title: "用户删除文件", detail: `${fileRecord.name || relativePath} 已移入回收站；历史记录仍保留。`, tone: "warning", source: item.source }, ...(item.activity || [])],
    };
    items[index] = nextItem;
    saveItems(items);
    logEvent("item-file-recycled", { id: item.id, path: target, relativePath: fileRecord.relativePath || fileRecord.name, adapter });
    return { item: nextItem, deleted: { path: target, relativePath: fileRecord.relativePath || fileRecord.name, recovery: adapter === "windows-recycle-bin" ? "recycle-bin" : "test-fixture" } };
  });
}

async function batchDeleteProjects(idsValue, confirm) {
  if (confirm !== true) throw new Error("批量删除本地项目需要显式确认 confirm:true");
  const ids = validateBatchIds(idsValue);
  return withItemsLockAsync(async () => {
    const items = loadItems();
    const candidates = [];
    const resultsById = new Map();
    for (const id of ids) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) { resultsById.set(id, { id, ok: false, error: `未找到产出项：${id}` }); continue; }
      try {
        const { target } = resolveRecordedTarget(item, undefined, { allowRoot: true, requireExists: true });
        assertSafeDeletionTarget(item, target);
        candidates.push({ id, item, target });
      } catch (error) {
        resultsById.set(id, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    candidates.sort((left, right) => normalizedRecordedPath(left.target).length - normalizedRecordedPath(right.target).length);
    const successfulRoots = [];
    for (const candidate of candidates) {
      const coveredBy = successfulRoots.find((entry) => recordedInsideOrSame(entry.target, candidate.target));
      if (coveredBy) {
        const deletedAt = nowText();
        const index = items.findIndex((item) => item.id === candidate.id);
        items[index] = deletedProjectShape(items[index], deletedAt, `项目随已选择的上级产出项“${coveredBy.item.title}”移入回收站；记录与历史版本仍保留`);
        resultsById.set(candidate.id, { id: candidate.id, ok: true, coveredBy: coveredBy.id, path: candidate.target, recovery: "recycle-bin" });
        continue;
      }
      try {
        const adapter = await recyclePath(candidate.target, candidate.item.path);
        const deletedAt = nowText();
        const index = items.findIndex((item) => item.id === candidate.id);
        items[index] = deletedProjectShape(items[index], deletedAt);
        successfulRoots.push(candidate);
        resultsById.set(candidate.id, { id: candidate.id, ok: true, path: candidate.target, recovery: adapter === "windows-recycle-bin" ? "recycle-bin" : "test-fixture" });
        logEvent("item-project-recycled", { id: candidate.id, path: candidate.target, adapter });
      } catch (error) {
        resultsById.set(candidate.id, { id: candidate.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if ([...resultsById.values()].some((result) => result.ok)) saveItems(items);
    const results = ids.map((id) => resultsById.get(id));
    return {
      results,
      succeeded: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      items: ids.map((id) => items.find((item) => item.id === id)).filter(Boolean),
    };
  });
}

async function deleteRecordedProject(id, confirm) {
  const safeId = validateItemId(id);
  const result = await batchDeleteProjects([safeId], confirm);
  const first = result.results[0];
  if (!first?.ok) throw new Error(first?.error || "删除项目失败");
  return { item: result.items.find((item) => item.id === safeId), deleted: first };
}

function setPriority(id, priorityValue) {
  const priority = validatePriority(priorityValue);
  const item = updateItem(id, (current) => {
    if ((current.priority || "none") === priority) return { ...current, priority };
    return {
      ...current,
      priority,
      activity: [{ time: nowText(), title: "优先级更新", detail: `优先级设为 ${priority}。`, tone: "neutral", source: current.source }, ...(current.activity || [])],
    };
  });
  logEvent("item-priority-updated", { id: item.id, priority });
  return item;
}

function batchSetPriority(idsValue, priorityValue) {
  const ids = validateBatchIds(idsValue);
  const priority = validatePriority(priorityValue);
  return withItemsLock(() => {
    const items = loadItems();
    const results = ids.map((id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return { id, ok: false, error: `未找到产出项：${id}` };
      const current = items[index];
      items[index] = (current.priority || "none") === priority ? { ...current, priority } : {
        ...current, priority,
        activity: [{ time: nowText(), title: "优先级更新", detail: `优先级设为 ${priority}。`, tone: "neutral", source: current.source }, ...(current.activity || [])],
      };
      return { id, ok: true, priority };
    });
    if (results.some((result) => result.ok)) saveItems(items);
    logEvent("items-priority-updated", { ids, priority, succeeded: results.filter((result) => result.ok).length });
    return { results, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, priority };
  });
}

function batchDetect(idsValue, mode = "quick") {
  const ids = validateBatchIds(idsValue);
  if (!["quick", "full", "custom"].includes(mode)) throw new Error("不支持的检测模式");
  return withItemsLock(() => {
    const items = loadItems();
    const results = ids.map((id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return { id, ok: false, error: `未找到产出项：${id}` };
      try {
        const detected = detectItem(items[index], mode);
        items[index] = detected.item;
        return { id, ok: true, item: detected.item, result: detected.result };
      } catch (error) {
        return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    if (results.some((result) => result.ok)) saveItems(items);
    logEvent("items-batch-detected", { ids, mode, succeeded: results.filter((result) => result.ok).length });
    return { results, succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length };
  });
}

function normalizedRecordedPath(value) {
  try {
    return path.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase();
  } catch {
    return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
  }
}

function recordedInsideOrSame(root, candidate) {
  return normalizedRecordedPath(root) === normalizedRecordedPath(candidate) || isInside(path.resolve(root), path.resolve(candidate));
}

function sourceTimeValue(value) {
  if (!value) return 0;
  const text = String(value);
  const normalizedText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}+08:00` : text;
  const parsed = Date.parse(normalizedText);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextScannerVersion(versions) {
  const integers = versions.map((entry) => /^v(\d+)$/.exec(String(entry.version || "")))
    .filter(Boolean).map((match) => Number(match[1])).filter(Number.isFinite);
  return `v${integers.length ? Math.max(...integers) + 1 : versions.length + 1}`;
}

function scannerPathScope(target, cwd) {
  if (cwd && recordedInsideOrSame(cwd, target)) return "workspace";
  if (recordedInsideOrSame(path.join(CODEX_DATA_ROOT, "generated_images"), target)
    || recordedInsideOrSame(path.join(CODEX_DATA_ROOT, "visualizations"), target)) return "codex-managed";
  return "external";
}

function scannerItemTitle(group, isFolder) {
  if (recordedInsideOrSame(path.join(CODEX_DATA_ROOT, "generated_images"), group.path)) {
    return `${group.task} · 生成图片`;
  }
  if (recordedInsideOrSame(path.join(CODEX_DATA_ROOT, "visualizations"), group.path)) {
    return `${group.task} · 可视化`;
  }
  return path.basename(group.path) || (isFolder ? "Codex 产出文件夹" : "Codex 产出文件");
}

function scannerItemShape(target, group) {
  const exists = fs.existsSync(target);
  let isFolder = group.evidencePaths.length > 1;
  if (exists) {
    try { isFolder = fs.statSync(target).isDirectory(); } catch { }
  } else if (path.extname(target)) {
    isFolder = false;
  }
  const extension = path.extname(target).toLowerCase();
  const isImageFolder = isFolder && recordedInsideOrSame(path.join(CODEX_DATA_ROOT, "generated_images"), target);
  const type = isFolder ? (isImageFolder ? "图片文件夹" : "程序文件夹") : `${extension.slice(1).toUpperCase() || "普通"} 文件`;
  const category = isFolder ? (isImageFolder ? "图片" : "程序") : STANDALONE_FILE_CATEGORY.get(extension) || "文档";
  return { exists, isFolder, type, category };
}

const STANDALONE_FILE_CATEGORY = new Map([
  [".png", "图片"], [".jpg", "图片"], [".jpeg", "图片"], [".webp", "图片"], [".gif", "图片"], [".svg", "图片"],
  [".mp3", "媒体"], [".wav", "媒体"], [".mp4", "媒体"], [".mov", "媒体"],
]);

function scannerFiles(target, previousFiles, evidencePaths, exists, deletedPaths = [], scanned = null) {
  const previous = Array.isArray(previousFiles) ? previousFiles : [];
  if (exists) {
    const discovered = (scanned || scanOutputTree(target)).files;
    const previousByPath = new Map(previous.map((file) => [file.relativePath || file.name, file]));
    const files = discovered.map((file) => ({ ...(previousByPath.get(file.relativePath || file.name) || {}), ...file }));
    const discoveredPaths = new Set(files.map((file) => file.relativePath || file.name));
    for (const previousFile of previous) {
      const previousPath = previousFile.relativePath || previousFile.name;
      if (previousFile.status === "已删除" && !discoveredPaths.has(previousPath)) files.push(previousFile);
    }
    const missingDeletes = deletedPaths.filter((deletedPath) => !fs.existsSync(deletedPath));
    for (const deletedPath of missingDeletes) {
      let relativePath = path.relative(target, deletedPath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) relativePath = path.basename(deletedPath);
      const existingIndex = files.findIndex((file) => (file.relativePath || file.name) === relativePath);
      const deletedFile = {
        ...(existingIndex >= 0 ? files[existingIndex] : {}),
        name: path.basename(deletedPath),
        relativePath,
        label: path.extname(deletedPath).slice(1).toUpperCase() || "文件",
        kind: existingIndex >= 0 ? files[existingIndex].kind : fileKind(deletedPath),
        status: "已删除",
        statusTone: "warning",
        detail: "Codex 任务记录确认该文件已删除；历史版本仍保留",
        updated: nowText(),
        sizeBytes: existingIndex >= 0 ? files[existingIndex].sizeBytes : null,
        directChildCount: existingIndex >= 0 ? files[existingIndex].directChildCount : 0,
        descendantCount: existingIndex >= 0 ? files[existingIndex].descendantCount : 0,
        aggregationComplete: existingIndex >= 0 ? files[existingIndex].aggregationComplete === true : false,
      };
      if (existingIndex >= 0) files[existingIndex] = deletedFile;
      else files.push(deletedFile);
    }
    return files;
  }
  const timestamp = nowText();
  const evidence = [...new Set(evidencePaths)].map((evidencePath) => {
    let relativePath = ".";
    try {
      const relative = path.relative(target, evidencePath);
      relativePath = relative && !relative.startsWith("..") ? relative : ".";
    } catch { }
    return {
      name: path.basename(evidencePath || target),
      relativePath,
      label: path.extname(evidencePath).slice(1).toUpperCase() || "文件",
      kind: fileKind(evidencePath),
      status: "已删除",
      statusTone: "warning",
      detail: "任务记录中存在产出证据，但当前路径已不存在",
      updated: timestamp,
      sizeBytes: null,
      directChildCount: 0,
      descendantCount: 0,
      aggregationComplete: false,
    };
  });
  return evidence.length ? evidence : previous;
}

function scannerInitialStatus(shape, scope) {
  if (!shape.exists) return { status: "已删除", statusTone: "warning", statusDetail: "任务记录中存在产出证据，但当前路径已不存在" };
  if (scope === "external") return { status: "工作区外", statusTone: "neutral", statusDetail: "产出位于来源工作区之外；只记录路径，不移动或执行文件" };
  return { status: "未检测", statusTone: "neutral", statusDetail: "已由自动抓取发现；尚未执行状态检测" };
}

function applyScannedArtifacts(groups, { reconcile = false, taskCatalog = null } = {}) {
  return withItemsLock(() => {
    const items = loadItems();
    let changed = false;
    const counts = { added: 0, updated: 0, unchanged: 0, missing: 0 };

    for (const group of groups) {
      const discoveredTarget = path.resolve(group.path);
      const existingAncestor = items.filter((item) => {
        if (item.discovery?.mode !== "codex-session-scan") return false;
        if (normalizedRecordedPath(item.path) === normalizedRecordedPath(discoveredTarget)) return false;
        if (!recordedInsideOrSame(item.path, discoveredTarget)) return false;
        try { return fs.existsSync(item.path) ? fs.statSync(item.path).isDirectory() : String(item.type || "").includes("文件夹"); }
        catch { return String(item.type || "").includes("文件夹"); }
      }).sort((left, right) => normalizedRecordedPath(right.path).length - normalizedRecordedPath(left.path).length)[0];
      const target = path.resolve(existingAncestor?.path || discoveredTarget);
      const targetKey = normalizedRecordedPath(target);
      const shape = scannerItemShape(target, group);
      const exact = items.filter((item) => normalizedRecordedPath(item.path) === targetKey);
      const absorbed = shape.isFolder ? items.filter((item) => (
        item.discovery?.mode === "codex-session-scan"
        && normalizedRecordedPath(item.path) !== targetKey
        && recordedInsideOrSame(target, item.path)
      )) : [];
      const matching = [...new Set([...exact, ...absorbed])];
      const previous = matching.reduce((best, item) => {
        if (!best) return item;
        return (item.versions?.length || 0) > (best.versions?.length || 0) ? item : best;
      }, null);
      const versions = matching.flatMap((item) => Array.isArray(item.versions) ? item.versions : []);
      const activities = matching.flatMap((item) => Array.isArray(item.activity) ? item.activity : []);
      const existingVersionIndex = versions.findIndex((entry) => entry.scanner?.key === group.versionKey);
      const source = {
        project: group.project || "Codex",
        task: group.task,
        threadId: group.threadId,
        created: dateText(group.lastAt),
        cwd: group.cwd || null,
        turnId: group.turnId || null,
        pathScope: scannerPathScope(target, group.cwd),
        scanner: {
          producerThreadId: group.producerThreadIds?.[0] || group.threadId,
          producerThreadIds: group.producerThreadIds || [group.threadId],
          agentPaths: group.agentPaths || [],
        },
      };
      const taskGroup = taskGroupFromSource(source);
      const missingDeletedPaths = (group.deletedPaths || []).filter((deletedPath) => !fs.existsSync(deletedPath));
      const rootDeleted = !shape.exists || missingDeletedPaths.some((deletedPath) => normalizedRecordedPath(deletedPath) === targetKey);
      const partiallyDeleted = !rootDeleted && missingDeletedPaths.length > 0;
      const currentVersion = versions.find((entry) => entry.current) || versions[0];
      const isNewest = !currentVersion || sourceTimeValue(group.lastAt) >= sourceTimeValue(currentVersion.time);
      const evidenceIds = new Set(group.evidenceIds);
      let versionChanged = false;
      let nextVersions;
      let versionName;

      if (existingVersionIndex >= 0) {
        const existingVersion = versions[existingVersionIndex];
        const previousEvidence = new Set(existingVersion.scanner?.evidenceIds || []);
        for (const evidenceId of evidenceIds) previousEvidence.add(evidenceId);
        const evidencePaths = [...new Set([...(existingVersion.scanner?.evidencePaths || []), ...group.evidencePaths])];
        versionChanged = previousEvidence.size !== (existingVersion.scanner?.evidenceIds || []).length
          || evidencePaths.length !== (existingVersion.scanner?.evidencePaths || []).length;
        const replacement = {
          ...existingVersion,
          time: dateText(group.lastAt),
          status: rootDeleted ? "记录删除" : shape.exists ? "快照可用" : "仅保留记录",
          source,
          scanner: {
            ...(existingVersion.scanner || {}),
            key: group.versionKey,
            automatic: true,
            evidenceIds: [...previousEvidence],
            evidencePaths,
            kinds: [...new Set([...(existingVersion.scanner?.kinds || []), ...group.kinds])],
          },
        };
        versionName = replacement.version;
        nextVersions = versions.map((entry, index) => index === existingVersionIndex ? replacement : entry);
      } else {
        versionName = nextScannerVersion(versions);
        const versionRecord = {
          version: versionName,
          current: isNewest,
          time: dateText(group.lastAt),
          note: `自动从 Codex 任务记录抓取（${group.evidencePaths.length} 个文件证据）`,
          status: rootDeleted ? "记录删除" : shape.exists ? "快照可用" : "仅保留记录",
          source,
          scanner: {
            key: group.versionKey,
            automatic: true,
            evidenceIds: [...evidenceIds],
            evidencePaths: group.evidencePaths,
            kinds: group.kinds,
          },
        };
        nextVersions = [
          versionRecord,
          ...versions.map((entry) => isNewest ? { ...entry, current: false } : entry),
        ];
        versionChanged = true;
      }

      const preservedMark = matching.find((item) => item.mark && item.mark !== "待确认")?.mark || previous?.mark || "待确认";
      const initial = rootDeleted
        ? { status: "已删除", statusTone: "warning", statusDetail: "Codex 任务记录确认该产出路径已删除；来源与历史版本仍保留" }
        : partiallyDeleted
          ? { status: "部分文件已删除", statusTone: "warning", statusDetail: `${missingDeletedPaths.length} 个文件已删除；来源与历史版本仍保留` }
          : scannerInitialStatus(shape, source.pathScope);
      const scanned = shape.exists ? scanOutputTree(target) : null;
      const files = scannerFiles(target, previous?.files, group.evidencePaths, shape.exists, missingDeletedPaths, scanned);
      const itemSizeMetadata = itemSizeMetadataFromScan(scanned);
      const activityKey = `scanner:${group.versionKey}`;
      const hasActivity = activities.some((entry) => entry.scannerKey === activityKey);
      const nextActivity = hasActivity ? activities : [{
        time: dateText(group.lastAt),
        title: rootDeleted || partiallyDeleted ? `自动抓取 Codex 删除记录 ${versionName}` : `自动抓取 Codex 产出 ${versionName}`,
        detail: `从来源任务记录确认 ${group.evidencePaths.length} 个文件证据${missingDeletedPaths.length ? `，其中 ${missingDeletedPaths.length} 个已删除` : ""}。`,
        tone: rootDeleted || partiallyDeleted ? "warning" : "accent",
        source,
        scannerKey: activityKey,
      }, ...activities];
      const nextItem = {
        ...(previous || {}),
        id: previous?.id || `output-${crypto.createHash("sha256").update(target.toLowerCase()).digest("hex").slice(0, 16)}`,
        title: previous?.title || scannerItemTitle(group, shape.isFolder),
        type: previous?.type || shape.type,
        category: previous?.category || shape.category,
        version: isNewest ? versionName : previous?.version || currentVersion?.version || versionName,
        meta: scanned ? `${scanned.totalEntryCount} 个文件` : "路径缺失",
        time: isNewest ? dateText(group.lastAt) : previous?.time || dateText(group.lastAt),
        updatedAt: isNewest && versionChanged
          ? dateText(group.lastAt)
          : previous?.updatedAt || currentVersion?.time || dateText(group.lastAt),
        description: previous?.description || "由产出项自动扫描 Codex 本地任务记录发现。",
        path: target,
        ...(previous && !(isNewest && (rootDeleted || partiallyDeleted)) ? {} : initial),
        mark: preservedMark,
        priority: PRIORITIES.has(previous?.priority) ? previous.priority : "none",
        source: isNewest ? source : previous?.source || source,
        taskGroup: isNewest ? taskGroup : taskGroupForItem(previous || { source }),
        fileMetadataVersion: FILE_METADATA_VERSION,
        ...itemSizeMetadata,
        files,
        versions: nextVersions,
        activity: nextActivity,
        discovery: {
          ...(previous?.discovery || {}),
          mode: "codex-session-scan",
          automatic: true,
          firstSeenAt: previous?.discovery?.firstSeenAt || new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      };
      const sizeMetadataChanged = previous?.sizeBytes !== nextItem.sizeBytes
        || previous?.sizeAggregationComplete !== nextItem.sizeAggregationComplete;
      const positions = matching.map((item) => items.indexOf(item)).filter((index) => index >= 0);
      const insertAt = positions.length ? Math.min(...positions) : 0;
      for (const index of positions.sort((left, right) => right - left)) items.splice(index, 1);
      items.splice(insertAt, 0, nextItem);
      if (!previous) counts.added += 1;
      else if (versionChanged || absorbed.length || !hasActivity || sizeMetadataChanged) counts.updated += 1;
      else counts.unchanged += 1;
      changed = changed || !previous || versionChanged || absorbed.length > 0 || !hasActivity || sizeMetadataChanged;
    }

    if (reconcile) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.discovery?.mode !== "codex-session-scan") continue;
        const exists = fs.existsSync(item.path);
        if (!exists) {
          counts.missing += 1;
          if (item.status !== "已删除") {
            items[index] = {
              ...item,
              ...itemSizeMetadataFromScan(null),
              updatedAt: nowText(),
              status: "已删除",
              statusTone: "warning",
              statusDetail: "登记路径已不存在；来源、人工标记和版本历史均已保留",
              files: (Array.isArray(item.files) ? item.files : []).map((file) => ({
                ...file, status: "已删除", statusTone: "warning", updated: nowText(),
              })),
            };
            counts.updated += 1;
            changed = true;
          }
        } else if (item.status === "已删除") {
          const scope = scannerPathScope(item.path, item.source?.cwd);
          const initial = scannerInitialStatus({ exists: true }, scope);
          const scanned = scanOutputTree(item.path);
          items[index] = {
            ...item,
            ...initial,
            ...itemSizeMetadataFromScan(scanned),
            updatedAt: nowText(),
            files: scannerFiles(item.path, item.files, [], true, [], scanned),
          };
          counts.updated += 1;
          changed = true;
        }
      }

      const metadataUpdates = syncTaskCatalogMetadata(items, taskCatalog);
      if (metadataUpdates > 0) {
        counts.updated += metadataUpdates;
        changed = true;
      }
    }

    if (changed) saveItems(items);
    return counts;
  });
}

const outputScanner = createCodexOutputScanner({
  codexDataRoot: CODEX_DATA_ROOT,
  stateFile: SCAN_STATE_FILE,
  excludedRoots: [DATA_ROOT],
  logEvent,
  applyArtifacts: applyScannedArtifacts,
});

function updateGitHubPublication(itemId, publication) {
  return updateItem(itemId, (current) => {
    const uploadedAt = publication.uploadedAt || new Date().toISOString();
    const record = {
      repository: publication.repository,
      repositoryUrl: publication.repositoryUrl,
      visibility: publication.visibility,
      branch: publication.branch,
      baseBranch: publication.baseBranch,
      commit: publication.commit,
      pullRequestUrl: publication.pullRequestUrl || null,
      publishMode: publication.publishMode,
      branchProtection: publication.branchProtection || { requested: false, applied: false, warning: null },
      warnings: Array.isArray(publication.warnings) ? publication.warnings.slice(0, 100) : [],
      uploadedAt,
    };
    return {
      ...current,
      githubPublication: record,
      githubPublications: [record, ...(Array.isArray(current.githubPublications) ? current.githubPublications : [])].slice(0, 20),
      activity: [{
        time: dateText(uploadedAt), title: "上传个人 GitHub 完成",
        detail: record.warnings.length
          ? `${record.repository} · 已上传，但有 ${record.warnings.length} 项警告`
          : `${record.repository} · ${record.branch} · ${String(record.commit || "").slice(0, 8)}`,
        tone: record.warnings.length ? "warning" : "success", source: current.source, github: record,
      }, ...(Array.isArray(current.activity) ? current.activity : [])],
    };
  });
}

const githubPublisher = createGitHubPublisher({
  dataRoot: DATA_ROOT,
  getItem: (itemId) => withItemsLock(() => findItemById(loadItems(), itemId)),
  updateItemPublication: updateGitHubPublication,
  logEvent,
  adapter: process.env.NODE_ENV === "test" && process.env.OUTPUT_ITEMS_GITHUB_ADAPTER === "fake"
    ? createFakeGitHubAdapter({ login: process.env.OUTPUT_ITEMS_GITHUB_FAKE_LOGIN || "fixture-user", delayMs: Number(process.env.OUTPUT_ITEMS_GITHUB_FAKE_DELAY_MS || 0) })
    : undefined,
});

function publicScanStatus() {
  const internal = outputScanner.status();
  const running = internal.running === true || ["scheduled", "scanning"].includes(internal.phase);
  const failed = internal.phase === "error";
  const completed = internal.lastScan || (internal.completedAt ? internal : null);
  const counters = running ? internal : completed || internal;
  const state = failed ? "error" : running ? "running" : completed ? "complete" : "idle";
  const message = failed
    ? `扫描失败：${internal.lastError || "未知错误"}`
    : running
      ? `正在后台扫描 Codex 任务记录（${internal.filesScanned || 0}/${internal.filesTotal || 0}）`
      : completed
        ? `扫描完成：新增 ${counters.added || 0} 项，更新 ${counters.updated || 0} 项`
        : "尚未开始扫描";
  return {
    ...internal,
    state,
    finishedAt: completed?.completedAt || internal.completedAt || null,
    scannedTasks: Number(counters.filesScanned || 0),
    imported: Number(counters.added || 0),
    updated: Number(counters.updated || 0),
    skipped: Number(counters.skippedRecords || 0) + Number(counters.unchanged || 0),
    message,
  };
}

async function registerItem(args, { allowUnknownThread = false } = {}) {
  const target = path.resolve(String(args.path));
  const requestedThreadId = String(args.threadId || "").trim().toLowerCase();
  const threadId = THREAD_ID_PATTERN.test(requestedThreadId) ? requestedThreadId : null;
  if (!threadId && !allowUnknownThread) throw new Error("来源任务 ID 必须是有效 UUID");
  const taskGroup = threadId
    ? await outputScanner.resolveTaskGroup({
      threadId,
      title: args.task,
      project: args.project,
      projectKind: "manual",
    })
    : localInstallTaskGroup();
  return withItemsLock(() => {
    const items = loadItems();
    const id = `output-${crypto.createHash("sha256").update(target.toLowerCase()).digest("hex").slice(0, 16)}`;
    const created = nowText();
    const targetKey = normalizedRecordedPath(target);
    const matchingItems = items.filter((item) => item.id === id || normalizedRecordedPath(item.path) === targetKey);
    const previous = matchingItems.reduce((best, item) => {
      if (!best) return item;
      return (item.versions?.length || 0) > (best.versions?.length || 0) ? item : best;
    }, null);
    const previousVersions = matchingItems.flatMap((item) => Array.isArray(item.versions) ? item.versions : []);
    const previousActivity = matchingItems.flatMap((item) => Array.isArray(item.activity) ? item.activity : []);
    const exists = fs.existsSync(target);
    const isFolder = exists ? fs.statSync(target).isDirectory() : path.extname(target) === "";
    const scanned = exists ? scanOutputTree(target) : null;
    const source = threadId
      ? { project: args.project, task: args.task, threadId, created }
      : selfRegistrationSource(created, { threadId: null });
    const version = args.version || (previousVersions.length ? `v${previousVersions.length + 1}` : "v1");
    const versionRecord = { version, current: true, time: created, note: args.description || "Codex 登记新产出", status: exists ? "快照可用" : "仅保留记录", source };
    const preservedMark = matchingItems.find((item) => item.mark && item.mark !== "待确认")?.mark || previous?.mark || "待确认";
    const nextItem = {
      ...(previous || {}), id, title: args.title, type: isFolder ? "程序文件夹" : `${path.extname(target).slice(1).toUpperCase() || "普通"} 文件`,
      category: isFolder ? "程序" : "文档", version, meta: scanned ? `${scanned.totalEntryCount} 个文件` : "路径缺失", time: "刚刚",
      description: args.description || previous?.description || "由 Codex 登记的产出项。", path: target, updatedAt: created,
      status: "未检测", statusTone: "neutral", statusDetail: "尚未执行状态检测", lastChecked: "—",
      mark: preservedMark, priority: PRIORITIES.has(previous?.priority) ? previous.priority : "none", source, taskGroup, files: scanned?.files || [],
      fileMetadataVersion: FILE_METADATA_VERSION,
      ...itemSizeMetadataFromScan(scanned),
      versions: [versionRecord, ...previousVersions.filter((entry) => entry.version !== version).map((entry) => ({ ...entry, current: false }))],
      activity: [{ time: created, title: `Codex 产出新版本 ${version}`, detail: args.description || "登记新产出。", tone: "accent", source }, ...previousActivity.filter((entry) => entry.title !== `Codex 产出新版本 ${version}`)],
    };
    const remainingItems = items.filter((item) => item.id !== id && normalizedRecordedPath(item.path) !== targetKey);
    remainingItems.unshift(nextItem);
    saveItems(remainingItems);
    logEvent("item-registered", { id, path: target, threadId, taskGroup: taskGroup.key, version });
    return nextItem;
  });
}

async function registerSelfItem(args = {}) {
  const requestedThreadId = RUNTIME_CODEX_THREAD_ID
    || normalizedRuntimeThreadId(args.threadId)
    || RUNTIME_EXPLICIT_THREAD_ID
    || null;
  return registerItem({
    path: ROOT,
    title: "产出项本地扩展",
    project: String(args.project || "产出项").trim().slice(0, 240) || "产出项",
    task: String(args.task || "安装产出项本地扩展").trim().slice(0, 240) || "安装产出项本地扩展",
    ...(THREAD_ID_PATTERN.test(requestedThreadId) ? { threadId: requestedThreadId } : {}),
    version: String(args.version || "v1.0.0").trim().slice(0, 80) || "v1.0.0",
    description: String(args.description || "登记产出项本地扩展。").trim().slice(0, 1000),
  }, { allowUnknownThread: true });
}

function inlineDashboardHtml() {
  const indexPath = path.join(UI_ROOT, "index.html");
  let html = fs.readFileSync(indexPath, "utf8");
  const loadAsset = (reference) => {
    const relative = reference.replace(/^\/+/, "").replaceAll("/", path.sep);
    const resolved = path.resolve(UI_ROOT, relative);
    if (!resolved.startsWith(path.resolve(UI_ROOT) + path.sep)) throw new Error("界面资源路径越界");
    return fs.readFileSync(resolved, "utf8");
  };
  html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/i, (_, href) => `<style>${loadAsset(href)}</style>`);
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i, (_, src) => `<script type="module">${loadAsset(src).replace(/<\/script/gi, "<\\/script")}</script>`);
  return html.replace("<title>Prototype</title>", "<title>产出项</title>");
}

function toolResult(structuredContent, text = "操作完成。", meta = APP_TOOL_META) {
  return { content: [{ type: "text", text }], structuredContent, _meta: meta };
}

async function callTool(name, args = {}) {
  if (name === "open_output_items" || name === "list_output_items") {
    outputScanner.maybeStart(`mcp-${name}`);
    return toolResult({ items: listItemsForDisplay(), scan: publicScanStatus(), dataDirectory: DATA_ROOT, generatedAt: new Date().toISOString() }, name === "open_output_items" ? "已打开产出项工作台。" : "已读取产出项。", name === "open_output_items" ? ENTRY_UI_META : APP_TOOL_META);
  }
  if (name === "scan_output_items") {
    outputScanner.start("mcp-manual", { force: args.force === true });
    return toolResult({ scan: publicScanStatus() }, "已在后台开始扫描 Codex 产出项。", APP_MODEL_TOOL_META);
  }
  if (name === "detect_output_item") {
    let result;
    const item = updateItem(String(args.id || ""), (current) => {
      result = detectItem(current, args.mode || "quick");
      return result.item;
    });
    logEvent("item-detected", { id: item.id, status: item.status, mode: args.mode || "quick" });
    return toolResult({ item, result: result.result }, `检测完成：${item.status}`);
  }
  if (name === "mark_output_item") {
    if (!MARKS.has(args.mark)) throw new Error("不支持的人工标记");
    const item = updateItem(String(args.id || ""), (current) => ({
      ...current, mark: args.mark,
      activity: [{ time: nowText(), title: "用户标记更新", detail: `标记为“${args.mark}”${args.note ? `：${args.note}` : "。"}`, tone: "neutral", source: current.source }, ...current.activity],
    }));
    logEvent("item-marked", { id: item.id, mark: args.mark });
    return toolResult({ item }, `已标记为“${args.mark}”。`);
  }
  if (name === "register_output_item") {
    const item = await registerItem(args);
    return toolResult({ item }, `已登记产出项“${item.title}”。`, APP_MODEL_TOOL_META);
  }
  if (name === "open_output_item_location") {
    const opened = await openRecordedLocation(args.id, args.relativePath);
    const successText = opened.action === "select" ? "已在前台文件资源管理器中选中文件。" : "已在前台文件资源管理器中打开目录。";
    const failureText = opened.launched
      ? `文件资源管理器已打开，但未能确认前置：${opened.error}`
      : `文件资源管理器未能打开：${opened.error}`;
    return toolResult({ opened, ok: opened.ok, error: opened.error }, opened.ok ? successText : failureText);
  }
  if (name === "preview_output_item_file") {
    const preview = previewRecordedFile(args.id, args.relativePath);
    return toolResult(preview, preview.preview.kind === "image" ? "已安全读取图片预览。" : "已安全读取纯文本预览。");
  }
  if (name === "delete_output_item_file") {
    const deleted = await deleteRecordedFile(args.id, args.relativePath, args.confirm);
    return toolResult(deleted, "文件已移入回收站；产出项记录与版本历史已保留。");
  }
  if (name === "delete_output_item") {
    const deleted = await deleteRecordedProject(args.id, args.confirm);
    return toolResult(deleted, "项目已移入回收站；产出项记录与版本历史已保留。");
  }
  if (name === "set_output_item_priority") {
    const item = setPriority(args.id, args.priority);
    return toolResult({ item }, `已将“${item.title}”优先级设为 ${item.priority}。`);
  }
  if (name === "batch_set_output_item_priority") {
    const batch = batchSetPriority(args.ids, args.priority);
    return toolResult(batch, `已更新 ${batch.succeeded} 个产出项的优先级。`);
  }
  if (name === "batch_detect_output_items") {
    const batch = batchDetect(args.ids, args.mode || "quick");
    return toolResult(batch, `批量检测完成：成功 ${batch.succeeded} 项，失败 ${batch.failed} 项。`);
  }
  if (name === "batch_delete_output_items") {
    const batch = await batchDeleteProjects(args.ids, args.confirm);
    return toolResult(batch, `批量删除完成：成功 ${batch.succeeded} 项，失败 ${batch.failed} 项。`);
  }
  if (name === "get_github_upload_context") {
    const context = await githubPublisher.context(args.id);
    return toolResult(context, context.ready ? `GitHub 已就绪：${context.account?.login}` : "GitHub CLI 尚未安装或登录。");
  }
  if (name === "preflight_github_upload") {
    const { id, ...config } = args;
    const preflight = await githubPublisher.preflight(id, args.config || config);
    const blockers = preflight.report.blockers;
    const warnings = preflight.report.warnings;
    const sensitiveFiles = blockers.filter((entry) => entry.code === "SECRET_DETECTED");
    const largeFiles = [...blockers, ...warnings].filter((entry) => ["FILE_OVER_100_MIB", "FILE_OVER_50_MIB"].includes(entry.code));
    const state = blockers.length ? "blocked" : warnings.length ? "warning" : "passed";
    const structured = {
      ...preflight,
      ok: preflight.report.ok,
      state,
      message: blockers.length ? `发现 ${blockers.length} 个不可上传项` : warnings.length ? `检查通过，有 ${warnings.length} 项提示` : "检查通过，可以上传",
      summary: preflight.report.summary,
      files: preflight.report.includedPreview,
      totalFiles: preflight.report.summary.includedFiles,
      totalBytes: preflight.report.summary.includedBytes,
      warnings,
      blockers,
      blockingFiles: blockers,
      sensitiveFiles,
      largeFiles,
      excluded: preflight.report.excludedPreview,
    };
    return toolResult(structured, preflight.report.ok ? "GitHub 上传预检通过。" : `预检发现 ${preflight.report.blockers.length} 个阻断项。`);
  }
  if (name === "start_github_upload") {
    const job = await githubPublisher.startJob(args.id, { preflightId: args.preflightId, confirm: args.confirm, config: args.config });
    return toolResult({ jobId: job.id, job, ...job }, "GitHub 上传任务已创建，正在后台执行。");
  }
  if (name === "get_github_upload_job") {
    const job = githubPublisher.jobStatus(args.jobId);
    return toolResult({ job, ...job }, `GitHub 上传任务：${job.state} · ${job.progress}%`);
  }
  if (name === "cancel_github_upload") {
    const job = githubPublisher.cancelJob(args.jobId);
    return toolResult({ job, ...job }, job.state === "cancelled" ? "GitHub 上传任务已取消。" : "已请求取消 GitHub 上传任务。");
  }
  throw new Error(`Unknown tool: ${name}`);
}

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return response(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "这是本地优先的产出项扩展。open_output_items 是全局工作台入口；扩展会后台增量扫描 Codex 本地任务记录，scan_output_items 可手动触发；register_output_item 仍可用于补充登记。",
      });
    case "ping": return response(id, {});
    case "output-items/register-self": return response(id, { item: await registerSelfItem(params || {}) });
    case "tools/list": return response(id, { tools: TOOLS });
    case "tools/call": return response(id, await callTool(params?.name, params?.arguments || {}));
    case "resources/list":
      return response(id, { resources: [{ uri: RESOURCE_URI, name: "output-items-dashboard", title: "产出项", description: "Codex 产出项工作台界面。", mimeType: "text/html;profile=mcp-app" }] });
    case "resources/read":
      if (params?.uri !== RESOURCE_URI) return errorResponse(id, -32002, `Resource not found: ${String(params?.uri ?? "")}`);
      return response(id, { contents: [{ uri: RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text: inlineDashboardHtml(), _meta: { "openai/widgetPrefersBorder": false } }] });
    case "resources/templates/list": return response(id, { resourceTemplates: [] });
    case "prompts/list": return response(id, { prompts: [] });
    default:
      if (id === undefined) return null;
      return errorResponse(id, -32601, `Method not found: ${String(method ?? "")}`);
  }
}

function emit(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

function startStdioServer() {
  ensureStorage();
  outputScanner.maybeStart("stdio-startup");
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch (error) { emit(errorResponse(null, -32700, "Parse error", String(error))); return; }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message?.id !== undefined) emit(errorResponse(message.id, -32600, "Invalid Request"));
      return;
    }
    if (message.id === undefined) {
      try { await handleRequest(message); } catch { }
      return;
    }
    try { const result = await handleRequest(message); if (result) emit(result); }
    catch (error) { emit(errorResponse(message.id, -32603, error instanceof Error ? error.message : "Internal error")); }
  });
  input.on("close", () => { process.exitCode = 0; });
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function operationHttpError(error) {
  if (Number.isInteger(error?.statusCode)) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("未找到产出项")) return httpError(404, message);
  if (message.includes("已不存在") || message.includes("未能") || message.includes("失败") || message.includes("超时")) return httpError(409, message);
  return httpError(400, message);
}

function setCommonHttpHeaders(res, { allowFrame = false } = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (allowFrame) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
  } else {
    res.setHeader("X-Frame-Options", "DENY");
  }
}

function sendJson(res, statusCode, value, method = "GET") {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  setCommonHttpHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  if (method === "HEAD") res.end(); else res.end(body);
}

function setOpaqueFrameCorsHeaders(res, { preflight = false } = {}) {
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Vary", "Origin");
  if (preflight) {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  }
}

function readJsonBody(req) {
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") return Promise.reject(httpError(415, "请求体必须是 application/json"));
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    req.resume();
    return Promise.reject(httpError(413, "请求体过大"));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.once("aborted", () => reject(httpError(400, "请求已中止")));
    req.once("error", reject);
    req.once("end", () => {
      if (tooLarge) { reject(httpError(413, "请求体过大")); return; }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const value = text ? JSON.parse(text) : {};
        if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("JSON 根值必须是对象");
        resolve(value);
      } catch (error) {
        reject(httpError(400, `JSON 无效：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

const STATIC_MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw httpError(400, "URL 路径编码无效"); }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes(":")) throw httpError(400, "URL 路径无效");
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) throw httpError(403, "禁止路径穿越");
  if (segments.length === 0) segments.push("index.html");
  const candidate = path.resolve(UI_ROOT, ...segments);
  const realRoot = fs.realpathSync(UI_ROOT);
  if (!isInside(realRoot, candidate)) throw httpError(403, "禁止路径穿越");
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw httpError(404, "资源不存在");
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) throw httpError(403, "禁止路径穿越");
  return realCandidate;
}

function serveStatic(req, res, pathname, { allowFrame = false } = {}) {
  const filePath = resolveStaticPath(pathname);
  const stat = fs.statSync(filePath);
  setCommonHttpHeaders(res, { allowFrame });
  res.statusCode = 200;
  res.setHeader("Content-Type", STATIC_MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  if (req.method === "HEAD") { res.end(); return; }
  const stream = fs.createReadStream(filePath);
  stream.once("error", (error) => {
    if (!res.headersSent) sendJson(res, 500, { error: "读取界面资源失败" }, req.method);
    else res.destroy(error);
  });
  stream.pipe(res);
}

function writeServerState(state) {
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const temporary = `${SERVER_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, SERVER_STATE_FILE);
}

function removeOwnServerState(instanceId) {
  try {
    if (!fs.existsSync(SERVER_STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(SERVER_STATE_FILE, "utf8"));
    if (state.pid === process.pid && state.instanceId === instanceId) fs.rmSync(SERVER_STATE_FILE, { force: true });
  } catch { }
}

async function startHttpServer() {
  ensureStorage();
  const instanceId = crypto.randomUUID();
  const companionToken = crypto.randomBytes(24).toString("base64url");
  let baseUrl = "";
  let expectedHost = "";
  const startedAt = new Date().toISOString();

  const requireTrustedMutation = (req, requestOrigin, allowOpaqueApiCors, baseUrlValue) => {
    if (allowOpaqueApiCors) return;
    if (requestOrigin !== baseUrlValue.slice(0, -1)) throw httpError(403, "只接受同源请求");
    const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw httpError(403, "只接受同源请求");
  };

  const decodeItemId = (encoded) => {
    let id;
    try { id = decodeURIComponent(encoded); } catch { throw httpError(400, "产出项 ID 编码无效"); }
    if (!id || id.length > 256 || id.includes("/") || id.includes("\\")) throw httpError(400, "产出项 ID 无效");
    return id;
  };

  const server = http.createServer(async (req, res) => {
    req.setTimeout(10_000, () => req.destroy());
    let allowOpaqueApiCors = false;
    try {
      if (!req.url || !req.method) throw httpError(400, "请求无效");
      if (String(req.headers.host || "").toLowerCase() !== expectedHost) throw httpError(421, "Host 不受信任");
      const requestUrl = new URL(req.url, baseUrl);
      const pathname = requestUrl.pathname;
      const requestOrigin = String(req.headers.origin || "");
      const isApiRequest = pathname.startsWith("/api/");
      if (isApiRequest && requestOrigin === "null") {
        if (requestUrl.searchParams.get("frameToken") !== companionToken) {
          throw httpError(403, "伴生界面 API 令牌无效");
        }
        allowOpaqueApiCors = true;
      } else if (isApiRequest && requestOrigin && requestOrigin !== baseUrl.slice(0, -1)) {
        throw httpError(403, "只接受同源请求");
      }
      const wantsCompanionFrame = requestUrl.searchParams.get("embedded") === "1"
        && requestUrl.searchParams.get("host") === "codex-companion";
      if (wantsCompanionFrame && requestUrl.searchParams.get("token") !== companionToken) {
        throw httpError(403, "伴生界面令牌无效");
      }

      if (req.method === "OPTIONS" && isApiRequest) {
        if (!allowOpaqueApiCors) throw httpError(403, "只接受已授权的伴生界面预检请求");
        setCommonHttpHeaders(res);
        setOpaqueFrameCorsHeaders(res, { preflight: true });
        res.statusCode = 204;
        res.end();
        return;
      }

      if (pathname === "/health") {
        if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, "方法不允许");
        sendJson(res, 200, { ok: true, service: SERVER_INFO.name, version: SERVER_INFO.version, pid: process.pid, instanceId, url: baseUrl, startedAt, scan: publicScanStatus() }, req.method);
        return;
      }

      if (pathname === "/api/items") {
        if (req.method !== "GET") throw httpError(405, "方法不允许");
        outputScanner.maybeStart("http-items-read");
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 200, { items: listItemsForDisplay(), scan: publicScanStatus(), dataDirectory: DATA_ROOT, generatedAt: new Date().toISOString() }, req.method);
        return;
      }

      if (pathname === "/api/scan-status" || pathname === "/api/scan/status") {
        if (req.method !== "GET") throw httpError(405, "方法不允许");
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 200, { scan: publicScanStatus() }, req.method);
        return;
      }

      if (pathname === "/api/scan") {
        if (req.method !== "POST") throw httpError(405, "方法不允许");
        if (!allowOpaqueApiCors) {
          if (requestOrigin !== baseUrl.slice(0, -1)) throw httpError(403, "只接受同源请求");
          const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
          if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw httpError(403, "只接受同源请求");
        }
        const body = await readJsonBody(req);
        outputScanner.start("http-manual", { force: body.force === true });
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 202, { scan: publicScanStatus() }, req.method);
        return;
      }

      const githubItemRoute = /^\/api\/items\/([^/]+)\/github-upload(?:\/(context|preflight))?$/.exec(pathname);
      if (githubItemRoute) {
        const id = decodeItemId(githubItemRoute[1]);
        const action = githubItemRoute[2] || "start";
        if (action === "context") {
          if (req.method !== "GET") throw httpError(405, "方法不允许");
          const result = await callTool("get_github_upload_context", { id });
          if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
          sendJson(res, 200, result.structuredContent, req.method);
          return;
        }
        if (req.method !== "POST") throw httpError(405, "方法不允许");
        requireTrustedMutation(req, requestOrigin, allowOpaqueApiCors, baseUrl);
        const body = await readJsonBody(req);
        let result;
        try {
          result = action === "preflight"
            ? await callTool("preflight_github_upload", { id, ...body })
            : await callTool("start_github_upload", { id, preflightId: body.preflightId, confirm: body.confirm, config: body.config });
        } catch (error) { throw operationHttpError(error); }
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, action === "start" ? 202 : 200, result.structuredContent, req.method);
        return;
      }

      const githubJobRoute = /^\/api\/github-upload\/jobs\/([^/]+)(?:\/(cancel))?$/.exec(pathname);
      if (githubJobRoute) {
        let jobId;
        try { jobId = decodeURIComponent(githubJobRoute[1]); } catch { throw httpError(400, "任务 ID 编码无效"); }
        if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw httpError(400, "任务 ID 无效");
        const cancel = githubJobRoute[2] === "cancel";
        if (cancel) {
          if (req.method !== "POST") throw httpError(405, "方法不允许");
          requireTrustedMutation(req, requestOrigin, allowOpaqueApiCors, baseUrl);
          await readJsonBody(req);
        } else if (req.method !== "GET") throw httpError(405, "方法不允许");
        let result;
        try { result = await callTool(cancel ? "cancel_github_upload" : "get_github_upload_job", { jobId }); }
        catch (error) { throw operationHttpError(error); }
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 200, result.structuredContent, req.method);
        return;
      }

      const batchAction = /^\/api\/items\/batch\/(detect|delete|priority)$/.exec(pathname);
      if (batchAction) {
        if (req.method !== "POST") throw httpError(405, "方法不允许");
        if (!allowOpaqueApiCors) {
          if (requestOrigin !== baseUrl.slice(0, -1)) throw httpError(403, "只接受同源请求");
          const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
          if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw httpError(403, "只接受同源请求");
        }
        const body = await readJsonBody(req);
        if (batchAction[1] === "delete") {
          req.setTimeout(0);
          res.setTimeout(0);
        }
        let result;
        try {
          result = batchAction[1] === "detect"
            ? await callTool("batch_detect_output_items", { ids: body.ids, mode: body.mode || "quick" })
            : batchAction[1] === "delete"
              ? await callTool("batch_delete_output_items", { ids: body.ids, confirm: body.confirm })
              : await callTool("batch_set_output_item_priority", { ids: body.ids, priority: body.priority });
        } catch (error) {
          throw operationHttpError(error);
        }
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 200, result.structuredContent, req.method);
        return;
      }

      const itemAction = /^\/api\/items\/([^/]+)\/(detect|mark|open-location|preview|delete-file|delete-project|priority)$/.exec(pathname);
      if (itemAction) {
        if (req.method !== "POST") throw httpError(405, "方法不允许");
        if (!allowOpaqueApiCors) {
          if (requestOrigin !== baseUrl.slice(0, -1)) throw httpError(403, "只接受同源请求");
          const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
          if (fetchSite && !["same-origin", "none"].includes(fetchSite)) throw httpError(403, "只接受同源请求");
        }
        let id;
        try { id = decodeURIComponent(itemAction[1]); }
        catch { throw httpError(400, "产出项 ID 编码无效"); }
        if (!id || id.length > 256 || id.includes("/") || id.includes("\\")) throw httpError(400, "产出项 ID 无效");
        const body = await readJsonBody(req);
        if (itemAction[2] === "delete-file" || itemAction[2] === "delete-project") {
          req.setTimeout(0);
          res.setTimeout(0);
        }
        let result;
        try {
          result = itemAction[2] === "detect"
            ? await callTool("detect_output_item", { id, mode: body.mode || "quick" })
            : itemAction[2] === "mark"
              ? await callTool("mark_output_item", { id, mark: body.mark, note: body.note })
              : itemAction[2] === "open-location"
                ? await callTool("open_output_item_location", { id, relativePath: body.relativePath })
                : itemAction[2] === "preview"
                  ? await callTool("preview_output_item_file", { id, relativePath: body.relativePath })
                  : itemAction[2] === "delete-file"
                    ? await callTool("delete_output_item_file", { id, relativePath: body.relativePath, confirm: body.confirm })
                    : itemAction[2] === "delete-project"
                      ? await callTool("delete_output_item", { id, confirm: body.confirm })
                      : await callTool("set_output_item_priority", { id, priority: body.priority });
        } catch (error) {
          throw operationHttpError(error);
        }
        if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
        sendJson(res, 200, result.structuredContent, req.method);
        return;
      }

      if (!['GET', 'HEAD'].includes(req.method)) throw httpError(405, "方法不允许");
      const allowFrame = wantsCompanionFrame && (pathname === "/" || pathname === "/index.html");
      serveStatic(req, res, pathname, { allowFrame });
    } catch (error) {
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      const message = statusCode >= 500 ? "服务器内部错误" : error instanceof Error ? error.message : "请求失败";
      if (statusCode >= 500) logEvent("http-error", { message: error instanceof Error ? error.message : String(error) });
      if (allowOpaqueApiCors) setOpaqueFrameCorsHeaders(res);
      sendJson(res, statusCode, { error: message }, req.method);
    }
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法确定本地服务端口");
  expectedHost = `127.0.0.1:${address.port}`;
  baseUrl = `http://${expectedHost}/`;
  const companionUrl = new URL(baseUrl);
  companionUrl.searchParams.set("embedded", "1");
  companionUrl.searchParams.set("host", "codex-companion");
  companionUrl.searchParams.set("token", companionToken);
  const state = {
    pid: process.pid,
    instanceId,
    startedAt,
    url: baseUrl,
    companionUrl: companionUrl.toString(),
    host: "127.0.0.1",
    port: address.port,
    serverPath: path.join(ROOT, "server.mjs"),
    dataRoot: DATA_ROOT,
  };
  writeServerState(state);
  logEvent("http-started", { pid: process.pid, instanceId, url: baseUrl });
  process.stdout.write(`OUTPUT_ITEMS_URL=${baseUrl}\n`);
  outputScanner.maybeStart("http-startup");
  const automaticScanTimer = setInterval(() => outputScanner.maybeStart("http-periodic"), 30_000);
  automaticScanTimer.unref();
  server.once("close", () => clearInterval(automaticScanTimer));

  let closing = false;
  const close = (signal) => {
    if (closing) return;
    closing = true;
    clearInterval(automaticScanTimer);
    logEvent("http-stopping", { pid: process.pid, instanceId, signal });
    server.close(() => {
      removeOwnServerState(instanceId);
      process.exit(0);
    });
    setTimeout(() => {
      removeOwnServerState(instanceId);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGINT", () => close("SIGINT"));
  process.once("SIGTERM", () => close("SIGTERM"));
  process.once("exit", () => removeOwnServerState(instanceId));
}

if (process.argv.slice(2).includes("--http")) {
  startHttpServer().catch((error) => {
    process.stderr.write(`产出项本地服务启动失败：${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  startStdioServer();
}
