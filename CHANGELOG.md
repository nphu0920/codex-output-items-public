# Changelog

All notable changes are documented here. The project follows semantic versioning.

## 1.0.0 - 2026-08-17

- First public Windows release.
- Added historical and incremental Codex output discovery with task grouping.
- Bound self-registration only to a valid runtime task ID, with an explicit `local-install` fallback instead of a synthetic task.
- Added reliable persisted output sizes and hierarchical file lists.
- Kept deleted outputs below active outputs within a task; fully deleted task groups stay hidden.
- Added safe local previews, explicit Recycle Bin deletion, manual status and priority controls.
- Added optional GitHub publishing through the user's authenticated GitHub CLI.
- Added an isolated Codex companion window without modifying Codex installation files.
- Added a manifest-verified, staged installer with data backup and rollback.
- Added reproducible ZIP creation, SHA-256 checksums, SPDX SBOM, privacy scanning and clean-extract verification.
