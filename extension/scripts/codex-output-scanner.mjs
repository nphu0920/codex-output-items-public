import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_ROLLOUT_FILES = 10_000;
const DEFAULT_MIN_INTERVAL_MS = 15_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_MARKERS = [
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "pubspec.yaml",
];
const STANDALONE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".mp3", ".wav", ".mp4", ".mov", ".zip",
]);
const RELEVANT_MARKERS = [
  Buffer.from('"type":"session_meta"'),
  Buffer.from('"type":"turn_context"'),
  Buffer.from('"type":"patch_apply_end"'),
  Buffer.from('"type":"image_generation_end"'),
  Buffer.from("apply_patch"),
  Buffer.from("*** Add File:"),
  Buffer.from("*** Update File:"),
  Buffer.from("writeFile"),
  Buffer.from("Copy-Item"),
  Buffer.from("Out-File"),
  Buffer.from("Set-Content"),
  Buffer.from('"type":"custom_tool_call_output"'),
  Buffer.from('"type":"resource_link"'),
  Buffer.from('"phase":"final_answer"'),
];

function defaultState() {
  return { version: 3, updatedAt: null, files: {}, evidence: {}, lastScan: null };
}

function normalized(value) {
  try { return path.resolve(String(value || "")).replace(/[\\/]+$/, "").toLowerCase(); }
  catch { return String(value || "").replace(/[\\/]+$/, "").toLowerCase(); }
}

function isInsideOrSame(root, candidate) {
  if (!root || !candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function loadState(stateFile, log) {
  if (!fs.existsSync(stateFile)) return defaultState();
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scanner.json 根值必须是对象");
    if (Number(value.version) !== 3) return defaultState();
    return {
      version: 3,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
      files: value.files && typeof value.files === "object" && !Array.isArray(value.files) ? value.files : {},
      evidence: value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence) ? value.evidence : {},
      lastScan: value.lastScan && typeof value.lastScan === "object" ? value.lastScan : null,
    };
  } catch (error) {
    log("scanner-state-read-error", { message: error instanceof Error ? error.message : String(error) });
    return defaultState();
  }
}

function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, stateFile);
}

function collectRolloutFiles(codexRoot, log) {
  const roots = [path.join(codexRoot, "sessions"), path.join(codexRoot, "archived_sessions")];
  const files = [];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length && files.length < MAX_ROLLOUT_FILES) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      log("scanner-directory-error", { path: current, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(target);
      if (files.length >= MAX_ROLLOUT_FILES) break;
    }
  }
  return files.sort((left, right) => {
    try { return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs; }
    catch { return left.localeCompare(right); }
  });
}

function loadThreadTitles(codexRoot, log) {
  const candidates = new Map();
  const indexFile = path.join(codexRoot, "session_index.jsonl");
  if (!fs.existsSync(indexFile)) return new Map();
  let text;
  try {
    const stat = fs.statSync(indexFile);
    if (stat.size > 16 * 1024 * 1024) return new Map();
    text = fs.readFileSync(indexFile, "utf8");
  } catch (error) {
    log("scanner-index-error", { message: error instanceof Error ? error.message : String(error) });
    return new Map();
  }
  let lineNumber = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const id = String(record.id || "").trim().toLowerCase();
      const title = typeof record.thread_name === "string" ? record.thread_name.trim().slice(0, 240) : "";
      if (!THREAD_ID_PATTERN.test(id) || !title) continue;
      const rawUpdatedAt = record.updated_at ?? record.updatedAt;
      let updatedAt = null;
      if (typeof rawUpdatedAt === "number" && Number.isFinite(rawUpdatedAt)) {
        updatedAt = Math.abs(rawUpdatedAt) < 1_000_000_000_000 ? rawUpdatedAt * 1000 : rawUpdatedAt;
      } else if (typeof rawUpdatedAt === "string" && rawUpdatedAt.trim()) {
        const numeric = Number(rawUpdatedAt);
        if (Number.isFinite(numeric)) updatedAt = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric;
        else {
          const parsed = Date.parse(rawUpdatedAt);
          if (Number.isFinite(parsed)) updatedAt = parsed;
        }
      }
      const previous = candidates.get(id);
      const wins = !previous
        || (updatedAt !== null && previous.updatedAt === null)
        || (updatedAt !== null && previous.updatedAt !== null && updatedAt >= previous.updatedAt)
        || (updatedAt === null && previous.updatedAt === null && lineNumber > previous.lineNumber);
      if (wins) candidates.set(id, { title, updatedAt, lineNumber });
    } catch { }
  }
  return new Map([...candidates].map(([id, candidate]) => [id, candidate.title]));
}

async function loadThreadCatalog(codexRoot, log) {
  const titles = loadThreadTitles(codexRoot, log);
  const threads = new Map();
  const parents = new Map();
  let available = false;
  try {
    const sqliteFiles = fs.readdirSync(codexRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
      .sort((left, right) => Number(/\d+/.exec(right.name)?.[0] || 0) - Number(/\d+/.exec(left.name)?.[0] || 0));
    if (sqliteFiles.length) {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(path.join(codexRoot, sqliteFiles[0].name), { readOnly: true });
      try {
        const threadColumns = new Set(database.prepare("PRAGMA table_info(threads)").all()
          .map((row) => String(row.name || "").trim().toLowerCase()));
        const titleExpression = threadColumns.has("name")
          ? threadColumns.has("title")
            ? `COALESCE(NULLIF(TRIM("name"), ''), "title") AS resolved_title`
            : `"name" AS resolved_title`
          : threadColumns.has("title")
            ? `"title" AS resolved_title`
            : "NULL AS resolved_title";
        for (const row of database.prepare(`SELECT id, ${titleExpression}, cwd, thread_source, agent_role, agent_path FROM threads`).all()) {
          const id = String(row.id || "").trim().toLowerCase();
          if (!THREAD_ID_PATTERN.test(id)) continue;
          const sqliteTitle = String(row.resolved_title || "").trim();
          threads.set(id, {
            id,
            title: sqliteTitle,
            cwd: String(row.cwd || "").trim(),
            threadSource: String(row.thread_source || "").trim(),
            agentRole: row.agent_role == null ? null : String(row.agent_role),
            agentPath: row.agent_path == null ? null : String(row.agent_path),
          });
          if (!titles.has(id) && sqliteTitle) titles.set(id, sqliteTitle.slice(0, 240));
        }
        for (const row of database.prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges").all()) {
          const parent = String(row.parent_thread_id || "").trim().toLowerCase();
          const child = String(row.child_thread_id || "").trim().toLowerCase();
          if (THREAD_ID_PATTERN.test(parent) && THREAD_ID_PATTERN.test(child)) parents.set(child, parent);
        }
        available = true;
      } finally {
        database.close();
      }
    }
  } catch (error) {
    log("scanner-thread-catalog-fallback", { message: error instanceof Error ? error.message : String(error) });
  }

  const rootFor = (id, fallbackSessionId = null) => {
    let current = String(id || "").trim().toLowerCase();
    const seen = new Set();
    while (THREAD_ID_PATTERN.test(current) && parents.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parents.get(current);
    }
    if (threads.get(current)?.threadSource === "user") return current;
    const fallback = String(fallbackSessionId || "").trim().toLowerCase();
    if (THREAD_ID_PATTERN.test(fallback) && (!available || threads.get(fallback)?.threadSource === "user")) return fallback;
    if (!available && THREAD_ID_PATTERN.test(current)) return current;
    return null;
  };

  const isUnrootedSubagent = (id) => available
    && threads.get(String(id || "").trim().toLowerCase())?.threadSource === "subagent"
    && !rootFor(id);

  return { available, titles, threads, rootFor, isUnrootedSubagent };
}

function relevantRecord(recordBuffer) {
  return RELEVANT_MARKERS.some((marker) => recordBuffer.includes(marker));
}

function appendTail(previous, value, limit) {
  const combined = previous.length ? Buffer.concat([previous, value]) : Buffer.from(value);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

async function readJsonlRange(filePath, start, end, handlers) {
  if (end < start) return { offset: start, bytesRead: 0, skippedRecords: 0 };
  const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 256 * 1024 });
  let parts = [];
  let bufferedBytes = 0;
  let dropping = false;
  let oversizedHead = Buffer.alloc(0);
  let oversizedTail = Buffer.alloc(0);
  let absoluteOffset = start;
  let completeOffset = start;
  let skippedRecords = 0;

  const appendPart = (part) => {
    if (!part.length) return;
    if (dropping) {
      oversizedTail = appendTail(oversizedTail, part, 512 * 1024);
      return;
    }
    if (bufferedBytes + part.length <= MAX_JSONL_RECORD_BYTES) {
      parts.push(part);
      bufferedBytes += part.length;
      return;
    }
    const existing = parts.length ? Buffer.concat(parts, bufferedBytes) : Buffer.alloc(0);
    oversizedHead = existing.subarray(0, Math.min(existing.length, 64 * 1024));
    oversizedTail = appendTail(existing.subarray(Math.max(0, existing.length - 512 * 1024)), part, 512 * 1024);
    parts = [];
    bufferedBytes = 0;
    dropping = true;
  };

  const finishRecord = async () => {
    if (dropping) {
      skippedRecords += 1;
      await handlers.onOversized?.({ head: oversizedHead, tail: oversizedTail });
    } else {
      const recordBuffer = parts.length ? Buffer.concat(parts, bufferedBytes) : Buffer.alloc(0);
      if (recordBuffer.length && relevantRecord(recordBuffer)) await handlers.onRecord(recordBuffer);
    }
    parts = [];
    bufferedBytes = 0;
    dropping = false;
    oversizedHead = Buffer.alloc(0);
    oversizedTail = Buffer.alloc(0);
  };

  for await (const chunk of stream) {
    let position = 0;
    while (position < chunk.length) {
      const newline = chunk.indexOf(0x0a, position);
      const stop = newline < 0 ? chunk.length : newline;
      appendPart(chunk.subarray(position, stop));
      absoluteOffset += stop - position;
      position = stop;
      if (newline >= 0) {
        absoluteOffset += 1;
        position += 1;
        await finishRecord();
        completeOffset = absoluteOffset;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { offset: completeOffset, bytesRead: Math.max(0, completeOffset - start), skippedRecords };
}

function jsonStringField(rawText, field) {
  const pattern = new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = pattern.exec(rawText);
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch { return null; }
}

function imageEventFromRaw(headBuffer, tailBuffer = headBuffer) {
  const head = headBuffer.toString("utf8");
  if (!head.includes('"type":"image_generation_end"')) return null;
  const tail = tailBuffer.toString("utf8");
  const status = jsonStringField(head, "status");
  const savedPath = jsonStringField(tail, "saved_path") || jsonStringField(head, "saved_path");
  const callId = jsonStringField(head, "call_id");
  return status === "completed" && savedPath ? { savedPath, callId } : null;
}

function decodeRecordedPath(value) {
  let candidate = String(value || "").trim();
  candidate = candidate.replace(/^[<`"']+|[>`"',.;]+$/g, "");
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (/^[A-Za-z]:\\\\/.test(candidate)) candidate = candidate.replace(/\\\\/g, "\\");
  if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
  if (candidate.toLowerCase().startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
      if (/^\/[A-Za-z]:[\\/]/.test(candidate)) candidate = candidate.slice(1);
    } catch { return ""; }
  }
  return candidate;
}

function ignoredPath(target, codexRoot, excludedRoots = []) {
  const key = normalized(target);
  if (!key || /[<>|*?]/.test(target)) return true;
  const portable = String(target).replaceAll("/", "\\").toLowerCase();
  const segments = portable.split("\\").filter(Boolean);
  if (segments.some((part) => [".git", "node_modules", ".venv", "work", "tmp", "temp", "probe", "probes", "test", "tests"].includes(part))) return true;
  if (/\\appdata\\local\\temp(?:\\|$)/i.test(portable)) return true;
  if (/\\appdata\\local\\codexoutputitems(?:\\|$)/i.test(portable)) return true;
  if (segments.includes("desktop") && [".lnk", ".url"].includes(path.extname(target).toLowerCase())) return true;
  if (isInsideOrSame(os.tmpdir(), target)) return true;
  if (excludedRoots.some((root) => root && isInsideOrSame(root, target))) return true;
  if (!isInsideOrSame(codexRoot, target)) return false;
  return !isInsideOrSame(path.join(codexRoot, "generated_images"), target)
    && !isInsideOrSame(path.join(codexRoot, "visualizations"), target);
}

function resolveEvidencePath(value, cwd, codexRoot, excludedRoots) {
  const decoded = decodeRecordedPath(value);
  if (!decoded || decoded.length > 4096 || /%[^%]+%|\$\{|\$env:|^~[\\/]/i.test(decoded)) return null;
  let target;
  try {
    target = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(cwd || process.cwd(), decoded);
  } catch { return null; }
  return ignoredPath(target, codexRoot, excludedRoots) ? null : target;
}

function invokesApplyPatch(input) {
  return /\btools\.apply_patch\s*\(/.test(String(input || ""));
}

function extractDirectWritePaths(input) {
  const text = String(input || "");
  if (text.includes("apply_patch") || text.includes("*** Begin Patch")) return [];
  const paths = [];
  const patterns = [
    { regex: /(?:writeFile|writeFileSync)\s*\(\s*[`"']([^`"'\r\n]+)[`"']/g, group: 1 },
    { regex: /(?:copyFile|copyFileSync)\s*\(\s*[`"'][^`"'\r\n]+[`"']\s*,\s*[`"']([^`"'\r\n]+)[`"']/g, group: 1 },
    { regex: /\bCopy-Item\b[\s\S]{0,1000}?\s-Destination\s+[`"']([^`"'\r\n]+)[`"']/gi, group: 1 },
    { regex: /\b(?:Out-File|Set-Content)\b[\s\S]{0,500}?\s-(?:LiteralPath|FilePath|Path)\s+[`"']([^`"'\r\n]+)[`"']/gi, group: 1 },
  ];
  for (const { regex, group } of patterns) {
    for (const match of text.matchAll(regex)) paths.push({ value: match[group], kind: "write-call" });
  }
  return paths;
}

function flattenOutputText(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.filter((entry) => entry && typeof entry === "object" && typeof entry.text === "string")
    .map((entry) => entry.text).join("\n");
}

function extractResourcePaths(output) {
  if (!Array.isArray(output)) return [];
  return output
    .filter((entry) => entry && typeof entry === "object" && entry.type === "resource_link" && typeof entry.uri === "string")
    .map((entry) => ({ value: entry.uri, kind: "resource-link" }));
}

function extractFinalAnswerPaths(text) {
  const paths = [];
  const markdownLink = /\]\(\s*<?([A-Za-z]:[\\/][^)\r\n>]+)>?\s*\)/g;
  const angleLink = /\]\(\s*<?(\/[A-Za-z]:[\\/][^)\r\n>]+)>?\s*\)/g;
  for (const pattern of [markdownLink, angleLink]) {
    for (const match of String(text || "").matchAll(pattern)) paths.push({ value: match[1], kind: "final-link" });
  }
  return paths;
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((entry) => entry && typeof entry === "object" && typeof entry.text === "string")
    .map((entry) => entry.text).join("\n");
}

function hasProjectMarker(directory) {
  try {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(directory, marker)))) return true;
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isFile() && /\.(?:sln|csproj|fsproj|vbproj)$/i.test(entry.name));
  } catch { return false; }
}

function managedTaskFolder(target, codexRoot, threadId) {
  const generatedRoot = path.join(codexRoot, "generated_images");
  if (isInsideOrSame(generatedRoot, target)) {
    const relative = path.relative(generatedRoot, target).split(path.sep).filter(Boolean);
    if (relative.length >= 2 && THREAD_ID_PATTERN.test(relative[0])) return path.join(generatedRoot, relative[0]);
  }
  const visualRoot = path.join(codexRoot, "visualizations");
  if (isInsideOrSame(visualRoot, target)) {
    let current = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
    while (isInsideOrSame(visualRoot, current) && normalized(current) !== normalized(visualRoot)) {
      if (THREAD_ID_PATTERN.test(path.basename(current)) && (!threadId || path.basename(current).toLowerCase() === threadId.toLowerCase())) {
        try { if (fs.readdirSync(current).length) return current; } catch { }
      }
      current = path.dirname(current);
    }
  }
  return null;
}

function directOutputParent(observation) {
  if (!observation.cwd || !isInsideOrSame(observation.cwd, observation.path)) return null;
  const segments = path.relative(observation.cwd, observation.path).split(path.sep).filter(Boolean);
  if (segments.length === 2 && ["outputs", "output", "artifacts", "deliverables"].includes(segments[0].toLowerCase())) {
    return path.join(observation.cwd, segments[0]);
  }
  return null;
}

function artifactRootFor(observation, codexRoot, directGroupRoot = null) {
  const target = observation.path;
  const managed = managedTaskFolder(target, codexRoot, observation.threadId);
  if (managed) return managed;
  if (directGroupRoot) return directGroupRoot;
  const boundary = observation.cwd && isInsideOrSame(observation.cwd, target) ? path.resolve(observation.cwd) : null;
  if (boundary) {
    const relative = path.relative(boundary, target);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length >= 3 && ["outputs", "output", "artifacts", "deliverables"].includes(segments[0].toLowerCase())) {
      return path.join(boundary, segments[0], segments[1]);
    }
  }
  const extension = path.extname(target).toLowerCase();
  if (STANDALONE_EXTENSIONS.has(extension) && !observation.kind.startsWith("patch")) return target;
  let directory;
  try { directory = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target); }
  catch { directory = path.dirname(target); }
  let current = directory;
  for (let depth = 0; depth < 12; depth += 1) {
    if (hasProjectMarker(current)) return current;
    if ((boundary && normalized(current) === normalized(boundary)) || normalized(current) === normalized(path.dirname(current))) break;
    current = path.dirname(current);
  }
  return target;
}

function evidenceHash(observation) {
  return crypto.createHash("sha256").update([
    observation.threadId, observation.callId || observation.turnId || observation.timestamp || "", normalized(observation.path),
  ].join("|")).digest("hex").slice(0, 24);
}

function isReliableObservation(observation, codexRoot) {
  if (["generated-image", "resource-link", "final-link"].includes(observation.kind)) return true;
  if (managedTaskFolder(observation.path, codexRoot, observation.threadId)) return true;
  if (!observation.cwd || !isInsideOrSame(observation.cwd, observation.path)) return false;
  if (observation.kind === "patch-delete") return true;
  const relative = path.relative(observation.cwd, observation.path);
  const first = relative.split(path.sep).filter(Boolean)[0]?.toLowerCase();
  if (["outputs", "output", "artifacts", "deliverables"].includes(first)) return true;
  let current;
  try { current = fs.existsSync(observation.path) && fs.statSync(observation.path).isDirectory() ? observation.path : path.dirname(observation.path); }
  catch { current = path.dirname(observation.path); }
  for (let depth = 0; depth < 12 && isInsideOrSame(observation.cwd, current); depth += 1) {
    if (hasProjectMarker(current)) return true;
    if (normalized(current) === normalized(observation.cwd)) break;
    current = path.dirname(current);
  }
  return false;
}

function groupObservations(observations, codexRoot) {
  const reliable = observations.filter((observation) => isReliableObservation(observation, codexRoot));
  const groups = new Map();
  const directBuckets = new Map();
  for (const observation of reliable) {
    const parent = directOutputParent(observation);
    if (!parent) continue;
    const versionKey = `${observation.threadId}|${observation.turnId || observation.callId || "unknown"}|${normalized(parent)}`;
    const bucket = directBuckets.get(versionKey) || { parent, paths: new Set() };
    bucket.paths.add(normalized(observation.path));
    directBuckets.set(versionKey, bucket);
  }
  for (const observation of reliable) {
    const directParent = directOutputParent(observation);
    const directKey = directParent
      ? `${observation.threadId}|${observation.turnId || observation.callId || "unknown"}|${normalized(directParent)}`
      : null;
    const directRoot = directKey && directBuckets.get(directKey)?.paths.size >= 2 ? directParent : null;
    const root = artifactRootFor(observation, codexRoot, directRoot);
    const versionKey = `scan:${observation.threadId}:${observation.turnId || observation.callId || "unknown"}`;
    const key = `${normalized(root)}|${versionKey}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        path: root,
        versionKey,
        threadId: observation.threadId,
        turnId: observation.turnId || null,
        project: observation.project,
        task: observation.task,
        cwd: observation.cwd,
        firstAt: observation.timestamp,
        lastAt: observation.timestamp,
        evidenceIds: new Set(),
        evidencePaths: new Set(),
        kinds: new Set(),
        deletedPaths: new Set(),
        producerThreadIds: new Set(),
        agentPaths: new Set(),
      };
      groups.set(key, group);
    }
    if (String(observation.timestamp) < String(group.firstAt)) group.firstAt = observation.timestamp;
    if (String(observation.timestamp) > String(group.lastAt)) group.lastAt = observation.timestamp;
    group.evidenceIds.add(evidenceHash(observation));
    group.evidencePaths.add(observation.path);
    group.kinds.add(observation.kind);
    if (observation.deleted) group.deletedPaths.add(observation.path);
    if (observation.producerThreadId) group.producerThreadIds.add(observation.producerThreadId);
    if (observation.agentPath) group.agentPaths.add(observation.agentPath);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    evidenceIds: [...group.evidenceIds],
    evidencePaths: [...group.evidencePaths],
    kinds: [...group.kinds],
    deletedPaths: [...group.deletedPaths],
    producerThreadIds: [...group.producerThreadIds],
    agentPaths: [...group.agentPaths],
  })).sort((left, right) => String(left.lastAt).localeCompare(String(right.lastAt)));
}

function makeObservation(rawPath, kind, context, record, details, codexRoot, titles, excludedRoots) {
  const threadId = String(context.threadId || "").trim();
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const cwd = String(details.cwd || context.cwd || "").trim();
  const target = resolveEvidencePath(rawPath, cwd, codexRoot, excludedRoots);
  if (!target) return null;
  const task = titles.get(threadId) || context.task || `Codex 任务 ${threadId.slice(0, 8)}`;
  return {
    path: target,
    kind,
    threadId,
    turnId: details.turnId || context.turnId || null,
    callId: details.callId || null,
    timestamp: record?.timestamp || new Date().toISOString(),
    cwd,
    project: cwd ? path.basename(path.resolve(cwd)) : "Codex",
    task,
    rolloutPath: details.rolloutPath,
    producerThreadId: context.ownerId || threadId,
    agentPath: context.agentPath || null,
    deleted: details.deleted === true,
  };
}

function addCandidate(observations, rawPath, kind, context, record, details, codexRoot, titles, excludedRoots) {
  const observation = makeObservation(rawPath, kind, context, record, details, codexRoot, titles, excludedRoots);
  if (observation) observations.push(observation);
}

function recordTurnId(payload, context) {
  return payload?.turn_id
    || payload?.internal_chat_message_metadata_passthrough?.turn_id
    || context.turnId
    || null;
}

function recordTimeMs(record) {
  const parsed = Date.parse(String(record?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function originTimestamp(record, context) {
  if (!context.ownerMetaSeen || context.originStartedMs == null || !Number.isFinite(Number(context.originStartedMs))) return true;
  const timestamp = recordTimeMs(record);
  return timestamp == null || timestamp >= Number(context.originStartedMs) - 2_000;
}

function outputSucceeded(output) {
  let text = "";
  try { text = typeof output === "string" ? output : JSON.stringify(output); }
  catch { return false; }
  return !/(?:Script failed|Process exited with code\s+[1-9]|"isError"\s*:\s*true|"exit_code"\s*:\s*[1-9]\d*)/i.test(text);
}

async function scanRolloutFile(filePath, previousState, force, codexRoot, catalog, excludedRoots) {
  const titles = catalog.titles;
  const stat = fs.statSync(filePath);
  let start = force ? 0 : Number(previousState?.offset || 0);
  if (!Number.isFinite(start) || start < 0 || start > stat.size) start = 0;
  if (!force && previousState && Number(previousState.size) === stat.size
    && Number(previousState.mtimeMs) === stat.mtimeMs && start === stat.size) {
    return { state: previousState, observations: [], bytesRead: 0, skippedRecords: 0 };
  }
  if (!force && previousState && Number(previousState.size) === stat.size
    && Number(previousState.mtimeMs) !== stat.mtimeMs && start === stat.size) start = 0;

  const context = force ? {} : { ...(previousState?.context || {}) };
  const pendingApplyCalls = new Set(Array.isArray(context.pendingApplyCalls) ? context.pendingApplyCalls : []);
  const pendingWrites = new Map(Object.entries(context.pendingWrites && typeof context.pendingWrites === "object" ? context.pendingWrites : {}));
  const observations = [];
  let parseSkips = 0;
  const details = { rolloutPath: filePath };

  const handleRawImage = (head, tail = head) => {
    if (context.ignoreAgent) return false;
    const image = imageEventFromRaw(head, tail);
    if (!image) return false;
    const rawHead = head.toString("utf8");
    const timestamp = jsonStringField(rawHead, "timestamp") || new Date(stat.mtimeMs).toISOString();
    if (!originTimestamp({ timestamp }, context)) return false;
    addCandidate(observations, image.savedPath, "generated-image", context, { timestamp }, {
      ...details, callId: image.callId, turnId: context.turnId,
    }, codexRoot, titles, excludedRoots);
    return true;
  };

  const onRecord = async (recordBuffer) => {
    if (recordBuffer.includes(Buffer.from('"type":"image_generation_end"'))) {
      handleRawImage(recordBuffer);
      return;
    }
    let record;
    try { record = JSON.parse(recordBuffer.toString("utf8")); }
    catch { parseSkips += 1; return; }
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") return;

    if (record.type === "session_meta") {
      if (context.ownerMetaSeen) return;
      context.ownerMetaSeen = true;
      context.ownerId = String(payload.id || payload.session_id || "");
      const originMs = recordTimeMs(record) ?? Date.parse(String(payload.timestamp || ""));
      context.originStartedMs = Number.isFinite(originMs) ? originMs : null;
      context.ownerSessionId = String(payload.session_id || "");
      const rootId = catalog.rootFor(context.ownerId, context.ownerSessionId);
      const isGuardian = payload.source?.subagent?.other === "guardian"
        || payload.source?.subagent?.type === "guardian"
        || catalog.threads.get(context.ownerId)?.agentRole === "guardian";
      context.ignoreAgent = isGuardian || catalog.isUnrootedSubagent(context.ownerId) || !rootId;
      context.threadId = rootId || null;
      if (typeof payload.cwd === "string" && payload.cwd.trim()) context.cwd = payload.cwd;
      else if (rootId && catalog.threads.get(rootId)?.cwd) context.cwd = catalog.threads.get(rootId).cwd;
      if (payload.source?.subagent?.thread_spawn) {
        context.agentPath = payload.source.subagent.thread_spawn.agent_path || payload.agent_path || null;
      }
      if (rootId && titles.has(rootId)) context.task = titles.get(rootId);
      return;
    }
    if (!originTimestamp(record, context)) return;
    if (record.type === "turn_context") {
      if (typeof payload.cwd === "string" && payload.cwd.trim()) context.cwd = payload.cwd;
      if (typeof payload.turn_id === "string" && payload.turn_id.trim()) context.turnId = payload.turn_id;
      return;
    }
    if (record.type === "event_msg" && payload.type === "patch_apply_end") {
      if (context.ignoreAgent) return;
      const callId = String(payload.call_id || "");
      if (!callId || !pendingApplyCalls.has(callId)) return;
      pendingApplyCalls.delete(callId);
      if (payload.success !== true || payload.status !== "completed" || !payload.changes || typeof payload.changes !== "object") return;
      const turnId = recordTurnId(payload, context);
      for (const [changedPath, change] of Object.entries(payload.changes)) {
        if (!change || typeof change !== "object") continue;
        addCandidate(observations, changedPath, change.type === "delete" ? "patch-delete" : "patch-event", context, record, {
          ...details, callId, turnId, deleted: change.type === "delete",
        }, codexRoot, titles, excludedRoots);
        if (typeof change.move_path === "string" && change.move_path.trim()) {
          addCandidate(observations, change.move_path, "patch-event", context, record, {
            ...details, callId, turnId,
          }, codexRoot, titles, excludedRoots);
        }
      }
      return;
    }
    if (record.type === "response_item" && payload.type === "custom_tool_call" && payload.name === "exec") {
      if (context.ignoreAgent) return;
      const turnId = recordTurnId(payload, context);
      const input = String(payload.input || "");
      const callId = String(payload.call_id || "");
      if (!callId) return;
      if (invokesApplyPatch(input)) pendingApplyCalls.add(callId);
      const writes = extractDirectWritePaths(input);
      if (writes.length) pendingWrites.set(callId, {
        candidates: writes,
        cwd: context.cwd || null,
        turnId,
        timestamp: record.timestamp || null,
      });
      return;
    }
    if (record.type === "response_item" && payload.type === "custom_tool_call_output") {
      if (context.ignoreAgent) return;
      const turnId = recordTurnId(payload, context);
      const callId = String(payload.call_id || "");
      for (const candidate of extractResourcePaths(payload.output)) {
        addCandidate(observations, candidate.value, candidate.kind, context, record, {
          ...details, callId, turnId,
        }, codexRoot, titles, excludedRoots);
      }
      const pending = pendingWrites.get(callId);
      if (pending) {
        if (outputSucceeded(payload.output)) {
          for (const candidate of pending.candidates || []) {
            addCandidate(observations, candidate.value, candidate.kind, context, record, {
              ...details, cwd: pending.cwd, callId, turnId: pending.turnId || turnId,
            }, codexRoot, titles, excludedRoots);
          }
        }
        pendingWrites.delete(callId);
      }
      return;
    }
    if (record.type === "response_item" && payload.type === "message"
      && payload.role === "assistant" && payload.phase === "final_answer") {
      if (context.ignoreAgent) return;
      const turnId = recordTurnId(payload, context);
      for (const candidate of extractFinalAnswerPaths(contentText(payload.content))) {
        addCandidate(observations, candidate.value, candidate.kind, context, record, {
          ...details, callId: payload.id, turnId,
        }, codexRoot, titles, excludedRoots);
      }
      return;
    }
    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer") {
      if (context.ignoreAgent) return;
      for (const candidate of extractFinalAnswerPaths(payload.message)) {
        addCandidate(observations, candidate.value, candidate.kind, context, record, {
          ...details, callId: null, turnId: context.turnId,
        }, codexRoot, titles, excludedRoots);
      }
    }
  };

  const result = await readJsonlRange(filePath, start, Math.max(start - 1, stat.size - 1), {
    onRecord,
    onOversized: async ({ head, tail }) => { if (!handleRawImage(head, tail)) parseSkips += 1; },
  });
  return {
    state: {
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: result.offset,
      scannedAt: new Date().toISOString(),
      context: {
        threadId: context.threadId || null,
        turnId: context.turnId || null,
        cwd: context.cwd || null,
        task: context.task || null,
        ignoreAgent: context.ignoreAgent === true,
        agentPath: context.agentPath || null,
        ownerMetaSeen: context.ownerMetaSeen === true,
        ownerId: context.ownerId || null,
        ownerSessionId: context.ownerSessionId || null,
        originStartedMs: context.originStartedMs != null && Number.isFinite(Number(context.originStartedMs)) ? Number(context.originStartedMs) : null,
        pendingApplyCalls: [...pendingApplyCalls].slice(-128),
        pendingWrites: Object.fromEntries([...pendingWrites].slice(-128)),
      },
    },
    observations,
    bytesRead: result.bytesRead,
    skippedRecords: result.skippedRecords + parseSkips,
  };
}

function publicStatus(runtime, codexRoot, state) {
  return {
    ...runtime,
    codexDataDirectory: codexRoot,
    lastScan: state.lastScan || null,
  };
}

export function createCodexOutputScanner({
  codexDataRoot,
  stateFile,
  logEvent = () => {},
  applyArtifacts,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  excludedRoots = [],
}) {
  const codexRoot = path.resolve(codexDataRoot);
  const excluded = excludedRoots.filter(Boolean).map((root) => path.resolve(root));
  let job = null;
  let queued = null;
  let lastAutomaticRequest = 0;
  let runtime = {
    phase: "idle",
    running: false,
    reason: null,
    startedAt: null,
    completedAt: null,
    lastError: null,
    filesTotal: 0,
    filesScanned: 0,
    currentFile: null,
    bytesRead: 0,
    observations: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    skippedRecords: 0,
  };

  const log = (type, details = {}) => {
    try { logEvent(type, details); } catch { }
  };

  const status = () => publicStatus(runtime, codexRoot, loadState(stateFile, log));

  const resolveTaskGroup = async ({
    threadId,
    title,
    project,
    projectKind = "manual",
    hostId = null,
    workspacePath = null,
  } = {}) => {
    const requestedThreadId = String(threadId || "").trim();
    if (!THREAD_ID_PATTERN.test(requestedThreadId)) {
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

    const catalog = await loadThreadCatalog(codexRoot, log);
    const thread = catalog.threads.get(requestedThreadId);
    const rootedThreadId = catalog.rootFor(requestedThreadId, requestedThreadId);
    // A catalog may be incomplete while old/archived user tasks still have valid
    // source IDs. Only reject an explicitly known, unrooted subagent; otherwise
    // preserve the supplied task as its own compatible root.
    const rootThreadId = rootedThreadId
      || (thread?.threadSource === "subagent" ? null : requestedThreadId);
    if (!rootThreadId) {
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

    const rootThread = catalog.threads.get(rootThreadId);
    const resolvedWorkspace = String(rootThread?.cwd || workspacePath || "").trim() || null;
    const resolvedTitle = String(catalog.titles.get(rootThreadId) || title || `Codex 任务 ${rootThreadId.slice(0, 8)}`).trim();
    const resolvedProject = String(project || (resolvedWorkspace ? path.basename(path.resolve(resolvedWorkspace)) : "Codex")).trim() || "Codex";
    return {
      key: `thread:${rootThreadId.toLowerCase()}`,
      rootThreadId: rootThreadId.toLowerCase(),
      title: resolvedTitle.slice(0, 240),
      project: resolvedProject.slice(0, 240),
      projectKind,
      hostId: typeof hostId === "string" && hostId.trim() ? hostId.trim() : null,
      workspacePath: resolvedWorkspace,
      unknown: false,
    };
  };

  const run = async (reason, force) => {
    const state = loadState(stateFile, log);
    const catalog = await loadThreadCatalog(codexRoot, log);
    const rolloutFiles = collectRolloutFiles(codexRoot, log);
    const seenThisRun = new Set();
    let dirtyFiles = 0;
    let bytesSinceCheckpoint = 0;
    runtime = {
      ...runtime,
      phase: "scanning",
      running: true,
      reason,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastError: null,
      filesTotal: rolloutFiles.length,
      filesScanned: 0,
      currentFile: null,
      bytesRead: 0,
      observations: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      missing: 0,
      skippedRecords: 0,
    };
    log("scanner-started", { reason, force, files: rolloutFiles.length, codexRoot });

    for (const filePath of rolloutFiles) {
      runtime.currentFile = filePath;
      const key = normalized(filePath);
      let result;
      try {
        result = await scanRolloutFile(filePath, state.files[key], force, codexRoot, catalog, excluded);
        const fresh = [];
        let duplicateCount = 0;
        for (const observation of result.observations) {
          const evidenceId = evidenceHash(observation);
          if (seenThisRun.has(evidenceId) || (!force && state.evidence[evidenceId])) {
            duplicateCount += 1;
            continue;
          }
          seenThisRun.add(evidenceId);
          fresh.push(observation);
        }
        const groups = groupObservations(fresh, codexRoot);
        const acceptedEvidence = new Set(groups.flatMap((group) => group.evidenceIds));
        const applied = groups.length
          ? await applyArtifacts(groups, { reconcile: false, reason })
          : { added: 0, updated: 0, unchanged: 0, missing: 0 };
        const seenAt = new Date().toISOString();
        for (const evidenceId of acceptedEvidence) state.evidence[evidenceId] = seenAt;
        if (Object.keys(state.evidence).length > 50_000) {
          state.evidence = Object.fromEntries(Object.entries(state.evidence)
            .sort((left, right) => String(left[1]).localeCompare(String(right[1])))
            .slice(-40_000));
        }
        runtime.bytesRead += result.bytesRead;
        runtime.observations += acceptedEvidence.size;
        runtime.skippedRecords += result.skippedRecords + duplicateCount + Math.max(0, fresh.length - acceptedEvidence.size);
        runtime.added += Number(applied?.added || 0);
        runtime.updated += Number(applied?.updated || 0);
        runtime.unchanged += Number(applied?.unchanged || 0);
        runtime.missing += Number(applied?.missing || 0);
        const previousCursor = state.files[key];
        const cursorChanged = !previousCursor
          || Number(previousCursor.offset) !== Number(result.state.offset)
          || Number(previousCursor.size) !== Number(result.state.size)
          || Number(previousCursor.mtimeMs) !== Number(result.state.mtimeMs);
        state.files[key] = result.state;
        if (cursorChanged || acceptedEvidence.size) {
          state.updatedAt = new Date().toISOString();
          dirtyFiles += 1;
          bytesSinceCheckpoint += result.bytesRead;
          if (dirtyFiles >= 16 || bytesSinceCheckpoint >= 256 * 1024 * 1024) {
            saveState(stateFile, state);
            dirtyFiles = 0;
            bytesSinceCheckpoint = 0;
          }
        }
      } catch (error) {
        runtime.skippedRecords += 1;
        log("scanner-file-error", { path: filePath, message: error instanceof Error ? error.message : String(error) });
      }
      runtime.filesScanned += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }

    const reconciled = await applyArtifacts([], { reconcile: true, reason, taskCatalog: catalog });
    runtime.updated += Number(reconciled?.updated || 0);
    runtime.unchanged += Number(reconciled?.unchanged || 0);
    runtime.missing = Math.max(runtime.missing, Number(reconciled?.missing || 0));
    runtime.currentFile = null;
    runtime.phase = "idle";
    runtime.running = false;
    runtime.completedAt = new Date().toISOString();
    state.updatedAt = runtime.completedAt;
    state.lastScan = {
      reason,
      force,
      startedAt: runtime.startedAt,
      completedAt: runtime.completedAt,
      filesTotal: runtime.filesTotal,
      filesScanned: runtime.filesScanned,
      bytesRead: runtime.bytesRead,
      observations: runtime.observations,
      added: runtime.added,
      updated: runtime.updated,
      unchanged: runtime.unchanged,
      missing: runtime.missing,
      skippedRecords: runtime.skippedRecords,
    };
    saveState(stateFile, state);
    log("scanner-completed", state.lastScan);
  };

  const start = (reason = "manual", { force = false } = {}) => {
    if (job) {
      queued = { reason, force: Boolean(force || queued?.force) };
      return status();
    }
    runtime = { ...runtime, phase: "scheduled", running: true, reason, lastError: null };
    job = new Promise((resolve) => setImmediate(resolve))
      .then(() => run(reason, Boolean(force)))
      .catch((error) => {
        runtime = {
          ...runtime,
          phase: "error",
          running: false,
          currentFile: null,
          completedAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        };
        log("scanner-error", { reason, message: runtime.lastError });
      })
      .finally(() => {
        job = null;
        if (queued) {
          const next = queued;
          queued = null;
          start(next.reason, { force: next.force });
        }
      });
    return status();
  };

  const maybeStart = (reason = "automatic") => {
    const now = Date.now();
    if (job || now - lastAutomaticRequest < minIntervalMs) return status();
    lastAutomaticRequest = now;
    return start(reason, { force: false });
  };

  return { start, maybeStart, status, resolveTaskGroup };
}
