#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.resolve(process.argv[2] || path.join(root, "dist", "SBOM.spdx.json"));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockText = fs.readFileSync(path.join(root, "web", "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);
const digest = crypto.createHash("sha256").update(lockText).digest("hex").slice(0, 24);

function spdxId(name, version, location = "") {
  const suffix = location ? `-${crypto.createHash("sha256").update(location).digest("hex").slice(0, 12)}` : "";
  return `SPDXRef-Package-${`${name}-${version}`.replace(/[^A-Za-z0-9.-]+/g, "-")}${suffix}`;
}

const packages = [{
  SPDXID: spdxId(rootPackage.name, rootPackage.version),
  name: rootPackage.name,
  versionInfo: rootPackage.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: rootPackage.license || "NOASSERTION",
  licenseDeclared: rootPackage.license || "NOASSERTION",
}];

for (const [location, metadata] of Object.entries(lock.packages || {})) {
  if (!location || !location.startsWith("node_modules/") || !metadata.version) continue;
  const name = location.slice("node_modules/".length);
  packages.push({
    SPDXID: spdxId(name, metadata.version, location),
    name,
    versionInfo: metadata.version,
    downloadLocation: typeof metadata.resolved === "string" && /^https:\/\//.test(metadata.resolved) ? metadata.resolved : "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: typeof metadata.license === "string" ? metadata.license : "NOASSERTION",
  });
}
packages.sort((a, b) => a.SPDXID.localeCompare(b.SPDXID));

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${rootPackage.name}-${rootPackage.version}`,
  documentNamespace: `https://spdx.org/spdxdocs/${rootPackage.name}-${rootPackage.version}-${digest}`,
  creationInfo: {
    created: "1980-01-01T00:00:00Z",
    creators: ["Tool: codex-output-items-build"],
  },
  packages,
  relationships: [{
    spdxElementId: "SPDXRef-DOCUMENT",
    relationshipType: "DESCRIBES",
    relatedSpdxElement: spdxId(rootPackage.name, rootPackage.version),
  }],
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
process.stdout.write(`SBOM_WRITTEN ${outputPath}\n`);
