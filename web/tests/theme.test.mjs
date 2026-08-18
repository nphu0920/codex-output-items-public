import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyResolvedTheme,
  initialThemeState,
  installThemeSync,
  normalizeResolvedTheme,
  normalizeThemeMode,
  OUTPUT_ITEMS_THEME_MESSAGE,
  OUTPUT_ITEMS_THEME_MESSAGE_VERSION,
  standaloneThemeOverride,
} from "../src/theme.js";

function fakeEnvironment({ theme = null, companion = false, embedded = false, query = "", systemDark = false } = {}) {
  const listeners = new Map();
  const mediaListeners = new Set();
  const parent = {};
  const mediaQuery = {
    matches: systemDark,
    addEventListener(type, listener) {
      if (type === "change") mediaListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "change") mediaListeners.delete(listener);
    },
  };
  const windowObject = {
    openai: theme ? { theme } : undefined,
    __CODEX_OUTPUT_ITEMS_COMPANION__: companion,
    location: { search: query },
    matchMedia: () => mediaQuery,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      listeners.get(type)?.forEach((listener) => listener(event));
    },
  };
  windowObject.parent = companion || embedded ? parent : windowObject;
  const documentObject = {
    documentElement: { dataset: {}, style: {} },
  };
  return {
    windowObject,
    documentObject,
    parent,
    setSystemDark(value) {
      mediaQuery.matches = value;
      mediaListeners.forEach((listener) => listener({ matches: value }));
    },
  };
}

test("normalizes only supported theme values", () => {
  assert.equal(normalizeResolvedTheme(" LIGHT "), "light");
  assert.equal(normalizeThemeMode("auto"), "system");
  assert.equal(normalizeResolvedTheme("sepia"), null);
  assert.equal(normalizeThemeMode(null), null);
});

test("MCP initial and openai:set_globals themes take precedence", () => {
  const environment = fakeEnvironment({ theme: "dark", systemDark: false });
  environment.documentObject.documentElement.dataset.theme = "light";
  assert.deepEqual(initialThemeState(environment), {
    mode: "dark",
    resolvedTheme: "dark",
    source: "openai",
  });

  const dispose = installThemeSync(environment);
  assert.equal(environment.documentObject.documentElement.dataset.theme, "dark");
  environment.windowObject.dispatch("openai:set_globals", {
    detail: { globals: { theme: "light" } },
  });
  assert.equal(environment.documentObject.documentElement.dataset.theme, "light");
  assert.equal(environment.documentObject.documentElement.style.colorScheme, "light");
  dispose();
});

test("companion accepts only the versioned message from its parent", () => {
  const environment = fakeEnvironment({ companion: true, systemDark: false });
  environment.documentObject.documentElement.dataset.theme = "dark";
  installThemeSync(environment);

  const message = {
    type: OUTPUT_ITEMS_THEME_MESSAGE,
    version: OUTPUT_ITEMS_THEME_MESSAGE_VERSION,
    mode: "light",
    resolvedTheme: "light",
  };
  environment.windowObject.dispatch("message", { source: {}, data: message });
  assert.equal(environment.documentObject.documentElement.dataset.theme, "dark");
  environment.windowObject.dispatch("message", { source: environment.parent, data: message });
  assert.equal(environment.documentObject.documentElement.dataset.theme, "light");
});

test("standalone follows prefers-color-scheme changes", () => {
  const environment = fakeEnvironment({ systemDark: true });
  const dispose = installThemeSync(environment);
  assert.equal(environment.documentObject.documentElement.dataset.theme, "dark");
  environment.setSystemDark(false);
  assert.equal(environment.documentObject.documentElement.dataset.theme, "light");
  dispose();
  environment.setSystemDark(true);
  assert.equal(environment.documentObject.documentElement.dataset.theme, "light");
});

test("standalone QA query overrides the system but is ignored by hosted contexts", () => {
  const standalone = fakeEnvironment({ query: "?outputItemsTheme=light", systemDark: true });
  assert.equal(standaloneThemeOverride(standalone.windowObject), "light");
  installThemeSync(standalone);
  assert.equal(standalone.documentObject.documentElement.dataset.theme, "light");
  standalone.setSystemDark(false);
  standalone.setSystemDark(true);
  assert.equal(standalone.documentObject.documentElement.dataset.theme, "light");

  const mcp = fakeEnvironment({ theme: "dark", query: "?outputItemsTheme=light" });
  assert.equal(standaloneThemeOverride(mcp.windowObject), null);
  assert.equal(initialThemeState(mcp).resolvedTheme, "dark");

  const companion = fakeEnvironment({ companion: true, query: "?outputItemsTheme=light" });
  companion.documentObject.documentElement.dataset.theme = "dark";
  assert.equal(standaloneThemeOverride(companion.windowObject), null);
  assert.equal(initialThemeState(companion).resolvedTheme, "dark");

  const embeddedWithoutGlobals = fakeEnvironment({ embedded: true, query: "?outputItemsTheme=light", systemDark: true });
  assert.equal(standaloneThemeOverride(embeddedWithoutGlobals.windowObject), null);
  assert.equal(initialThemeState(embeddedWithoutGlobals).resolvedTheme, "dark");
});

test("prepaint runs before the module and CSS exposes both resolved themes", async () => {
  const [indexHtml, styles] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.ok(indexHtml.indexOf("root.dataset.theme = theme") < indexHtml.indexOf('src="/src/main.jsx"'));
  assert.match(indexHtml, /outputItemsTheme/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /:root\[data-theme="light"\]/);
  assert.match(styles, /--app-bg:/);
  const darkBlock = styles.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const lightBlock = styles.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const tokenNames = (block) => [...block.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]);
  assert.ok(tokenNames(darkBlock).length > 350, "the complete color palette should be tokenized");
  assert.deepEqual(tokenNames(lightBlock), tokenNames(darkBlock));
  const componentRules = styles.slice(styles.indexOf("\n* {"));
  assert.doesNotMatch(componentRules, /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i);
});

test("applyResolvedTheme rejects invalid values", () => {
  const environment = fakeEnvironment();
  assert.equal(applyResolvedTheme("sepia", environment.documentObject), null);
  assert.deepEqual(environment.documentObject.documentElement.dataset, {});
});
