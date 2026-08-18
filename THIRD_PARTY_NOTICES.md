# Third-party notices

The distributed web bundle contains the following MIT-licensed software:

- React and React DOM 19.2.0 — Copyright Meta Platforms, Inc. and affiliates.
- Scheduler 0.27.0 — part of the React distribution.
- Phosphor Icons for React 2.1.10 — Copyright 2020 Phosphor Icons.

The development toolchain uses Vite 6.4.2 and `@vitejs/plugin-react` 5.0.4 under the MIT License, together with their locked transitive build dependencies. Exact package versions and declared licenses are recorded in `SBOM.spdx.json` in every Release package.

The companion architecture was informed by the independent Codex profile, private Chrome DevTools Protocol pipe and runtime sidebar-injection approach in [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard), distributed under the Apache License 2.0. This implementation was rewritten for the local output-items service and control protocol.

The full MIT License for this project and the above MIT components is included in `LICENSE`. Upstream copyright notices remain in generated JavaScript where supplied by the build toolchain.
