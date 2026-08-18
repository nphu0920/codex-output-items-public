import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[]|\.$|\.lock(?:\/|$)))[A-Za-z0-9._\/-]{1,180}$/;
const SAFE_RELATIVE_PATTERN = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]+$/;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const GITHUB_WARNING_SIZE = 50 * 1024 * 1024;
const PREFLIGHT_TTL_MS = 15 * 60 * 1000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_EXIT_CLEANUPS = new Set();
let processExitCleanupRegistered = false;
const BINARY_EXTENSIONS = new Set([".exe", ".msi", ".msix", ".appx", ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".dmg", ".pkg", ".deb", ".rpm", ".apk", ".ipa"]);
const SKIP_DIRECTORY_NAMES = new Set([".git", "node_modules", ".pnpm-store", ".yarn", ".cache", "__pycache__"]);
const SENSITIVE_NAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /(?:credential|credentials|secret|secrets|token|tokens|password|passwd|auth)[._-]?(?:json|ya?ml|toml|ini|txt|config)?$/i,
  /^\.?(?:npmrc|pypirc|netrc)$/i,
];
const PRIVATE_KEY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);
const SECRET_PATTERNS = [
  { kind: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { kind: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { kind: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "aws-access-key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: "openai-api-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "generic-secret", regex: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-\/.+=]{16,}/i },
];

function errorWithCode(message, code = "GITHUB_PUBLISH_INVALID", statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function registerProcessExitCleanup(cleanup) {
  PROCESS_EXIT_CLEANUPS.add(cleanup);
  if (processExitCleanupRegistered) return;
  processExitCleanupRegistered = true;
  process.once("exit", () => {
    for (const handler of PROCESS_EXIT_CLEANUPS) {
      try { handler(); } catch { }
    }
  });
}

function redact(value) {
  return String(value || "")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .slice(0, 4000);
}

function runProcess(command, args, { cwd, env, timeoutMs = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutput = 2 * 1024 * 1024;
    child.stdout?.on("data", (chunk) => { if (stdoutBytes < maxOutput) stdout.push(chunk); stdoutBytes += chunk.length; });
    child.stderr?.on("data", (chunk) => { if (stderrBytes < maxOutput) stderr.push(chunk); stderrBytes += chunk.length; });
    let settled = false;
    let timer;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    if (input !== undefined) child.stdin.end(input);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(errorWithCode(`外部命令超时：${path.basename(command)}`, "GITHUB_COMMAND_TIMEOUT", 504));
    }, timeoutMs);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        stdout: redact(Buffer.concat(stdout).toString("utf8")),
        stderr: redact(Buffer.concat(stderr).toString("utf8")),
      };
      if (result.code !== 0) {
        reject(errorWithCode(result.stderr || result.stdout || `${path.basename(command)} 执行失败`, "GITHUB_COMMAND_FAILED", 409));
        return;
      }
      resolve(result);
    });
  });
}

function findExecutable(name) {
  const pathValue = String(process.env.PATH || "");
  const extensions = process.platform === "win32" ? [".exe"] : [""];
  for (const folder of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(folder.replace(/^"|"$/g, ""), `${name}${extension}`);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { }
    }
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || path.join(path.parse(process.execPath).root, "Program Files");
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const candidates = name.toLowerCase() === "gh" ? [
      path.join(programFiles, "GitHub CLI", "gh.exe"),
      path.join(localAppData, "Programs", "GitHub CLI", "gh.exe"),
      path.join(localAppData, "Microsoft", "WinGet", "Links", "gh.exe"),
      path.join(os.homedir(), "scoop", "shims", "gh.exe"),
    ] : name.toLowerCase() === "git" ? [
      path.join(programFiles, "Git", "cmd", "git.exe"),
      path.join(localAppData, "Programs", "Git", "cmd", "git.exe"),
      path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "cmd", "git.exe"),
    ] : [];
    for (const candidate of candidates) {
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { }
    }
  }
  return null;
}

function validateName(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized) || normalized === "." || normalized === ".." || normalized.endsWith(".git")) {
    throw errorWithCode(`${label}无效`);
  }
  return normalized;
}

function validateRelative(value, label = "文件路径") {
  const raw = String(value || "").trim().replaceAll("/", path.sep).replaceAll("\\", path.sep);
  if (!raw || !SAFE_RELATIVE_PATTERN.test(raw)) throw errorWithCode(`${label}无效`);
  const normalized = path.normalize(raw);
  if (normalized === "." || normalized === ".." || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`)) {
    throw errorWithCode(`${label}越出产出项范围`);
  }
  return normalized;
}

function validateBranchName(value, label = "分支名称") {
  const branch = String(value || "").trim();
  const segments = branch.split("/");
  if (!BRANCH_PATTERN.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch === "@"
    || segments.some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))) {
    throw errorWithCode(`${label}无效`);
  }
  return branch;
}

function validateDestinationPath(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  if (String(value).trim() === ".") return ".";
  const normalized = validateRelative(value, "仓库目标目录").split(path.sep).join("/");
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw errorWithCode("仓库目标目录不能写入 .git 元数据", "GITHUB_REPOSITORY_METADATA_BLOCKED", 403);
  }
  return normalized;
}

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsContainEachOther(left, right) {
  return isInsideOrEqual(left, right) || isInsideOrEqual(right, left);
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ""));
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const suffix = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function realInside(root, candidate) {
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideOrEqual(realRoot, realCandidate)) throw errorWithCode("文件路径越出产出项真实目录", "GITHUB_PATH_ESCAPE");
  return realCandidate;
}

function normalizeConfig(value, authenticatedLogin = null, { defaultBranch = null } = {}) {
  const input = value?.config && typeof value.config === "object" ? value.config : value || {};
  const destination = input.destination || {
    mode: input.repositoryMode,
    owner: input.owner,
    repo: input.repository,
    visibility: input.visibility,
    path: input.destinationPath,
  };
  const upload = input.upload || {
    scope: input.scope,
    customPaths: input.selectedPaths,
    currentRelativePath: input.currentRelativePath,
  };
  const repositoryMode = ["new", "existing"].includes(destination.mode) ? destination.mode : null;
  if (!repositoryMode) throw errorWithCode("请选择新建仓库或已有仓库");
  const owner = validateName(destination.owner || authenticatedLogin, OWNER_PATTERN, "仓库所有者");
  if (authenticatedLogin && owner.toLowerCase() !== authenticatedLogin.toLowerCase()) {
    throw errorWithCode("仅允许上传到当前 gh 登录账号拥有的个人仓库", "GITHUB_OWNER_MISMATCH", 403);
  }
  const repo = validateName(destination.repo, REPO_PATTERN, "仓库名称");
  const visibility = ["public", "private"].includes(destination.visibility) ? destination.visibility : null;
  if (repositoryMode === "new" && !visibility) throw errorWithCode("新仓库必须选择 Public 或 Private");
  const scope = ["whole", "current", "custom", "binaries"].includes(upload.scope) ? upload.scope : null;
  if (!scope) throw errorWithCode("上传范围无效");
  const customPaths = scope === "custom" ? [...new Set((upload.customPaths || []).map((entry) => validateRelative(entry)))] : [];
  if (scope === "custom" && (customPaths.length === 0 || customPaths.length > 500)) throw errorWithCode("自定义范围必须选择 1 至 500 个文件");
  const currentRelativePath = scope === "current" ? validateRelative(upload.currentRelativePath || ".", "当前文件路径") : null;
  const requestedPublishMode = (input.publishMode || input.writeMode) === "direct-main" ? "direct" : (input.publishMode || input.writeMode);
  const publishMode = ["branch-pr", "direct"].includes(requestedPublishMode) ? requestedPublishMode : null;
  if (!publishMode) throw errorWithCode("提交方式无效");
  const suppliedBranch = String(input.branch || "").trim();
  const branchLooksLikeLegacyDefault = /^codex-output\/\d{4}-\d{2}-\d{2}$/.test(suppliedBranch);
  const branch = publishMode === "branch-pr"
    ? String((!suppliedBranch || branchLooksLikeLegacyDefault) ? (defaultBranch || `codex-output/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`) : suppliedBranch).trim()
    : null;
  if (branch) validateBranchName(branch);
  const license = ["none", "mit", "apache-2.0", "gpl-3.0"].includes(input.license) ? input.license : "none";
  const description = String(input.description || "").trim().slice(0, 350);
  return {
    destination: { mode: repositoryMode, owner, repo, visibility, path: validateDestinationPath(destination.path ?? input.destinationPath) },
    upload: { scope, customPaths, currentRelativePath },
    publishMode,
    branch,
    license,
    generateReadme: input.generateReadme === true || input.includeReadme === true,
    protectMain: input.protectMain === true,
    description,
  };
}

function configDigest(itemId, config) {
  return crypto.createHash("sha256").update(JSON.stringify({ itemId, config })).digest("hex");
}

function defaultPublishBranch(itemId, jobId) {
  const itemSlug = String(itemId || "output").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "output";
  const date = new Date().toISOString().slice(0, 10);
  return validateBranchName(`codex-output/${itemSlug}-${date}-${String(jobId).replaceAll("-", "").slice(0, 10)}`);
}

function sensitiveName(relativePath) {
  const name = path.basename(relativePath);
  const lowerSegments = relativePath.toLowerCase().split(/[\\/]/);
  if (lowerSegments.some((segment) => SKIP_DIRECTORY_NAMES.has(segment))) return "dependency-or-vcs-directory";
  if (PRIVATE_KEY_EXTENSIONS.has(path.extname(name).toLowerCase())) return "private-key-file";
  if (SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(name))) return "credential-like-name";
  return null;
}

function fingerprintAndScan(filePath) {
  const handle = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const found = new Set();
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  let tail = "";
  let binary = false;
  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (!binary && chunk.includes(0)) { binary = true; tail = ""; }
      if (!binary) {
        const text = tail + chunk.toString("utf8");
        for (const entry of SECRET_PATTERNS) if (entry.regex.test(text)) found.add(entry.kind);
        tail = text.slice(-1024);
      }
    }
  } finally { fs.closeSync(handle); }
  return { sha256: hash.digest("hex"), secretKinds: [...found], contentScanned: !binary, bytesRead: position };
}

function assertSafeSourceRoot(value, dataRoot) {
  const requestedRoot = path.resolve(String(value || ""));
  if (!path.isAbsolute(String(value || "")) || /^\\\\[?.]\\/.test(requestedRoot) || requestedRoot.startsWith("\\\\")) {
    throw errorWithCode("产出项源路径必须是本机绝对路径", "GITHUB_SOURCE_UNSAFE", 403);
  }
  if (!fs.existsSync(requestedRoot)) throw errorWithCode("产出项路径已不存在", "GITHUB_SOURCE_MISSING", 409);
  if (fs.lstatSync(requestedRoot).isSymbolicLink()) throw errorWithCode("产出项根路径为链接，禁止上传", "GITHUB_SYMLINK_BLOCKED");
  const sourceRoot = fs.realpathSync(requestedRoot);
  const parsed = path.parse(sourceRoot);
  if (sourceRoot.toLowerCase() === parsed.root.toLowerCase()) throw errorWithCode("禁止上传磁盘根目录", "GITHUB_SOURCE_UNSAFE", 403);
  const homeRoot = canonicalPath(os.homedir());
  if (sourceRoot.toLowerCase() === homeRoot.toLowerCase()) throw errorWithCode("禁止把用户目录作为上传源", "GITHUB_SOURCE_UNSAFE", 403);
  const protectedRoots = [
    dataRoot,
    process.env.OUTPUT_ITEMS_CODEX_HOME,
    process.env.CODEX_HOME,
    path.join(os.homedir(), ".codex"),
    EXTENSION_ROOT,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
  ].filter(Boolean).map(canonicalPath);
  if (protectedRoots.some((entry) => pathsContainEachOther(entry, sourceRoot))) {
    throw errorWithCode("产出项源路径与扩展、Codex、系统或程序保护目录重叠", "GITHUB_SOURCE_UNSAFE", 403);
  }
  return sourceRoot;
}

function enumerateSelectedFiles(item, config, dataRoot) {
  const itemRoot = assertSafeSourceRoot(item.path, dataRoot);
  if (!fs.existsSync(itemRoot)) throw errorWithCode("产出项路径已不存在", "GITHUB_SOURCE_MISSING", 409);
  const rootStat = fs.lstatSync(itemRoot);
  if (rootStat.isSymbolicLink()) throw errorWithCode("产出项根路径为链接，禁止上传", "GITHUB_SYMLINK_BLOCKED");
  const baseRoot = rootStat.isDirectory() ? itemRoot : path.dirname(itemRoot);
  const explicit = [];
  if (rootStat.isFile()) explicit.push(itemRoot);
  else if (config.upload.scope === "current") explicit.push(path.resolve(itemRoot, config.upload.currentRelativePath));
  else if (config.upload.scope === "custom") explicit.push(...config.upload.customPaths.map((entry) => path.resolve(itemRoot, entry)));
  else explicit.push(itemRoot);
  for (const selected of explicit) {
    if (!isInsideOrEqual(baseRoot, selected)) throw errorWithCode("选择路径越出产出项范围", "GITHUB_PATH_ESCAPE");
    if (!fs.existsSync(selected)) throw errorWithCode(`选择路径不存在：${path.basename(selected)}`, "GITHUB_SOURCE_MISSING", 409);
    realInside(baseRoot, selected);
  }

  const files = [];
  const excluded = [];
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    const relative = path.relative(baseRoot, candidate) || path.basename(candidate);
    if (stat.isSymbolicLink()) { excluded.push({ path: relative, reason: "symbolic-link" }); return; }
    const nameReason = sensitiveName(relative);
    if (nameReason) { excluded.push({ path: relative, reason: nameReason }); return; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate).sort()) visit(path.join(candidate, name));
      return;
    }
    if (!stat.isFile()) { excluded.push({ path: relative, reason: "unsupported-file-type" }); return; }
    if (config.upload.scope === "binaries" && !BINARY_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return;
    files.push({ sourcePath: candidate, relativePath: relative, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  };
  for (const selected of explicit) visit(selected);
  const unique = new Map(files.map((entry) => [entry.sourcePath.toLowerCase(), entry]));
  return { baseRoot, files: [...unique.values()], excluded };
}

function performPreflight(item, input, authenticatedLogin, dataRoot, options) {
  const config = normalizeConfig(input, authenticatedLogin, options);
  if (!config.destination.path) config.destination.path = config.destination.mode === "existing" ? `codex-output-items/${String(item.id || "output").replace(/[^A-Za-z0-9._-]/g, "-")}` : ".";
  const { baseRoot, files, excluded } = enumerateSelectedFiles(item, config, dataRoot);
  const blockers = [];
  const warnings = [];
  let totalBytes = 0;
  if (files.length === 0) blockers.push({ code: "EMPTY_SELECTION", message: "当前范围没有可上传文件" });
  if (files.length > MAX_FILES) blockers.push({ code: "TOO_MANY_FILES", message: `文件数超过 ${MAX_FILES} 个安全上限` });
  for (const file of files) {
    totalBytes += file.sizeBytes;
    const security = fingerprintAndScan(file.sourcePath);
    file.sha256 = security.sha256;
    file.contentScanned = security.contentScanned;
    if (file.sizeBytes > GITHUB_FILE_LIMIT) blockers.push({ code: "FILE_OVER_100_MIB", path: file.relativePath, message: "单文件超过 GitHub 100 MiB 硬限制" });
    else if (file.sizeBytes > GITHUB_WARNING_SIZE) warnings.push({ code: "FILE_OVER_50_MIB", path: file.relativePath, message: "单文件超过 50 MiB，推送可能缓慢并接近 GitHub 限制" });
    if (!security.contentScanned) warnings.push({ code: "BINARY_CONTENT_NOT_SCANNED", path: file.relativePath, message: "二进制内容无法按文本规则扫描；已校验文件名、大小和 SHA-256 指纹" });
    for (const kind of security.secretKinds) blockers.push({ code: "SECRET_DETECTED", kind, path: file.relativePath, message: "检测到疑似凭据或私钥；禁止上传且不可绕过" });
  }
  if (totalBytes > MAX_TOTAL_BYTES) blockers.push({ code: "TOTAL_TOO_LARGE", message: "上传总量超过 512 MiB 本地安全上限" });
  for (const entry of excluded.slice(0, 100)) {
    warnings.push({ code: "EXCLUDED_SENSITIVE_OR_DEPENDENCY", path: entry.path, message: `已自动排除：${entry.reason}` });
  }
  if (config.destination.visibility === "public") {
    warnings.unshift({
      code: "PUBLIC_VISIBILITY",
      message: "Public 仓库对任何人可见、可下载和 fork；他人不能直接修改你的原仓库，除非你另行授予协作者权限。Pull Request 是否合并由你决定。",
    });
  }
  if (config.destination.mode === "existing" && config.destination.path === ".") warnings.push({ code: "EXISTING_ROOT_OVERWRITE", message: "将写入已有仓库根目录；同路径文件会在暂存副本中被替换并形成 Git 提交" });
  if (config.destination.mode === "existing" && config.destination.path !== ".") warnings.push({ code: "EXISTING_ISOLATED_PATH", message: `已有仓库默认写入隔离子目录 ${config.destination.path}，避免静默覆盖根目录文件` });
  if (config.publishMode === "direct") warnings.push({ code: "DIRECT_MAIN", message: "将直接写入默认分支；建议仅在确认内容完整时使用" });
  if (config.publishMode === "direct" && config.protectMain) warnings.push({ code: "DIRECT_WITH_PROTECTION", message: "本次直接提交完成后会尝试保护默认分支；仓库已有保护时直接提交可能失败" });
  if (!config.protectMain) warnings.push({ code: "MAIN_UNPROTECTED", message: "未请求主分支保护；仓库所有者仍可直接推送" });
  if (config.license === "none" && config.destination.mode === "new") warnings.push({ code: "NO_LICENSE", message: "不添加开源许可证时，默认保留全部著作权" });
  return {
    config,
    baseRoot,
    files,
    sourceDigest: selectionDigest(files),
    report: {
      ok: blockers.length === 0,
      blockers,
      warnings,
      summary: { includedFiles: files.length, includedBytes: totalBytes, excludedFiles: excluded.length },
      includedPreview: files.slice(0, 100).map(({ relativePath, sizeBytes }) => ({ path: relativePath, sizeBytes })),
      excludedPreview: excluded.slice(0, 100),
      limits: { maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, githubFileLimitBytes: GITHUB_FILE_LIMIT, warningFileBytes: GITHUB_WARNING_SIZE },
    },
  };
}

function selectionDigest(files) {
  return crypto.createHash("sha256").update(JSON.stringify(files.map((file) => ({
    path: file.relativePath, size: file.sizeBytes, mtimeMs: file.mtimeMs, sha256: file.sha256,
  })).sort((left, right) => left.path.localeCompare(right.path)))).digest("hex");
}

function assertSelectionUnchanged(expected, current) {
  if (selectionDigest(expected.files) !== selectionDigest(current.files)) {
    throw errorWithCode("源文件在预检后发生变化，请重新预检", "GITHUB_SOURCE_CHANGED", 409);
  }
}

function stageVerifiedPayload(preflight, payloadRoot) {
  fs.mkdirSync(payloadRoot, { recursive: true });
  for (const file of preflight.files) {
    if (!fs.existsSync(file.sourcePath) || fs.lstatSync(file.sourcePath).isSymbolicLink()) throw errorWithCode("源文件在预检后消失或变为链接", "GITHUB_SOURCE_CHANGED", 409);
    realInside(preflight.baseRoot, file.sourcePath);
    const before = fs.statSync(file.sourcePath);
    if (!before.isFile() || before.size !== file.sizeBytes || before.mtimeMs !== file.mtimeMs) throw errorWithCode("源文件大小或修改时间在预检后变化", "GITHUB_SOURCE_CHANGED", 409);
    const destination = path.resolve(payloadRoot, file.relativePath);
    if (!isInsideOrEqual(payloadRoot, destination)) throw errorWithCode("暂存目标路径越界", "GITHUB_STAGING_ESCAPE");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.sourcePath, destination);
    const staged = fingerprintAndScan(destination);
    const after = fs.statSync(file.sourcePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || staged.bytesRead !== file.sizeBytes || staged.sha256 !== file.sha256) {
      throw errorWithCode("源文件在复制期间发生变化，请重新预检", "GITHUB_SOURCE_CHANGED", 409);
    }
    if (staged.secretKinds.length) throw errorWithCode("暂存副本复检发现疑似凭据，禁止任何远端写入", "GITHUB_SECRET_AFTER_COPY", 409);
    if (staged.bytesRead > GITHUB_FILE_LIMIT) throw errorWithCode("暂存副本包含超过 100 MiB 的文件", "GITHUB_FILE_TOO_LARGE", 409);
  }
  return { sourceDigest: selectionDigest(preflight.files), fileCount: preflight.files.length };
}

function lstatOrNull(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function assertRepositoryRoot(repositoryRoot) {
  const resolvedRoot = path.resolve(repositoryRoot);
  let rootStat = lstatOrNull(resolvedRoot);
  if (!rootStat) { fs.mkdirSync(resolvedRoot, { recursive: false }); rootStat = fs.lstatSync(resolvedRoot); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw errorWithCode("仓库暂存根目录不是普通目录或已变为链接", "GITHUB_REPOSITORY_LINK_BLOCKED", 409);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realParent = fs.realpathSync(path.dirname(resolvedRoot));
  if (!isInsideOrEqual(realParent, realRoot)) {
    throw errorWithCode("仓库暂存根目录经目录联接越出任务暂存目录", "GITHUB_REPOSITORY_ESCAPE", 409);
  }
  return { resolvedRoot, realRoot };
}

function ensureRepositoryDirectory(repositoryRoot, candidate) {
  const { resolvedRoot, realRoot } = assertRepositoryRoot(repositoryRoot);
  const resolvedCandidate = path.resolve(candidate);
  if (!isInsideOrEqual(resolvedRoot, resolvedCandidate)) throw errorWithCode("仓库目标目录越界", "GITHUB_STAGING_ESCAPE");
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = lstatOrNull(current);
    if (!stat) { fs.mkdirSync(current, { recursive: false }); stat = fs.lstatSync(current); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw errorWithCode("仓库目标路径包含符号链接、目录联接或非目录节点", "GITHUB_REPOSITORY_LINK_BLOCKED", 409);
    }
    const realCurrent = fs.realpathSync(current);
    if (!isInsideOrEqual(realRoot, realCurrent)) {
      throw errorWithCode("仓库目标路径经目录联接越出暂存仓库", "GITHUB_REPOSITORY_ESCAPE", 409);
    }
  }
  return { resolvedRoot, realRoot, directory: resolvedCandidate };
}

function assertRepositoryFileTarget(repositoryRoot, candidate) {
  const parent = ensureRepositoryDirectory(repositoryRoot, path.dirname(candidate));
  const resolvedCandidate = path.resolve(candidate);
  if (!isInsideOrEqual(parent.resolvedRoot, resolvedCandidate)) throw errorWithCode("仓库目标文件越界", "GITHUB_STAGING_ESCAPE");
  const stat = lstatOrNull(resolvedCandidate);
  if (stat) {
    if (stat.isSymbolicLink()) throw errorWithCode("仓库目标文件是符号链接或目录联接", "GITHUB_REPOSITORY_LINK_BLOCKED", 409);
    const realCandidate = fs.realpathSync(resolvedCandidate);
    if (!isInsideOrEqual(parent.realRoot, realCandidate)) throw errorWithCode("仓库目标文件越出暂存仓库", "GITHUB_REPOSITORY_ESCAPE", 409);
    if (!stat.isFile()) throw errorWithCode("仓库目标文件路径已被非文件节点占用", "GITHUB_REPOSITORY_TARGET_INVALID", 409);
  }
  return { ...parent, file: resolvedCandidate };
}

function copyFileIntoRepository(source, repositoryRoot, destination) {
  const target = assertRepositoryFileTarget(repositoryRoot, destination);
  fs.copyFileSync(source, target.file);
  const written = fs.lstatSync(target.file);
  if (!written.isFile() || written.isSymbolicLink() || !isInsideOrEqual(target.realRoot, fs.realpathSync(target.file))) {
    throw errorWithCode("仓库文件写入后路径校验失败", "GITHUB_REPOSITORY_ESCAPE", 409);
  }
}

function mergePayloadIntoRepository(payloadRoot, repositoryRoot, destinationPath) {
  const { resolvedRoot } = assertRepositoryRoot(repositoryRoot);
  const destinationRoot = destinationPath === "." ? resolvedRoot : path.resolve(resolvedRoot, ...destinationPath.split("/"));
  ensureRepositoryDirectory(resolvedRoot, destinationRoot);
  const overwrittenPaths = [];
  const walk = (folder) => {
    for (const name of fs.readdirSync(folder)) {
      const source = path.join(folder, name);
      const relative = path.relative(payloadRoot, source);
      const destination = path.resolve(destinationRoot, relative);
      if (!isInsideOrEqual(destinationRoot, destination)) throw errorWithCode("仓库目标文件越界", "GITHUB_STAGING_ESCAPE");
      const stat = fs.lstatSync(source);
      if (stat.isDirectory()) { ensureRepositoryDirectory(resolvedRoot, destination); walk(source); continue; }
      if (!stat.isFile()) throw errorWithCode("暂存副本出现不支持的文件类型", "GITHUB_STAGING_INVALID", 409);
      if (fs.existsSync(destination)) overwrittenPaths.push(path.relative(resolvedRoot, destination).split(path.sep).join("/"));
      copyFileIntoRepository(source, resolvedRoot, destination);
    }
  };
  walk(payloadRoot);
  return { destinationPath, overwrittenPaths };
}

function writeGeneratedFiles(repositoryRoot, contentRoot, item, config) {
  if (config.generateReadme) {
    ensureRepositoryDirectory(repositoryRoot, contentRoot);
    const readmePath = path.join(contentRoot, "README.md");
    const existingReadme = lstatOrNull(readmePath);
    if (existingReadme?.isSymbolicLink()) throw errorWithCode("仓库 README 目标是符号链接或目录联接", "GITHUB_REPOSITORY_LINK_BLOCKED", 409);
    if (!existingReadme) {
      const title = String(item.title || config.destination.repo).replace(/[\r\n#]/g, " ").trim();
      const description = String(item.description || "由 Codex 产出项上传。").replace(/[\r\n]/g, " ").trim();
      const target = assertRepositoryFileTarget(repositoryRoot, readmePath);
      fs.writeFileSync(target.file, `# ${title}\n\n${description}\n\n> 由本地“产出项”功能生成并上传。上传前已执行敏感信息预检。\n`, { encoding: "utf8", flag: "wx" });
    }
  }
}

export class RealGitHubAdapter {
  constructor({ ghPath, gitPath, runner = runProcess }) { this.ghPath = ghPath; this.gitPath = gitPath; this.runner = runner; }
  async gh(args, options) { return this.runner(this.ghPath, args, { ...options, timeoutMs: options?.timeoutMs || 120_000 }); }
  async git(args, options) { return this.runner(this.gitPath, args, { ...options, timeoutMs: options?.timeoutMs || 120_000 }); }
  async authStatus() {
    let account;
    try {
      const status = await this.gh(["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"]);
      const json = JSON.parse(status.stdout || "{}");
      const accounts = Array.isArray(json.hosts?.["github.com"]) ? json.hosts["github.com"] : [];
      account = accounts.find((entry) => entry?.active === true && String(entry?.state || "").toLowerCase() === "success");
    } catch {
      throw errorWithCode("无法验证 GitHub CLI 登录状态，请重新登录。", "GITHUB_AUTH_STATUS_FAILED", 401);
    }
    if (!account?.login || !OWNER_PATTERN.test(String(account.login))) {
      throw errorWithCode("GitHub CLI 登录凭据无效，请重新登录。", "GITHUB_AUTH_INVALID", 401);
    }

    let apiLogin;
    try {
      const user = await this.gh(["api", "--hostname", "github.com", "user", "--jq", ".login"]);
      apiLogin = String(user.stdout || "").trim();
    } catch {
      throw errorWithCode("GitHub API 身份验证失败，请重新登录。", "GITHUB_API_AUTH_FAILED", 401);
    }
    if (!OWNER_PATTERN.test(apiLogin)) {
      throw errorWithCode("GitHub API 未返回有效的当前账号，请重新登录。", "GITHUB_API_IDENTITY_INVALID", 401);
    }
    if (apiLogin.toLowerCase() !== String(account.login).toLowerCase()) {
      throw errorWithCode("GitHub CLI 登录状态与 API 当前账号不一致，请重新登录。", "GITHUB_AUTH_IDENTITY_MISMATCH", 401);
    }
    return { authenticated: true, login: apiLogin };
  }
  async listRepositories(login) {
    const result = await this.gh(["repo", "list", login, "--limit", "100", "--source", "--no-archived", "--json", "name,nameWithOwner,visibility,isPrivate,url,viewerPermission,defaultBranchRef,pushedAt"]);
    return JSON.parse(result.stdout || "[]");
  }
  async inspectRepository(owner, repo) {
    const result = await this.gh(["repo", "view", `${owner}/${repo}`, "--json", "name,nameWithOwner,visibility,isPrivate,url,viewerPermission,defaultBranchRef,isArchived"]);
    return JSON.parse(result.stdout || "{}");
  }
  async createRepository(config) {
    const fullName = `${config.destination.owner}/${config.destination.repo}`;
    const args = ["repo", "create", fullName, config.destination.visibility === "public" ? "--public" : "--private"];
    if (config.description) args.push("--description", config.description);
    if (config.license !== "none") args.push("--license", config.license);
    else if (config.publishMode === "branch-pr") args.push("--add-readme");
    await this.gh(args);
  }
  async cloneRepository(fullName, target) { await this.gh(["repo", "clone", fullName, target]); }
  async configureIdentity(cwd, login) {
    await this.git(["config", "user.name", login], { cwd });
    await this.git(["config", "user.email", `${login}@users.noreply.github.com`], { cwd });
  }
  async checkoutBranch(cwd, branch, baseBranch) {
    if (baseBranch) await this.git(["checkout", baseBranch], { cwd });
    await this.git(["checkout", "-B", branch], { cwd });
  }
  async commitAndPush(cwd, { branch, message }) {
    await this.git(["add", "--all"], { cwd });
    const changes = await this.git(["status", "--porcelain"], { cwd });
    if (!changes.stdout.trim()) throw errorWithCode("仓库内容与所选文件一致，没有可提交的更改", "GITHUB_NO_CHANGES", 409);
    await this.git(["commit", "-m", message], { cwd });
    await this.git(["push", "--set-upstream", "origin", branch], { cwd, timeoutMs: 300_000 });
    const commit = await this.git(["rev-parse", "HEAD"], { cwd });
    return commit.stdout.trim();
  }
  async createPullRequest(fullName, branch, baseBranch, title) {
    const result = await this.gh(["pr", "create", "--repo", fullName, "--head", branch, "--base", baseBranch, "--title", title, "--body", "由本地 Codex 产出项创建。合并决定权保留给仓库所有者。", "--no-maintainer-edit"]);
    return result.stdout.trim().split(/\r?\n/).at(-1);
  }
  async protectDefaultBranch(fullName, baseBranch, stagingRoot) {
    const inputPath = path.join(stagingRoot, "ruleset.json");
    const payload = {
      name: "Protect default branch", target: "branch", enforcement: "active",
      conditions: { ref_name: { include: [`refs/heads/${baseBranch}`], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } }],
      bypass_actors: [],
    };
    fs.writeFileSync(inputPath, JSON.stringify(payload), "utf8");
    await this.gh(["api", "-X", "POST", `repos/${fullName}/rulesets`, "--input", inputPath]);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function readProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || path.join(path.parse(process.execPath).root, "Windows");
      const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)}`;
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5_000 });
      const ticks = String(result.stdout || "").trim();
      return result.status === 0 && /^\d+$/.test(ticks) ? `windows:${ticks}` : null;
    }
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { shell: false, encoding: "utf8", timeout: 5_000 });
    const started = String(result.stdout || "").trim();
    return result.status === 0 && started ? `${process.platform}:${started}` : null;
  } catch { return null; }
}

const PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid)
  || `self:${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;

function ownerProcessIsCurrent(owner) {
  const pid = Number(owner?.pid);
  if (!processIsAlive(pid)) return false;
  if (!owner?.processStartIdentity) return true;
  const observed = pid === process.pid ? PROCESS_START_IDENTITY : readProcessStartIdentity(pid);
  return observed ? observed === owner.processStartIdentity : true;
}

function removeStaleOwnedDirectory(base, candidate, { missingOwnerStaleMs = 60_000 } = {}) {
  const realBase = fs.realpathSync(base);
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  const realCandidate = fs.realpathSync(candidate);
  if (!isInsideOrEqual(realBase, realCandidate)) return false;
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(candidate, "owner.json"), "utf8")); } catch { }
  if (owner && ownerProcessIsCurrent(owner)) return false;
  if (!owner && Date.now() - stat.mtimeMs <= missingOwnerStaleMs) return false;
  fs.rmSync(realCandidate, { recursive: true, force: true });
  return true;
}

function prepareProcessStaging(dataRoot) {
  const base = path.join(dataRoot, "temp", "github-jobs");
  fs.mkdirSync(base, { recursive: true });
  const realBase = fs.realpathSync(base);
  const now = Date.now();
  for (const name of fs.readdirSync(base)) {
    if (!/^process-\d+-[0-9a-f-]+$/i.test(name)) continue;
    const candidate = path.join(base, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const realCandidate = fs.realpathSync(candidate);
      if (!isInsideOrEqual(realBase, realCandidate)) continue;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(candidate, "owner.json"), "utf8")); } catch { }
      const abandoned = owner ? !ownerProcessIsCurrent(owner) : now - stat.mtimeMs > JOB_TTL_MS;
      if (abandoned) fs.rmSync(realCandidate, { recursive: true, force: true });
    } catch { }
  }
  const nonce = crypto.randomUUID();
  const processRoot = path.join(base, `process-${process.pid}-${nonce}`);
  fs.mkdirSync(processRoot, { recursive: false });
  fs.writeFileSync(path.join(processRoot, "owner.json"), `${JSON.stringify({ pid: process.pid, processStartIdentity: PROCESS_START_IDENTITY, nonce, startedAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
  return { base, processRoot, nonce, processStartIdentity: PROCESS_START_IDENTITY };
}

function acquirePublishLocks(dataRoot, { owner, repo, branch }) {
  const lockRoot = path.join(dataRoot, "run", "github-publish-locks");
  fs.mkdirSync(lockRoot, { recursive: true });
  if (fs.lstatSync(lockRoot).isSymbolicLink()) throw errorWithCode("GitHub 上传锁目录不安全", "GITHUB_LOCK_UNSAFE", 409);
  const realLockRoot = fs.realpathSync(lockRoot);
  const nonce = crypto.randomUUID();
  const ownerRecord = { pid: process.pid, processStartIdentity: PROCESS_START_IDENTITY, nonce, createdAt: new Date().toISOString(), owner, repo, branch };
  const keys = [
    { scope: "repository", value: `${owner.toLowerCase()}/${repo.toLowerCase()}` },
    { scope: "branch", value: `${owner.toLowerCase()}/${repo.toLowerCase()}#${String(branch || "@default").toLowerCase()}` },
  ];
  const acquired = [];
  const release = () => {
    for (const entry of [...acquired].reverse()) {
      try {
        if (!fs.existsSync(entry.path) || fs.lstatSync(entry.path).isSymbolicLink()) continue;
        const current = JSON.parse(fs.readFileSync(path.join(entry.path, "owner.json"), "utf8"));
        const realEntry = fs.realpathSync(entry.path);
        if (current.nonce === nonce && current.pid === process.pid && current.processStartIdentity === PROCESS_START_IDENTITY && isInsideOrEqual(realLockRoot, realEntry)) {
          fs.rmSync(realEntry, { recursive: true, force: true });
        }
      } catch { }
    }
  };
  try {
    for (const key of keys) {
      const hash = crypto.createHash("sha256").update(`${key.scope}:${key.value}`).digest("hex");
      const lockPath = path.join(lockRoot, `${key.scope}-${hash}`);
      let created = false;
      for (let attempt = 0; attempt < 2 && !created; attempt += 1) {
        try {
          fs.mkdirSync(lockPath, { recursive: false });
          created = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          let removed = false;
          try { removed = removeStaleOwnedDirectory(lockRoot, lockPath); } catch { }
          if (!removed) throw errorWithCode(`GitHub 目标正在由另一个上传任务使用（${key.scope === "repository" ? "仓库" : "分支"}锁）`, "GITHUB_DESTINATION_BUSY", 409);
        }
      }
      if (!created) throw errorWithCode("无法取得 GitHub 上传目标锁", "GITHUB_DESTINATION_BUSY", 409);
      fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ ...ownerRecord, scope: key.scope })}\n`, { encoding: "utf8", flag: "wx" });
      acquired.push({ path: lockPath, scope: key.scope });
    }
    return { release, nonce, owner: ownerRecord, paths: acquired.map((entry) => entry.path) };
  } catch (error) {
    release();
    throw error;
  }
}

export function createGitHubPublisher({ dataRoot, getItem, updateItemPublication, logEvent = () => {}, adapter: suppliedAdapter } = {}) {
  if (!dataRoot || typeof getItem !== "function") throw new Error("createGitHubPublisher requires dataRoot and getItem");
  const staging = prepareProcessStaging(dataRoot);
  const stagingRoot = staging.processRoot;
  const cleanupOwnStaging = () => {
    try {
      if (!fs.existsSync(stagingRoot) || fs.lstatSync(stagingRoot).isSymbolicLink()) return;
      const owner = JSON.parse(fs.readFileSync(path.join(stagingRoot, "owner.json"), "utf8"));
      if (owner.pid !== process.pid || owner.processStartIdentity !== staging.processStartIdentity || owner.nonce !== staging.nonce) return;
      const realBase = fs.realpathSync(staging.base);
      const realRoot = fs.realpathSync(stagingRoot);
      if (isInsideOrEqual(realBase, realRoot)) fs.rmSync(realRoot, { recursive: true, force: true });
    } catch { }
  };
  registerProcessExitCleanup(cleanupOwnStaging);
  const preflights = new Map();
  const jobs = new Map();

  const dependencyStatus = async () => {
    const ghPath = findExecutable("gh");
    const gitPath = findExecutable("git");
    const base = {
      ghAvailable: Boolean(ghPath), gitAvailable: Boolean(gitPath), authenticated: false, login: null,
      ready: false, host: "github.com", tokenStoredByExtension: false,
      setup: {
        installUrl: "https://cli.github.com/",
        installCommand: "winget install --id GitHub.cli",
        loginCommand: "gh auth login --web --hostname github.com",
        note: "产出项不会自动安装 GitHub CLI，也不会读取、显示或保存令牌。",
      },
    };
    const ghAvailable = suppliedAdapter ? true : Boolean(ghPath);
    const gitAvailable = suppliedAdapter ? true : Boolean(gitPath);
    const detected = { ...base, ghAvailable, gitAvailable };
    if (!ghAvailable || !gitAvailable) return detected;
    try {
      const adapter = suppliedAdapter || new RealGitHubAdapter({ ghPath, gitPath });
      const auth = await adapter.authStatus();
      const authenticated = auth?.authenticated === true && OWNER_PATTERN.test(String(auth?.login || ""));
      if (!authenticated) {
        return { ...detected, authError: redact(auth?.authError || "GitHub 登录验证失败，请重新登录。") };
      }
      return { ...detected, authenticated: true, login: String(auth.login), ready: true };
    } catch (error) {
      return { ...detected, authError: redact(error?.message || "GitHub 登录验证失败，请重新登录。") };
    }
  };

  const adapterForStatus = async (status) => suppliedAdapter || new RealGitHubAdapter({ ghPath: findExecutable("gh"), gitPath: findExecutable("git") });

  const status = async () => dependencyStatus();

  const repositories = async () => {
    const state = await dependencyStatus();
    if (!state.ready) throw errorWithCode("GitHub CLI 尚未安装或登录", "GITHUB_NOT_READY", 409);
    const adapter = await adapterForStatus(state);
    const repos = await adapter.listRepositories(state.login);
    return {
      account: { login: state.login, host: state.host },
      repositories: repos.filter((entry) => String(entry.nameWithOwner || "").toLowerCase().startsWith(`${state.login.toLowerCase()}/`)).map((entry) => ({
        name: entry.name, nameWithOwner: entry.nameWithOwner, visibility: String(entry.visibility || (entry.isPrivate ? "PRIVATE" : "PUBLIC")).toLowerCase(),
        url: entry.url, viewerPermission: entry.viewerPermission, defaultBranch: entry.defaultBranchRef?.name || null, pushedAt: entry.pushedAt || null,
      })),
    };
  };

  const context = async (itemId) => {
    const item = getItem(itemId);
    const state = await dependencyStatus();
    let repoList = [];
    if (state.ready) {
      try { repoList = (await repositories()).repositories; } catch { }
    }
    return {
      item: { id: item.id, title: item.title, path: item.path, type: item.type, fileCount: Array.isArray(item.files) ? item.files.length : 0 },
      ghAvailable: state.ghAvailable,
      ghInstalled: state.ghAvailable,
      cliInstalled: state.ghAvailable,
      gitAvailable: state.gitAvailable,
      authenticated: state.authenticated,
      ready: state.ready,
      account: state.login ? { login: state.login, host: state.host, authenticated: state.authenticated } : { login: "", host: state.host, authenticated: false },
      repositories: repoList,
      setup: state.setup,
      defaults: { owner: state.login || "", visibility: "public" },
      capabilities: {
        repositoryModes: ["new", "existing"], visibility: ["public", "private"],
        uploadScopes: ["whole", "current", "custom", "binaries"], publishModes: ["branch-pr", "direct"],
        licenses: ["none", "mit", "apache-2.0", "gpl-3.0"], branchProtection: true, collaboratorsGranted: false,
        destinationPath: true, existingRepositoryDefaultIsolated: true,
        requiresPreflight: true, requiresExplicitConfirmation: true, storesToken: false,
      },
    };
  };

  const preflight = async (itemId, input) => {
    const state = await dependencyStatus();
    const login = state.login || validateName(input?.destination?.owner || input?.config?.destination?.owner || input?.owner || input?.config?.owner, OWNER_PATTERN, "仓库所有者");
    const item = getItem(itemId);
    const reservedJobId = crypto.randomUUID();
    const checked = performPreflight(item, input, login, dataRoot, { defaultBranch: defaultPublishBranch(item.id, reservedJobId) });
    if (state.authenticated && checked.config.destination.owner.toLowerCase() !== state.login.toLowerCase()) throw errorWithCode("仓库所有者与当前 GitHub 账号不一致", "GITHUB_OWNER_MISMATCH", 403);
    if (checked.config.destination.mode === "existing" && state.ready) {
      const adapter = await adapterForStatus(state);
      const repo = await adapter.inspectRepository(checked.config.destination.owner, checked.config.destination.repo);
      if (repo.isArchived) checked.report.blockers.push({ code: "REPOSITORY_ARCHIVED", message: "已有仓库已归档，不能写入" });
      if (String(repo.viewerPermission || "").toUpperCase() !== "ADMIN") checked.report.blockers.push({ code: "REPOSITORY_NOT_OWNED", message: "仅允许写入当前账号拥有且可管理的个人仓库" });
      checked.config.destination.visibility = String(repo.visibility || (repo.isPrivate ? "PRIVATE" : "PUBLIC")).toLowerCase();
      checked.report.warnings.push({ code: "EXISTING_ACCESS_UNCHANGED", message: "不会添加、删除或修改已有仓库的协作者；该仓库现有写权限保持不变" });
      if (checked.config.destination.visibility === "public" && !checked.report.warnings.some((entry) => entry.code === "PUBLIC_VISIBILITY")) {
        checked.report.warnings.unshift({ code: "PUBLIC_VISIBILITY", message: "Public 仓库对任何人可见、可下载和 fork；他人不能直接修改你的原仓库，除非你另行授予协作者权限。Pull Request 是否合并由你决定。" });
      }
      checked.report.ok = checked.report.blockers.length === 0;
      checked.report.repository = { nameWithOwner: repo.nameWithOwner, url: repo.url, visibility: checked.config.destination.visibility, defaultBranch: repo.defaultBranchRef?.name || null };
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const record = { id, reservedJobId, itemId: String(item.id), config: checked.config, digest: configDigest(item.id, checked.config), createdAt, expiresAt: createdAt + PREFLIGHT_TTL_MS, checked, claim: null };
    preflights.set(id, record);
    return { preflightId: id, expiresAt: new Date(record.expiresAt).toISOString(), dependency: state, config: checked.config, report: checked.report };
  };

  const publicJob = (job) => {
    const terminalState = job.state === "succeeded" ? "success" : job.state;
    const publicPhase = terminalState === "success" ? "success"
      : ["failed", "cancelled"].includes(terminalState) ? terminalState
        : job.phase === "creating-pr" ? "creating_pr"
          : ["queued"].includes(job.phase) ? "queued"
            : ["staging", "copying"].includes(job.phase) ? "scanning" : "uploading";
    const cancellable = job.state === "queued" || (job.state === "running" && ["staging", "cloning", "copying"].includes(job.phase));
    const result = job.result || null;
    return {
      id: job.id, jobId: job.id, itemId: job.itemId, state: terminalState, phase: publicPhase, progress: job.progress,
      createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
      config: job.config, result, error: job.error || null,
      message: job.error?.message || result?.warning || result?.warnings?.[0]?.message || "",
      repositoryUrl: result?.repositoryUrl || null,
      pullRequestUrl: result?.pullRequestUrl || null,
      branch: result?.branch || null,
      commit: result?.commit || null,
      uploaded: terminalState === "success" ? job.totalFiles || 0 : 0,
      total: job.totalFiles || 0,
      failures: job.error ? [{ message: job.error.message }] : [],
      cancellable,
      canCancel: cancellable,
    };
  };

  const startJob = async (itemId, input) => {
    if (input?.confirm !== true) throw errorWithCode("上传 GitHub 必须明确确认", "GITHUB_CONFIRM_REQUIRED");
    const record = preflights.get(String(input.preflightId || ""));
    if (!record || record.itemId !== String(itemId)) throw errorWithCode("预检记录无效", "GITHUB_PREFLIGHT_INVALID", 409);
    if (Date.now() > record.expiresAt) throw errorWithCode("预检已过期，请重新检查", "GITHUB_PREFLIGHT_EXPIRED", 409);
    if (!record.checked.report.ok) throw errorWithCode("预检存在阻断项，禁止上传", "GITHUB_PREFLIGHT_BLOCKED", 409);
    if (input.config) {
      const candidate = normalizeConfig(input.config, record.config.destination.owner, { defaultBranch: record.config.branch });
      if (!candidate.destination.path) candidate.destination.path = record.config.destination.path;
      if (candidate.destination.mode === "existing") candidate.destination.visibility = record.config.destination.visibility;
      if (configDigest(itemId, candidate) !== record.digest) throw errorWithCode("上传配置在预检后发生变化，请重新预检", "GITHUB_CONFIG_CHANGED", 409);
    }
    if (record.claim) throw errorWithCode("该预检已被另一个上传请求占用；请等待或重新预检", "GITHUB_PREFLIGHT_ALREADY_CLAIMED", 409);
    record.claim = { nonce: crypto.randomUUID(), pid: process.pid, processStartIdentity: PROCESS_START_IDENTITY, claimedAt: new Date().toISOString() };
    const state = await dependencyStatus();
    if (!state.ready) throw errorWithCode("GitHub CLI 尚未安装或登录", "GITHUB_NOT_READY", 409);
    if (record.config.destination.owner.toLowerCase() !== state.login.toLowerCase()) throw errorWithCode("GitHub 登录账号已变化，请重新预检", "GITHUB_ACCOUNT_CHANGED", 409);
    const item = getItem(itemId);
    const repeated = performPreflight(item, record.config, state.login, dataRoot);
    assertSelectionUnchanged(record.checked, repeated);
    if (!repeated.report.ok) throw errorWithCode("源文件在预检后发生风险变化，请重新预检", "GITHUB_SOURCE_CHANGED", 409);
    const publishLocks = acquirePublishLocks(dataRoot, {
      owner: record.config.destination.owner,
      repo: record.config.destination.repo,
      branch: record.config.publishMode === "branch-pr" ? record.config.branch : "@default",
    });
    const job = {
      id: record.reservedJobId, itemId: String(item.id), state: "queued", phase: "queued", progress: 0,
      createdAt: new Date().toISOString(), config: record.config, totalFiles: repeated.files.length,
    };
    jobs.set(job.id, job);
    record.claim = { ...record.claim, state: "started", jobId: job.id };
    setImmediate(async () => {
      job.state = "running"; job.phase = "staging"; job.progress = 10; job.startedAt = new Date().toISOString();
      const jobRoot = path.join(stagingRoot, job.id);
      const payloadRoot = path.join(jobRoot, "payload");
      const repositoryRoot = path.join(jobRoot, "repository");
      let remoteCreated = false;
      let remotePushed = false;
      let remoteRepository = null;
      try {
        fs.mkdirSync(jobRoot, { recursive: true });
        if (job.cancelRequested) throw errorWithCode("上传已取消", "GITHUB_JOB_CANCELLED", 409);
        job.phase = "copying"; job.progress = 16;
        const stagedPayload = stageVerifiedPayload(record.checked, payloadRoot);
        if (stagedPayload.sourceDigest !== record.checked.sourceDigest) throw errorWithCode("暂存副本与预检摘要不一致", "GITHUB_SOURCE_CHANGED", 409);
        if (job.cancelRequested) throw errorWithCode("上传已取消", "GITHUB_JOB_CANCELLED", 409);
        const adapter = await adapterForStatus(state);
        const fullName = `${job.config.destination.owner}/${job.config.destination.repo}`;
        remoteRepository = fullName;
        if (job.config.destination.mode === "new") {
          job.phase = "creating-repository"; job.progress = 18;
          await adapter.createRepository(job.config);
          remoteCreated = true;
        }
        job.phase = "cloning"; job.progress = 32;
        await adapter.cloneRepository(fullName, repositoryRoot);
        if (job.cancelRequested) throw errorWithCode("上传已取消", "GITHUB_JOB_CANCELLED", 409);
        assertRepositoryRoot(repositoryRoot);
        job.phase = "merging"; job.progress = 48;
        if (job.config.destination.mode === "new" && job.config.publishMode === "branch-pr" && job.config.license === "none") {
          try { fs.rmSync(path.join(repositoryRoot, "README.md"), { force: true }); } catch { }
        }
        const merge = mergePayloadIntoRepository(payloadRoot, repositoryRoot, job.config.destination.path);
        const contentRoot = job.config.destination.path === "." ? repositoryRoot : path.resolve(repositoryRoot, ...job.config.destination.path.split("/"));
        writeGeneratedFiles(repositoryRoot, contentRoot, item, job.config);
        if (job.cancelRequested) throw errorWithCode("上传已取消", "GITHUB_JOB_CANCELLED", 409);
        await adapter.configureIdentity(repositoryRoot, state.login);
        const inspected = await adapter.inspectRepository(job.config.destination.owner, job.config.destination.repo);
        const baseBranch = validateBranchName(inspected.defaultBranchRef?.name || "main", "GitHub 默认分支名称");
        const targetBranch = job.config.publishMode === "branch-pr" ? job.config.branch : baseBranch;
        await adapter.checkoutBranch(repositoryRoot, targetBranch, job.config.publishMode === "branch-pr" ? baseBranch : null);
        job.phase = "pushing"; job.progress = 65;
        const commit = await adapter.commitAndPush(repositoryRoot, { branch: targetBranch, message: `Upload ${item.title || item.id} from Codex output items` });
        remotePushed = true;
        let pullRequestUrl = null;
        if (job.config.publishMode === "branch-pr") {
          job.phase = "creating-pr"; job.progress = 82;
          pullRequestUrl = await adapter.createPullRequest(fullName, targetBranch, baseBranch, `Upload ${item.title || item.id}`);
        }
        const postWarnings = [];
        const branchProtection = { requested: job.config.protectMain, applied: false, warning: null };
        if (job.config.protectMain) {
          job.phase = "protecting-branch"; job.progress = 90;
          try { await adapter.protectDefaultBranch(fullName, baseBranch, jobRoot); branchProtection.applied = true; }
          catch (error) {
            const warning = { code: "BRANCH_PROTECTION_FAILED", message: `内容已上传，但主分支保护未启用：${redact(error.message)}` };
            branchProtection.warning = warning;
            postWarnings.push(warning);
          }
        }
        const repositoryUrl = inspected.url || `https://github.com/${fullName}`;
        if (job.config.destination.mode === "existing" && merge.overwrittenPaths.length) postWarnings.push({ code: "EXISTING_PATHS_REPLACED", message: `${merge.overwrittenPaths.length} 个已有仓库路径已在提交中更新`, paths: merge.overwrittenPaths.slice(0, 100) });
        job.result = { repository: fullName, repositoryUrl, visibility: job.config.destination.visibility || String(inspected.visibility || "").toLowerCase(), destinationPath: merge.destinationPath, overwrittenPaths: merge.overwrittenPaths, branch: targetBranch, baseBranch, commit, pullRequestUrl, branchProtection, warnings: postWarnings };
        job.state = "succeeded"; job.phase = "complete"; job.progress = 100; job.finishedAt = new Date().toISOString();
        if (typeof updateItemPublication === "function") updateItemPublication(job.itemId, { ...job.result, uploadedAt: job.finishedAt, publishMode: job.config.publishMode });
        logEvent("github-publish-succeeded", { itemId: job.itemId, repository: fullName, branch: targetBranch, commit, pullRequestUrl });
      } catch (error) {
        const cancelled = error?.code === "GITHUB_JOB_CANCELLED";
        job.state = cancelled ? "cancelled" : "failed"; job.phase = cancelled ? "cancelled" : "failed"; job.finishedAt = new Date().toISOString();
        job.error = cancelled ? null : { code: error.code || "GITHUB_PUBLISH_FAILED", message: redact(error.message) };
        if (remoteCreated || remotePushed) {
          job.result = {
            partial: true,
            repository: remoteRepository,
            repositoryUrl: remoteRepository ? `https://github.com/${remoteRepository}` : null,
            repositoryCreated: remoteCreated,
            contentPushed: remotePushed,
            warning: remotePushed
              ? "远端已收到提交，但后续步骤失败；请在 GitHub 检查仓库状态。"
              : "新仓库已创建，但内容上传未完成；扩展不会自动删除远端仓库。",
          };
        }
        logEvent(cancelled ? "github-publish-cancelled" : "github-publish-failed", { itemId: job.itemId, code: error?.code, message: redact(error?.message) });
      } finally {
        try { fs.rmSync(jobRoot, { recursive: true, force: true }); } catch { }
        publishLocks.release();
      }
    });
    return publicJob(job);
  };

  const jobStatus = (jobId) => {
    const job = jobs.get(String(jobId || ""));
    if (!job) throw errorWithCode("未找到 GitHub 上传任务", "GITHUB_JOB_NOT_FOUND", 404);
    return publicJob(job);
  };

  const cancelJob = (jobId) => {
    const job = jobs.get(String(jobId || ""));
    if (!job) throw errorWithCode("未找到 GitHub 上传任务", "GITHUB_JOB_NOT_FOUND", 404);
    if (!["queued", "running"].includes(job.state) || !["queued", "staging", "cloning", "copying"].includes(job.phase)) {
      throw errorWithCode("任务已进入提交或推送阶段，不能安全取消", "GITHUB_JOB_NOT_CANCELLABLE", 409);
    }
    job.cancelRequested = true;
    job.state = job.state === "queued" ? "cancelled" : "running";
    if (job.phase === "queued") { job.phase = "cancelled"; job.finishedAt = new Date().toISOString(); }
    return publicJob(job);
  };

  const cleanup = () => {
    const now = Date.now();
    for (const [id, value] of preflights) if (value.expiresAt < now) preflights.delete(id);
    for (const [id, value] of jobs) if (value.finishedAt && new Date(value.finishedAt).getTime() + JOB_TTL_MS < now) jobs.delete(id);
  };
  const cleanupTimer = setInterval(cleanup, 60_000);
  cleanupTimer.unref?.();

  return { status, context, repositories, preflight, startJob, jobStatus, cancelJob, normalizeConfig, constants: { MAX_FILES, MAX_TOTAL_BYTES, GITHUB_FILE_LIMIT, GITHUB_WARNING_SIZE } };
}

export function createFakeGitHubAdapter({ login = "fixture-user", delayMs = 0 } = {}) {
  const calls = [];
  const pause = () => delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
  const record = async (name, payload = {}) => { calls.push({ name, ...payload }); await pause(); };
  return {
    calls,
    async authStatus() { await record("authStatus"); return { authenticated: true, login }; },
    async listRepositories() { await record("listRepositories"); return [{ name: "existing", nameWithOwner: `${login}/existing`, visibility: "PUBLIC", isPrivate: false, url: `https://github.com/${login}/existing`, viewerPermission: "ADMIN", defaultBranchRef: { name: "main" } }]; },
    async inspectRepository(owner, repo) { await record("inspectRepository", { owner, repo }); return { name: repo, nameWithOwner: `${owner}/${repo}`, visibility: "PUBLIC", isPrivate: false, isArchived: false, url: `https://github.com/${owner}/${repo}`, viewerPermission: "ADMIN", defaultBranchRef: { name: "main" } }; },
    async createRepository(config) { await record("createRepository", { config }); },
    async cloneRepository(fullName, target) {
      await record("cloneRepository", { fullName, target });
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
      if (fullName.endsWith("/existing")) {
        const seeded = path.join(target, "codex-output-items", "fixture-item", "README.md");
        fs.mkdirSync(path.dirname(seeded), { recursive: true });
        fs.writeFileSync(seeded, "# existing remote content\n", "utf8");
      }
    },
    async configureIdentity(cwd, account) { await record("configureIdentity", { cwd, account }); },
    async checkoutBranch(cwd, branch, baseBranch) { await record("checkoutBranch", { cwd, branch, baseBranch }); },
    async commitAndPush(cwd, options) {
      const files = [];
      const walk = (folder) => { for (const name of fs.readdirSync(folder)) { if (name === ".git") continue; const full = path.join(folder, name); const stat = fs.statSync(full); if (stat.isDirectory()) walk(full); else files.push(path.relative(cwd, full)); } };
      walk(cwd); await record("commitAndPush", { cwd, options, files }); return "0123456789abcdef0123456789abcdef01234567";
    },
    async createPullRequest(fullName, branch, baseBranch) { await record("createPullRequest", { fullName, branch, baseBranch }); return `https://github.com/${fullName}/pull/1`; },
    async protectDefaultBranch(fullName, baseBranch) { await record("protectDefaultBranch", { fullName, baseBranch }); },
  };
}
