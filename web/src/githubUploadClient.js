const TERMINAL_STATES = new Set(["success", "partial", "failed", "cancelled"]);

function structured(result) {
  return result?.structuredContent || result?.structured_content || result;
}

function pick(payload, keys) {
  for (const key of keys) {
    if (payload?.[key] !== undefined) return payload[key];
  }
  return undefined;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueEntries(...groups) {
  const seen = new Set();
  const values = [];
  for (const entry of groups.flatMap(asArray)) {
    if (entry == null) continue;
    const key = typeof entry === "string"
      ? entry
      : JSON.stringify([entry?.code || "", entry?.path || entry?.file || entry?.name || "", entry?.message || entry?.error || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(entry);
  }
  return values;
}

function entryMessage(entry) {
  return String(typeof entry === "string" ? entry : entry?.message || entry?.error || entry?.code || "").trim();
}

export function safeGithubCliInstallUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname === "cli.github.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function normalizeGithubContext(raw = {}) {
  const payload = structured(raw) || {};
  const account = payload.account || payload.githubAccount || payload.viewer || {};
  const repositories = payload.repositories || payload.repos || [];
  return {
    cliInstalled: Boolean(pick(payload, ["cliInstalled", "ghInstalled", "ghAvailable"]) ?? pick(account, ["cliInstalled", "ghInstalled", "ghAvailable"])),
    authenticated: Boolean(pick(account, ["authenticated", "loggedIn", "login"]) || payload.authenticated),
    login: String(pick(account, ["login", "username", "name"]) || ""),
    avatarUrl: String(pick(account, ["avatarUrl", "avatar_url"]) || ""),
    owners: Array.isArray(payload.owners) ? payload.owners : [],
    repositories: Array.isArray(repositories) ? repositories : [],
    capabilities: payload.capabilities || {},
    defaults: payload.defaults || {},
    setup: payload.setup || {},
    preflight: payload.preflight || null,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : []
  };
}

export function normalizeGithubJob(raw = {}) {
  const payload = structured(raw) || {};
  const source = payload.job || payload.upload || payload;
  let state = String(pick(source, ["state", "status", "phase"]) || "queued").toLowerCase();
  if (state === "succeeded") state = "success";
  const failures = pick(source, ["failures", "errors", "failedFiles"]);
  const result = source.result || payload.result || {};
  const branchProtection = result.branchProtection || source.branchProtection || null;
  const warnings = uniqueEntries(payload.warnings, source.warnings, result.warnings, branchProtection?.warning ? [branchProtection.warning] : []);
  const protectionFailed = warnings.some((entry) => String(entry?.code || "").toUpperCase() === "BRANCH_PROTECTION_FAILED")
    || (branchProtection?.requested === true && branchProtection?.applied === false);
  if ((state === "failed" && result.partial === true) || result.partial === true || (state === "success" && protectionFailed)) state = "partial";
  const warning = String(result.warning || source.warning || warnings.map(entryMessage).filter(Boolean).join("；"));
  return {
    id: String(pick(source, ["id", "jobId", "job_id"]) || ""),
    state: ["queued", "scanning", "uploading", "creating_pr", "success", "partial", "failed", "cancelled"].includes(state) ? state : "queued",
    progress: Math.max(0, Math.min(100, Number(pick(source, ["progress", "percent", "percentage"])) || 0)),
    message: String(pick(source, ["message", "detail", "statusText"]) || ""),
    repositoryUrl: String(pick(source, ["repositoryUrl", "repoUrl", "html_url"]) || pick(result, ["repositoryUrl", "repoUrl", "html_url"]) || ""),
    pullRequestUrl: String(pick(source, ["pullRequestUrl", "prUrl"]) || pick(result, ["pullRequestUrl", "prUrl"]) || ""),
    branch: String(pick(source, ["branch", "branchName"]) || pick(result, ["branch", "branchName"]) || ""),
    commit: String(pick(source, ["commit", "commitSha", "sha"]) || pick(result, ["commit", "commitSha", "sha"]) || ""),
    uploaded: Number(pick(source, ["uploaded", "uploadedFiles", "succeeded"])) || 0,
    total: Number(pick(source, ["total", "totalFiles"])) || 0,
    failures: Array.isArray(failures) ? failures : [],
    warnings,
    warning,
    protectionFailed,
    branchProtection,
    remotePartial: result.partial === true,
    canCancel: !TERMINAL_STATES.has(state) && pick(source, ["canCancel", "cancellable"]) !== false
  };
}

export function normalizeGithubPreflight(raw = {}) {
  const payload = structured(raw) || {};
  const report = payload.report || payload.preflight || payload.scan || payload;
  const blockers = Array.isArray(report.blockers) ? report.blockers : Array.isArray(report.blockingFiles) ? report.blockingFiles : Array.isArray(report.blockedFiles) ? report.blockedFiles : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const summary = report.summary || payload.summary || {};
  const config = payload.config || report.config || {};
  const repository = report.repository || payload.repository || null;
  const sensitive = uniqueEntries(
    payload.sensitiveFiles,
    payload.sensitive,
    report.sensitiveFiles,
    report.sensitive,
    blockers.filter((entry) => ["SECRET_DETECTED", "SENSITIVE_FILE"].includes(String(entry?.code || "").toUpperCase()))
  );
  const large = uniqueEntries(
    payload.largeFiles,
    payload.large,
    report.largeFiles,
    report.large,
    blockers.filter((entry) => String(entry?.code || "").toUpperCase().includes("TOO_LARGE") || String(entry?.code || "").toUpperCase().includes("OVER_100")),
    warnings.filter((entry) => String(entry?.code || "").toUpperCase().includes("OVER_50"))
  );
  const visibility = String(repository?.visibility || config?.destination?.visibility || payload.visibility || report.visibility || "").toLowerCase();
  const ok = payload.ok === true || report.ok === true;
  let state = String(report.state || report.status || payload.state || payload.status || "").toLowerCase();
  if (!state) state = blockers.length ? "blocked" : ok ? (warnings.length ? "warning" : "passed") : "idle";
  if (state === "success" || state === "succeeded" || state === "ok") state = warnings.length ? "warning" : "passed";
  if (blockers.length) state = "blocked";
  return {
    id: String(payload.preflightId || payload.preflight_id || report.preflightId || report.id || ""),
    state: ["idle", "running", "passed", "warning", "blocked", "error"].includes(state) ? state : "idle",
    message: String(report.message || report.detail || payload.message || ""),
    blockers,
    warnings,
    sensitive,
    large,
    totalFiles: Number(summary.includedFiles || summary.totalFiles || summary.fileCount || payload.totalFiles || report.totalFiles || report.files || 0),
    totalBytes: Number(summary.includedBytes || summary.totalBytes || summary.bytes || payload.totalBytes || report.totalBytes || report.bytes || 0),
    config,
    repository,
    visibility,
    branch: String(config?.branch || repository?.defaultBranch || payload.branch || report.branch || "")
  };
}

export function serializeGithubUploadConfig(config = {}) {
  const serialized = {
    destination: {
      mode: config.repositoryMode,
      owner: config.owner,
      repo: config.repository,
      visibility: config.visibility,
      ...(String(config.destinationPath || "").trim() ? { path: String(config.destinationPath).trim() } : {})
    },
    upload: {
      scope: config.scope,
      customPaths: Array.isArray(config.selectedPaths) ? config.selectedPaths : [],
      currentRelativePath: config.currentRelativePath || null
    },
    publishMode: config.writeMode === "direct-main" ? "direct" : config.writeMode,
    license: config.license,
    generateReadme: Boolean(config.includeReadme),
    protectMain: Boolean(config.protectMain)
  };
  if (String(config.branch || "").trim()) serialized.branch = String(config.branch).trim();
  return serialized;
}

export function createGithubUploadClient({ callTool, callApi }) {
  async function invoke(tool, args, apiPath, apiOptions) {
    const result = await callTool?.(tool, args);
    if (result != null) return structured(result);
    if (!callApi) throw new Error("当前环境没有可用的 GitHub 上传服务");
    return callApi(apiPath, apiOptions);
  }

  return {
    async getContext(outputId, signal) {
      const result = await invoke(
        "get_github_upload_context",
        { id: outputId },
        `/api/items/${encodeURIComponent(outputId)}/github-upload/context`,
        { signal }
      );
      return normalizeGithubContext(result);
    },

    async start(outputId, config, preflightId, signal) {
      if (!preflightId) throw new Error("缺少有效的预检凭据，请重新执行上传前检查");
      const payload = { config: serializeGithubUploadConfig(config), preflightId, confirm: true };
      const result = await invoke(
        "start_github_upload",
        { id: outputId, ...payload },
        `/api/items/${encodeURIComponent(outputId)}/github-upload`,
        { method: "POST", body: payload, signal }
      );
      return normalizeGithubJob(result);
    },

    async preflight(outputId, config, signal) {
      const result = await invoke(
        "preflight_github_upload",
        { id: outputId, config: serializeGithubUploadConfig(config) },
        `/api/items/${encodeURIComponent(outputId)}/github-upload/preflight`,
        { method: "POST", body: { config: serializeGithubUploadConfig(config) }, signal }
      );
      return normalizeGithubPreflight(result);
    },

    async getJob(jobId, signal) {
      const result = await invoke(
        "get_github_upload_job",
        { jobId },
        `/api/github-upload/jobs/${encodeURIComponent(jobId)}`,
        { signal }
      );
      return normalizeGithubJob(result);
    },

    async cancel(jobId, signal) {
      const result = await invoke(
        "cancel_github_upload",
        { jobId },
        `/api/github-upload/jobs/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", body: {}, signal }
      );
      return normalizeGithubJob(result);
    }
  };
}

export const GITHUB_UPLOAD_CONTRACT = Object.freeze({
  tools: ["get_github_upload_context", "preflight_github_upload", "start_github_upload", "get_github_upload_job", "cancel_github_upload"],
  endpoints: [
    "GET /api/items/:id/github-upload/context",
    "POST /api/items/:id/github-upload/preflight",
    "POST /api/items/:id/github-upload",
    "GET /api/github-upload/jobs/:jobId",
    "POST /api/github-upload/jobs/:jobId/cancel"
  ]
});
