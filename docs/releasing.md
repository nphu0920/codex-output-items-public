# Release procedure

## Preconditions

- Work from a clean checkout on Windows.
- Use Windows PowerShell 5.1 and Node.js 24.
- Confirm the root package, web package, extension manifest, server and injection versions are all `1.0.0`.
- Never copy a local installation or `%LOCALAPPDATA%` data into the repository.

## Build

```powershell
npm ci --prefix web
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build\build-release.ps1 -SkipDependencyInstall
```

The build reads `build/release-files.json`, builds the web UI, copies only allowlisted files, includes only assets referenced by the generated HTML, creates an SPDX 2.3 SBOM, scans source and staging content for private identifiers, and generates a deterministic ZIP.

## Mandatory outputs

- `dist/codex-output-items-windows-1.0.0.zip`
- `dist/codex-output-items-windows-1.0.0.zip.sha256`
- `dist/codex-output-items-1.0.0.spdx.json`
- `dist/release-manifest-1.0.0.json`

## Verification

`build/verify-release.ps1` verifies the external SHA-256, extracts to a fresh random temporary directory, rejects unexpected files and reparse points, validates every internal file hash, checks UI asset references, reruns the privacy scanner and executes all isolated self-tests. It never installs the extension, registers MCP, starts a real Codex window or connects to GitHub.

Before publishing, also perform a manual clean-VM test with the supported Microsoft Store Codex version:

1. Download and verify the final ZIP as an end user would.
2. Extract it completely and double-click the installer.
3. Complete first-run login in the isolated companion profile.
4. Verify history scanning, task opening, preview, stop, disable, re-enable and uninstall.
5. Confirm normal Codex windows and real output files were not changed.

Do not publish GitHub's automatically generated source archive as the installer. Only attach the four verified artifacts above to a tagged release.
