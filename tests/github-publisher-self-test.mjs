#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFakeGitHubAdapter, createGitHubPublisher, RealGitHubAdapter } from "./github-publisher.mjs";

const PRIVATE_KEY_HEADER_FIXTURE = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const PROJECT_SECRET_FIXTURE = ["sk", "-proj-", "abcdefghijklmnopqrstuvwxyz", "123456"].join("");
const GITHUB_TOKEN_FIXTURE = ["gh", "p_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "1234567890"].join("");

if (process.argv[2] === "--lock-holder-fixture") {
  const fixture = JSON.parse(Buffer.from(String(process.argv[3] || ""), "base64url").toString("utf8"));
  const childItem = { id: "fixture-item", title: "Fixture App", description: "lock holder", path: fixture.source, type: "程序文件夹", files: [] };
  const childAdapter = createFakeGitHubAdapter({ login: "fixture-user", delayMs: 120 });
  const childPublisher = createGitHubPublisher({ dataRoot: fixture.dataRoot, getItem: () => childItem, adapter: childAdapter });
  const childConfig = {
    destination: { mode: "new", owner: "fixture-user", repo: "cross-process-lock", visibility: "private" },
    upload: { scope: "whole" }, publishMode: "branch-pr", branch: "codex-output/shared-lock",
    license: "none", generateReadme: false, protectMain: false,
  };
  const childChecked = await childPublisher.preflight(childItem.id, childConfig);
  const childStarted = await childPublisher.startJob(childItem.id, { preflightId: childChecked.preflightId, confirm: true, config: childConfig });
  fs.writeFileSync(fixture.readyFile, childStarted.id, { encoding: "utf8", flag: "wx" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = childPublisher.jobStatus(childStarted.id);
    if (["success", "failed", "cancelled"].includes(status.state)) process.exit(status.state === "success" ? 0 : 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.exit(3);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-github-self-test-"));
const source = path.join(root, "source");
const dataRoot = path.join(root, "data");
fs.mkdirSync(path.join(source, "src"), { recursive: true });
fs.mkdirSync(path.join(source, ".git"), { recursive: true });
fs.mkdirSync(path.join(source, "node_modules", "fixture"), { recursive: true });
fs.writeFileSync(path.join(source, "src", "app.js"), "console.log('safe');\n");
fs.writeFileSync(path.join(source, "README.md"), "# fixture\n");
fs.writeFileSync(path.join(source, ".env"), "PASSWORD=must-not-upload\n");
fs.writeFileSync(path.join(source, ".git", "config"), "must-not-upload\n");
fs.writeFileSync(path.join(source, "node_modules", "fixture", "index.js"), "must-not-upload\n");
fs.writeFileSync(path.join(source, "private.pem"), `${PRIVATE_KEY_HEADER_FIXTURE}\nnot-real\n`);

const item = {
  id: "fixture-item", title: "Fixture App", description: "安全上传测试", path: source, type: "程序文件夹",
  files: [{ relativePath: "src/app.js" }, { relativePath: "README.md" }], activity: [],
};
const publications = [];
const events = [];
const fake = createFakeGitHubAdapter({ login: "fixture-user" });
const publisher = createGitHubPublisher({
  dataRoot,
  getItem(id) { assert.equal(id, item.id); return item; },
  updateItemPublication(id, publication) { publications.push({ id, publication }); },
  logEvent(name, detail) { events.push({ name, detail }); },
  adapter: fake,
});

const baseConfig = {
  destination: { mode: "new", owner: "fixture-user", repo: "fixture-output", visibility: "public" },
  upload: { scope: "whole" }, publishMode: "branch-pr", branch: "codex-output/fixture",
  license: "mit", generateReadme: true, protectMain: true, description: "fixture",
};

async function waitJob(publisherValue, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = publisherValue.jobStatus(id);
    if (["success", "failed", "cancelled"].includes(value.state)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return value;
}

function remoteWriteCount() {
  return fake.calls.filter((entry) => ["createRepository", "commitAndPush", "createPullRequest", "protectDefaultBranch"].includes(entry.name)).length;
}

try {
  const status = await publisher.status();
  assert.equal(status.ready, true);
  assert.equal(status.login, "fixture-user");
  assert.equal(status.tokenStoredByExtension, false);

  const context = await publisher.context(item.id);
  assert.equal(context.account.login, "fixture-user");
  assert.equal(context.repositories[0].nameWithOwner, "fixture-user/existing");

  const selfTestSource = path.join(root, "self-test-source");
  fs.mkdirSync(selfTestSource, { recursive: true });
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(selfTestSource, "github-publisher-self-test.mjs"));
  const selfTestItem = { ...item, id: "self-test-source", path: selfTestSource, files: [] };
  const selfTestPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "self-test-data"),
    getItem: () => selfTestItem,
    adapter: createFakeGitHubAdapter({ login: "fixture-user" }),
  });
  const selfTestPreflight = await selfTestPublisher.preflight(selfTestItem.id, {
    ...baseConfig,
    destination: { ...baseConfig.destination, repo: "self-test-source" },
    license: "none",
    generateReadme: false,
    protectMain: false,
  });
  assert.equal(selfTestPreflight.report.ok, true, "runtime-built fake credentials must not block distributing the self-test source");
  assert.equal(selfTestPreflight.report.summary.includedFiles, 1);
  assert.equal(selfTestPreflight.report.blockers.some((entry) => entry.kind === "private-key"), false);

  const commandResult = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr });
  const invalidStatusAdapter = new RealGitHubAdapter({
    ghPath: "fixture-gh",
    gitPath: "fixture-git",
    async runner(_command, args) {
      if (args[0] === "auth") {
        return commandResult(JSON.stringify({ hosts: { "github.com": [{ active: true, state: "error", login: "fixture-user", error: `HTTP 401 ${GITHUB_TOKEN_FIXTURE}` }] } }));
      }
      throw new Error(`API verification must not run after invalid auth status: ${args.join(" ")}`);
    },
  });
  const invalidStatusPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "invalid-status-data"),
    getItem: () => item,
    adapter: invalidStatusAdapter,
  });
  const invalidStatus = await invalidStatusPublisher.status();
  assert.equal(invalidStatus.authenticated, false);
  assert.equal(invalidStatus.ready, false);
  assert.match(invalidStatus.authError, /登录凭据无效/);
  assert.doesNotMatch(JSON.stringify(invalidStatus), /ghp_|ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890/);

  const staleCredentialAdapter = new RealGitHubAdapter({
    ghPath: "fixture-gh",
    gitPath: "fixture-git",
    async runner(_command, args) {
      if (args[0] === "auth") {
        return commandResult(JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", login: "fixture-user" }] } }));
      }
      if (args[0] === "api") throw new Error(`HTTP 401: Bad credentials ${GITHUB_TOKEN_FIXTURE}`);
      throw new Error(`unexpected fixture command: ${args.join(" ")}`);
    },
  });
  const staleCredentialPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "stale-credential-data"),
    getItem: () => item,
    adapter: staleCredentialAdapter,
  });
  const staleCredentialStatus = await staleCredentialPublisher.status();
  assert.equal(staleCredentialStatus.authenticated, false);
  assert.equal(staleCredentialStatus.ready, false);
  assert.match(staleCredentialStatus.authError, /API 身份验证失败/);
  assert.doesNotMatch(JSON.stringify(staleCredentialStatus), /ghp_|ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890/);

  const mismatchedIdentityAdapter = new RealGitHubAdapter({
    ghPath: "fixture-gh",
    gitPath: "fixture-git",
    async runner(_command, args) {
      if (args[0] === "auth") {
        return commandResult(JSON.stringify({ hosts: { "github.com": [{ active: true, state: "success", login: "fixture-user" }] } }));
      }
      if (args[0] === "api") return commandResult("different-user\n");
      throw new Error(`unexpected fixture command: ${args.join(" ")}`);
    },
  });
  const mismatchedIdentityPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "mismatched-identity-data"),
    getItem: () => item,
    adapter: mismatchedIdentityAdapter,
  });
  const mismatchedIdentityStatus = await mismatchedIdentityPublisher.status();
  assert.equal(mismatchedIdentityStatus.authenticated, false);
  assert.equal(mismatchedIdentityStatus.ready, false);
  assert.match(mismatchedIdentityStatus.authError, /不一致/);
  assert.equal(context.capabilities.collaboratorsGranted, false);
  assert.equal(context.capabilities.requiresExplicitConfirmation, true);

  const checked = await publisher.preflight(item.id, baseConfig);
  assert.equal(checked.report.ok, true);
  assert.ok(checked.report.warnings.some((entry) => entry.code === "PUBLIC_VISIBILITY"));
  assert.ok(checked.report.excludedPreview.some((entry) => entry.path === ".env"));
  assert.ok(checked.report.excludedPreview.some((entry) => entry.path.includes("node_modules")));
  assert.ok(checked.report.excludedPreview.some((entry) => entry.path === "private.pem"));
  assert.ok(!checked.report.includedPreview.some((entry) => entry.path.includes(".git")));

  const uniqueDefaultOne = await publisher.preflight(item.id, {
    ...baseConfig, branch: undefined, destination: { ...baseConfig.destination, repo: "unique-default-one" },
  });
  const uniqueDefaultTwo = await publisher.preflight(item.id, {
    ...baseConfig, branch: undefined, destination: { ...baseConfig.destination, repo: "unique-default-two" },
  });
  assert.match(uniqueDefaultOne.config.branch, /^codex-output\/fixture-item-\d{4}-\d{2}-\d{2}-[0-9a-f]{10}$/);
  assert.notEqual(uniqueDefaultOne.config.branch, uniqueDefaultTwo.config.branch, "default branches must include a unique reserved-job nonce");
  const legacyDefault = await publisher.preflight(item.id, {
    ...baseConfig, branch: `codex-output/${new Date().toISOString().slice(0, 10)}`, destination: { ...baseConfig.destination, repo: "legacy-default" },
  });
  assert.match(legacyDefault.config.branch, /^codex-output\/fixture-item-/, "legacy date-only UI defaults must be upgraded to a unique branch");

  const existingChecked = await publisher.preflight(item.id, {
    ...baseConfig,
    destination: { mode: "existing", owner: "fixture-user", repo: "existing" },
  });
  assert.equal(existingChecked.report.ok, true);
  assert.ok(existingChecked.report.warnings.some((entry) => entry.code === "EXISTING_ACCESS_UNCHANGED"));
  assert.equal(existingChecked.config.destination.path, "codex-output-items/fixture-item");
  assert.ok(existingChecked.report.warnings.some((entry) => entry.code === "EXISTING_ISOLATED_PATH"));

  const flatChecked = await publisher.preflight(item.id, {
    repositoryMode: "new", owner: "fixture-user", repository: "flat-config", visibility: "private",
    scope: "custom", selectedPaths: ["README.md"], writeMode: "direct-main",
    license: "apache-2.0", includeReadme: false, protectMain: false,
  });
  assert.equal(flatChecked.config.publishMode, "direct");
  assert.equal(flatChecked.config.destination.repo, "flat-config");
  assert.equal(flatChecked.config.license, "apache-2.0");

  await assert.rejects(
    publisher.startJob(item.id, { preflightId: checked.preflightId, confirm: false }),
    (error) => error.code === "GITHUB_CONFIRM_REQUIRED",
  );
  assert.equal(fake.calls.some((entry) => entry.name === "createRepository"), false, "unconfirmed upload must perform no GitHub write");

  await assert.rejects(
    publisher.startJob(item.id, { preflightId: checked.preflightId, confirm: true, config: { ...baseConfig, destination: { ...baseConfig.destination, repo: "changed" } } }),
    (error) => error.code === "GITHUB_CONFIG_CHANGED",
  );
  assert.equal(fake.calls.some((entry) => entry.name === "createRepository"), false, "changed config must perform no GitHub write");

  const started = await publisher.startJob(item.id, { preflightId: checked.preflightId, confirm: true, config: baseConfig });
  assert.equal(started.state, "queued");
  const completed = await waitJob(publisher, started.id);
  assert.equal(completed.state, "success", JSON.stringify(completed));
  assert.equal(completed.result.repository, "fixture-user/fixture-output");
  assert.equal(completed.result.pullRequestUrl, "https://github.com/fixture-user/fixture-output/pull/1");
  assert.equal(publications.length, 1);
  assert.equal(publications[0].publication.commit.length, 40);
  const push = fake.calls.find((entry) => entry.name === "commitAndPush");
  assert.ok(push.files.includes(path.join("src", "app.js")));
  assert.ok(push.files.includes("README.md"));
  assert.ok(!push.files.some((entry) => entry.includes(".env") || entry.includes("private.pem") || entry.includes("node_modules")));
  const stagedNames = [];
  const stagingBase = path.join(dataRoot, "temp", "github-jobs");
  const collectNames = (folder) => { if (!fs.existsSync(folder)) return; for (const name of fs.readdirSync(folder)) { const full = path.join(folder, name); if (fs.statSync(full).isDirectory()) collectNames(full); else stagedNames.push(full); } };
  collectNames(stagingBase);
  assert.ok(!stagedNames.some((entry) => entry.includes(started.id)), "completed job staging must be deleted");
  assert.ok(events.some((entry) => entry.name === "github-publish-succeeded"));

  const claimConfig = { ...baseConfig, destination: { ...baseConfig.destination, repo: "atomic-claim-test" }, branch: "codex-output/atomic-claim" };
  const claimPreflight = await publisher.preflight(item.id, claimConfig);
  const firstClaim = publisher.startJob(item.id, { preflightId: claimPreflight.preflightId, confirm: true, config: claimConfig });
  await assert.rejects(
    publisher.startJob(item.id, { preflightId: claimPreflight.preflightId, confirm: true, config: claimConfig }),
    (error) => error.code === "GITHUB_PREFLIGHT_ALREADY_CLAIMED",
  );
  const claimStarted = await firstClaim;
  await assert.rejects(
    publisher.startJob(item.id, { preflightId: claimPreflight.preflightId, confirm: true, config: claimConfig }),
    (error) => error.code === "GITHUB_PREFLIGHT_ALREADY_CLAIMED",
    "a consumed preflight must retain an explicit claimed tombstone until expiry",
  );
  assert.equal((await waitJob(publisher, claimStarted.id)).state, "success");

  const existingStarted = await publisher.startJob(item.id, { preflightId: existingChecked.preflightId, confirm: true, config: existingChecked.config });
  const existingCompleted = await waitJob(publisher, existingStarted.id);
  assert.equal(existingCompleted.state, "success", JSON.stringify(existingCompleted));
  assert.equal(existingCompleted.result.destinationPath, "codex-output-items/fixture-item");
  assert.ok(existingCompleted.result.overwrittenPaths.includes("codex-output-items/fixture-item/README.md"));
  assert.ok(existingCompleted.result.warnings.some((entry) => entry.code === "EXISTING_PATHS_REPLACED"));

  const protectionPublications = [];
  const protectionBase = createFakeGitHubAdapter({ login: "fixture-user" });
  const protectionFake = {
    ...protectionBase,
    async protectDefaultBranch() { protectionBase.calls.push({ name: "protectDefaultBranch" }); throw new Error("ruleset permission denied"); },
  };
  const protectionPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "protection-data"), getItem: () => item, adapter: protectionFake,
    updateItemPublication(id, publication) { protectionPublications.push({ id, publication }); },
  });
  const protectionConfig = { ...baseConfig, destination: { ...baseConfig.destination, repo: "protection-warning" }, branch: "codex-output/protection-warning" };
  const protectionChecked = await protectionPublisher.preflight(item.id, protectionConfig);
  const protectionStarted = await protectionPublisher.startJob(item.id, { preflightId: protectionChecked.preflightId, confirm: true, config: protectionConfig });
  const protectionCompleted = await waitJob(protectionPublisher, protectionStarted.id);
  assert.equal(protectionCompleted.state, "success");
  assert.equal(protectionCompleted.result.branchProtection.requested, true);
  assert.equal(protectionCompleted.result.branchProtection.applied, false);
  assert.ok(protectionCompleted.result.warnings.some((entry) => entry.code === "BRANCH_PROTECTION_FAILED"));
  assert.ok(protectionCompleted.message.includes("主分支保护未启用"));
  assert.equal(protectionPublications[0].publication.branchProtection.applied, false, "branch protection warning must reach persistent publication callback");
  assert.ok(protectionPublications[0].publication.warnings.some((entry) => entry.code === "BRANCH_PROTECTION_FAILED"));

  const outsideRepository = path.join(root, "outside-repository-target");
  fs.mkdirSync(outsideRepository, { recursive: true });
  fs.writeFileSync(path.join(outsideRepository, "sentinel.txt"), "must remain unchanged\n");
  const symlinkBase = createFakeGitHubAdapter({ login: "fixture-user" });
  let repositoryLinkCreated = false;
  const symlinkFake = {
    ...symlinkBase,
    async cloneRepository(fullName, target) {
      symlinkBase.calls.push({ name: "cloneRepository", fullName, target });
      fs.mkdirSync(path.join(target, ".git"), { recursive: true });
      try {
        fs.symlinkSync(outsideRepository, path.join(target, "codex-output-items"), process.platform === "win32" ? "junction" : "dir");
        repositoryLinkCreated = true;
      } catch { }
    },
  };
  const symlinkPublisher = createGitHubPublisher({ dataRoot: path.join(root, "symlink-repo-data"), getItem: () => item, adapter: symlinkFake });
  const symlinkConfig = { ...baseConfig, destination: { mode: "existing", owner: "fixture-user", repo: "existing" }, branch: "codex-output/symlink-repo" };
  const symlinkChecked = await symlinkPublisher.preflight(item.id, symlinkConfig);
  const symlinkStarted = await symlinkPublisher.startJob(item.id, { preflightId: symlinkChecked.preflightId, confirm: true, config: symlinkChecked.config });
  const symlinkCompleted = await waitJob(symlinkPublisher, symlinkStarted.id);
  assert.equal(repositoryLinkCreated, true, "repository junction fixture must be available on this test host");
  assert.equal(symlinkCompleted.state, "failed");
  assert.ok(["GITHUB_REPOSITORY_LINK_BLOCKED", "GITHUB_REPOSITORY_ESCAPE"].includes(symlinkCompleted.error.code));
  assert.equal(symlinkBase.calls.some((entry) => entry.name === "commitAndPush"), false, "repository junction must fail before commit or push");
  assert.equal(fs.readFileSync(path.join(outsideRepository, "sentinel.txt"), "utf8"), "must remain unchanged\n");
  assert.equal(fs.existsSync(path.join(outsideRepository, "src", "app.js")), false, "merge must never follow a repository junction");

  const cancelPreflight = await publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "cancel-test" } });
  const cancelStarted = await publisher.startJob(item.id, { preflightId: cancelPreflight.preflightId, confirm: true, config: { ...baseConfig, destination: { ...baseConfig.destination, repo: "cancel-test" } } });
  const cancelled = publisher.cancelJob(cancelStarted.id);
  assert.equal(cancelled.state, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(publisher.jobStatus(cancelStarted.id).state, "cancelled");

  const sharedLockData = path.join(root, "shared-lock-data");
  const lockReadyFile = path.join(root, "cross-process-lock.ready");
  const childPayload = Buffer.from(JSON.stringify({ source, dataRoot: sharedLockData, readyFile: lockReadyFile }), "utf8").toString("base64url");
  const lockHolder = spawn(process.execPath, [fileURLToPath(import.meta.url), "--lock-holder-fixture", childPayload], {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const childOutput = [];
  lockHolder.stdout.on("data", (chunk) => childOutput.push(chunk));
  lockHolder.stderr.on("data", (chunk) => childOutput.push(chunk));
  const childExitPromise = new Promise((resolve, reject) => {
    lockHolder.once("error", reject);
    lockHolder.once("close", (code) => resolve(code));
  });
  const readyDeadline = Date.now() + 10_000;
  while (!fs.existsSync(lockReadyFile) && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(lockReadyFile), true, `real child lock holder did not become ready: ${Buffer.concat(childOutput).toString("utf8")}`);
  const lockFakeTwo = createFakeGitHubAdapter({ login: "fixture-user" });
  const lockPublisherTwo = createGitHubPublisher({ dataRoot: sharedLockData, getItem: () => item, adapter: lockFakeTwo });
  const lockConfig = { ...baseConfig, destination: { ...baseConfig.destination, repo: "cross-process-lock" }, branch: "codex-output/shared-lock" };
  const lockCheckedTwo = await lockPublisherTwo.preflight(item.id, lockConfig);
  await assert.rejects(
    lockPublisherTwo.startJob(item.id, { preflightId: lockCheckedTwo.preflightId, confirm: true, config: lockConfig }),
    (error) => error.code === "GITHUB_DESTINATION_BUSY" && /仓库锁/.test(error.message),
    "a second publisher sharing DATA_ROOT must fail clearly while owner/repo is locked",
  );
  const childExit = await childExitPromise;
  assert.equal(childExit, 0, `real child lock holder failed: ${Buffer.concat(childOutput).toString("utf8")}`);

  const racePath = path.join(source, "race.txt");
  const safeRace = "This file contains only safe fixture text.                       \n";
  fs.writeFileSync(racePath, safeRace, "utf8");
  const raceStat = fs.statSync(racePath);
  const raceConfig = { ...baseConfig, destination: { ...baseConfig.destination, repo: "race-test" }, upload: { scope: "custom", customPaths: ["race.txt"] } };
  const racePreflight = await publisher.preflight(item.id, raceConfig);
  const writesBeforeRace = remoteWriteCount();
  const raceStarted = await publisher.startJob(item.id, { preflightId: racePreflight.preflightId, confirm: true, config: raceConfig });
  const leakedRace = `api_key='${PROJECT_SECRET_FIXTURE}'`.padEnd(Buffer.byteLength(safeRace) - 1, " ") + "\n";
  assert.equal(Buffer.byteLength(leakedRace), Buffer.byteLength(safeRace));
  fs.writeFileSync(racePath, leakedRace, "utf8");
  fs.utimesSync(racePath, raceStat.atime, raceStat.mtime);
  const raceCompleted = await waitJob(publisher, raceStarted.id);
  assert.equal(raceCompleted.state, "failed");
  assert.ok(["GITHUB_SOURCE_CHANGED", "GITHUB_SECRET_AFTER_COPY"].includes(raceCompleted.error.code));
  assert.equal(remoteWriteCount(), writesBeforeRace, "source/secret change after start must cause zero remote writes");
  fs.rmSync(racePath);

  fs.writeFileSync(path.join(source, "leak.txt"), `api_key = '${PROJECT_SECRET_FIXTURE}'\n`);
  const secret = await publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "secret-test" } });
  assert.equal(secret.report.ok, false);
  assert.ok(secret.report.blockers.some((entry) => entry.code === "SECRET_DETECTED" && entry.path === "leak.txt"));
  await assert.rejects(publisher.startJob(item.id, { preflightId: secret.preflightId, confirm: true }), (error) => error.code === "GITHUB_PREFLIGHT_BLOCKED");
  fs.rmSync(path.join(source, "leak.txt"));

  const longSecretPath = path.join(source, "long-text.txt");
  fs.writeFileSync(longSecretPath, `${"safe text line\n".repeat(180000)}api_key='${PROJECT_SECRET_FIXTURE}'\n`);
  const longSecret = await publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "long-secret-test" }, upload: { scope: "custom", customPaths: ["long-text.txt"] } });
  assert.ok(fs.statSync(longSecretPath).size > 2 * 1024 * 1024);
  assert.equal(longSecret.report.ok, false);
  assert.ok(longSecret.report.blockers.some((entry) => entry.code === "SECRET_DETECTED"), "streaming scan must inspect text beyond 2 MiB");
  fs.rmSync(longSecretPath);

  const largePath = path.join(source, "large.zip");
  fs.writeFileSync(largePath, "");
  fs.truncateSync(largePath, 101 * 1024 * 1024);
  const large = await publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "large-test" }, upload: { scope: "binaries" } });
  assert.equal(large.report.ok, false);
  assert.ok(large.report.blockers.some((entry) => entry.code === "FILE_OVER_100_MIB"));
  assert.ok(large.report.warnings.some((entry) => entry.code === "BINARY_CONTENT_NOT_SCANNED"));
  fs.rmSync(largePath);

  await assert.rejects(
    publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "bad;repo" } }),
    /仓库名称无效/,
  );
  await assert.rejects(
    publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, owner: "other-user" } }),
    (error) => error.code === "GITHUB_OWNER_MISMATCH",
  );
  await assert.rejects(
    publisher.preflight(item.id, { ...baseConfig, upload: { scope: "custom", customPaths: ["..\\outside.txt"] } }),
    /无效|越出产出项范围/,
  );
  await assert.rejects(
    publisher.preflight(item.id, { ...baseConfig, destination: { ...baseConfig.destination, path: ".git/hooks" } }),
    (error) => error.code === "GITHUB_REPOSITORY_METADATA_BLOCKED",
  );

  const protectedSource = path.join(dataRoot, "protected-source");
  fs.mkdirSync(protectedSource, { recursive: true });
  fs.writeFileSync(path.join(protectedSource, "do-not-upload.txt"), "protected\n");
  const ancestorItem = { ...item, id: "data-root-ancestor", path: root };
  const ancestorPublisher = createGitHubPublisher({ dataRoot, getItem: () => ancestorItem, adapter: fake });
  await assert.rejects(
    ancestorPublisher.preflight(ancestorItem.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "data-ancestor-test" } }),
    (error) => error.code === "GITHUB_SOURCE_UNSAFE",
    "a source that contains DATA_ROOT must be blocked, not only a source inside DATA_ROOT",
  );

  const extensionRootItem = { ...item, id: "extension-root", path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
  const extensionRootPublisher = createGitHubPublisher({
    dataRoot: path.join(root, "extension-root-protection-data"),
    getItem: () => extensionRootItem,
    adapter: fake,
  });
  await assert.rejects(
    extensionRootPublisher.preflight(extensionRootItem.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "extension-root-test" } }),
    (error) => error.code === "GITHUB_SOURCE_UNSAFE",
    "the installed extension root must remain protected from GitHub upload",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const codexOverlapSource = path.join(root, "codex-overlap-source");
  const protectedCodexHome = path.join(codexOverlapSource, ".codex-private");
  const codexOverlapData = path.join(root, "codex-overlap-data");
  fs.mkdirSync(protectedCodexHome, { recursive: true });
  fs.writeFileSync(path.join(codexOverlapSource, "safe-looking.txt"), "safe text\n");
  process.env.CODEX_HOME = protectedCodexHome;
  try {
    const codexOverlapItem = { ...item, id: "codex-home-ancestor", path: codexOverlapSource };
    const codexOverlapPublisher = createGitHubPublisher({ dataRoot: codexOverlapData, getItem: () => codexOverlapItem, adapter: fake });
    await assert.rejects(
      codexOverlapPublisher.preflight(codexOverlapItem.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "codex-overlap-test" } }),
      (error) => error.code === "GITHUB_SOURCE_UNSAFE",
      "a source that contains CODEX_HOME must be blocked by realpath containment",
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  }
  const junctionParent = path.join(root, "junction-parent");
  let junctionCreated = false;
  try { fs.symlinkSync(dataRoot, junctionParent, "junction"); junctionCreated = true; } catch { }
  if (junctionCreated) {
    const junctionItem = { ...item, id: "junction-item", path: path.join(junctionParent, "protected-source") };
    const junctionPublisher = createGitHubPublisher({ dataRoot, getItem: () => junctionItem, adapter: fake });
    await assert.rejects(
      junctionPublisher.preflight(junctionItem.id, { ...baseConfig, destination: { ...baseConfig.destination, repo: "junction-test" } }),
      (error) => error.code === "GITHUB_SOURCE_UNSAFE",
    );
  }

  const tokenEvents = [];
  const tokenFakeBase = createFakeGitHubAdapter({ login: "fixture-user" });
  const tokenFake = {
    ...tokenFakeBase,
    async cloneRepository() { throw new Error(`${GITHUB_TOKEN_FIXTURE} Authorization: Bearer super-secret-token`); },
  };
  const tokenPublisher = createGitHubPublisher({ dataRoot: path.join(root, "token-redaction"), getItem: () => item, adapter: tokenFake, logEvent: (name, detail) => tokenEvents.push({ name, detail }) });
  const tokenConfig = { ...baseConfig, destination: { ...baseConfig.destination, repo: "redaction-test" } };
  const tokenPreflight = await tokenPublisher.preflight(item.id, tokenConfig);
  const tokenStarted = await tokenPublisher.startJob(item.id, { preflightId: tokenPreflight.preflightId, confirm: true, config: tokenConfig });
  const tokenFailed = await waitJob(tokenPublisher, tokenStarted.id);
  assert.equal(tokenFailed.state, "failed");
  assert.doesNotMatch(JSON.stringify({ tokenFailed, tokenEvents }), /ghp_|super-secret-token/);

  const isolatedCliRoot = path.join(root, "isolated-cli-environment");
  const isolatedBin = path.join(isolatedCliRoot, "bin");
  const isolatedProfile = path.join(isolatedCliRoot, "profile");
  const isolatedProgramFiles = path.join(isolatedCliRoot, "program-files");
  const isolatedLocalAppData = path.join(isolatedCliRoot, "local-app-data");
  fs.mkdirSync(isolatedBin, { recursive: true });
  fs.mkdirSync(isolatedProfile, { recursive: true });
  fs.mkdirSync(isolatedProgramFiles, { recursive: true });
  fs.mkdirSync(isolatedLocalAppData, { recursive: true });
  fs.writeFileSync(path.join(isolatedBin, process.platform === "win32" ? "git.exe" : "git"), "fixture-only executable marker\n");

  const isolatedEnvironmentKeys = ["PATH", "LOCALAPPDATA", "ProgramFiles", "USERPROFILE", "HOME"];
  const previousCliEnvironment = new Map(isolatedEnvironmentKeys.map((key) => [key, process.env[key]]));
  process.env.PATH = isolatedBin;
  process.env.LOCALAPPDATA = isolatedLocalAppData;
  process.env.ProgramFiles = isolatedProgramFiles;
  process.env.USERPROFILE = isolatedProfile;
  process.env.HOME = isolatedProfile;
  try {
    const unavailableRoot = path.join(root, "unavailable");
    const staleRoot = path.join(unavailableRoot, "temp", "github-jobs", "process-99999999-00000000-0000-0000-0000-000000000000");
    fs.mkdirSync(staleRoot, { recursive: true });
    fs.writeFileSync(path.join(staleRoot, "owner.json"), JSON.stringify({ pid: 99999999, nonce: "stale" }));
    const liveRoot = path.join(unavailableRoot, "temp", "github-jobs", `process-${process.pid}-11111111-1111-1111-1111-111111111111`);
    fs.mkdirSync(liveRoot, { recursive: true });
    fs.writeFileSync(path.join(liveRoot, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "live" }));
    const reusedPidRoot = path.join(unavailableRoot, "temp", "github-jobs", `process-${process.pid}-22222222-2222-2222-2222-222222222222`);
    fs.mkdirSync(reusedPidRoot, { recursive: true });
    fs.writeFileSync(path.join(reusedPidRoot, "owner.json"), JSON.stringify({ pid: process.pid, processStartIdentity: "windows:1", nonce: "reused-pid" }));
    const unavailable = createGitHubPublisher({ dataRoot: unavailableRoot, getItem: () => item });
    const unavailableStatus = await unavailable.status();
    assert.equal(unavailableStatus.ghAvailable, false, "isolated CLI fixture must not discover a host-installed GitHub CLI");
    assert.equal(unavailableStatus.gitAvailable, true, "isolated Git fixture must remain discoverable");
    assert.equal(unavailableStatus.ready, false);
    assert.equal(unavailableStatus.authenticated, false);
    assert.equal(unavailableStatus.tokenStoredByExtension, false);
    assert.equal(fs.existsSync(staleRoot), false, "dead process staging must be cleaned");
    assert.equal(fs.existsSync(liveRoot), true, "live process staging must never be removed");
    assert.equal(fs.existsSync(reusedPidRoot), false, "a live but reused PID with mismatched start identity must not retain stale staging");

    const commonLocal = path.join(root, "common-localappdata");
    const commonGh = path.join(commonLocal, "Programs", "GitHub CLI", "gh.exe");
    fs.mkdirSync(path.dirname(commonGh), { recursive: true });
    fs.writeFileSync(commonGh, "not-a-real-executable");
    process.env.LOCALAPPDATA = commonLocal;
    const commonPathPublisher = createGitHubPublisher({ dataRoot: path.join(root, "common-path"), getItem: () => item });
    const commonPathStatus = await commonPathPublisher.status();
    assert.equal(commonPathStatus.ghAvailable, true, "common GitHub CLI install path must be detected when PATH is stale");
    assert.equal(commonPathStatus.authenticated, false);
  } finally {
    for (const [key, value] of previousCliEnvironment) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

  process.stdout.write("PASS GitHub publisher (fake adapter, staging, preflight, limits, injection and no-network checks)\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
