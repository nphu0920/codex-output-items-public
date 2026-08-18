import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
let appModulePromise;

function loadAppModule() {
  if (!appModulePromise) {
    appModulePromise = build({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      ssr: { noExternal: true },
      build: {
        ssr: path.join(projectRoot, "src", "App.jsx"),
        target: "node20",
        write: false,
        rollupOptions: { output: { format: "es" } }
      }
    }).then(async (result) => {
      const output = Array.isArray(result) ? result[0] : result;
      const chunk = output.output.find((entry) => entry.type === "chunk");
      assert.ok(chunk, "Vite must produce an SSR JavaScript chunk for App.jsx");
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;
      return import(moduleUrl);
    });
  }
  return appModulePromise;
}

function output({ id, groupKey = "group-a", priority = "normal", updatedAt, status = "正常", category = "程序" }) {
  return {
    id,
    title: id,
    type: "程序文件夹",
    meta: "2 个文件",
    version: "v1",
    priority,
    updatedAt,
    time: updatedAt,
    status,
    category,
    taskGroup: {
      key: groupKey,
      rootThreadId: groupKey,
      title: groupKey,
      project: "测试项目"
    },
    source: { project: "测试项目", task: groupKey, threadId: groupKey }
  };
}

test("deleted outputs stay below active outputs while each bucket keeps priority and time ordering", async () => {
  const { buildTaskGroups } = await loadAppModule();
  const groups = buildTaskGroups([
    output({ id: "active-low-newer", priority: "low", updatedAt: "2026-08-12T10:00:00Z" }),
    output({ id: "deleted-high-newest", priority: "high", updatedAt: "2026-08-17T10:00:00Z", status: "已删除" }),
    output({ id: "active-high-older", priority: "high", updatedAt: "2026-08-10T10:00:00Z" }),
    output({ id: "deleted-high-older", priority: "high", updatedAt: "2026-08-15T10:00:00Z", status: "已删除" }),
    output({ id: "deleted-low-latest", priority: "low", updatedAt: "2026-08-18T10:00:00Z", status: "已删除" })
  ], "", "全部类型");

  assert.deepEqual(groups[0].items.map((item) => item.id), [
    "active-high-older",
    "active-low-newer",
    "deleted-high-newest",
    "deleted-high-older",
    "deleted-low-latest"
  ]);
  assert.equal(groups[0].highestPriority, 3);
  assert.equal(groups[0].latestTimestamp, Date.parse("2026-08-12T10:00:00Z"));
});

test("deleted timestamps and priorities do not float a task group with active outputs", async () => {
  const { buildTaskGroups } = await loadAppModule();
  const groups = buildTaskGroups([
    output({ id: "stale-active", groupKey: "stale", updatedAt: "2026-08-10T10:00:00Z" }),
    output({ id: "stale-deleted", groupKey: "stale", priority: "critical", updatedAt: "2026-08-17T10:00:00Z", status: "已删除" }),
    output({ id: "recent-active", groupKey: "recent", updatedAt: "2026-08-11T10:00:00Z" })
  ], "", "全部类型");

  assert.deepEqual(groups.map((group) => group.key), ["recent", "stale"]);
  assert.equal(groups[1].highestPriority, 2);
  assert.equal(groups[1].latestTimestamp, Date.parse("2026-08-10T10:00:00Z"));
});

test("an all-deleted task group stays hidden until an active output appears", async () => {
  const { buildTaskGroups } = await loadAppModule();
  const deletedItems = [
    output({ id: "deleted-high-older", priority: "high", updatedAt: "2026-08-15T10:00:00Z", status: "已删除" }),
    output({ id: "deleted-normal-newer", updatedAt: "2026-08-18T10:00:00Z", status: "已删除" })
  ];

  assert.deepEqual(buildTaskGroups(deletedItems, "", "全部类型"), []);
  assert.deepEqual(buildTaskGroups(deletedItems, "deleted", "全部类型"), []);
  assert.deepEqual(buildTaskGroups(deletedItems, "", "程序"), []);

  const [restoredGroup] = buildTaskGroups([
    ...deletedItems,
    output({ id: "restored-active", priority: "low", updatedAt: "2026-08-14T10:00:00Z" })
  ], "", "全部类型");
  assert.deepEqual(restoredGroup.items.map((item) => item.id), ["restored-active", "deleted-high-older", "deleted-normal-newer"]);
  assert.equal(restoredGroup.highestPriority, 1);
  assert.equal(restoredGroup.latestTimestamp, Date.parse("2026-08-14T10:00:00Z"));
});

test("a mixed task group remains visible when search or type filters match only deleted items", async () => {
  const { buildTaskGroups } = await loadAppModule();
  const items = [
    output({ id: "active-program", updatedAt: "2026-08-14T10:00:00Z" }),
    output({ id: "deleted-slide-match", category: "演示", updatedAt: "2026-08-17T10:00:00Z", status: "已删除" })
  ];

  const [searchGroup] = buildTaskGroups(items, "deleted-slide-match", "全部类型");
  assert.deepEqual(searchGroup.visibleItems.map((item) => item.id), ["deleted-slide-match"]);

  const [typeGroup] = buildTaskGroups(items, "", "演示");
  assert.deepEqual(typeGroup.visibleItems.map((item) => item.id), ["deleted-slide-match"]);
});

test("output metadata inserts reliable total size between file count and version", async () => {
  const { outputMetadataText } = await loadAppModule();

  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "52 个文件", sizeBytes: 1536, sizeAggregationComplete: true, version: "v0.9.1" }), "程序文件夹 · 52 个文件 · 1.5 KB · v0.9.1");
  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "52 个文件", sizeBytes: 0, sizeAggregationComplete: true, version: "v0.9.1" }), "程序文件夹 · 52 个文件 · 0 B · v0.9.1");
  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "52 个文件", sizeBytes: 1536, sizeAggregationComplete: false, version: "v0.9.1" }), "程序文件夹 · 52 个文件 · 大小未知 · v0.9.1");
  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "52 个文件", sizeAggregationComplete: true, version: "v0.9.1" }), "程序文件夹 · 52 个文件 · 大小未知 · v0.9.1");
});

test("deleted output metadata omits the size segment", async () => {
  const { outputMetadataText } = await loadAppModule();

  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "路径缺失", sizeBytes: 1536, sizeAggregationComplete: true, status: "已删除", version: "v0.9.1" }), "程序文件夹 · 路径缺失 · v0.9.1");
  assert.equal(outputMetadataText({ type: "程序文件夹", meta: "路径缺失", sizeAggregationComplete: false, status: "已删除", version: "v0.9.1" }), "程序文件夹 · 路径缺失 · v0.9.1");
});

test("file tree keeps folders before files at every level without reordering either bucket", async () => {
  const { buildFileTree } = await loadAppModule();
  const files = [
    { name: "root-first.txt", relativePath: "root-first.txt", kind: "text" },
    { name: "z-last.txt", relativePath: "docs/z-last.txt", kind: "text" },
    { name: "root-second.txt", relativePath: "root-second.txt", kind: "text" },
    { name: "deep.txt", relativePath: "docs/nested/deep.txt", kind: "text" },
    { name: "a-later.txt", relativePath: "docs/a-later.txt", kind: "text" },
    { name: "logo.png", relativePath: "assets/logo.png", kind: "image" },
    { name: "empty", relativePath: "empty", kind: "folder" },
  ];

  const tree = buildFileTree(files);
  assert.deepEqual(tree.map((node) => node.path), [
    "docs",
    "assets",
    "empty",
    "root-first.txt",
    "root-second.txt",
  ]);
  assert.deepEqual(tree[0].children.map((node) => node.path), [
    "docs/nested",
    "docs/z-last.txt",
    "docs/a-later.txt",
  ]);
  assert.deepEqual(tree[0].children[0].children.map((node) => node.path), ["docs/nested/deep.txt"]);
  assert.equal(tree[2].record, files[6]);
  assert.equal(tree[3].record, files[0]);
  assert.equal(tree[0].children[1].record, files[1]);
});

test("GitHub upload gate moves from preflight to explicit confirmation before upload", async () => {
  const { deriveGithubUploadGate } = await loadAppModule();
  const account = { contextPhase: "ready", cliReady: true, accountReady: true };

  const idle = deriveGithubUploadGate({ ...account, preflight: { state: "idle", id: "", blockers: [] }, confirmed: false });
  assert.deepEqual({ action: idle.action, label: idle.label, disabled: idle.disabled }, { action: "preflight", label: "执行上传前检查", disabled: false });

  const checked = deriveGithubUploadGate({ ...account, preflight: { state: "passed", id: "pf-1", blockers: [] }, confirmed: false });
  assert.deepEqual({ action: checked.action, label: checked.label, disabled: checked.disabled }, { action: "upload", label: "开始上传", disabled: true });
  assert.match(checked.message, /勾选/);

  const ready = deriveGithubUploadGate({ ...account, preflight: { state: "passed", id: "pf-1", blockers: [] }, confirmed: true });
  assert.deepEqual({ action: ready.action, label: ready.label, disabled: ready.disabled }, { action: "upload", label: "开始上传", disabled: false });
});

test("GitHub upload gate retries error and blocked preflights without enabling upload", async () => {
  const { deriveGithubUploadGate, formatGithubPreflightFailure } = await loadAppModule();
  const account = { contextPhase: "ready", cliReady: true, accountReady: true };
  const unsafeMessage = "产出项源路径与扩展、Codex、系统或程序保护目录重叠";

  assert.equal(formatGithubPreflightFailure(unsafeMessage), "安装/保护目录不可直接上传，请选择普通工作目录中的正式发行项 codex-output-items-public。");

  const failed = deriveGithubUploadGate({ ...account, preflight: { state: "error", id: "", message: unsafeMessage, blockers: [] }, confirmed: true });
  assert.deepEqual({ action: failed.action, label: failed.label, disabled: failed.disabled }, { action: "preflight", label: "重新执行检查", disabled: false });
  assert.match(failed.message, /codex-output-items-public/);

  const blocked = deriveGithubUploadGate({ ...account, preflight: { state: "blocked", id: "pf-blocked", blockers: [{ code: "SECRET_DETECTED" }] }, confirmed: true });
  assert.deepEqual({ action: blocked.action, label: blocked.label, disabled: blocked.disabled }, { action: "preflight", label: "重新执行检查", disabled: false });
});

test("GitHub upload gate requires login when CLI exists but authentication is invalid", async () => {
  const { deriveGithubCliAccountAction, deriveGithubUploadGate } = await loadAppModule();
  const needsLogin = deriveGithubUploadGate({
    contextPhase: "ready",
    cliReady: true,
    accountReady: false,
    preflight: { state: "passed", id: "stale-preflight", blockers: [] },
    confirmed: true
  });

  assert.deepEqual({ phase: needsLogin.phase, action: needsLogin.action, disabled: needsLogin.disabled }, { phase: "needs-login", action: "preflight", disabled: true });
  assert.match(needsLogin.message, /凭据.*失效|登录/);

  const accountAction = deriveGithubCliAccountAction({ loginCommand: "gh auth login --hostname github.com --web" }, false);
  assert.deepEqual(accountAction, { label: "复制登录命令", copyLabel: "GitHub 登录命令", command: "gh auth login --hostname github.com --web" });
  assert.equal(deriveGithubCliAccountAction({}, true).label, "切换说明");
});
