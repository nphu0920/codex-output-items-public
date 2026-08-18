# Contributing

1. Use Windows 11, Windows PowerShell 5.1 and Node.js 24 for the full validation path.
2. Run `npm ci --prefix web` once, then `npm run check`, `npm run test:web` and `npm run build:release`.
3. Do not commit user names, user-profile paths, real Codex task IDs, session data, logs, profiles, tokens or screenshots made from a real account.
4. Use synthetic UUID fixtures and synthetic UI data in tests and documentation.
5. Do not edit generated files under `web/dist` or `dist`; change `web/src` or runtime sources and rebuild.
6. Keep the extension version aligned across the root package, web package, extension manifest, server metadata and companion injection script.

Pull requests should describe security-boundary changes, compatibility assumptions and the exact verification commands that passed.
