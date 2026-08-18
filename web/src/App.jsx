import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, At, Bell, CalendarDots,
  CaretDown, ChatCircleText, Check, CheckCircle, ClockCounterClockwise,
  Copy, DotsThree, Eye, FileCode, FileImage, FilePdf, FilePpt, FileText, FileXls, Folder, FolderOpen,
  Flag, GearSix, GitBranch, GithubLogo, GitPullRequest, Globe, Info, Lightning, LinkSimple, ListChecks, Lock, MagnifyingGlass,
  Minus, PaperPlaneTilt, PencilSimple, Play, SidebarSimple, SlidersHorizontal,
  ShieldCheck, SpinnerGap, SquaresFour, Stack, TerminalWindow, Trash, UserCircle, Warning, Waveform, X
} from "@phosphor-icons/react";
import { createGithubUploadClient, normalizeGithubPreflight, safeGithubCliInstallUrl } from "./githubUploadClient.js";

const INITIAL_OUTPUTS = [
  {
    id: "client-tool",
    title: "客户资料整理工具",
    type: "程序文件夹",
    category: "程序",
    version: "v3.2",
    meta: "24 个文件",
    time: "今天 16:42",
    description: "批量整理客户资料、规范文件命名并导出汇总表。",
    path: "示例工作区\\客户资料整理工具",
    status: "可正常运行",
    statusTone: "success",
    statusDetail: "19 项通过 · 1 项警告",
    lastChecked: "今天 16:42",
    mark: "使用中",
    source: {
      project: "营销自动化",
      task: "修复客户资料工具的批量导出",
      threadId: "task-client-export-032",
      created: "2026-08-14 16:40"
    },
    files: [
      { name: "启动程序.bat", label: "启动器", kind: "code", status: "正常", updated: "16:40" },
      { name: "app.exe", label: "主程序", kind: "app", status: "正常", updated: "16:40" },
      { name: "config.json", label: "配置", kind: "code", status: "已修改", updated: "16:37" },
      { name: "templates", label: "文件夹 · 8 项", kind: "folder", status: "正常", updated: "16:35" },
      { name: "README.md", label: "说明", kind: "text", status: "正常", updated: "16:39" },
      { name: "运行日志.txt", label: "日志", kind: "text", status: "1 项警告", updated: "16:42" }
    ],
    versions: [
      { version: "v3.2", current: true, time: "今天 16:40", note: "修复批量导出并更新启动器", status: "快照可用", source: { project: "营销自动化", task: "修复客户资料工具的批量导出", threadId: "task-client-export-032" } },
      { version: "v3.1", time: "今天 14:18", note: "增加文件名冲突处理", status: "快照可用", source: { project: "营销自动化", task: "处理导出文件的同名冲突", threadId: "task-client-conflict-029" } },
      { version: "v3.0", time: "8 月 12 日 19:06", note: "完成首个可运行版本", status: "仅保留记录", source: { project: "营销自动化", task: "创建客户资料整理工具", threadId: "task-client-tool-021" } }
    ],
    activity: [
      { time: "16:42", title: "系统检测完成", detail: "通过 19 项，警告 1 项；状态保持为“可正常运行”。", tone: "success" },
      { time: "16:40", title: "Codex 产出新版本 v3.2", detail: "修复批量导出并更新启动器。", tone: "accent" },
      { time: "16:38", title: "用户标记更新", detail: "将产出项标记为“使用中”。", tone: "neutral" },
      { time: "14:18", title: "生成历史版本 v3.1", detail: "来自任务“修复客户资料工具的批量导出”。", tone: "accent" }
    ]
  },
  {
    id: "quarterly-report",
    title: "季度复盘报告.pdf",
    type: "PDF 文档",
    category: "文档",
    version: "v2",
    meta: "4.8 MB",
    time: "今天 11:28",
    description: "2026 年第二季度业务复盘、关键指标和下一季度行动计划。",
    path: "示例工作区\\季度复盘报告.pdf",
    status: "文件可读",
    statusTone: "success",
    statusDetail: "结构完整 · 38 页",
    lastChecked: "今天 11:31",
    mark: "已定稿",
    source: {
      project: "经营分析",
      task: "生成 Q2 季度复盘报告",
      threadId: "task-q2-review-014",
      created: "2026-08-14 11:28"
    },
    files: [
      { name: "季度复盘报告.pdf", label: "PDF · 38 页", kind: "pdf", status: "正常", updated: "11:28" }
    ],
    versions: [
      { version: "v2", current: true, time: "今天 11:28", note: "修正图表标注并补充结论", status: "快照可用", source: { project: "经营分析", task: "生成 Q2 季度复盘报告", threadId: "task-q2-review-014" } },
      { version: "v1", time: "昨天 20:11", note: "首版报告", status: "快照可用", source: { project: "经营分析", task: "整理 Q2 指标与结论", threadId: "task-q2-draft-011" } }
    ],
    activity: [
      { time: "11:31", title: "快速检测完成", detail: "文件可读取，页面结构完整。", tone: "success" },
      { time: "11:28", title: "Codex 产出新版本 v2", detail: "修正图表标注并补充结论。", tone: "accent" },
      { time: "11:29", title: "用户标记更新", detail: "将产出项标记为“已定稿”。", tone: "neutral" }
    ]
  },
  {
    id: "brand-presentation",
    title: "品牌视觉方案.pptx",
    type: "演示文稿",
    category: "演示",
    version: "v5",
    meta: "16.3 MB",
    time: "昨天 18:06",
    description: "品牌视觉系统提案，包含色彩、字体与应用示例。",
    path: "示例工作区\\品牌视觉方案.pptx",
    status: "路径缺失",
    statusTone: "warning",
    statusDetail: "未在最后路径找到文件",
    lastChecked: "今天 09:12",
    mark: "需要修复",
    source: {
      project: "品牌升级",
      task: "输出品牌视觉提案终稿",
      threadId: "task-brand-final-027",
      created: "2026-08-13 18:06"
    },
    files: [
      { name: "品牌视觉方案.pptx", label: "PPTX · 42 页", kind: "ppt", status: "路径缺失", updated: "昨天 18:06" }
    ],
    versions: [
      { version: "v5", current: true, time: "昨天 18:06", note: "完善应用场景示例", status: "路径缺失", source: { project: "品牌升级", task: "输出品牌视觉提案终稿", threadId: "task-brand-final-027" } },
      { version: "v4", time: "8 月 13 日 15:30", note: "统一字体与配色", status: "快照可用", source: { project: "品牌升级", task: "统一提案字体与配色", threadId: "task-brand-system-023" } },
      { version: "v3", time: "8 月 12 日 22:18", note: "补充移动端组件", status: "快照可用", source: { project: "品牌升级", task: "补充移动端品牌组件", threadId: "task-brand-mobile-019" } }
    ],
    activity: [
      { time: "09:12", title: "检测发现路径缺失", detail: "最后路径不可访问；历史记录仍保留。", tone: "warning" },
      { time: "昨天 18:06", title: "Codex 产出新版本 v5", detail: "完善应用场景示例。", tone: "accent" },
      { time: "昨天 18:08", title: "用户标记更新", detail: "将产出项标记为“需要修复”。", tone: "neutral" }
    ]
  },
  {
    id: "sales-data",
    title: "销售数据清洗.xlsx",
    type: "电子表格",
    category: "表格",
    version: "v1",
    meta: "2.1 MB",
    time: "8 月 12 日",
    description: "销售原始数据清洗结果与异常行说明。",
    path: "示例工作区\\销售数据清洗.xlsx",
    status: "未检测",
    statusTone: "neutral",
    statusDetail: "尚未执行状态检测",
    lastChecked: "—",
    mark: "待确认",
    source: {
      project: "销售分析",
      task: "清洗 7 月销售明细",
      threadId: "task-sales-clean-006",
      created: "2026-08-12 20:16"
    },
    files: [
      { name: "销售数据清洗.xlsx", label: "XLSX · 4 个工作表", kind: "xls", status: "未检测", updated: "8 月 12 日" }
    ],
    versions: [
      { version: "v1", current: true, time: "8 月 12 日 20:16", note: "首版清洗结果", status: "快照可用", source: { project: "销售分析", task: "清洗 7 月销售明细", threadId: "task-sales-clean-006" } }
    ],
    activity: [
      { time: "8 月 12 日", title: "Codex 创建产出项", detail: "生成销售数据清洗结果。", tone: "accent" }
    ]
  }
];

const DETECTION_MODES = {
  quick: {
    label: "快速检测",
    description: "刷新文件清单并检查路径与读取权限",
    items: ["确认根路径可访问", "刷新新增和已删除条目", "检查登记条目的读取权限", "写入检测日志"]
  },
  full: {
    label: "完整检测",
    description: "刷新文件清单，并检查读取权限与常见文件基础结构",
    items: ["确认根路径可访问", "刷新新增和已删除条目", "检查登记条目的读取权限", "验证 PDF、Office、PNG 与 JSON 基础结构"]
  }
};

const PRIORITY_OPTIONS = [
  { value: "critical", label: "最高", rank: 4, tone: "critical" },
  { value: "high", label: "高", rank: 3, tone: "high" },
  { value: "normal", label: "普通", rank: 2, tone: "normal" },
  { value: "low", label: "低", rank: 1, tone: "low" },
  { value: "none", label: "不设置", rank: 0, tone: "none" }
];

const PRIORITY_BY_VALUE = new Map(PRIORITY_OPTIONS.map((option) => [option.value, option]));
const LEGACY_PRIORITY_VALUES = new Map([[4, "critical"], [3, "high"], [2, "normal"], [1, "low"], [0, "none"]]);
const MAX_BATCH_SELECTION = 50;
const BATCH_CONFIRM_VISIBLE_ITEMS = 5;
const MAX_GITHUB_CUSTOM_PATHS = 500;
const PREVIEW_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const PREVIEW_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
const PREVIEW_TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "xml", "html", "htm", "svg",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "less", "py", "ps1", "bat",
  "cmd", "sh", "zsh", "fish", "sql", "graphql", "gql"
]);

function previewKindForFile(file) {
  const path = String(file?.relativePath || file?.name || "");
  const name = path.split(/[\\/]/).pop() || "";
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex < 1 || dotIndex === name.length - 1) return "";
  const extension = name.slice(dotIndex + 1).toLowerCase();
  if (PREVIEW_IMAGE_EXTENSIONS.has(extension)) return "image";
  if (PREVIEW_TEXT_EXTENSIONS.has(extension)) return "text";
  return "";
}

function priorityValue(output) {
  const raw = output?.priority;
  if (PRIORITY_BY_VALUE.has(raw)) return raw;
  if (Number.isFinite(Number(raw))) return LEGACY_PRIORITY_VALUES.get(Number(raw)) || "none";
  return "none";
}

function priorityInfo(output) {
  return PRIORITY_BY_VALUE.get(priorityValue(output)) || PRIORITY_BY_VALUE.get("none");
}

function outputTimestamp(output) {
  const currentVersion = output?.versions?.find((version) => version.current);
  const candidates = [
    output?.updatedAt,
    currentVersion?.updatedAt,
    currentVersion?.time,
    output?.source?.updatedAt,
    output?.source?.updated,
    output?.source?.created
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = typeof candidate === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(candidate)
      ? candidate.replace(" ", "T")
      : candidate;
    const timestamp = new Date(normalized).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function isDeletedOutput(output) {
  return output?.status === "已删除";
}

function compareOutputEntries(left, right) {
  const deletedDifference = Number(isDeletedOutput(left.output)) - Number(isDeletedOutput(right.output));
  if (deletedDifference) return deletedDifference;
  const priorityDifference = priorityInfo(right.output).rank - priorityInfo(left.output).rank;
  if (priorityDifference) return priorityDifference;
  const timeDifference = outputTimestamp(right.output) - outputTimestamp(left.output);
  return timeDifference || left.index - right.index;
}

function shortTaskId(value) {
  const id = String(value || "").trim();
  if (!id) return "—";
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-5)}`;
}

function taskGroupIdentity(output) {
  const source = output?.source || {};
  const metadata = output?.taskGroup || output?.groupMetadata || output?.group || source?.taskGroup || {};
  const rootThreadId = String(
    metadata.rootThreadId
      || metadata.threadId
      || source.rootThreadId
      || source.rootTaskThreadId
      || source.threadId
      || ""
  ).trim();
  const explicitUnknown = metadata.unknown === true || metadata.key === "unknown";
  const title = String(
    metadata.title
      || metadata.rootTaskTitle
      || source.rootTaskTitle
      || source.rootTask
      || source.task
      || ""
  ).trim();
  const project = String(metadata.project || source.rootProject || source.project || "").trim();
  const unknown = explicitUnknown || (!rootThreadId && !title);
  const safeTitle = unknown ? "来源任务未知" : (title || "未命名任务会话");
  const safeProject = unknown ? "等待后续扫描补充来源" : (project || "未归属项目");
  const fallbackKey = unknown
    ? "unknown"
    : rootThreadId
      ? `thread:${rootThreadId.toLowerCase()}`
      : `legacy:${safeProject.toLowerCase()}::${safeTitle.toLowerCase()}`;

  return {
    key: String(metadata.key || fallbackKey),
    rootThreadId,
    title: safeTitle,
    project: safeProject,
    projectKind: metadata.projectKind || "",
    hostId: metadata.hostId || source.hostId || "",
    workspacePath: metadata.workspacePath || source.cwd || "",
    unknown
  };
}

function taskGroupSource(group) {
  return {
    ...(group.items[0]?.source || {}),
    task: group.title,
    project: group.project,
    threadId: group.rootThreadId,
    hostId: group.hostId
  };
}

function outputSearchText(output) {
  const source = output?.source || {};
  return [output?.title, output?.type, output?.category, output?.path, source.project, source.task, source.threadId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function buildTaskGroups(outputs, query, typeFilter) {
  const groupsByKey = new Map();

  outputs.forEach((output, index) => {
    const identity = taskGroupIdentity(output);
    let group = groupsByKey.get(identity.key);
    if (!group) {
      group = { ...identity, items: [], firstIndex: index };
      groupsByKey.set(identity.key, group);
    }
    group.items.push({ output, index });
  });

  const normalizedQuery = query.trim().toLowerCase();
  const groups = [];
  for (const group of groupsByKey.values()) {
    const sortedEntries = [...group.items].sort(compareOutputEntries);
    const allItems = sortedEntries.map(({ output }) => output);
    const activeItems = allItems.filter((item) => !isDeletedOutput(item));
    if (!activeItems.length) continue;

    const categoryItems = allItems.filter((item) => typeFilter === "全部类型" || item.category === typeFilter);
    const groupText = [group.title, group.project, group.rootThreadId, group.workspacePath].filter(Boolean).join(" ").toLowerCase();
    const visibleItems = normalizedQuery && !groupText.includes(normalizedQuery)
      ? categoryItems.filter((item) => outputSearchText(item).includes(normalizedQuery))
      : categoryItems;
    if (!visibleItems.length) continue;

    let highestPriority = 0;
    let latestTimestamp = 0;
    let latestItem = activeItems[0];
    for (const item of activeItems) {
      highestPriority = Math.max(highestPriority, priorityInfo(item).rank);
      const timestamp = outputTimestamp(item);
      if (timestamp >= latestTimestamp) {
        latestTimestamp = timestamp;
        latestItem = item;
      }
    }
    groups.push({
      ...group,
      items: allItems,
      visibleItems,
      totalCount: allItems.length,
      highestPriority,
      latestTimestamp,
      latestLabel: latestItem?.time || latestItem?.updatedAt || latestItem?.source?.created || "—"
    });
  }

  return groups.sort((left, right) => {
    const priorityDifference = right.highestPriority - left.highestPriority;
    if (priorityDifference) return priorityDifference;
    const timeDifference = right.latestTimestamp - left.latestTimestamp;
    return timeDifference || left.firstIndex - right.firstIndex;
  });
}

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const FILE_SIZE_FORMATTER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

function formatFileSize(value) {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), FILE_SIZE_UNITS.length - 1);
  const size = bytes / (1024 ** unitIndex);
  return `${FILE_SIZE_FORMATTER.format(size)} ${FILE_SIZE_UNITS[unitIndex]}`;
}

function outputSizeLabel(output) {
  const sizeBytes = output?.sizeBytes;
  if (output?.sizeAggregationComplete !== true || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    return "大小未知";
  }
  return formatFileSize(sizeBytes);
}

export function outputMetadataText(output) {
  const sizeLabel = isDeletedOutput(output) ? null : outputSizeLabel(output);
  return [output?.type, output?.meta, sizeLabel, output?.version]
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .join(" · ");
}

function normalizeFileTreePath(file) {
  const rawPath = String(file?.relativePath || file?.name || "").trim();
  if (!rawPath || rawPath === ".") return rawPath;
  return rawPath.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function folderFirstFileTreeNodes(nodes) {
  const folders = [];
  const files = [];
  for (const node of nodes) {
    const orderedNode = node.children.length
      ? { ...node, children: folderFirstFileTreeNodes(node.children) }
      : node;
    if (isFileTreeFolder(orderedNode)) folders.push(orderedNode);
    else files.push(orderedNode);
  }
  return [...folders, ...files];
}

export function buildFileTree(files) {
  const roots = [];
  const nodesByPath = new Map();

  for (const [recordIndex, file] of (Array.isArray(files) ? files : []).entries()) {
    const normalizedPath = normalizeFileTreePath(file);
    if (!normalizedPath) continue;
    if (normalizedPath === ".") {
      roots.push({ key: `root-file-${recordIndex}`, path: ".", name: file.name || "未命名文件", record: file, children: [] });
      continue;
    }

    const segments = normalizedPath.split("/").filter(Boolean);
    let children = roots;
    let currentPath = "";
    for (const [segmentIndex, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const key = currentPath.toLowerCase();
      let node = nodesByPath.get(key);
      if (!node) {
        node = { key, path: currentPath, name: segment, record: null, children: [] };
        nodesByPath.set(key, node);
        children.push(node);
      }
      if (segmentIndex === segments.length - 1) {
        node.name = file.name || segment;
        node.record = file;
      }
      children = node.children;
    }
  }
  return folderFirstFileTreeNodes(roots);
}

function isFileTreeFolder(node) {
  return node.record?.kind === "folder" || node.children.length > 0;
}

function visibleFileTreeNodes(nodes, expandedPaths, depth = 0, visible = []) {
  nodes.forEach((node, index) => {
    visible.push({ node, depth, position: index + 1, setSize: nodes.length });
    if (node.children.length && expandedPaths.has(node.key)) {
      visibleFileTreeNodes(node.children, expandedPaths, depth + 1, visible);
    }
  });
  return visible;
}

function fileTreeSizeLabel(file, isFolder) {
  if (!file || (isFolder && file.aggregationComplete !== true)) return "—";
  return formatFileSize(file.sizeBytes);
}

const cx = (...items) => items.filter(Boolean).join(" ");

const EMBED_PARAMS = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const IS_IFRAME_EMBEDDED = typeof window !== "undefined" && window.parent !== window;
const COMPANION_API_BASE = typeof window !== "undefined"
  ? String(window.__CODEX_OUTPUT_ITEMS_API_BASE__ || "").trim()
  : "";
const COMPANION_FRAME_TOKEN = typeof window !== "undefined"
  ? String(window.__CODEX_OUTPUT_ITEMS_FRAME_TOKEN__ || "").trim()
  : "";
const IS_COMPANION_EMBEDDED = EMBED_PARAMS.get("host") === "codex-companion"
  || (typeof window !== "undefined" && window.__CODEX_OUTPUT_ITEMS_COMPANION__ === true);
const IS_CODEX_EMBEDDED = IS_IFRAME_EMBEDDED || EMBED_PARAMS.has("embedded");
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

function readStructuredContent(result) {
  return result?.structuredContent || result?.structured_content || null;
}

async function callOutputItemsTool(name, args = {}) {
  if (IS_COMPANION_EMBEDDED || !IS_CODEX_EMBEDDED || typeof window.openai?.callTool !== "function") return null;
  return window.openai.callTool(name, args);
}

function getErrorMessage(error, fallback = "请求未完成") {
  if (typeof error === "string" && error.trim()) return error;
  if (error?.message) return error.message;
  return fallback;
}

function readItemsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  const structured = readStructuredContent(payload);
  return Array.isArray(structured?.items) ? structured.items : null;
}

function readScanPayload(payload) {
  const structured = readStructuredContent(payload);
  const scan = payload?.scan || structured?.scan;
  if (!scan || typeof scan !== "object") return null;
  if (!["idle", "running", "complete", "error"].includes(scan.state)) return null;
  return scan;
}

function formatScanTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return SCAN_TIME_FORMATTER.format(date);
}

function scanResultToast(scan) {
  const stats = [];
  if (Number.isFinite(scan?.imported)) stats.push(`新增 ${scan.imported} 项`);
  if (Number.isFinite(scan?.updated)) stats.push(`更新 ${scan.updated} 项`);
  if (Number.isFinite(scan?.skipped) && scan.skipped > 0) stats.push(`跳过 ${scan.skipped} 项`);
  return stats.length ? `自动抓取完成：${stats.join("，")}` : "自动抓取完成，产出列表已刷新";
}

async function callStandaloneApi(path, { method = "GET", body, signal } = {}) {
  let requestUrl = path;
  if (IS_COMPANION_EMBEDDED && COMPANION_API_BASE) {
    const url = new URL(path, COMPANION_API_BASE);
    if (COMPANION_FRAME_TOKEN) url.searchParams.set("frameToken", COMPANION_FRAME_TOKEN);
    requestUrl = url.toString();
  }
  const response = await fetch(requestUrl, {
    method,
    cache: "no-store",
    signal,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`本地服务返回了无法读取的响应（HTTP ${response.status}）`);
  }

  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.message;
    throw new Error(typeof detail === "string" && detail ? detail : `本地服务请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

async function requestItemsSnapshot(signal) {
  if (!IS_COMPANION_EMBEDDED && IS_CODEX_EMBEDDED) {
    const result = await callOutputItemsTool("list_output_items", {});
    const payload = readStructuredContent(result) || result;
    if (!payload) throw new Error("Codex 工具没有返回产出项数据");
    return payload;
  }
  return callStandaloneApi("/api/items", { signal });
}

async function requestScanSnapshot(signal) {
  if (!IS_COMPANION_EMBEDDED && IS_CODEX_EMBEDDED) return requestItemsSnapshot(signal);
  return callStandaloneApi("/api/scan-status", { signal });
}

async function startOutputItemsScan(signal) {
  if (!IS_COMPANION_EMBEDDED && IS_CODEX_EMBEDDED) {
    const result = await callOutputItemsTool("scan_output_items", {});
    const payload = readStructuredContent(result) || result;
    if (!payload) throw new Error("Codex 扫描工具没有返回结果");
    return payload;
  }
  return callStandaloneApi("/api/scan", { method: "POST", body: {}, signal });
}

async function requestOutputAction(name, args = {}, signal) {
  if (!IS_COMPANION_EMBEDDED && IS_CODEX_EMBEDDED) {
    const result = await callOutputItemsTool(name, args);
    const payload = readStructuredContent(result);
    if (!payload) throw new Error("Codex 工具没有返回结构化结果");
    return payload;
  }

  if (name === "detect_output_item") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/detect`, {
      method: "POST",
      body: { mode: args.mode },
      signal
    });
  }
  if (name === "mark_output_item") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/mark`, {
      method: "POST",
      body: { mark: args.mark, note: args.note },
      signal
    });
  }
  if (name === "open_output_item_location") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/open-location`, {
      method: "POST",
      body: { relativePath: args.relativePath },
      signal
    });
  }
  if (name === "preview_output_item_file") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/preview`, {
      method: "POST",
      body: { relativePath: args.relativePath },
      signal
    });
  }
  if (name === "delete_output_item_file") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/delete-file`, {
      method: "POST",
      body: { relativePath: args.relativePath, confirm: true },
      signal
    });
  }
  if (name === "delete_output_item") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/delete-project`, {
      method: "POST",
      body: { confirm: true },
      signal
    });
  }
  if (name === "set_output_item_priority") {
    return callStandaloneApi(`/api/items/${encodeURIComponent(args.id)}/priority`, {
      method: "POST",
      body: { priority: args.priority },
      signal
    });
  }
  if (name === "batch_detect_output_items") {
    return callStandaloneApi("/api/items/batch/detect", {
      method: "POST",
      body: { ids: args.ids, mode: args.mode },
      signal
    });
  }
  if (name === "batch_delete_output_items") {
    return callStandaloneApi("/api/items/batch/delete", {
      method: "POST",
      body: { ids: args.ids, confirm: true },
      signal
    });
  }
  if (name === "batch_set_output_item_priority") {
    return callStandaloneApi("/api/items/batch/priority", {
      method: "POST",
      body: { ids: args.ids, priority: args.priority },
      signal
    });
  }
  throw new Error(`不支持的操作：${name}`);
}

const githubUploadClient = createGithubUploadClient({
  callTool: (name, args) => callOutputItemsTool(name, args),
  callApi: (path, options) => callStandaloneApi(path, options)
});

async function openNativeTask(source) {
  const threadId = source?.threadId;
  if (!THREAD_ID_PATTERN.test(threadId || "")) return { ok: false, error: "该记录没有可用的真实任务 ID" };
  if (IS_COMPANION_EMBEDDED) {
    const requestId = typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
        resolve(result);
      };
      const onMessage = (event) => {
        if (event.source !== window.parent) return;
        if (event.data?.type !== "output-items:open-thread-result" || event.data?.requestId !== requestId) return;
        finish({ ok: event.data.ok === true, error: event.data.error || "Codex 未确认已打开对应任务" });
      };
      const timer = window.setTimeout(() => finish({ ok: false, error: "打开任务超时；Codex 可能仍在切换任务" }), 6500);
      window.addEventListener("message", onMessage);
      window.parent.postMessage({ type: "output-items:open-thread", requestId, threadId }, "*");
    });
  }
  const href = `codex://threads/${threadId}`;
  try {
    if (typeof window.openai?.openExternal === "function") {
      await window.openai.openExternal({ href });
      return { ok: true };
    }
    window.location.href = href;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error, "无法打开对应任务") };
  }
}

function useModalFocus(onClose, lockClose = false) {
  const modalRef = useRef(null);
  const closeRef = useRef(onClose);
  const lockCloseRef = useRef(lockClose);
  closeRef.current = onClose;
  lockCloseRef.current = lockClose;

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return undefined;
    const previous = document.activeElement;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const first = modal.querySelector(focusableSelector);
    modal.tabIndex = -1;
    if (first) first.focus();
    else modal.focus();

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !lockCloseRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(modal.querySelectorAll(focusableSelector)).filter((node) => node.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
      }
      const firstNode = focusable[0];
      const lastNode = focusable[focusable.length - 1];
      if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? lastNode : firstNode).focus();
      } else if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previous && previous.focus) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!lockClose) return;
    const modal = modalRef.current;
    if (!modal) return;
    const active = document.activeElement;
    if (!modal.contains(active) || active?.disabled) modal.focus();
  }, [lockClose]);

  return modalRef;
}

function FileIcon({ kind, size = 19 }) {
  if (kind === "folder") return <Folder size={size} />;
  if (kind === "pdf") return <FilePdf size={size} />;
  if (kind === "ppt") return <FilePpt size={size} />;
  if (kind === "xls") return <FileXls size={size} />;
  if (kind === "app") return <AppWindow size={size} />;
  if (kind === "text") return <FileText size={size} />;
  return <FileCode size={size} />;
}

function TopBar() {
  return (
    <header className="topbar">
      <div className="window-menu">
        <SidebarSimple size={16} />
        <button aria-label="后退"><ArrowLeft size={16} /></button>
        <button aria-label="前进" className="disabled" disabled><ArrowRight size={16} /></button>
        <span>文件</span><span>编辑</span><span>视图</span><span>帮助</span>
      </div>
      <div className="window-controls" aria-hidden="true">
        <span><Minus size={15} /></span><span className="window-square" /><span><X size={15} /></span>
      </div>
    </header>
  );
}

function Sidebar({ view, output, onOutputs, onTask, onToast }) {
  const nav = [
    [PencilSimple, "新对话"],
    [GitPullRequest, "拉取请求"],
    [SquaresFour, "站点"],
    [CalendarDots, "已安排"],
    [At, "插件"]
  ];
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <button className="brand-button">Codex <CaretDown size={12} /></button>
        <div className="brand-actions">
          <button aria-label="搜索" onClick={() => onToast("搜索入口（原型）")}><MagnifyingGlass size={17} /></button>
          <button aria-label="通知" onClick={() => onToast("暂无新通知")}><Bell size={17} /></button>
        </div>
      </div>
      <nav className="primary-nav">
        {nav.map(([Icon, label]) => (
          <button key={label} onClick={() => onToast(label + "（原型）")}><Icon size={18} /><span>{label}</span></button>
        ))}
        <button className={view === "outputs" ? "active" : ""} onClick={onOutputs}><Stack size={18} /><span>产出项</span></button>
      </nav>
      <div className="sidebar-section">
        <div className="section-label">置顶</div>
        <button className="task-link" onClick={() => onToast("已打开置顶任务（原型）")}><span>我用 type-c 接口连接了 ipad 和主机...</span><i /></button>
        <button className={cx("task-link", view === "outputs" && "soft-active")} onClick={onOutputs}><span>这一栏功能区，你们命名为什么区</span><i /></button>
      </div>
      <div className="sidebar-section">
        <div className="section-label">项目</div>
        <div className="project-empty">没有项目</div>
      </div>
      <div className="sidebar-section recent-section">
        <div className="section-label">最近</div>
        <button className={cx("task-link", view === "task" && "soft-active")} onClick={onTask} disabled={!output}>
          <span>{output?.source?.task || "暂无产出项"}</span><i />
        </button>
      </div>
      <div className="account-bar">
        <div className="avatar">D</div><span>Demo User</span><div className="account-spacer" />
        <Waveform size={17} /><span className="voice-label">语音</span>
        <button aria-label="帮助" onClick={() => onToast("帮助中心（原型）")}>?</button>
      </div>
    </aside>
  );
}

function OutputIcon({ output, large = false }) {
  const size = large ? 27 : 19;
  let icon = <FilePdf size={size} />;
  if (output.category === "程序") icon = <Folder size={size} />;
  if (output.category === "演示") icon = <FilePpt size={size} />;
  if (output.category === "表格") icon = <FileXls size={size} />;
  return <span className={cx("output-icon", large && "large", output.statusTone)}>{icon}</span>;
}

function StatusPill({ tone = "neutral", outlined = false, children }) {
  return <span className={cx("status-pill", tone, outlined && "outlined")}><i />{children}</span>;
}

function PriorityBadge({ output, compact = false }) {
  const priority = priorityInfo(output);
  if (priority.value === "none") return compact ? null : <span className="priority-badge none"><Flag size={12} />未设置优先级</span>;
  return <span className={cx("priority-badge", priority.tone)}><Flag size={12} weight="fill" />{priority.label}优先级</span>;
}

function SelectionCheckbox({ checked, indeterminate = false, onChange, disabled, label }) {
  const checkboxRef = useRef(null);
  useLayoutEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={checkboxRef} type="checkbox" checked={checked} aria-checked={indeterminate ? "mixed" : checked} onChange={onChange} disabled={disabled} aria-label={label} />;
}

function OutputList({ groups, selectedId, onSelect, selectedIds, onToggleSelection, onToggleAll, onTask, batchMode, selectionBusy, selectionLimit = MAX_BATCH_SELECTION }) {
  const selectedGroupKey = groups.find((group) => group.visibleItems.some((output) => output.id === selectedId))?.key || "";
  const [expandedGroupKeys, setExpandedGroupKeys] = useState(() => new Set(selectedGroupKey ? [selectedGroupKey] : groups[0]?.key ? [groups[0].key] : []));
  const selectionLimitReached = selectedIds.size >= selectionLimit;
  const totalVisibleItems = groups.reduce((total, group) => total + group.visibleItems.length, 0);

  useEffect(() => {
    if (!selectedGroupKey) return;
    setExpandedGroupKeys((current) => {
      if (current.has(selectedGroupKey)) return current;
      const next = new Set(current);
      next.add(selectedGroupKey);
      return next;
    });
  }, [selectedGroupKey]);

  const toggleGroup = (key) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className={cx("output-list-panel", batchMode && "batch-mode")}>
      <div className="panel-title-row">
        <div><h2>任务会话</h2><span>{groups.length} 个任务 · {totalVisibleItems} 项产出</span></div>
      </div>
      <div className="output-list task-group-list">
        {groups.map((group) => {
          const expanded = expandedGroupKeys.has(group.key);
          const visibleIds = group.visibleItems.map((output) => output.id);
          const selectedInGroup = visibleIds.filter((id) => selectedIds.has(id)).length;
          const groupChecked = visibleIds.length > 0 && selectedInGroup === visibleIds.length;
          const groupIndeterminate = selectedInGroup > 0 && !groupChecked;
          const canOpenTask = !group.unknown && THREAD_ID_PATTERN.test(group.rootThreadId);
          return (
            <section className={cx("task-output-group", selectedInGroup > 0 && "has-batch-selection")} key={group.key} data-task-group-key={group.key}>
              <div className="task-group-row">
                {batchMode && (
                  <label className="task-group-select">
                    <SelectionCheckbox
                      checked={groupChecked}
                      indeterminate={groupIndeterminate}
                      onChange={() => onToggleAll(visibleIds, !groupChecked)}
                      disabled={selectionBusy || !visibleIds.length}
                      label={`选择任务“${group.title}”下的全部产出项`}
                    />
                  </label>
                )}
                <button className="task-group-toggle" onClick={() => toggleGroup(group.key)} aria-expanded={expanded}>
                  <span className={cx("task-group-caret", expanded && "expanded")}><CaretDown size={14} weight="bold" /></span>
                  <span className="task-group-icon">{expanded ? <FolderOpen size={19} /> : <Folder size={19} />}</span>
                  <span className="task-group-copy">
                    <strong>{group.title}</strong>
                    <small>
                      <span>{group.project}</span>
                      <span title={group.rootThreadId || "没有可用的任务 ID"}>{shortTaskId(group.rootThreadId)}</span>
                      <span>{group.totalCount} 项</span>
                      <span>最新 {group.latestLabel}</span>
                    </small>
                  </span>
                </button>
                <button className="open-group-task" onClick={() => onTask(taskGroupSource(group))} disabled={!canOpenTask} title={canOpenTask ? `打开任务：${group.title}` : "来源任务不可用"}>
                  打开任务<ArrowSquareOut size={13} />
                </button>
              </div>
              {expanded && (
                <div className="task-group-children">
                  {group.visibleItems.map((output) => (
                    <div className={cx("output-row", selectedId === output.id && "selected", selectedIds.has(output.id) && "batch-selected")} key={output.id}>
                      {batchMode && (
                        <label className="output-select">
                          <SelectionCheckbox
                            checked={selectedIds.has(output.id)}
                            onChange={() => onToggleSelection(output.id)}
                            disabled={selectionBusy || (selectionLimitReached && !selectedIds.has(output.id))}
                            label={`选择 ${output.title}`}
                          />
                        </label>
                      )}
                      <button className="output-row-main" onClick={() => onSelect(output.id)}>
                        <OutputIcon output={output} />
                        <span className="output-row-copy">
                          <span className="output-row-title">{output.title}</span>
                          <span className="output-row-meta"><PriorityBadge output={output} compact />{outputMetadataText(output)}</span>
                        </span>
                        <span className="output-row-side">
                          <span className={cx("output-state-label", output.statusTone)}><i />{output.status}</span>
                          <small>{output.time}</small>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!groups.length && (
          <div className="empty-state"><MagnifyingGlass size={26} /><strong>没有匹配的任务会话</strong><span>尝试更换关键词或类型筛选。</span></div>
        )}
      </div>
    </section>
  );
}

function FileTree({ output, onToast, onPreview, onOpenLocation, onGithubUpload, onRequestDeleteFile, operationBusy }) {
  const [menuPath, setMenuPath] = useState("");
  const [expandedPaths, setExpandedPaths] = useState(() => new Set());
  const tree = useMemo(() => buildFileTree(output.files), [output.files]);
  const visibleNodes = useMemo(() => visibleFileTreeNodes(tree, expandedPaths), [expandedPaths, tree]);

  useEffect(() => {
    setMenuPath("");
    setExpandedPaths(new Set());
  }, [output.id]);

  const setFolderExpanded = (node, expanded) => {
    setMenuPath("");
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (expanded) next.add(node.key);
      else next.delete(node.key);
      return next;
    });
  };

  return (
    <section className="file-tree-panel">
      <div className="file-tree-heading">
        <div><h2>{output.title}</h2><p>{outputMetadataText(output)}</p></div>
        <button className="icon-button" aria-label="打开项目位置" onClick={() => onOpenLocation(output)} disabled={operationBusy}><FolderOpen size={20} /></button>
      </div>
      <div className="file-table-head"><span>名称</span><span>大小</span><span>状态</span><span>修改时间</span><span /></div>
      <div className="file-rows" role="tree" aria-label={`${output.title} 文件树`}>
        {visibleNodes.map(({ node, depth, position, setSize }) => {
          const file = node.record;
          const isFolder = isFileTreeFolder(node);
          const hasChildren = node.children.length > 0;
          const expanded = hasChildren && expandedPaths.has(node.key);
          const relativePath = file?.relativePath || node.path || file?.name;
          const menuOpen = Boolean(file) && menuPath === node.key;
          const status = file?.status || "—";
          const statusTone = file?.statusTone || (status.includes("缺失") || status.includes("警告") || status === "已删除" ? "warning" : status === "未检测" || status === "—" ? "neutral" : "success");
          const sizeLabel = fileTreeSizeLabel(file, isFolder);
          const previewKind = !isFolder && file?.status !== "已删除" ? previewKindForFile(file) : "";
          return (
            <div className="file-row" key={node.key} role="none">
              <button
                className="file-row-main"
                role="treeitem"
                aria-level={depth + 1}
                aria-posinset={position}
                aria-setsize={setSize}
                aria-expanded={hasChildren ? expanded : undefined}
                style={{ "--tree-depth": depth }}
                onClick={() => {
                  if (isFolder && hasChildren) setFolderExpanded(node, !expanded);
                  else if (isFolder) onToast(`${node.name} 文件夹为空`);
                  else if (previewKind) onPreview(output, file);
                  else onToast("此格式暂不支持预览，可使用“打开所在位置”查看文件");
                }}
                onKeyDown={(event) => {
                  if (!hasChildren) return;
                  if (event.key === "ArrowRight" && !expanded) {
                    event.preventDefault();
                    setFolderExpanded(node, true);
                  } else if (event.key === "ArrowLeft" && expanded) {
                    event.preventDefault();
                    setFolderExpanded(node, false);
                  }
                }}
              >
                <span className="file-name-cell">
                  <span className={cx("file-tree-caret", expanded && "expanded", !hasChildren && "placeholder")} aria-hidden="true">{hasChildren && <CaretDown size={13} weight="bold" />}</span>
                  <span className={cx("file-kind", isFolder ? "folder" : file?.kind)}><FileIcon kind={isFolder ? "folder" : file?.kind} /></span>
                  <span className="file-copy"><strong title={relativePath}>{node.name}</strong><small>{file?.label || "文件夹"}</small></span>
                </span>
                <span className="file-size" title={isFolder && file?.aggregationComplete === false ? "目录大小未完整统计" : sizeLabel}>{sizeLabel}</span>
                <span className={cx("file-status", statusTone)}>{status}</span>
                <span className="file-updated">{file?.updated || "—"}</span>
              </button>
              {file ? <button className="file-more-button" aria-label={`${relativePath} 的文件操作`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuPath(menuOpen ? "" : node.key)} disabled={operationBusy}><DotsThree size={18} /></button> : <span className="file-more-placeholder" aria-hidden="true" />}
              {menuOpen && (
                <div className="row-action-menu" role="menu">
                  {previewKind && <button role="menuitem" onClick={() => { setMenuPath(""); onPreview(output, file); }}><Eye size={16} />预览</button>}
                  <button role="menuitem" onClick={() => { setMenuPath(""); onOpenLocation(output, file); }}><FolderOpen size={16} />打开所在位置</button>
                  {!isFolder && <button role="menuitem" onClick={() => { setMenuPath(""); onGithubUpload({ ...output, githubCurrentRelativePath: relativePath }); }}><GithubLogo size={16} weight="fill" />上传到 GitHub</button>}
                  {output.deletable !== false && output.status !== "已删除" && !isFolder && file.status !== "已删除" && <button role="menuitem" className="danger-menu-item" onClick={() => { setMenuPath(""); onRequestDeleteFile(output, file); }}><Trash size={16} />删除</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {output.statusTone === "warning" && (
        <div className="inline-warning">
          <Warning size={18} weight="fill" />
          <div><strong>最后路径不可访问</strong><span>记录、历史版本和活动日志仍会保留。</span></div>
          <button onClick={() => onToast("请选择新的文件路径（原型）")}>更新路径</button>
        </div>
      )}
      {output.category === "程序" && (
        <div className="program-note">
          <TerminalWindow size={18} />
          <div><strong>程序完整性</strong><span>{output.statusDetail}。自动检测不会执行程序。</span></div>
        </div>
      )}
    </section>
  );
}

function OverviewTab({ output, onTask, onDetect, onMark, onOpenLocation, onGithubUpload, onRequestDeleteProject, onToast, menuOpen, setMenuOpen, operationBusy }) {
  const outputDeleted = output.status === "已删除";
  const outputProtected = !outputDeleted && output.deletable === false;
  const deleteActionState = outputDeleted ? "deleted" : outputProtected ? "protected" : operationBusy ? "busy" : "ready";
  const deleteActionLabel = deleteActionState === "busy"
    ? "正在处理…"
    : deleteActionState === "deleted"
      ? "已删除"
      : deleteActionState === "protected"
        ? "不可删除"
        : "删除产出项";
  const deleteActionHelp = deleteActionState === "busy"
    ? "当前操作完成后可继续。"
    : deleteActionState === "deleted"
      ? "本地内容已移入回收站；产出记录与历史仍保留。"
      : deleteActionState === "protected"
        ? "受保护路径或无法安全确认删除范围。"
        : "本地内容将移入 Windows 回收站；产出记录与历史仍保留。";
  const deleteActionDisabled = deleteActionState !== "ready";
  return (
    <div className="inspector-scroll">
      <section className="overview-section">
        <div className="section-title-inline"><h3>系统检测</h3><span>最近：{output.lastChecked}</span></div>
        <div className={cx("detection-card", output.statusTone)}>
          <span className="detection-icon">
            {output.statusTone === "success" ? <CheckCircle size={23} weight="fill" /> : output.statusTone === "warning" ? <Warning size={23} weight="fill" /> : <ClockCounterClockwise size={23} />}
          </span>
          <div><strong>{output.status}</strong><span>{output.statusDetail}</span></div>
          <button aria-label="查看最近检测日志" onClick={() => onToast("已打开最近检测日志")}><ArrowSquareOut size={17} /></button>
        </div>
      </section>
      <section className="overview-section">
        <h3>我的标记</h3>
        <button className="mark-row" onClick={onMark}>
          <StatusPill tone="accent" outlined>{output.mark}</StatusPill>
          <span>仅由你维护，不会被系统检测覆盖</span><PencilSimple size={17} />
        </button>
      </section>
      <section className="overview-section source-section">
        <h3>源任务</h3>
        <button className="source-task-row" onClick={onTask} data-testid="open-source-task">
          <span className="source-icon"><ChatCircleText size={20} /></span>
          <span className="source-copy"><strong>{output.source.task}</strong><small>{output.source.project} · {output.source.threadId}</small></span>
          <span className="open-task-label">打开任务 <ArrowSquareOut size={15} /></span>
        </button>
      </section>
      <div className="inspector-actions">
        <div className="detect-action-wrap">
          <button className="primary-button" onClick={() => setMenuOpen(!menuOpen)} data-testid="detect-menu-button"><Lightning size={17} />检测状态<CaretDown size={13} /></button>
          {menuOpen && (
            <div className="detect-menu">
              {Object.entries(DETECTION_MODES).map(([key, mode]) => (
                <button key={key} onClick={() => onDetect(key)}>
                  <span className="menu-icon">{key === "quick" ? <Lightning size={18} /> : key === "full" ? <ListChecks size={18} /> : <SlidersHorizontal size={18} />}</span>
                  <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="secondary-button github-upload-entry" onClick={() => onGithubUpload(output)} disabled={operationBusy}><GithubLogo size={17} weight="fill" />上传个人 GitHub</button>
        <button className="secondary-button" onClick={() => onOpenLocation(output)} disabled={operationBusy}><FolderOpen size={17} />打开位置</button>
        <div className="delete-output-action">
          <button
            className={cx("secondary-button", "delete-output-entry", `is-${deleteActionState}`)}
            onClick={() => onRequestDeleteProject(output)}
            disabled={deleteActionDisabled}
            aria-describedby="delete-output-help"
            title={deleteActionHelp}
            data-testid="delete-output-item"
          >
            {deleteActionState === "busy" ? <SpinnerGap size={17} className="spin" /> : <Trash size={17} />}
            {deleteActionLabel}
          </button>
          <small id="delete-output-help" className={cx("delete-output-help", `is-${deleteActionState}`)}>{deleteActionHelp}</small>
        </div>
      </div>
      <section className="overview-section compact-details">
        <h3>基本信息</h3>
        <div className="detail-grid">
          <span>类型</span><strong>{output.type}</strong>
          <span>当前版本</span><strong>{output.version}</strong>
          <span>产出时间</span><strong>{output.source.created}</strong>
          <span>来源项目</span><strong>{output.source.project}</strong>
        </div>
      </section>
    </div>
  );
}

function ContentTab({ output, onToast }) {
  return (
    <div className="inspector-scroll compact-tab">
      <div className="summary-block"><span>内容摘要</span><strong>{output.files.length} 个当前可追踪条目</strong><p>程序产出以文件夹为一个产出项，内部关键文件在此处独立展示状态。</p></div>
      <div className="mini-file-list">
        {output.files.map((file) => (
          <button key={file.name} onClick={() => onToast(file.name + " 已选中")}>
            <span className={cx("file-kind", file.kind)}><FileIcon kind={file.kind} size={18} /></span>
            <span><strong>{file.name}</strong><small>{file.label}</small></span><span className="mini-state">{file.status}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VersionsTab({ output, onTask, onToast }) {
  return (
    <div className="inspector-scroll compact-tab">
      <div className="tab-intro"><div><strong>版本历史</strong><span>{output.versions.length} 个记录</span></div><button onClick={() => onToast("版本比较（原型）")}>比较版本</button></div>
      <div className="version-list">
        {output.versions.map((item, index) => (
          <article className={cx("version-item", item.current && "current")} key={item.version}>
            <div className="version-line"><span className="version-node" />{index < output.versions.length - 1 && <span className="version-stem" />}</div>
            <div className="version-copy">
              <div className="version-topline"><strong>{item.version}</strong>{item.current && <span>当前版本</span>}<small>{item.time}</small></div>
              <p>{item.note}</p>
              <div className="version-source">{(item.source || output.source).project} / {(item.source || output.source).task}</div>
              <div className="version-path" title={item.current ? output.path : output.path + "\\历史版本\\" + item.version}><Folder size={12} />{item.current ? output.path : output.path + "\\历史版本\\" + item.version}</div>
              <div className="version-footer"><span className={item.status.includes("缺失") ? "warning-text" : ""}>{item.status}</span><button onClick={() => onTask(item.source || output.source)}>查看源任务 <ArrowSquareOut size={13} /></button></div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ActivityTab({ output, onTask, filter, setFilter }) {
  const events = output.activity.filter((event) => filter === "全部活动" || event.title.includes("检测"));
  return (
    <div className="inspector-scroll compact-tab">
      <div className="activity-filter"><button onClick={() => setFilter(filter === "全部活动" ? "仅系统检测" : "全部活动")}>{filter}<CaretDown size={12} /></button><span>{events.length} 条记录</span></div>
      <div className="activity-list">
        {events.map((event, index) => (
          <article className="activity-item" key={event.time + index}>
            <div className="activity-time">{event.time}</div>
            <div className="activity-rail"><span className={cx("activity-node", event.tone)} />{index < events.length - 1 && <span className="activity-stem" />}</div>
            <div className="activity-copy"><strong>{event.title}</strong><p>{event.detail}</p><button onClick={() => onTask(event.source || output.source)}>源任务 <ArrowSquareOut size={13} /></button></div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Inspector({ output, activeTab, setActiveTab, activityFilter, setActivityFilter, onTask, onDetect, onMark, onOpenLocation, onGithubUpload, onPriority, onRequestDeleteProject, operationBusy, onToast }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const tabs = ["概览", "内容", "版本", "活动"];
  const canDeleteProject = output.deletable !== false && output.status !== "已删除";
  useEffect(() => setProjectMenuOpen(false), [output.id]);
  return (
    <section className="inspector">
      <div className="inspector-header">
        <OutputIcon output={output} large />
        <div className="inspector-title-copy">
          <div className="inspector-title-line"><h2>{output.title}</h2><div className="project-menu-wrap"><button className="icon-button" aria-label="更多产出项操作" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)} disabled={operationBusy}><DotsThree size={20} /></button>{projectMenuOpen && <div className="project-action-menu"><div className="project-menu-label">设置优先级</div>{PRIORITY_OPTIONS.map((priority) => <button className={priorityValue(output) === priority.value ? "active" : ""} key={priority.value} onClick={() => { setProjectMenuOpen(false); onPriority(output.id, priority.value); }}><Flag size={15} weight={priority.value === "none" ? "regular" : "fill"} /><span>{priority.label}</span>{priorityValue(output) === priority.value && <Check size={14} />}</button>)}<div className="project-menu-divider" /><button onClick={() => { setProjectMenuOpen(false); onGithubUpload(output); }}><GithubLogo size={15} weight="fill" /><span>上传个人 GitHub</span></button>{canDeleteProject && <><div className="project-menu-divider" /><button className="danger-menu-item" onClick={() => { setProjectMenuOpen(false); onRequestDeleteProject(output); }}><Trash size={15} /><span>删除产出项</span></button></>}</div>}</div></div>
          <p>{output.source.project} / {output.source.task}</p>
          <div className="inspector-header-path" title={output.path}>{output.path}</div>
          <div className="inspector-badges"><PriorityBadge output={output} /><span>{output.version} · {output.source.created}</span></div>
        </div>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="产出项详情">
        {tabs.map((tab) => <button role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} key={tab} onClick={() => { setMenuOpen(false); setActiveTab(tab); }}>{tab}</button>)}
      </div>
      {activeTab === "概览" && <OverviewTab output={output} onTask={() => onTask(output.source)} onDetect={(mode) => { setMenuOpen(false); onDetect(mode); }} onMark={onMark} onOpenLocation={onOpenLocation} onGithubUpload={onGithubUpload} onRequestDeleteProject={onRequestDeleteProject} onToast={onToast} menuOpen={menuOpen} setMenuOpen={setMenuOpen} operationBusy={operationBusy} />}
      {activeTab === "内容" && <ContentTab output={output} onToast={onToast} />}
      {activeTab === "版本" && <VersionsTab output={output} onTask={onTask} onToast={onToast} />}
      {activeTab === "活动" && <ActivityTab output={output} onTask={() => onTask(output.source)} filter={activityFilter} setFilter={setActivityFilter} />}
    </section>
  );
}

function ScanControls({ scanState, scanRequestPending, onScan }) {
  const scan = scanState.scan;
  const running = scanRequestPending || scan?.state === "running";
  let title = "正在读取自动抓取状态";
  let detail = "正在连接本地扫描服务…";
  let tone = "neutral";

  if (scanRequestPending) {
    title = "正在抓取 Codex 产出";
    detail = "正在扫描任务记录与产出路径…";
    tone = "running";
  } else if (scanState.phase === "error") {
    title = "自动抓取状态不可用";
    detail = scanState.error || "暂时无法读取扫描状态";
    tone = "warning";
  } else if (scan?.state === "running") {
    title = "正在抓取 Codex 产出";
    const progress = Number.isFinite(scan.scannedTasks) ? `已检查 ${scan.scannedTasks} 个任务` : "扫描仍在进行";
    detail = scan.message || progress;
    tone = "running";
  } else if (scan?.state === "complete") {
    title = "自动抓取已完成";
    const finishedAt = formatScanTime(scan.finishedAt);
    const stats = [];
    if (Number.isFinite(scan.imported)) stats.push(`新增 ${scan.imported}`);
    if (Number.isFinite(scan.updated)) stats.push(`更新 ${scan.updated}`);
    detail = [finishedAt ? `最近扫描 ${finishedAt}` : "", ...stats].filter(Boolean).join(" · ") || "最近一次扫描已完成";
    tone = "success";
  } else if (scan?.state === "error") {
    title = "上次自动抓取未完成";
    const finishedAt = formatScanTime(scan.finishedAt);
    detail = scan.message || (finishedAt ? `最近尝试 ${finishedAt}` : "请重新扫描");
    tone = "warning";
  } else if (scan?.state === "idle") {
    title = "自动抓取已启用";
    const finishedAt = formatScanTime(scan.finishedAt);
    detail = finishedAt ? `最近扫描 ${finishedAt}` : "尚无扫描记录";
  }

  return (
    <div className="scan-controls" aria-live="polite">
      <div className={cx("scan-status", `scan-${tone}`)} title={detail}>
        <span className="scan-status-icon">{running ? <SpinnerGap size={17} className="spin" /> : <ArrowClockwise size={17} />}</span>
        <span className="scan-status-copy"><strong>{title}</strong><small>{detail}</small></span>
      </div>
      <button className="scan-now-button" onClick={onScan} disabled={running} data-testid="scan-now">
        {running ? <SpinnerGap size={16} className="spin" /> : <ArrowClockwise size={16} />}
        {running ? "扫描中" : "立即扫描"}
      </button>
    </div>
  );
}

function DataStateView({ status, error, onRetry, scanState, scanRequestPending, onScan }) {
  const loading = status === "loading";
  const empty = status === "ready";
  return (
    <main className="main-view outputs-view">
      <div className="page-heading">
        <div><h1>产出项</h1><p>汇总由 Codex 产出的文件、程序与版本记录</p></div>
        <ScanControls scanState={scanState} scanRequestPending={scanRequestPending} onScan={onScan} />
      </div>
      <section className="data-state-panel" role={loading ? "status" : "alert"} aria-live="polite">
        {loading ? <SpinnerGap size={32} className="spin" /> : empty ? <Stack size={32} /> : <Warning size={32} weight="fill" />}
        <h2>{loading ? "正在加载产出项" : empty ? "还没有产出项" : "无法加载产出项"}</h2>
        <p>{loading ? "正在连接本地产出项服务…" : empty ? "本地服务已连接，但目前没有登记的产出文件。" : error}</p>
        {!loading && !empty && <button className="secondary-button" onClick={onRetry}>重新加载</button>}
      </section>
    </main>
  );
}

function OutputsView({ outputs, selectedId, setSelectedId, selectedIds, onToggleSelection, onToggleAll, onClearSelection, activeTab, setActiveTab, activityFilter, setActivityFilter, query, setQuery, typeFilter, setTypeFilter, onTask, onDetect, onMark, onPreview, onOpenLocation, onGithubUpload, onPriority, onRequestDeleteFile, onRequestDeleteProject, onBatchDetect, onBatchDelete, onBatchPriority, batchAction, operationBusy, onToast, scanState, scanRequestPending, onScan }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [batchPriorityOpen, setBatchPriorityOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const categories = ["全部类型", "程序", "文档", "演示", "表格"];
  const groups = useMemo(() => buildTaskGroups(outputs, query, typeFilter), [outputs, query, typeFilter]);
  const filteredOutputs = useMemo(() => groups.flatMap((group) => group.visibleItems), [groups]);
  const selectableIds = useMemo(() => filteredOutputs.slice(0, MAX_BATCH_SELECTION).map((item) => item.id), [filteredOutputs]);
  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const selected = filteredOutputs.find((item) => item.id === selectedId) || filteredOutputs[0] || null;
  const healthyCount = outputs.filter((item) => item.statusTone === "success").length;
  const attentionCount = outputs.filter((item) => item.statusTone === "warning").length;
  const selectedCount = selectedIds.size;

  useEffect(() => {
    const nextSelectedId = selected?.id || "";
    if (nextSelectedId === selectedId) return;
    setSelectedId(nextSelectedId);
    setActiveTab("概览");
  }, [selected?.id, selectedId, setActiveTab, setSelectedId]);

  useEffect(() => {
    onClearSelection();
    setBatchPriorityOpen(false);
  }, [query, typeFilter]);

  const exitBatchMode = () => {
    onClearSelection();
    setBatchPriorityOpen(false);
    setBatchMode(false);
  };

  return (
    <main className="main-view outputs-view">
      <div className="page-heading">
        <div><h1>产出项</h1><p>汇总由 Codex 产出的文件、程序与版本记录</p></div>
        <div className="heading-actions">
          <div className="heading-meta"><span><CheckCircle size={16} />{healthyCount} 项正常</span><span><Warning size={16} />{attentionCount} 项需关注</span></div>
          <ScanControls scanState={scanState} scanRequestPending={scanRequestPending} onScan={onScan} />
        </div>
      </div>
      {batchMode ? (
        <div className="toolbar batch-toolbar" aria-live="polite">
          <strong>已选择 {selectedCount} 项</strong>
          {batchAction?.state === "running" && <span className="batch-progress"><SpinnerGap size={16} className="spin" />{batchAction.label}（{batchAction.completed || 0}/{batchAction.total || selectedCount}）</span>}
          <div className="toolbar-spacer" />
          <button className="batch-action-button" onClick={() => onToggleAll(selectableIds, !allVisibleSelected)} disabled={operationBusy || !selectableIds.length}><Check size={17} />{allVisibleSelected ? "取消全选" : filteredOutputs.length > MAX_BATCH_SELECTION ? `选择前 ${MAX_BATCH_SELECTION} 项` : "全选"}</button>
          <button className="batch-action-button" onClick={onBatchDetect} disabled={operationBusy || !selectedCount}><ListChecks size={17} />批量检测</button>
          <div className="filter-wrap">
            <button className="batch-action-button" onClick={() => setBatchPriorityOpen((open) => !open)} disabled={operationBusy || !selectedCount}><Flag size={17} />设置优先级<CaretDown size={12} /></button>
            {batchPriorityOpen && <div className="filter-menu batch-priority-menu">{PRIORITY_OPTIONS.map((priority) => <button key={priority.value} onClick={() => { setBatchPriorityOpen(false); onBatchPriority(priority.value); }}><span>{priority.label}</span></button>)}</div>}
          </div>
          <button className="batch-action-button danger" onClick={onBatchDelete} disabled={operationBusy || !selectedCount}><Trash size={17} />批量删除</button>
          <button className="batch-clear-button" onClick={exitBatchMode} disabled={operationBusy} data-testid="exit-batch-mode"><X size={15} />退出批量操作</button>
        </div>
      ) : (
        <div className="toolbar">
          <div className="search-box">
            <MagnifyingGlass size={18} />
            <input aria-label="搜索产出项" value={query} onChange={(event) => { onClearSelection(); setQuery(event.target.value); }} placeholder="搜索产出项、项目或源任务" />
            {query && <button aria-label="清除搜索" onClick={() => { onClearSelection(); setQuery(""); }}><X size={15} /></button>}
          </div>
          <div className="toolbar-spacer" />
          <button className="batch-mode-button" onClick={() => { onClearSelection(); setBatchMode(true); }} data-testid="enter-batch-mode"><ListChecks size={17} />批量操作</button>
          <div className="filter-wrap">
            <button className="filter-button" onClick={() => setFilterOpen(!filterOpen)}><SlidersHorizontal size={17} />{typeFilter}<CaretDown size={12} /></button>
            {filterOpen && <div className="filter-menu">{categories.map((category) => <button key={category} className={typeFilter === category ? "active" : ""} onClick={() => { onClearSelection(); setTypeFilter(category); setFilterOpen(false); }}><span>{category}</span>{typeFilter === category && <Check size={15} />}</button>)}</div>}
          </div>
        </div>
      )}
      <div className={cx("workspace-grid", batchMode && "batch-mode")}>
        <OutputList groups={groups} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setActiveTab("概览"); }} selectedIds={selectedIds} onToggleSelection={onToggleSelection} onToggleAll={onToggleAll} onTask={onTask} batchMode={batchMode} selectionBusy={operationBusy} selectionLimit={MAX_BATCH_SELECTION} />
        {selected ? <>
          <FileTree key={selected.id} output={selected} onToast={onToast} onPreview={onPreview} onOpenLocation={onOpenLocation} onGithubUpload={onGithubUpload} onRequestDeleteFile={onRequestDeleteFile} operationBusy={operationBusy} />
          <Inspector output={selected} activeTab={activeTab} setActiveTab={setActiveTab} activityFilter={activityFilter} setActivityFilter={setActivityFilter} onTask={onTask} onDetect={onDetect} onMark={onMark} onOpenLocation={onOpenLocation} onGithubUpload={onGithubUpload} onPriority={onPriority} onRequestDeleteProject={onRequestDeleteProject} operationBusy={operationBusy} onToast={onToast} />
        </> : <section className="filtered-detail-empty"><MagnifyingGlass size={30} /><strong>没有可显示的详情</strong><span>调整搜索关键词或类型筛选后再试。</span></section>}
      </div>
    </main>
  );
}

function createThreadMessages(output, source) {
  return [
    { role: "user", text: output.category === "程序" ? "请修复批量导出时同名文件被覆盖的问题，并更新启动器。" : "请完成“" + output.title + "”并保留可追溯的产出版本。" },
    { role: "assistant", text: output.category === "程序" ? "已完成任务“" + source.task + "”，修复同名文件处理逻辑并同步更新启动器和说明。" : "已完成 " + output.title + "，当前版本为 " + output.version + "。产出路径与版本记录已登记。", attachment: true }
  ];
}

function TaskView({ output, source, messages, setMessages, draft, setDraft, onBack, onToast }) {
  const sendMessage = () => {
    const value = draft.trim();
    if (!value) return;
    setMessages((current) => [...current, { role: "user", text: value }]);
    setDraft("");
    window.setTimeout(() => setMessages((current) => [...current, { role: "assistant", text: "收到。我会基于 " + output.version + " 继续处理，并把新的产出记录到“产出项”。" }]), 550);
  };
  return (
    <main className="main-view task-view" data-testid="task-view">
      <div className="task-top">
        <button className="back-to-outputs" onClick={onBack} data-testid="back-to-outputs"><ArrowLeft size={17} />返回产出项</button>
        <div className="task-identity"><span>{source.project}</span><h1>{source.task}</h1></div>
        <button className="icon-button" aria-label="任务菜单" onClick={() => onToast("任务菜单（原型）")}><DotsThree size={21} /></button>
      </div>
      <div className="task-body">
        <div className="task-context-strip"><LinkSimple size={16} /><span>从产出项打开</span><strong>{output.title} · {output.version}</strong><button onClick={onBack}>查看产出项</button></div>
        <div className="conversation">
          <div className="task-date">今天</div>
          {messages.map((message, index) => (
            <article className={cx("message", message.role)} key={index}>
              <div className="message-avatar">{message.role === "user" ? <UserCircle size={26} weight="fill" /> : <span className="codex-mark">C</span>}</div>
              <div className="message-content">
                <div className="message-author">{message.role === "user" ? "你" : "Codex"} <span>{index === 0 ? "16:31" : "16:40"}</span></div>
                <p>{message.text}</p>
                {message.attachment && (
                  <button className="message-output-card" onClick={onBack}>
                    <OutputIcon output={output} /><span><strong>{output.title}</strong><small>{output.type} · {output.version}</small></span>
                    <StatusPill tone={output.statusTone}>{output.status}</StatusPill><ArrowSquareOut size={16} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder="继续该任务..." rows={2} />
          <div className="composer-footer">
            <button onClick={() => onToast("添加附件（原型）")}>＋</button>
            <button onClick={() => onToast("当前为带批准模式（原型）")}><GearSix size={15} />带我批准</button><span />
            <button onClick={() => onToast("模型选择（原型）")}><Lightning size={14} weight="fill" />5.6 Sol<CaretDown size={11} /></button>
            <button className="send-button" aria-label="发送消息" onClick={sendMessage}><PaperPlaneTilt size={17} weight="fill" /></button>
          </div>
        </div>
      </div>
    </main>
  );
}

function PreviewModal({ state, operationBusy, onRetry, onOpenLocation, onClose }) {
  const modalRef = useModalFocus(onClose, false);
  const preview = state.preview;
  const isImage = state.phase === "ready" && preview?.kind === "image" && PREVIEW_IMAGE_MIME_TYPES.has(preview.mimeType);
  const isText = state.phase === "ready" && preview?.kind === "text" && typeof preview.text === "string";
  const imageSource = isImage && preview.bytesBase64
    ? `data:${preview.mimeType};base64,${preview.bytesBase64}`
    : "";
  const title = preview?.name || state.file?.name || "文件预览";
  const relativePath = preview?.relativePath || state.file?.relativePath || state.file?.name || "";
  const metadata = preview
    ? [preview.mimeType, formatFileSize(preview.sizeBytes), preview.width && preview.height ? `${preview.width} × ${preview.height}` : ""].filter(Boolean).join(" · ")
    : relativePath;

  return (
    <div className="modal-backdrop preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={modalRef} className="modal preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header className="preview-header">
          <span className="preview-title-icon">{isImage ? <FileImage size={22} /> : <FileText size={22} />}</span>
          <div><h2 id="preview-title">预览文件</h2><strong>{title}</strong><p title={relativePath}>{metadata}</p></div>
          <button className="icon-button" aria-label="关闭预览" onClick={onClose}><X size={20} /></button>
        </header>
        <div className={cx("preview-stage", isText && "text-preview-stage")}>
          {state.phase === "loading" && <div className="preview-state" role="status"><SpinnerGap size={31} className="spin" /><strong>正在安全读取文件</strong><span>仅读取已登记的文件，不会运行其中的内容。</span></div>}
          {state.phase === "error" && <div className="preview-state preview-error" role="alert"><Warning size={31} weight="fill" /><strong>无法预览此文件</strong><span>{state.error}</span><button className="secondary-button" onClick={onRetry}>重试</button></div>}
          {isImage && <img className="preview-image" src={imageSource} alt={title} />}
          {isText && <pre className="preview-text" tabIndex={0}>{preview.text}</pre>}
          {state.phase === "ready" && !isImage && !isText && <div className="preview-state preview-error" role="alert"><Warning size={31} weight="fill" /><strong>预览数据不可用</strong><span>服务没有返回受支持的图片或文本内容。</span></div>}
        </div>
        <footer className="preview-footer">
          <span>{isText ? "仅以纯文本显示，不会运行文件内容。" : preview?.truncated ? "文件内容已按安全上限截断。" : "仅预览已登记文件，不会修改原文件。"}</span>
          {preview?.truncated && <em>内容已截断</em>}
          <button className="secondary-button" onClick={() => onOpenLocation(state.output, state.file)} disabled={operationBusy}><FolderOpen size={17} />打开所在位置</button>
          <button className="primary-button preview-close-button" onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>
  );
}

function DetectionModal({ mode, output, stage, result, onStart, onClose, onViewLog }) {
  const info = DETECTION_MODES[mode];
  const [progress, setProgress] = useState(0);
  const modalRef = useModalFocus(onClose, stage === "running");
  const warningResult = (result?.tone || output.statusTone) === "warning";
  const passedCount = result?.passed ?? 0;
  const warningCount = result?.warnings ?? 0;
  const failedCount = result?.failed ?? 0;
  useEffect(() => {
    if (stage !== "running") { setProgress(stage === "result" ? 100 : 0); return undefined; }
    const interval = window.setInterval(() => setProgress((value) => Math.min(value + 3, 92)), 140);
    return () => window.clearInterval(interval);
  }, [stage]);
  return (
    <div className="modal-backdrop">
      <section ref={modalRef} className="modal detection-modal" role="dialog" aria-modal="true" aria-labelledby="detection-title">
        <div className="modal-header">
          <div className="modal-title-icon"><ListChecks size={21} /></div>
          <div><h2 id="detection-title">{info.label}</h2><p>{output.title} · {output.version}</p></div>
          {stage !== "running" && <button className="icon-button" aria-label="关闭检测窗口" onClick={onClose}><X size={19} /></button>}
        </div>
        {stage === "ready" && (
          <>
            <div className="modal-copy">
              <p>{info.description}。检测结果会更新“系统检测”并写入活动日志，不会修改“我的标记”。</p>
              <div className="checklist">{info.items.map((item) => <div key={item}><span /><strong>{item}</strong></div>)}</div>
              {output.category === "程序" && <div className="result-note"><Check size={16} />安全检测不会启动或执行程序。</div>}
            </div>
            <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={onStart} data-testid="start-detection"><Play size={16} weight="fill" />开始检测</button></div>
          </>
        )}
        {stage === "running" && (
          <div className="detection-running"><SpinnerGap size={34} className="spin" /><h3>正在检测产出项</h3><p>{info.items[Math.min(Math.floor(progress / 25), info.items.length - 1)]}</p><div className="progress-track" role="progressbar" aria-label="检测进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><span style={{ width: progress + "%" }} /></div><strong>{progress}%</strong></div>
        )}
        {stage === "result" && (
          <>
            <div className={cx("detection-result", warningResult && "warning")} >
              {warningResult ? <Warning size={38} weight="fill" /> : <CheckCircle size={38} weight="fill" />}
              <h3>检测完成：{result?.title || output.status}</h3>
              <p>{result?.detail || output.statusDetail}</p>
              <div className="result-stats"><div><strong>{passedCount}</strong><span>通过</span></div><div><strong>{warningCount}</strong><span>警告</span></div><div><strong>{failedCount}</strong><span>失败</span></div></div>
              <div className="result-note"><Check size={16} />“我的标记”仍为“{output.mark}”</div>
            </div>
            <div className="modal-actions"><button className="secondary-button" onClick={onViewLog}>查看检测日志</button><button className="primary-button" onClick={onClose} data-testid="finish-detection">完成</button></div>
          </>
        )}
        {stage === "error" && (
          <>
            <div className="detection-result warning"><Warning size={38} weight="fill" /><h3>检测未完成</h3><p>{result?.detail || "本地检测服务没有返回结果；原状态已保留。"}</p><div className="result-note"><Check size={16} />未修改系统状态或“我的标记”</div></div>
            <div className="modal-actions"><button className="primary-button" onClick={onClose}>关闭</button></div>
          </>
        )}
      </section>
    </div>
  );
}

function MarkModal({ output, saving, onSave, onClose }) {
  const marks = ["使用中", "待确认", "需要修复", "已定稿", "已归档", "已废弃"];
  const [mark, setMark] = useState(output.mark);
  const [note, setNote] = useState("");
  const modalRef = useModalFocus(onClose, saving);
  return (
    <div className="modal-backdrop">
      <section ref={modalRef} className="modal mark-modal" role="dialog" aria-modal="true" aria-labelledby="mark-modal-title">
        <div className="modal-header"><div className="modal-title-icon"><PencilSimple size={20} /></div><div><h2 id="mark-modal-title">编辑我的标记</h2><p>{output.title}</p></div><button className="icon-button" aria-label="关闭标记窗口" onClick={onClose} disabled={saving}><X size={19} /></button></div>
        <div className="modal-copy">
          <div className="read-only-status"><span>当前系统检测</span><StatusPill tone={output.statusTone}>{output.status}</StatusPill></div>
          <label className="field-label">选择标记</label>
          <div className="mark-options">{marks.map((item) => <button className={mark === item ? "selected" : ""} onClick={() => setMark(item)} key={item} disabled={saving}><span className="mark-radio">{mark === item && <i />}</span>{item}</button>)}</div>
          <label className="field-label" htmlFor="mark-note">备注（可选）</label>
          <textarea id="mark-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录为何修改此标记..." disabled={saving} />
          <p className="helper-copy">保存后会写入活动日志；自动检测不会覆盖这个标记。</p>
        </div>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={saving}>取消</button><button className="primary-button" onClick={() => onSave(mark, note)} data-testid="save-mark" disabled={saving}>{saving ? "正在保存…" : "保存标记"}</button></div>
      </section>
    </div>
  );
}

const GITHUB_UPLOAD_SCOPES = [
  { value: "whole", label: "整个产出项", note: "上传全部已登记文件与目录。", risk: "完整同步", tone: "safe" },
  { value: "current", label: "仅发布包", note: "只上传当前版本的主要文件。", risk: "可能遗漏依赖", tone: "attention" },
  { value: "custom", label: "自定义选择", note: "手动选择要上传的文件或目录。", risk: "自行核对", tone: "attention" },
  { value: "binaries", label: "仅发布构建产物", note: "只上传可执行文件与安装包。", risk: "兼容性风险", tone: "warning" }
];

function repoSlug(value) {
  return String(value || "output-item").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "output-item";
}

function mergeCanonicalGithubConfig(current, canonical) {
  if (!canonical || typeof canonical !== "object") return current;
  const destination = canonical.destination || {};
  const upload = canonical.upload || {};
  return {
    ...current,
    repositoryMode: destination.mode || current.repositoryMode,
    owner: destination.owner || current.owner,
    repository: destination.repo || current.repository,
    visibility: destination.visibility || current.visibility,
    destinationPath: destination.path || current.destinationPath,
    scope: upload.scope || current.scope,
    selectedPaths: Array.isArray(upload.customPaths) ? upload.customPaths : current.selectedPaths,
    currentRelativePath: upload.currentRelativePath || current.currentRelativePath,
    writeMode: canonical.publishMode === "direct" ? "direct-main" : canonical.publishMode || current.writeMode,
    branch: canonical.branch || current.branch,
    license: canonical.license || current.license,
    includeReadme: canonical.generateReadme === true || (canonical.generateReadme === undefined && current.includeReadme),
    protectMain: canonical.protectMain === true || (canonical.protectMain === undefined && current.protectMain)
  };
}

const GITHUB_PROTECTED_SOURCE_GUIDANCE = "安装/保护目录不可直接上传，请选择普通工作目录中的正式发行项 codex-output-items-public。";

export function formatGithubPreflightFailure(message) {
  const detail = String(message || "").trim();
  if (/GITHUB_SOURCE_UNSAFE/i.test(detail) || /产出项源路径与扩展、Codex、系统或程序保护目录重叠/.test(detail)) {
    return GITHUB_PROTECTED_SOURCE_GUIDANCE;
  }
  return detail || "上传前检查未完成，请修正问题后重新执行检查。";
}

export function deriveGithubCliAccountAction(setup = {}, authenticated = false) {
  if (authenticated) {
    return { label: "切换说明", copyLabel: "账号切换命令", command: "gh auth switch --hostname github.com" };
  }
  return {
    label: "复制登录命令",
    copyLabel: "GitHub 登录命令",
    command: String(setup.loginCommand || "gh auth login --web --hostname github.com")
  };
}

export function deriveGithubUploadGate({
  contextPhase = "ready",
  contextError = "",
  cliReady = false,
  accountReady = false,
  preflight = {},
  confirmed = false,
  jobActive = false
} = {}) {
  const state = String(preflight?.state || "idle").toLowerCase();
  const blockers = Array.isArray(preflight?.blockers) ? preflight.blockers : [];
  const blocked = state === "blocked" || blockers.length > 0;
  const passed = ["passed", "warning"].includes(state) && Boolean(preflight?.id) && !blocked;

  if (contextPhase === "loading") {
    return { phase: "context-loading", action: "preflight", label: "执行上传前检查", disabled: true, tone: "neutral", message: "正在检查 GitHub CLI 与登录状态…" };
  }
  if (contextPhase === "error") {
    return { phase: "context-error", action: "preflight", label: "执行上传前检查", disabled: true, tone: "danger", message: contextError || "GitHub 状态不可用，请稍后重试。" };
  }
  if (!cliReady) {
    return { phase: "needs-cli", action: "preflight", label: "执行上传前检查", disabled: true, tone: "warning", message: "请先安装 GitHub CLI，之后才能检查和上传。" };
  }
  if (!accountReady) {
    return { phase: "needs-login", action: "preflight", label: "执行上传前检查", disabled: true, tone: "warning", message: "GitHub CLI 凭据未登录或已失效，请先复制登录命令并完成登录。" };
  }
  if (state === "running") {
    return { phase: "checking", action: "preflight", label: "正在检查…", disabled: true, tone: "neutral", message: "正在执行上传前检查，请稍候。" };
  }
  if (state === "error") {
    return { phase: "error", action: "preflight", label: "重新执行检查", disabled: false, tone: "danger", message: formatGithubPreflightFailure(preflight?.message) };
  }
  if (blocked) {
    return { phase: "blocked", action: "preflight", label: "重新执行检查", disabled: false, tone: "danger", message: "上传前检查发现阻断项。请处理右侧列出的敏感文件或超大文件后重新检查。" };
  }
  if (!passed) {
    return { phase: "idle", action: "preflight", label: "执行上传前检查", disabled: false, tone: "neutral", message: "步骤 1：先执行上传前检查，不会立即上传任何文件。" };
  }
  if (!confirmed) {
    return {
      phase: "awaiting-confirmation",
      action: "upload",
      label: "开始上传",
      disabled: true,
      tone: state === "warning" ? "warning" : "success",
      message: state === "warning" ? "检查有提示，请核对右侧风险后勾选上传确认。" : "检查通过。步骤 2：请勾选“我已确认上传范围和仓库权限”。"
    };
  }
  if (jobActive) {
    return { phase: "starting", action: "upload", label: "正在启动…", disabled: true, tone: "neutral", message: "正在创建 GitHub 上传任务…" };
  }
  return {
    phase: "ready",
    action: "upload",
    label: "开始上传",
    disabled: false,
    tone: state === "warning" ? "warning" : "success",
    message: state === "warning" ? "已确认检查提示，可以开始上传。" : "范围和权限已确认，可以开始上传。"
  };
}

function GithubUploadModal({ output, onClose, onToast }) {
  const modalRef = useModalFocus(onClose, false);
  const singleCurrentPath = output.githubCurrentRelativePath || (output.files?.length === 1 && output.files[0]?.kind !== "folder"
    ? (output.files[0].relativePath || output.files[0].name || "")
    : "");
  const [contextState, setContextState] = useState({ phase: "loading", value: null, error: "" });
  const [config, setConfig] = useState(() => ({
    repositoryMode: "new",
    owner: "",
    repository: repoSlug(output.title),
    visibility: "public",
    scope: "whole",
    selectedPaths: [],
    currentRelativePath: singleCurrentPath,
    writeMode: "branch-pr",
    branch: "",
    destinationPath: "",
    license: "none",
    includeReadme: true,
    protectMain: true
  }));
  const [preflight, setPreflight] = useState({ id: "", state: "idle", message: "点击预检后，将扫描敏感信息与 GitHub 文件大小限制。", sensitive: [], blockers: [], warnings: [], large: [], totalFiles: 0, totalBytes: 0 });
  const [confirmed, setConfirmed] = useState(false);
  const [customSearch, setCustomSearch] = useState("");
  const [job, setJob] = useState(null);
  const [actionError, setActionError] = useState("");
  const jobTerminal = job && ["success", "partial", "failed", "cancelled"].includes(job.state);

  const updateConfig = (patch) => {
    setConfig((current) => ({ ...current, ...patch }));
    setConfirmed(false);
    setPreflight((current) => current.state === "idle" ? { ...current, id: "" } : { ...current, id: "", state: "idle", message: "设置已变更，请重新执行上传前检查。" });
  };

  useEffect(() => {
    const controller = new AbortController();
    setContextState({ phase: "loading", value: null, error: "" });
    githubUploadClient.getContext(output.id, controller.signal).then((value) => {
      setContextState({ phase: "ready", value, error: "" });
      setConfig((current) => ({
        ...current,
        owner: value.defaults?.owner || value.login || value.owners?.[0]?.login || value.owners?.[0]?.name || current.owner,
        repository: value.defaults?.repository || current.repository,
        visibility: value.defaults?.visibility || current.visibility
      }));
      if (value.preflight) setPreflight(normalizeGithubPreflight(value.preflight));
    }).catch((error) => {
      if (error?.name !== "AbortError") setContextState({ phase: "error", value: null, error: getErrorMessage(error, "无法读取 GitHub 账号状态") });
    });
    return () => controller.abort();
  }, [output.id]);

  useEffect(() => {
    if (!job?.id || jobTerminal) return undefined;
    let stopped = false;
    let timer;
    const poll = async () => {
      try {
        const next = await githubUploadClient.getJob(job.id);
        if (stopped) return;
        setJob(next);
        if (!["success", "partial", "failed", "cancelled"].includes(next.state)) timer = window.setTimeout(poll, 900);
      } catch (error) {
        if (!stopped) setActionError(`读取上传进度失败：${getErrorMessage(error)}`);
      }
    };
    timer = window.setTimeout(poll, 700);
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [job?.id, jobTerminal]);

  const runPreflight = async () => {
    setActionError("");
    setConfirmed(false);
    setPreflight({ id: "", state: "running", message: "正在扫描密钥、私钥、令牌与超大文件…", sensitive: [], blockers: [], warnings: [], large: [], totalFiles: 0, totalBytes: 0 });
    try {
      const result = await githubUploadClient.preflight(output.id, config);
      setPreflight(result);
      setConfig((current) => mergeCanonicalGithubConfig(current, result.config));
    } catch (error) {
      setPreflight({ id: "", state: "error", message: formatGithubPreflightFailure(getErrorMessage(error, "预检服务没有返回结果")), sensitive: [], blockers: [], warnings: [], large: [], totalFiles: 0, totalBytes: 0 });
    }
  };

  const startUpload = async () => {
    setActionError("");
    if (!canUpload) {
      setActionError(uploadGate.message);
      return;
    }
    try {
      const next = await githubUploadClient.start(output.id, config, preflight.id);
      setJob(next);
    } catch (error) {
      setActionError(getErrorMessage(error, "上传任务未能启动"));
    }
  };

  const cancelUpload = async () => {
    if (!job?.id || !job.canCancel) return;
    try { setJob(await githubUploadClient.cancel(job.id)); }
    catch (error) { setActionError(`取消失败：${getErrorMessage(error)}`); }
  };

  const account = contextState.value;
  const cliReady = contextState.phase === "ready" && account?.cliInstalled;
  const accountReady = cliReady && account?.authenticated;
  const preflightPassed = preflight.state === "passed" || preflight.state === "warning";
  const hasBlockingFile = preflight.state === "blocked" || preflight.blockers.length > 0;
  const canConfirmUpload = accountReady && preflightPassed && Boolean(preflight.id) && !hasBlockingFile && !job;
  const uploadGate = deriveGithubUploadGate({
    contextPhase: contextState.phase,
    contextError: contextState.error,
    cliReady,
    accountReady,
    preflight,
    confirmed,
    jobActive: Boolean(job)
  });
  const canUpload = uploadGate.action === "upload" && !uploadGate.disabled;
  const repoLabel = `${config.owner || "owner"}/${config.repository || "repository"}`;
  const scopeFileCount = preflight.id ? preflight.totalFiles : config.scope === "custom" ? config.selectedPaths.length : (output.fileCount || output.files?.length || 0);
  const scopeBytes = preflight.id ? preflight.totalBytes : (output.sizeBytes || 0);
  const publicNotice = "任何人可看、下载、fork；只有仓库所有者及被授予写权限的协作者能直接写入；其他人只能提 PR，是否合并由你决定。";
  const setup = account?.setup || {};
  const installUrl = safeGithubCliInstallUrl(setup.installUrl);
  const installCommand = String(setup.installCommand || "winget install --id GitHub.cli");
  const accountAction = deriveGithubCliAccountAction(setup, accountReady);
  const selectedRepository = useMemo(() => {
    const fullName = `${config.owner}/${config.repository}`.toLowerCase();
    return (account?.repositories || []).find((entry) => String(entry?.nameWithOwner || `${config.owner}/${entry?.name || ""}`).toLowerCase() === fullName) || null;
  }, [account?.repositories, config.owner, config.repository]);
  const existingRepository = config.repositoryMode === "existing";
  const effectiveVisibility = existingRepository
    ? (preflight.id ? preflight.visibility : String(selectedRepository?.visibility || "").toLowerCase())
    : config.visibility;
  const effectiveBranch = preflight.id ? (preflight.branch || config.branch) : config.branch;
  const preflightDisplayMessage = preflight.state === "error" ? formatGithubPreflightFailure(preflight.message) : preflight.message;
  const preflightButtonLabel = preflight.state === "running" ? "正在检查…" : preflight.state === "idle" ? "执行上传前检查" : "重新执行检查";
  const runPrimaryAction = () => {
    if (uploadGate.disabled) return;
    if (uploadGate.action === "preflight") {
      runPreflight();
      return;
    }
    startUpload();
  };
  const customOptions = useMemo(() => {
    const query = customSearch.trim().toLowerCase();
    const seen = new Set();
    const values = [];
    for (const file of output.files || []) {
      const path = String(file?.relativePath || file?.name || "").trim();
      if (!path || seen.has(path) || (query && !path.toLowerCase().includes(query))) continue;
      seen.add(path);
      values.push({ path, folder: file?.kind === "folder" || file?.isDirectory === true });
      if (values.length >= MAX_GITHUB_CUSTOM_PATHS) break;
    }
    return values;
  }, [customSearch, output.files]);

  const copyCommand = async (command, label) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(command);
      onToast(`${label}已复制：${command}`);
    } catch {
      onToast(`${label}：${command}`);
    }
  };

  const chooseRepositoryMode = (mode) => {
    if (mode === "existing" && account?.repositories?.length) {
      const repository = account.repositories[0];
      const [owner, name] = String(repository.nameWithOwner || `${config.owner}/${repository.name || ""}`).split("/");
      updateConfig({ repositoryMode: mode, owner: owner || config.owner, repository: name || config.repository, visibility: String(repository.visibility || config.visibility).toLowerCase() });
      return;
    }
    updateConfig({ repositoryMode: mode });
  };

  if (job) {
    const statusMap = {
      queued: ["已创建上传任务", "正在等待本地服务处理…"], scanning: ["正在执行安全检查", "检查敏感信息与 GitHub 文件大小限制…"],
      uploading: ["正在上传到 GitHub", job.message || "正在创建提交并发送文件…"], creating_pr: ["正在创建 Pull Request", "文件已上传，正在生成可审阅的合并请求…"],
      success: ["上传完成", "仓库内容已成功写入 GitHub。"], partial: [job.protectionFailed ? "文件已上传，保护设置未完成" : "上传部分完成", job.warning || "远端可能已保留部分结果，请检查警告与失败列表。"],
      failed: ["上传失败", job.message || "没有完成 GitHub 上传。"], cancelled: ["上传已取消", "尚未完成的内容已停止处理。"]
    };
    const [title, detail] = statusMap[job.state] || statusMap.queued;
    return <div className="modal-backdrop github-backdrop"><section ref={modalRef} className="modal github-upload-modal github-job-modal" role="dialog" aria-modal="true" aria-labelledby="github-job-title">
      <div className="github-modal-title"><span><GithubLogo size={20} weight="fill" /></span><h2 id="github-job-title">上传个人 GitHub</h2><button aria-label="关闭 GitHub 上传窗口" onClick={onClose} disabled={!jobTerminal}><X size={20} /></button></div>
      <div className="github-job-copy">
        <div className={cx("github-job-icon", job.state)}>{["success"].includes(job.state) ? <CheckCircle size={32} weight="fill" /> : ["partial", "failed"].includes(job.state) ? <Warning size={32} weight="fill" /> : job.state === "cancelled" ? <X size={30} /> : <SpinnerGap size={30} className="spin" />}</div>
        <h3>{title}</h3><p>{detail}</p>
        {!jobTerminal && <><div className="github-progress"><span style={{ width: `${job.progress}%` }} /></div><small>{job.progress}% · 可继续在此查看进度</small></>}
        {jobTerminal && <dl className="github-result-links">
          {job.repositoryUrl && <div><dt>仓库</dt><dd><a href={job.repositoryUrl} target="_blank" rel="noreferrer">{job.repositoryUrl}<ArrowSquareOut size={13} /></a></dd></div>}
          {job.branch && <div><dt>分支</dt><dd>{job.branch}</dd></div>}
          {job.commit && <div><dt>提交</dt><dd><code>{job.commit}</code><button aria-label="复制提交哈希" onClick={() => navigator.clipboard?.writeText(job.commit)}><Copy size={13} /></button></dd></div>}
          {job.pullRequestUrl && <div><dt>Pull Request</dt><dd><a href={job.pullRequestUrl} target="_blank" rel="noreferrer">{job.pullRequestUrl}<ArrowSquareOut size={13} /></a></dd></div>}
        </dl>}
        {jobTerminal && (job.warning || job.warnings?.length > 0) && <div className={cx("github-job-warning-panel", job.state === "partial" && "prominent")}><Warning size={18} weight="fill" /><div><strong>{job.protectionFailed ? "主分支保护未生效" : job.state === "partial" ? "远端结果需要检查" : "上传完成，但有提示"}</strong>{job.warning && <p>{job.warning}</p>}{job.warnings?.length > 1 && <ul>{job.warnings.slice(0, 4).map((warning, index) => <li key={`${warning?.code || "warning"}-${index}`}>{warning?.message || warning?.error || warning?.code || warning}</li>)}</ul>}</div></div>}
        {job.failures?.length > 0 && <div className="github-failure-list"><strong>未完成的文件</strong>{job.failures.slice(0, 5).map((failure, index) => <span key={index}>{failure.path || failure.file || `文件 ${index + 1}`} · {failure.message || failure.error || "上传失败"}</span>)}</div>}
        {actionError && <div className="github-inline-error"><Warning size={16} />{actionError}</div>}
      </div>
      <div className="github-upload-footer"><span>{job.uploaded || 0}/{job.total || scopeFileCount || "—"} 个文件</span>{!jobTerminal ? <button className="secondary-button" onClick={cancelUpload} disabled={!job.canCancel}>取消上传</button> : <button className="primary-button" onClick={onClose}>完成</button>}</div>
    </section></div>;
  }

  return (
    <div className="modal-backdrop github-backdrop">
      <section ref={modalRef} className="modal github-upload-modal" role="dialog" aria-modal="true" aria-labelledby="github-upload-title">
        <div className="github-modal-title"><h2 id="github-upload-title">上传个人 GitHub</h2><button aria-label="关闭 GitHub 上传窗口" onClick={onClose}><X size={20} /></button></div>
        <div className="github-upload-body">
          <div className="github-settings-column">
            <h3>上传设置</h3>
            <div className="github-setting-row account-row"><span className="github-field-name">GitHub 账号</span><div className="github-account">
              <span className="github-avatar">{account?.login ? account.login.slice(0, 1).toUpperCase() : <GithubLogo size={18} weight="fill" />}</span><strong>{contextState.phase === "loading" ? "正在检查…" : account?.login || "未登录"}</strong>
              <em className={accountReady ? "ready" : "warning"}>{accountReady ? "已登录" : !cliReady ? "CLI 未安装" : "需要登录"}</em>
            </div>{contextState.phase === "loading" ? <button className="github-compact-button" disabled>检查中</button> : !cliReady ? (installUrl ? <a className="github-compact-button" href={installUrl} target="_blank" rel="noreferrer">安装说明</a> : <button className="github-compact-button" onClick={() => copyCommand(installCommand, "安装命令")}>复制安装命令</button>) : <button className="github-compact-button" title={accountAction.command} onClick={() => copyCommand(accountAction.command, accountAction.copyLabel)}>{accountAction.label}</button>}</div>
            <p className="github-auth-note" title="若系统凭据库不可用，GitHub CLI 可能回退为写入明文配置；登录终端会在发生时提示。"><ShieldCheck size={13} />凭据由 GitHub CLI 管理，本插件不读取或保存 token。<em>凭据风险</em></p>
            {contextState.phase === "error" && <div className="github-cli-warning"><Warning size={16} weight="fill" /><span><strong>GitHub 状态不可用</strong><small>{contextState.error}</small></span></div>}
            {contextState.phase === "ready" && !cliReady && <div className="github-cli-warning"><Warning size={16} weight="fill" /><span><strong>GitHub CLI 未安装</strong><small>上传依赖本机 GitHub CLI；未安装时不会启用上传，也不会保存任何账号令牌。</small></span></div>}
            {contextState.phase === "ready" && cliReady && !accountReady && <div className="github-cli-warning"><Warning size={16} weight="fill" /><span><strong>GitHub 登录未完成或凭据已失效</strong><small>点击“复制登录命令”，在终端完成 GitHub 登录后重新打开此窗口。</small></span></div>}
            <div className="github-setting-block"><span className="github-field-name">目标仓库</span><div className="github-segmented"><button className={config.repositoryMode === "new" ? "selected" : ""} onClick={() => chooseRepositoryMode("new")}>新建仓库</button><button className={config.repositoryMode === "existing" ? "selected" : ""} onClick={() => chooseRepositoryMode("existing")}>已有仓库</button></div><small className="github-help">新建仓库不会修改本地产出项；已有仓库可能与远端内容产生冲突。<em>注意覆盖</em></small></div>
            <div className="github-repo-fields"><input aria-label="仓库所有者" value={config.owner} onChange={(event) => updateConfig({ owner: event.target.value })} placeholder="owner" /><span>/</span><input aria-label="仓库名称" list={existingRepository ? "github-existing-repositories" : undefined} value={config.repository} onChange={(event) => updateConfig({ repository: repoSlug(event.target.value) })} placeholder="repository" />{existingRepository && <datalist id="github-existing-repositories">{(account?.repositories || []).map((repository) => <option key={repository.nameWithOwner || repository.name} value={repository.name || String(repository.nameWithOwner || "").split("/").pop()}>{repository.nameWithOwner}</option>)}</datalist>}</div>
            <div className="github-setting-block"><span className="github-field-name">可见性</span><div className="github-visibility-grid">
              <button disabled={existingRepository} aria-label={existingRepository ? "Public 公开（已有仓库可见性由远端决定）" : "Public 公开"} className={effectiveVisibility === "public" ? "selected" : ""} onClick={() => updateConfig({ visibility: "public" })}><Globe size={18} weight="fill" /><span><strong>Public 公开</strong><small>任何人都能查看、下载和 fork。</small><em className="risk warning">内容永久公开</em></span><i /></button>
              <button disabled={existingRepository} aria-label={existingRepository ? "Private 私有（已有仓库可见性由远端决定）" : "Private 私有"} className={effectiveVisibility === "private" ? "selected" : ""} onClick={() => updateConfig({ visibility: "private" })}><Lock size={18} /><span><strong>Private 私有</strong><small>仅你和被授权者可访问。</small><em className="risk neutral">受账号权限保护</em></span><i /></button>
            </div><p className="public-policy"><Info size={14} />{existingRepository && !effectiveVisibility ? "已有仓库的可见性不可在此修改；执行预检后读取 GitHub 远端实际权限。" : effectiveVisibility === "public" ? publicNotice : "Private 仓库不会被公众发现；授予协作者权限后，对方仍可能读取或写入仓库内容。"}</p>{existingRepository && <small className="github-remote-access-note">已有仓库权限只读显示；本次上传不会变更可见性或协作者。</small>}</div>
            <div className="github-setting-block"><span className="github-field-name">上传内容</span><div className="github-scope-list">{GITHUB_UPLOAD_SCOPES.map((scope) => { const currentUnavailable = scope.value === "current" && !config.currentRelativePath; return <label key={scope.value} className={cx(config.scope === scope.value && "selected", currentUnavailable && "disabled")}><input type="radio" name="upload-scope" value={scope.value} checked={config.scope === scope.value} disabled={currentUnavailable} onChange={() => updateConfig({ scope: scope.value })} /><span><strong>{scope.label}</strong><small>{currentUnavailable ? "请先在内容列表中明确选择一个文件。" : scope.note}</small></span><em className={cx("risk", currentUnavailable ? "neutral" : scope.tone)}>{currentUnavailable ? "当前不可用" : scope.risk}</em></label>; })}</div>
              {config.scope === "custom" && <div className="github-custom-picker"><div className="github-custom-toolbar"><input type="search" aria-label="搜索自定义上传文件" placeholder="搜索文件或文件夹" value={customSearch} onChange={(event) => setCustomSearch(event.target.value)} /><span>已选 {config.selectedPaths.length}/{MAX_GITHUB_CUSTOM_PATHS}</span>{config.selectedPaths.length > 0 && <button onClick={() => updateConfig({ selectedPaths: [] })}>清空</button>}</div><div className="github-custom-files">{customOptions.map((file) => { const selected = config.selectedPaths.includes(file.path); return <label key={file.path}><input type="checkbox" checked={selected} onChange={() => { if (!selected && config.selectedPaths.length >= MAX_GITHUB_CUSTOM_PATHS) { onToast(`自定义上传最多选择 ${MAX_GITHUB_CUSTOM_PATHS} 条路径`); return; } updateConfig({ selectedPaths: selected ? config.selectedPaths.filter((item) => item !== file.path) : [...config.selectedPaths, file.path] }); }} /><span>{file.path}{file.folder && <small>文件夹 · 包含其下符合规则的文件</small>}</span></label>; })}{!customOptions.length && <p>没有匹配的文件或文件夹</p>}</div><small>最多选择 500 条路径；选择文件夹时，预检会展开并检查其下文件。</small></div>}
            </div>
            <div className="github-setting-block"><span className="github-field-name">写入方式</span><div className="github-write-modes"><label className={config.writeMode === "branch-pr" ? "selected" : ""}><input type="radio" name="write-mode" checked={config.writeMode === "branch-pr"} onChange={() => updateConfig({ writeMode: "branch-pr" })} /><span><strong>新分支 + Pull Request</strong><small>创建新分支并发起 PR，便于审阅后合并。</small></span><em className="risk safe">推荐</em></label><label className={config.writeMode === "direct-main" ? "selected" : ""}><input type="radio" name="write-mode" checked={config.writeMode === "direct-main"} onChange={() => updateConfig({ writeMode: "direct-main" })} /><span><strong>直接提交默认分支</strong><small>直接改变远端默认分支历史，已有内容可能被覆盖。</small></span><em className="risk danger">高风险</em></label></div>{config.writeMode === "branch-pr" && <label className="github-branch-field"><span>新分支名称</span><input aria-label="新分支名称" value={config.branch} onChange={(event) => updateConfig({ branch: event.target.value })} placeholder="留空时由后端生成唯一分支" /><small>{preflight.id && preflight.branch ? `预检已锁定：${preflight.branch}` : "可自定义；留空时预检会生成唯一分支，并在上传时原样复用。"}</small></label>}</div>
            <div className="github-license-line"><span className="github-field-name">许可证</span><select value={config.license} onChange={(event) => updateConfig({ license: event.target.value })}><option value="none">不添加许可证</option><option value="mit">MIT — 允许复用与修改</option><option value="apache-2.0">Apache-2.0 — 含专利授权</option><option value="gpl-3.0">GPL-3.0 — 衍生需开源</option></select><small>无许可证时，他人虽能查看和 fork，但复用权利不明确。<em>需了解</em></small></div>
            <label className="github-toggle"><input type="checkbox" checked={config.includeReadme} onChange={(event) => updateConfig({ includeReadme: event.target.checked })} /><i /><span><strong>附带来源说明 README</strong><small>写入版本、产出时间和源任务，不记录本地绝对路径。</small></span><em className="risk safe">建议</em></label>
            <label className="github-toggle"><input type="checkbox" checked={config.protectMain} onChange={(event) => updateConfig({ protectMain: event.target.checked })} /><i /><span><strong>保护默认分支</strong><small>实际效果受 GitHub 计划与仓库现有规则影响；失败时文件仍可能已上传。</small></span><em className="risk safe">降低误改</em></label>
          </div>
          <aside className="github-risk-column">
            <h3>影响与风险</h3>
            <ul className="github-impact-list"><li className="safe"><CheckCircle size={18} weight="fill" /><span>不会修改本地产出文件</span></li><li className="safe"><CheckCircle size={18} weight="fill" /><span>{config.repositoryMode === "new" ? "不会新增协作者，初始只有所有者可直接写" : "不会新增或移除协作者，现有写权限保持不变"}</span></li><li className={effectiveVisibility === "public" ? "warning" : "safe"}>{effectiveVisibility === "public" ? <Warning size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />}<span>{effectiveVisibility === "public" ? "Public 仓库：任何人都能查看、下载和 fork" : effectiveVisibility === "private" ? "Private 仓库：仅授权用户可访问" : "已有仓库：预检后读取远端实际可见性"}</span></li><li className="warning"><Warning size={18} weight="fill" /><span>单文件大于 100 MiB 将阻断；大于 50 MiB 会提示</span></li><li><GitBranch size={18} /><span>{config.writeMode === "branch-pr" ? `将写入 ${effectiveBranch || "后端确认的新分支"} 并创建 Pull Request` : "将直接写入远端默认分支，影响仓库历史"}</span></li></ul>
            <div className="github-preflight-card" aria-live="polite" aria-atomic="true"><div><strong>敏感文件检查</strong>{preflight.state === "running" && <SpinnerGap size={17} className="spin" />}{preflight.state === "passed" && <CheckCircle size={18} weight="fill" />}{["warning", "blocked", "error"].includes(preflight.state) && <Warning size={18} weight="fill" />}</div><p id="github-preflight-status">{preflightDisplayMessage || "检查 .env、私钥、证书、访问令牌与超大文件。"}</p><small>默认排除：.git、node_modules；重点检查：.env、私钥、证书、访问令牌</small>{preflight.sensitive.length > 0 && <small className="blocked">敏感项：{preflight.sensitive.slice(0, 2).map((item) => item.path || item.file || item.name || item).join("、")}</small>}{preflight.large.length > 0 && <small>大文件：{preflight.large.slice(0, 2).map((item) => item.path || item.file || item.name || item).join("、")}</small>}{preflight.blockers.length > 0 && <small className="blocked">已阻断：{preflight.blockers.slice(0, 2).map((item) => item.path || item.name || item.message || item).join("、")}</small>}{preflight.warnings.length > 0 && <small>提示：{preflight.warnings.slice(0, 2).map((item) => item.message || item.code || item).join("；")}</small>}<button onClick={runPreflight} disabled={!accountReady || preflight.state === "running"} aria-describedby="github-preflight-status" title={!accountReady ? uploadGate.message : preflight.state === "running" ? "上传前检查正在进行" : "重新扫描当前上传范围与安全风险"}>{preflightButtonLabel}</button></div>
            <dl className="github-summary"><div><dt>仓库</dt><dd>{preflight.repository?.nameWithOwner || repoLabel}</dd></div><div><dt>范围</dt><dd>{scopeFileCount || "—"} 个文件{scopeBytes ? ` · ${formatFileSize(scopeBytes)}` : ""}</dd></div><div><dt>权限</dt><dd>{effectiveVisibility ? effectiveVisibility[0].toUpperCase() + effectiveVisibility.slice(1) : "预检后读取"} · {config.repositoryMode === "new" ? "初始无协作者" : "远端现有权限不变"}</dd></div><div><dt>写入</dt><dd>{config.writeMode === "branch-pr" ? `新分支 + PR${effectiveBranch ? ` · ${effectiveBranch}` : ""}` : "直接提交远端默认分支"}</dd></div></dl>
            {!accountReady && <div className="github-right-warning"><Warning size={16} /><span>{!cliReady ? "安装 GitHub CLI 后才能预检与上传。" : "请先通过 GitHub CLI 登录个人账号。"}</span></div>}
            {hasBlockingFile && <div className="github-right-warning danger"><Warning size={16} weight="fill" /><span>发现敏感文件或超过 100 MiB 的文件，修正前禁止上传。</span></div>}
            {actionError && <div className="github-right-warning danger"><Warning size={16} />{actionError}</div>}
          </aside>
        </div>
        <div className="github-upload-footer"><label className={cx(!canConfirmUpload && "disabled")} title={!canConfirmUpload ? uploadGate.message : "勾选后才允许开始上传"}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!canConfirmUpload} aria-describedby="github-upload-footer-status" /><span>我已确认上传范围和仓库权限</span></label><span id="github-upload-footer-status" className={cx("github-upload-gate", uploadGate.tone)} role="status" aria-live="polite">{uploadGate.message}</span><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={runPrimaryAction} disabled={uploadGate.disabled} aria-describedby="github-upload-footer-status" title={uploadGate.message}>{preflight.state === "running" ? <SpinnerGap size={17} className="spin" /> : uploadGate.action === "preflight" ? <ShieldCheck size={17} /> : <GithubLogo size={17} weight="fill" />}{uploadGate.label}</button></div>
      </section>
    </div>
  );
}

function DestructiveConfirmModal({ action, busy, onConfirm, onClose }) {
  const [confirmed, setConfirmed] = useState(false);
  const modalRef = useModalFocus(onClose, busy);
  const isFile = action.kind === "file";
  const isBatch = action.kind === "batch-delete";
  const title = isFile ? "删除文件" : isBatch ? `批量删除 ${action.ids.length} 个产出项` : "删除产出项";
  const target = isFile ? action.file.name : isBatch ? `${action.ids.length} 个已选产出项` : action.output.title;
  const relativePath = isFile ? (action.file.relativePath || action.file.name) : "";
  const batchItems = isBatch && Array.isArray(action.items) ? action.items : [];
  const visibleBatchItems = batchItems.slice(0, BATCH_CONFIRM_VISIBLE_ITEMS);
  const hiddenBatchCount = isBatch ? Math.max(0, action.ids.length - visibleBatchItems.length) : 0;
  const detail = isFile
    ? "该文件会从本地磁盘移入 Windows 回收站。所属产出项、版本记录和活动日志仍会保留。"
    : isBatch
      ? "所选产出项对应的全部本地文件和文件夹都会移入 Windows 回收站。产出项记录、版本记录和活动日志仍会保留，并标记为“已删除”。"
      : "该产出项对应的全部本地文件和文件夹都会移入 Windows 回收站。产出项记录、版本记录和活动日志仍会保留，并标记为“已删除”。";
  return (
    <div className="modal-backdrop">
      <section ref={modalRef} className="modal destructive-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-modal-title" aria-describedby="delete-modal-description" tabIndex={-1}>
        <div className="modal-header"><div className="modal-title-icon danger"><Trash size={20} /></div><div><h2 id="delete-modal-title">{title}</h2><p title={target}>{target}</p></div><button className="icon-button" aria-label="关闭删除确认" onClick={onClose} disabled={busy}><X size={19} /></button></div>
        <div className="modal-copy" id="delete-modal-description">
          <div className="destructive-warning"><Warning size={21} weight="fill" /><p><strong>这会实质删除本地内容</strong><span>{detail}</span></p></div>
          {isFile && <dl className="destructive-target-details"><div><dt>相对路径</dt><dd title={relativePath}>{relativePath}</dd></div><div><dt>产出项路径</dt><dd title={action.output.path}>{action.output.path}</dd></div></dl>}
          {!isFile && !isBatch && <dl className="destructive-target-details"><div><dt>产出项</dt><dd title={action.output.title}>{action.output.title}</dd></div><div><dt>本地路径</dt><dd title={action.output.path}>{action.output.path}</dd></div></dl>}
          {isBatch && <div className="batch-delete-targets" aria-label="将删除的产出项">
            {visibleBatchItems.map((item) => <div key={item.id}><strong title={item.title}>{item.title}</strong><span title={item.path}>{item.path}</span></div>)}
            {hiddenBatchCount > 0 && <p>另有 {hiddenBatchCount} 项未显示；确认后会一并移入回收站。</p>}
          </div>}
          <label className="destructive-confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} /><span>我已确认删除上述本地内容</span></label>
        </div>
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="danger-button" onClick={onConfirm} disabled={!confirmed || busy}>{busy ? <><SpinnerGap size={16} className="spin" />正在删除…</> : <><Trash size={16} />移入回收站</>}</button></div>
      </section>
    </div>
  );
}

function BatchResultModal({ result, onClose }) {
  const modalRef = useModalFocus(onClose, false);
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const refreshWarning = result.refreshWarning || "";
  const hasWarning = failures.length > 0 || Boolean(refreshWarning);
  return (
    <div className="modal-backdrop">
      <section ref={modalRef} className="modal batch-result-modal" role="dialog" aria-modal="true" aria-labelledby="batch-result-title">
        <div className="modal-header"><div className={cx("modal-title-icon", hasWarning && "warning")} >{hasWarning ? <Warning size={20} weight="fill" /> : <CheckCircle size={20} weight="fill" />}</div><div><h2 id="batch-result-title">{result.label}完成</h2><p>成功 {result.succeeded} 项 · 失败 {failures.length} 项</p></div><button className="icon-button" aria-label="关闭批量结果" onClick={onClose}><X size={19} /></button></div>
        <div className="modal-copy batch-result-copy">
          <div className="batch-result-progress"><span style={{ width: `${result.total ? Math.round((result.succeeded / result.total) * 100) : 100}%` }} /></div>
          {failures.length ? <><p className="failure-intro">以下项目未完成，其他成功项目已保存：</p><div className="failure-list">{failures.map((failure, index) => <div key={`${failure.id || "failure"}-${index}`}><strong>{failure.title || failure.id || `第 ${index + 1} 项`}</strong><span>{failure.error || failure.message || "操作未完成"}</span></div>)}</div></> : <div className="batch-success-copy"><CheckCircle size={25} weight="fill" /><span>{refreshWarning ? "所有选中项目均已完成操作。" : "所有选中项目均已完成操作，产出列表已刷新。"}</span></div>}
          {refreshWarning && <div className="batch-refresh-warning" role="status"><Warning size={18} weight="fill" /><span>{refreshWarning}</span></div>}
        </div>
        <div className="modal-actions"><button className="primary-button" onClick={onClose}>完成</button></div>
      </section>
    </div>
  );
}

function Toast({ message }) {
  const warning = /失败|无法|错误|未完成/.test(message);
  return <div className={cx("toast", warning && "warning")} role="status" aria-live="polite">{warning ? <Warning size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />}{message}</div>;
}

export function App() {
  const [outputs, setOutputs] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [activeTab, setActiveTab] = useState("概览");
  const [activityFilter, setActivityFilter] = useState("全部活动");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("全部类型");
  const [dataState, setDataState] = useState({ status: "loading", error: "" });
  const [scanState, setScanState] = useState({ phase: "loading", scan: null, error: "" });
  const [scanRequestPending, setScanRequestPending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [detection, setDetection] = useState(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);
  const [destructiveAction, setDestructiveAction] = useState(null);
  const [operationBusy, setOperationBusy] = useState("");
  const [batchAction, setBatchAction] = useState(null);
  const [batchResult, setBatchResult] = useState(null);
  const [githubUploadOutput, setGithubUploadOutput] = useState(null);
  const [previewState, setPreviewState] = useState(null);
  const [toast, setToast] = useState("");
  const previewRequestRef = useRef(null);
  const selected = outputs.find((item) => item.id === selectedId) || outputs[0] || null;
  const commitItems = useCallback((items) => {
    if (!Array.isArray(items)) throw new Error("服务响应中缺少产出项列表");
    setOutputs(items);
    setSelectedId((current) => items.some((item) => item.id === current) ? current : (items[0]?.id || ""));
    setSelectedIds((current) => {
      const validIds = new Set(items.map((item) => item.id));
      return new Set([...current].filter((id) => validIds.has(id)));
    });
    setDataState({ status: "ready", error: "" });
  }, []);
  const replaceOutput = useCallback((nextItem) => {
    if (!nextItem?.id) return;
    setOutputs((items) => {
      const exists = items.some((item) => item.id === nextItem.id);
      return exists ? items.map((item) => item.id === nextItem.id ? nextItem : item) : [nextItem, ...items];
    });
  }, []);
  const toggleSelection = useCallback((id) => {
    if (!selectedIds.has(id) && selectedIds.size >= MAX_BATCH_SELECTION) {
      setToast(`一次最多选择 ${MAX_BATCH_SELECTION} 个产出项`);
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_BATCH_SELECTION) next.add(id);
      return next;
    });
  }, [selectedIds]);
  const toggleAll = useCallback((ids, shouldSelect) => {
    const uniqueIds = [...new Set(ids)];
    if (shouldSelect) {
      const requested = uniqueIds.filter((id) => !selectedIds.has(id)).length;
      const available = Math.max(0, MAX_BATCH_SELECTION - selectedIds.size);
      if (requested > available) setToast(`一次最多选择 ${MAX_BATCH_SELECTION} 个产出项，已按当前顺序选满`);
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      let available = Math.max(0, MAX_BATCH_SELECTION - next.size);
      for (const id of uniqueIds) {
        if (!shouldSelect) {
          next.delete(id);
        } else if (!next.has(id) && available > 0) {
          next.add(id);
          available -= 1;
        }
      }
      return next;
    });
  }, [selectedIds]);
  const openTask = async (source) => {
    const nextSource = source || selected?.source;
    const result = await openNativeTask(nextSource);
    setToast(result.ok ? "正在打开源任务" : result.error || "无法打开对应任务");
  };

  useEffect(() => {
    let cancelled = false;
    let retryTimer;
    let attempts = 0;
    const controller = new AbortController();
    setDataState({ status: "loading", error: "" });
    setScanState({ phase: "loading", scan: null, error: "" });

    const hydrate = async () => {
      attempts += 1;
      if (!IS_COMPANION_EMBEDDED && IS_CODEX_EMBEDDED) {
        const initialPayload = window.openai?.toolOutput;
        const initialItems = readItemsPayload(initialPayload);
        if (initialItems) {
          if (!cancelled) {
            commitItems(initialItems);
            const initialScan = readScanPayload(initialPayload);
            if (initialScan) {
              setScanState({ phase: "ready", scan: initialScan, error: "" });
              return;
            }
          }
        }
        try {
          const result = await requestItemsSnapshot(controller.signal);
          const items = readItemsPayload(result);
          if (items) {
            if (!cancelled) {
              commitItems(items);
              const resultScan = readScanPayload(result);
              setScanState(resultScan
                ? { phase: "ready", scan: resultScan, error: "" }
                : { phase: "error", scan: null, error: "当前 Codex 嵌入环境未返回自动抓取状态" });
            }
            return;
          }
        } catch {
          // The Codex bridge can arrive shortly after the first render.
        }
        if (!cancelled && attempts < 20) {
          retryTimer = window.setTimeout(hydrate, 250);
          return;
        }
        if (!cancelled) {
          if (!initialItems) setDataState({ status: "error", error: "无法从 Codex 本地工具读取产出项。" });
          setScanState({ phase: "error", scan: null, error: "无法连接 Codex 本地扫描服务" });
        }
        return;
      }

      const [itemsResult, scanResult] = await Promise.allSettled([
        requestItemsSnapshot(controller.signal),
        requestScanSnapshot(controller.signal)
      ]);
      if (cancelled) return;

      if (itemsResult.status === "fulfilled") {
        try {
          commitItems(readItemsPayload(itemsResult.value));
        } catch (error) {
          setDataState({ status: "error", error: getErrorMessage(error, "无法读取产出项列表。") });
        }
      } else if (itemsResult.reason?.name !== "AbortError") {
        setDataState({ status: "error", error: getErrorMessage(itemsResult.reason, "无法连接本地产出项服务。") });
      }

      const scan = scanResult.status === "fulfilled"
        ? readScanPayload(scanResult.value)
        : (itemsResult.status === "fulfilled" ? readScanPayload(itemsResult.value) : null);
      if (scan) {
        setScanState({ phase: "ready", scan, error: "" });
      } else if (scanResult.status === "rejected" && scanResult.reason?.name !== "AbortError") {
        setScanState({ phase: "error", scan: null, error: getErrorMessage(scanResult.reason, "无法读取自动抓取状态") });
      } else {
        setScanState({ phase: "error", scan: null, error: "扫描服务没有返回有效状态" });
      }
    };
    hydrate();
    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [commitItems, reloadToken]);

  const refreshItemsAfterScan = useCallback(async () => {
    const payload = await requestItemsSnapshot();
    const items = readItemsPayload(payload);
    commitItems(items);
    const scan = readScanPayload(payload);
    if (scan) setScanState({ phase: "ready", scan, error: "" });
  }, [commitItems]);

  const openLocation = useCallback(async (output, file) => {
    if (!output?.id || operationBusy) return;
    setOperationBusy("open-location");
    try {
      const relativePath = file?.relativePath || (file ? file.name : undefined);
      const payload = await requestOutputAction("open_output_item_location", { id: output.id, relativePath });
      if (payload?.ok === false) throw new Error(payload.error || payload.message || "文件资源管理器未能打开该位置");
      setToast(file ? `已在文件资源管理器中定位“${file.name}”` : "已用文件资源管理器打开项目位置");
    } catch (error) {
      setToast(`打开位置失败：${getErrorMessage(error, "请确认路径仍然存在")}`);
    } finally {
      setOperationBusy("");
    }
  }, [operationBusy]);

  const closePreview = useCallback(() => {
    previewRequestRef.current?.abort();
    previewRequestRef.current = null;
    setPreviewState(null);
  }, []);

  const openPreview = useCallback(async (output, file) => {
    if (!output?.id || !file) return;
    const relativePath = file.relativePath || file.name;
    if (!relativePath) return;
    previewRequestRef.current?.abort();
    const controller = new AbortController();
    previewRequestRef.current = controller;
    setPreviewState({ phase: "loading", output, file, preview: null, error: "" });
    try {
      const payload = await requestOutputAction("preview_output_item_file", { id: output.id, relativePath }, controller.signal);
      if (!payload?.preview || !["image", "text"].includes(payload.preview.kind)) throw new Error("预览服务没有返回可显示的内容");
      if (!controller.signal.aborted) setPreviewState({ phase: "ready", output, file, preview: payload.preview, error: "" });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return;
      setPreviewState({ phase: "error", output, file, preview: null, error: getErrorMessage(error, "文件无法安全预览") });
    } finally {
      if (previewRequestRef.current === controller) previewRequestRef.current = null;
    }
  }, []);

  useEffect(() => () => previewRequestRef.current?.abort(), []);
  useEffect(() => {
    previewRequestRef.current?.abort();
    previewRequestRef.current = null;
    setPreviewState(null);
  }, [selectedId]);

  const setPriority = useCallback(async (id, priority) => {
    if (!id || operationBusy) return;
    setOperationBusy("priority");
    try {
      const payload = await requestOutputAction("set_output_item_priority", { id, priority });
      if (payload?.item) replaceOutput(payload.item);
      else await refreshItemsAfterScan();
      setToast(`优先级已设置为“${PRIORITY_BY_VALUE.get(priority)?.label || priority}”`);
    } catch (error) {
      setToast(`设置优先级失败：${getErrorMessage(error)}`);
    } finally {
      setOperationBusy("");
    }
  }, [operationBusy, refreshItemsAfterScan, replaceOutput]);

  const normalizeBatchResult = useCallback((payload, ids, label) => {
    const rawFailures = Array.isArray(payload?.failures)
      ? payload.failures
      : Array.isArray(payload?.results)
        ? payload.results.filter((result) => result?.ok === false || result?.success === false || result?.error)
        : [];
    const titleById = new Map(outputs.map((output) => [output.id, output.title]));
    const failures = rawFailures.map((failure) => ({
      ...failure,
      title: failure.title || titleById.get(failure.id)
    }));
    const succeeded = Number.isFinite(payload?.succeeded)
      ? payload.succeeded
      : Number.isFinite(payload?.summary?.succeeded)
        ? payload.summary.succeeded
        : Math.max(0, ids.length - failures.length);
    return { label, total: ids.length, succeeded, failures };
  }, [outputs]);

  const runBatchAction = useCallback(async (name, args, label) => {
    const ids = [...new Set(Array.isArray(args?.ids) ? args.ids : [...selectedIds])];
    if (!ids.length || operationBusy) return;
    if (ids.length > MAX_BATCH_SELECTION) {
      setToast(`一次最多操作 ${MAX_BATCH_SELECTION} 个产出项，请缩小选择范围`);
      return;
    }
    setOperationBusy(name);
    setBatchAction({ state: "running", label, total: ids.length, completed: 0 });
    try {
      const payload = await requestOutputAction(name, { ...args, ids });
      const result = normalizeBatchResult(payload, ids, label);
      setBatchAction({ state: "complete", label, total: ids.length, completed: ids.length });
      try {
        await refreshItemsAfterScan();
      } catch (refreshError) {
        result.refreshWarning = `操作已完成，但刷新失败：${getErrorMessage(refreshError)}`;
      }
      setBatchResult(result);
      const failedIds = new Set(result.failures.map((failure) => failure.id).filter(Boolean));
      setSelectedIds(new Set(ids.filter((id) => failedIds.has(id))));
    } catch (error) {
      setBatchAction({ state: "error", label, total: ids.length, completed: 0 });
      setBatchResult({ label, total: ids.length, succeeded: 0, failures: ids.map((id) => ({ id, error: getErrorMessage(error) })), refreshWarning: "" });
    } finally {
      setOperationBusy("");
      window.setTimeout(() => setBatchAction(null), 350);
    }
  }, [normalizeBatchResult, operationBusy, refreshItemsAfterScan, selectedIds]);

  useEffect(() => {
    if (scanRequestPending || scanState.phase !== "ready" || scanState.scan?.state !== "running") return undefined;
    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const payload = await requestScanSnapshot();
        const scan = readScanPayload(payload);
        if (!scan) throw new Error("扫描服务没有返回有效状态");
        if (cancelled) return;
        setScanState({ phase: "ready", scan, error: "" });
        if (scan.state === "running") {
          timer = window.setTimeout(poll, 1000);
          return;
        }
        if (scan.state === "complete") {
          try {
            await refreshItemsAfterScan();
            if (!cancelled) setToast(scanResultToast(scan));
          } catch (error) {
            if (!cancelled) setToast(`自动抓取完成，但列表刷新失败：${getErrorMessage(error)}`);
          }
          return;
        }
        if (scan.state === "error") {
          setToast(`自动抓取未完成：${scan.message || "请重新扫描"}`);
        }
      } catch (error) {
        if (cancelled) return;
        const detail = getErrorMessage(error, "无法读取扫描进度");
        setScanState((current) => ({ ...current, phase: "error", error: detail }));
        setToast(`自动抓取失败：${detail}`);
      }
    };

    timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshItemsAfterScan, scanRequestPending, scanState.phase, scanState.scan?.state]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runOutputScan = async () => {
    if (scanRequestPending || scanState.scan?.state === "running") return;
    setScanRequestPending(true);
    try {
      const payload = await startOutputItemsScan();
      const scan = readScanPayload(payload);
      if (!scan) throw new Error("扫描服务没有返回有效结果");
      setScanState({ phase: "ready", scan, error: "" });
      if (scan.state === "error") {
        setToast(`自动抓取未完成：${scan.message || "请重新扫描"}`);
        return;
      }
      if (scan.state === "complete") {
        try {
          await refreshItemsAfterScan();
          setToast(scanResultToast(scan));
        } catch (error) {
          setToast(`自动抓取完成，但列表刷新失败：${getErrorMessage(error)}`);
        }
      }
    } catch (error) {
      const detail = getErrorMessage(error, "无法启动自动抓取");
      setScanState((current) => ({ ...current, phase: "error", error: detail }));
      setToast(`自动抓取失败：${detail}`);
    } finally {
      setScanRequestPending(false);
    }
  };

  const runDetection = async (mode) => {
    setDetection((current) => current ? { ...current, stage: "running", result: null } : current);
    try {
      const payload = await requestOutputAction("detect_output_item", { id: selectedId, mode });
      if (!payload?.item || !payload?.result) throw new Error("检测服务没有返回完整结果");
      replaceOutput(payload.item);
      setDetection((current) => current ? { ...current, stage: "result", result: payload.result } : current);
    } catch (error) {
      const detail = getErrorMessage(error, "本地检测服务没有返回结果；原状态已保留。");
      setDetection((current) => current ? { ...current, stage: "error", result: { detail } } : current);
    }
  };
  const saveMark = async (mark, note) => {
    setMarkSaving(true);
    try {
      const payload = await requestOutputAction("mark_output_item", { id: selectedId, mark, note });
      if (!payload?.item) throw new Error("标记服务没有返回更新后的产出项");
      replaceOutput(payload.item);
      setMarkOpen(false);
      setToast("已标记为“" + mark + "”");
    } catch (error) {
      setToast("保存失败：" + getErrorMessage(error, "原标记已保留"));
    } finally {
      setMarkSaving(false);
    }
  };

  const confirmDestructiveAction = async () => {
    const action = destructiveAction;
    if (!action || operationBusy) return;
    if (action.kind === "batch-delete") {
      setDestructiveAction(null);
      await runBatchAction("batch_delete_output_items", { ids: action.ids, confirm: true }, "批量删除");
      return;
    }
    setOperationBusy(action.kind === "file" ? "delete-file" : "delete-project");
    try {
      if (action.kind === "file") {
        const relativePath = action.file.relativePath || action.file.name;
        const payload = await requestOutputAction("delete_output_item_file", { id: action.output.id, relativePath, confirm: true });
        if (payload?.item) replaceOutput(payload.item);
        else await refreshItemsAfterScan();
        setToast(`“${action.file.name}”已移入 Windows 回收站`);
      } else {
        const payload = await requestOutputAction("delete_output_item", { id: action.output.id, confirm: true });
        if (payload?.item) replaceOutput(payload.item);
        else await refreshItemsAfterScan();
        setToast(`“${action.output.title}”的本地文件已移入 Windows 回收站，历史记录已保留`);
      }
      setDestructiveAction(null);
    } catch (error) {
      setToast(`删除失败：${getErrorMessage(error, "本地文件未被删除")}`);
    } finally {
      setOperationBusy("");
    }
  };

  const showDataState = dataState.status !== "ready" || !selected;

  return (
    <div className={cx("app-shell", IS_CODEX_EMBEDDED && "codex-embedded")}>
      {!IS_CODEX_EMBEDDED && <TopBar />}
      <div className={cx("app-content", IS_CODEX_EMBEDDED && "embedded-content")}>
        {!IS_CODEX_EMBEDDED && <Sidebar view="outputs" output={selected} onOutputs={() => undefined} onTask={() => selected && openTask(selected.source)} onToast={setToast} />}
        {showDataState ? (
          <DataStateView status={dataState.status} error={dataState.error} onRetry={() => setReloadToken((value) => value + 1)} scanState={scanState} scanRequestPending={scanRequestPending} onScan={runOutputScan} />
        ) : (
          <OutputsView outputs={outputs} selectedId={selectedId} setSelectedId={setSelectedId} selectedIds={selectedIds} onToggleSelection={toggleSelection} onToggleAll={toggleAll} onClearSelection={() => setSelectedIds(new Set())} activeTab={activeTab} setActiveTab={setActiveTab} activityFilter={activityFilter} setActivityFilter={setActivityFilter} query={query} setQuery={setQuery} typeFilter={typeFilter} setTypeFilter={setTypeFilter} onTask={openTask} onDetect={(mode) => setDetection({ mode, stage: "ready" })} onMark={() => setMarkOpen(true)} onPreview={openPreview} onOpenLocation={openLocation} onGithubUpload={setGithubUploadOutput} onPriority={setPriority} onRequestDeleteFile={(output, file) => setDestructiveAction({ kind: "file", output, file })} onRequestDeleteProject={(output) => setDestructiveAction({ kind: "project", output })} onBatchDetect={() => runBatchAction("batch_detect_output_items", { mode: "quick" }, "批量检测")} onBatchDelete={() => setDestructiveAction({ kind: "batch-delete", ids: [...selectedIds], items: outputs.filter((output) => selectedIds.has(output.id)) })} onBatchPriority={(priority) => runBatchAction("batch_set_output_item_priority", { priority }, "批量设置优先级")} batchAction={batchAction} operationBusy={Boolean(operationBusy)} onToast={setToast} scanState={scanState} scanRequestPending={scanRequestPending} onScan={runOutputScan} />
        )}
      </div>
      {detection && selected && <DetectionModal mode={detection.mode} output={selected} stage={detection.stage} result={detection.result} onStart={() => runDetection(detection.mode)} onClose={() => setDetection(null)} onViewLog={() => { setDetection(null); setActiveTab("活动"); setToast("已打开本次检测日志"); }} />}
      {markOpen && selected && <MarkModal output={selected} saving={markSaving} onSave={saveMark} onClose={() => setMarkOpen(false)} />}
      {destructiveAction && <DestructiveConfirmModal action={destructiveAction} busy={Boolean(operationBusy)} onConfirm={confirmDestructiveAction} onClose={() => setDestructiveAction(null)} />}
      {batchResult && <BatchResultModal result={batchResult} onClose={() => setBatchResult(null)} />}
      {githubUploadOutput && <GithubUploadModal key={githubUploadOutput.id} output={githubUploadOutput} onClose={() => setGithubUploadOutput(null)} onToast={setToast} />}
      {previewState && <PreviewModal state={previewState} operationBusy={Boolean(operationBusy)} onRetry={() => openPreview(previewState.output, previewState.file)} onOpenLocation={openLocation} onClose={closePreview} />}
      {toast && <Toast message={toast} />}
    </div>
  );
}
