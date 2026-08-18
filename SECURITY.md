# Security policy

## Supported versions

Only the latest 1.x release receives security fixes.

## Reporting a vulnerability

Use the repository's private **Security → Report a vulnerability** workflow. Do not include tokens, private Codex task data, local paths or proof-of-concept secrets in a public issue.

Include the affected version, Windows and Codex versions, reproduction steps, expected impact and whether the issue requires local user interaction. Maintainers should acknowledge a complete report within seven days.

## Security boundaries

- The scanner reads Codex's local task databases, session logs and managed output directories; it must not modify them.
- Indexes, logs, the isolated companion profile and temporary GitHub staging data stay under `%LOCALAPPDATA%\CodexOutputItems`.
- Destructive file actions require explicit confirmation and use the Windows Recycle Bin.
- GitHub writes require the user's separately installed and authenticated `gh` CLI plus a matching preflight confirmation.
- The companion uses a private Chromium debugging pipe and an isolated profile. It does not patch Codex files, but it depends on private Codex DOM and storage formats that may change.

Verify Release ZIPs with the accompanying SHA-256 file before installation.
