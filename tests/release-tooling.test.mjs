import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "../build/privacy-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("installer validates and stages before swapping, with data and directory rollback", () => {
  const installer = read("installer/scripts/install.ps1");
  const positions = [
    "$releaseManifest = Assert-OutputItemsReleasePackage $sourceRoot",
    "Copy-VerifiedReleasePackage $releaseManifest $sourceRoot $stageRoot",
    "$dataBackupRoot = New-OutputItemsDataBackup",
    "$transactionStarted = $true",
    "Move-Item -LiteralPath $script:InstallRoot -Destination $installBackupRoot",
    "Move-Item -LiteralPath $stageRoot -Destination $script:InstallRoot",
  ].map((needle) => installer.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(installer, /Restore-OutputItemsDataBackup \$dataBackupRoot/);
  assert.match(installer, /Move-Item -LiteralPath \$installBackupRoot -Destination \$script:InstallRoot/);
  assert.doesNotMatch(installer, /Copy-Item\s+-Path\s+\(Join-Path\s+\$sourceRoot\s+"\*"\)/i);
});

test("release map is explicit, unique and contains the install-critical runtime", () => {
  const definition = JSON.parse(read("build/release-files.json"));
  const targets = definition.files.map((entry) => entry.target.replaceAll("\\", "/").toLowerCase());
  assert.equal(new Set(targets).size, targets.length);
  for (const required of [
    "server.mjs",
    "extension.json",
    "scripts/common.ps1",
    "scripts/install.ps1",
    "scripts/open-explorer-location.ps1",
    "scripts/self-test.mjs",
    "companion/lifecycle-fixture.html",
    "安装产出项扩展.bat",
  ]) assert.ok(targets.includes(required.toLowerCase()), `missing ${required}`);
  for (const entry of definition.files) {
    assert.ok(fs.statSync(path.join(root, entry.source)).isFile(), entry.source);
  }
});

test("privacy scanner rejects account data, UTF-16 paths, unknown UUIDs, production synthetic UUIDs, screenshots and secret literals", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "output-items-public-privacy-"));
  try {
    const privatePath = ["C:", "Users", "Example", "Documents", "private.txt"].join("\\");
    const unknownUuid = ["77777777", "7777", "4777", "8777", "777777777777"].join("-");
    const githubClassic = ["gh", "p_", "A".repeat(36)].join("");
    const githubFineGrained = ["github", "_pat_", "B".repeat(40)].join("");
    const projectSecret = ["sk", "-proj-", "c".repeat(32)].join("");
    const legacySyntheticUuid = ["00000000", "0000", "4000", "8000", "000000000001"].join("-");
    fs.writeFileSync(path.join(fixture, "fixture.txt"), `${privatePath}\n${unknownUuid}\n`, "utf8");
    fs.writeFileSync(path.join(fixture, "fixture-secrets.txt"), `${githubClassic}\n${githubFineGrained}\n${projectSecret}\n`, "utf8");
    const mixedCaseAccount = ["N", "p", "H", "u"].join("");
    const utf16Body = Buffer.from(`${mixedCaseAccount}\n${privatePath}\n${unknownUuid}\n${projectSecret}\n`, "utf16le");
    fs.writeFileSync(path.join(fixture, "fixture-utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), utf16Body]));
    fs.writeFileSync(path.join(fixture, "screenshot-account.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.mkdirSync(path.join(fixture, "extension"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "extension", "server.mjs"), `const sourceThreadId = "${legacySyntheticUuid}";\n`, "utf8");
    const findings = scanTree(fixture);
    const rules = new Set(findings.map((finding) => finding.rule));
    const secretKinds = new Set(findings.filter((finding) => finding.rule === "secret-literal").map((finding) => finding.kind));
    assert.ok(rules.has("personal-account"));
    assert.ok(rules.has("drive-absolute-path"));
    assert.ok(rules.has("non-synthetic-uuid"));
    assert.ok(rules.has("production-synthetic-uuid"));
    assert.ok(rules.has("real-screenshot-file"));
    assert.deepEqual(secretKinds, new Set(["github-classic-token", "github-fine-grained-token", "openai-api-key"]));
    assert.ok(findings.some((finding) => finding.rule === "secret-literal" && finding.file === "fixture-utf16.txt"));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
