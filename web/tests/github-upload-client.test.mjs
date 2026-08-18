import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGithubUploadClient, normalizeGithubContext, normalizeGithubJob, normalizeGithubPreflight, safeGithubCliInstallUrl, serializeGithubUploadConfig } from "../src/githubUploadClient.js";
import { createFakeGitHubAdapter, createGitHubPublisher } from "../../extension/scripts/github-publisher.mjs";

test("normalizes missing CLI as unavailable without inventing authentication", () => {
  const context = normalizeGithubContext({ account: { login: "demo-user", authenticated: false }, cliInstalled: false });
  assert.equal(context.cliInstalled, false);
  assert.equal(context.authenticated, false);
  assert.equal(context.login, "demo-user");
  assert.equal(safeGithubCliInstallUrl("https://cli.github.com/"), "https://cli.github.com/");
  assert.equal(safeGithubCliInstallUrl("https://cli.github.com.evil.example/"), "");
  assert.equal(safeGithubCliInstallUrl("javascript:alert(1)"), "");
});

test("normalizes successful and partial GitHub jobs", () => {
  const success = normalizeGithubJob({ job: { jobId: "j1", status: "success", repoUrl: "https://github.com/a/b", branchName: "codex-output/v1", commitSha: "abc" } });
  assert.deepEqual({ id: success.id, state: success.state, url: success.repositoryUrl, branch: success.branch, commit: success.commit }, { id: "j1", state: "success", url: "https://github.com/a/b", branch: "codex-output/v1", commit: "abc" });
  const partial = normalizeGithubJob({ upload: { id: "j2", phase: "partial", failedFiles: [{ path: "a.bin" }] } });
  assert.equal(partial.state, "partial");
  assert.equal(partial.failures.length, 1);
  const serverPartial = normalizeGithubJob({ state: "failed", phase: "failed", result: { partial: true, warning: "远端仓库已创建，但后续步骤失败" } });
  assert.equal(serverPartial.state, "partial");
  assert.equal(serverPartial.warning, "远端仓库已创建，但后续步骤失败");
  const protectionWarning = normalizeGithubJob({
    state: "succeeded",
    total: 2,
    uploaded: 2,
    result: {
      repositoryUrl: "https://github.com/a/b",
      warnings: [{ code: "BRANCH_PROTECTION_FAILED", message: "ruleset permission denied" }]
    }
  });
  assert.equal(protectionWarning.state, "partial");
  assert.equal(protectionWarning.protectionFailed, true);
  assert.equal(protectionWarning.warnings.length, 1);
  assert.match(protectionWarning.warning, /ruleset permission denied/);
  const protectionShapeOnly = normalizeGithubJob({
    state: "success",
    result: {
      branchProtection: { requested: true, applied: false, warning: { code: "BRANCH_PROTECTION_FAILED", message: "protection not applied" } }
    }
  });
  assert.equal(protectionShapeOnly.state, "partial");
  assert.equal(protectionShapeOnly.branchProtection.applied, false);
  assert.match(protectionShapeOnly.warning, /protection not applied/);
});

test("binds a successful preflight id and serializes the strict upload config", () => {
  const preflight = normalizeGithubPreflight({ ok: true, preflightId: "pf-1", report: { blockers: [], warnings: [], summary: { fileCount: 4, totalBytes: 9 } } });
  assert.deepEqual({ id: preflight.id, state: preflight.state, files: preflight.totalFiles }, { id: "pf-1", state: "passed", files: 4 });
  const serverSummary = normalizeGithubPreflight({ ok: true, preflightId: "pf-server", report: { ok: true, blockers: [], warnings: [], summary: { includedFiles: 17, includedBytes: 2048 } }, totalFiles: 17, totalBytes: 2048 });
  assert.deepEqual({ files: serverSummary.totalFiles, bytes: serverSummary.totalBytes }, { files: 17, bytes: 2048 });
  const actualFields = normalizeGithubPreflight({
    ok: true,
    preflightId: "pf-actual",
    config: { destination: { mode: "existing", owner: "demo-user", repo: "demo", visibility: "private" }, branch: "codex-output/actual" },
    report: { ok: true, repository: { nameWithOwner: "demo-user/demo", visibility: "private", defaultBranch: "trunk" }, sensitiveFiles: [{ path: ".env" }], largeFiles: [{ path: "build.zip" }] },
    sensitiveFiles: [{ path: "token.txt" }],
    largeFiles: [{ path: "bundle.exe" }]
  });
  assert.equal(actualFields.visibility, "private");
  assert.equal(actualFields.repository.defaultBranch, "trunk");
  assert.equal(actualFields.branch, "codex-output/actual");
  assert.deepEqual(actualFields.sensitive.map((entry) => entry.path), ["token.txt", ".env"]);
  assert.deepEqual(actualFields.large.map((entry) => entry.path), ["bundle.exe", "build.zip"]);
  assert.deepEqual(serializeGithubUploadConfig({ repositoryMode: "new", owner: "demo-user", repository: "demo", visibility: "public", destinationPath: "codex-output-items/demo", scope: "custom", selectedPaths: ["a.txt"], writeMode: "branch-pr", branch: "codex-output/v1", license: "mit", includeReadme: true, protectMain: true }), {
    destination: { mode: "new", owner: "demo-user", repo: "demo", visibility: "public", path: "codex-output-items/demo" },
    upload: { scope: "custom", customPaths: ["a.txt"], currentRelativePath: null },
    publishMode: "branch-pr", license: "mit", generateReadme: true, protectMain: true, branch: "codex-output/v1"
  });
});

test("normalizes the real publisher preflight and publicJob field shapes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-github-contract-"));
  const source = path.join(root, "source");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "app.js"), "console.log('fixture');\n");
  fs.writeFileSync(path.join(source, "README.md"), "# fixture\n");
  const item = { id: "frontend-fixture", title: "Frontend Fixture", path: source, type: "程序文件夹", files: [{ relativePath: "src", kind: "folder" }, { relativePath: "src/app.js" }, { relativePath: "README.md" }] };
  const fake = createFakeGitHubAdapter({ login: "fixture-user" });
  const failingAfterPush = {
    ...fake,
    async createPullRequest(fullName, branch, baseBranch) {
      await fake.createPullRequest(fullName, branch, baseBranch);
      throw new Error("fixture pull request failure");
    }
  };
  const publisher = createGitHubPublisher({ dataRoot, getItem: () => item, adapter: failingAfterPush });
  const config = {
    destination: { mode: "new", owner: "fixture-user", repo: "frontend-fixture", visibility: "public" },
    upload: { scope: "whole" }, publishMode: "branch-pr", branch: "codex-output/frontend-fixture",
    license: "none", generateReadme: true, protectMain: true
  };
  try {
    const realContext = normalizeGithubContext(await publisher.context(item.id));
    assert.equal(realContext.setup.installUrl, "https://cli.github.com/");
    const rawPreflight = await publisher.preflight(item.id, config);
    const normalizedPreflight = normalizeGithubPreflight(rawPreflight);
    assert.equal(normalizedPreflight.id, rawPreflight.preflightId);
    assert.equal(normalizedPreflight.totalFiles, rawPreflight.report.summary.includedFiles);
    assert.equal(normalizedPreflight.totalBytes, rawPreflight.report.summary.includedBytes);
    assert.equal(normalizedPreflight.state, "warning");
    assert.deepEqual(normalizedPreflight.config, rawPreflight.config);
    assert.equal(normalizedPreflight.branch, "codex-output/frontend-fixture");

    const automaticBranchConfig = {
      ...config,
      destination: { mode: "new", owner: "fixture-user", repo: "frontend-auto-branch", visibility: "private" }
    };
    delete automaticBranchConfig.branch;
    const automaticBranchPreflight = await publisher.preflight(item.id, automaticBranchConfig);
    const normalizedAutomaticBranch = normalizeGithubPreflight(automaticBranchPreflight);
    assert.equal(normalizedAutomaticBranch.branch, automaticBranchPreflight.config.branch);
    assert.match(normalizedAutomaticBranch.branch, /^codex-output\/.+-\d{4}-\d{2}-\d{2}-[a-f0-9]{10}$/);

    const rawExistingPreflight = await publisher.preflight(item.id, {
      ...config,
      destination: { mode: "existing", owner: "fixture-user", repo: "existing", visibility: "private" },
      branch: "codex-output/existing"
    });
    const existingPreflight = normalizeGithubPreflight(rawExistingPreflight);
    assert.equal(rawExistingPreflight.config.destination.visibility, "public");
    assert.equal(existingPreflight.visibility, "public");
    assert.equal(existingPreflight.repository.nameWithOwner, "fixture-user/existing");
    assert.equal(existingPreflight.repository.defaultBranch, "main");

    const started = await publisher.startJob(item.id, { preflightId: rawPreflight.preflightId, confirm: true, config: rawPreflight.config });
    let rawPublicJob = started;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      rawPublicJob = publisher.jobStatus(started.id);
      if (["success", "failed", "cancelled"].includes(rawPublicJob.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rawPublicJob.result.partial, true);
    const normalizedJob = normalizeGithubJob(rawPublicJob);
    assert.equal(normalizedJob.state, "partial");
    assert.equal(normalizedJob.warning, rawPublicJob.result.warning);
    assert.equal(normalizedJob.repositoryUrl, rawPublicJob.result.repositoryUrl);

    const protectionAdapter = createFakeGitHubAdapter({ login: "fixture-user" });
    const protectionFailure = {
      ...protectionAdapter,
      async protectDefaultBranch(fullName, branch, cwd) {
        await protectionAdapter.protectDefaultBranch(fullName, branch, cwd);
        throw new Error("fixture ruleset permission denied");
      }
    };
    const protectionPublisher = createGitHubPublisher({ dataRoot: path.join(root, "protection-data"), getItem: () => item, adapter: protectionFailure });
    const protectionConfig = {
      ...config,
      destination: { mode: "new", owner: "fixture-user", repo: "frontend-protection-fixture", visibility: "private" },
      branch: "codex-output/protection-fixture"
    };
    const protectionPreflight = await protectionPublisher.preflight(item.id, protectionConfig);
    const protectionStarted = await protectionPublisher.startJob(item.id, { preflightId: protectionPreflight.preflightId, confirm: true, config: protectionPreflight.config });
    let protectionJob = protectionStarted;
    const protectionDeadline = Date.now() + 5000;
    while (Date.now() < protectionDeadline) {
      protectionJob = protectionPublisher.jobStatus(protectionStarted.id);
      if (["success", "succeeded", "partial", "failed", "cancelled"].includes(protectionJob.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(protectionJob.result.warnings[0].code, "BRANCH_PROTECTION_FAILED");
    const normalizedProtectionJob = normalizeGithubJob(protectionJob);
    assert.equal(normalizedProtectionJob.state, "partial");
    assert.equal(normalizedProtectionJob.protectionFailed, true);
    assert.deepEqual(normalizedProtectionJob.branchProtection, protectionJob.result.branchProtection);
    assert.match(normalizedProtectionJob.warning, /fixture ruleset permission denied/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers MCP and falls back to HTTP with the same adapter shape", async () => {
  const calls = [];
  const mcpClient = createGithubUploadClient({
    callTool: async (name, args) => { calls.push([name, args]); return { structuredContent: { cliInstalled: true, account: { login: "demo-user", authenticated: true } } }; },
    callApi: async () => { throw new Error("HTTP should not be used"); }
  });
  assert.equal((await mcpClient.getContext("item-1")).login, "demo-user");
  assert.equal(calls[0][0], "get_github_upload_context");

  let sentBody;
  const httpClient = createGithubUploadClient({
    callTool: async () => null,
    callApi: async (path, options) => { sentBody = options.body; return { job: { id: "j3", state: "queued", message: `${options.method}:${path}` } }; }
  });
  const job = await httpClient.start("item-1", { repositoryMode: "new", owner: "demo-user", repository: "demo", visibility: "public", scope: "whole", writeMode: "branch-pr" }, "pf-3");
  assert.equal(job.id, "j3");
  assert.match(job.message, /POST:\/api\/items\/item-1\/github-upload/);
  assert.equal(sentBody.preflightId, "pf-3");
  assert.equal(sentBody.confirm, true);
  assert.equal(sentBody.config.destination.repo, "demo");
});
