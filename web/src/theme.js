export const OUTPUT_ITEMS_THEME_MESSAGE = "output-items:theme";
export const OUTPUT_ITEMS_THEME_MESSAGE_VERSION = 1;
export const OUTPUT_ITEMS_THEME_QUERY = "outputItemsTheme";

const RESOLVED_THEMES = new Set(["light", "dark"]);

export function normalizeResolvedTheme(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return RESOLVED_THEMES.has(normalized) ? normalized : null;
}

export function normalizeThemeMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "system" || normalized === "auto"
    ? "system"
    : normalizeResolvedTheme(normalized);
}

function systemTheme(windowObject) {
  try {
    const query = windowObject?.matchMedia?.("(prefers-color-scheme: dark)");
    return query ? (query.matches ? "dark" : "light") : "dark";
  } catch (_) {
    return "dark";
  }
}

export function resolveThemeMode(mode, windowObject = globalThis.window) {
  const normalized = normalizeThemeMode(mode);
  return normalized && normalized !== "system" ? normalized : systemTheme(windowObject);
}

export function standaloneThemeOverride(windowObject = globalThis.window) {
  if (
    !windowObject
    || windowObject.parent !== windowObject
    || windowObject.openai
    || windowObject.__CODEX_OUTPUT_ITEMS_COMPANION__ === true
  ) return null;
  try {
    return normalizeResolvedTheme(
      new URLSearchParams(windowObject.location?.search || "").get(OUTPUT_ITEMS_THEME_QUERY),
    );
  } catch (_) {
    return null;
  }
}

export function applyResolvedTheme(theme, documentObject = globalThis.document) {
  const normalized = normalizeResolvedTheme(theme);
  const root = documentObject?.documentElement;
  if (!normalized || !root) return null;
  root.dataset.theme = normalized;
  root.style.colorScheme = normalized;
  return normalized;
}

export function initialThemeState({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
} = {}) {
  const openAITheme = normalizeThemeMode(windowObject?.openai?.theme);
  if (openAITheme) {
    return {
      mode: openAITheme,
      resolvedTheme: resolveThemeMode(openAITheme, windowObject),
      source: "openai",
    };
  }

  const prepaintTheme = normalizeResolvedTheme(documentObject?.documentElement?.dataset?.theme);
  if (windowObject?.__CODEX_OUTPUT_ITEMS_COMPANION__ === true && prepaintTheme) {
    return { mode: prepaintTheme, resolvedTheme: prepaintTheme, source: "companion" };
  }

  const queryTheme = standaloneThemeOverride(windowObject);
  if (queryTheme) {
    return { mode: queryTheme, resolvedTheme: queryTheme, source: "query" };
  }

  return {
    mode: "system",
    resolvedTheme: prepaintTheme || systemTheme(windowObject),
    source: "system",
  };
}

export function installThemeSync({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
} = {}) {
  if (!windowObject || !documentObject?.documentElement) return () => {};

  const initial = initialThemeState({ windowObject, documentObject });
  let source = initial.source;
  applyResolvedTheme(initial.resolvedTheme, documentObject);

  const mediaQuery = windowObject.matchMedia?.("(prefers-color-scheme: dark)") || null;
  const onSystemThemeChange = () => {
    if (source === "system") applyResolvedTheme(systemTheme(windowObject), documentObject);
  };
  const onOpenAIGlobals = (event) => {
    const mode = normalizeThemeMode(event?.detail?.globals?.theme);
    if (!mode) return;
    source = "openai";
    applyResolvedTheme(resolveThemeMode(mode, windowObject), documentObject);
  };
  const onCompanionMessage = (event) => {
    if (
      windowObject.__CODEX_OUTPUT_ITEMS_COMPANION__ !== true
      || windowObject.parent === windowObject
      || event?.source !== windowObject.parent
    ) return;
    const message = event.data;
    if (
      !message
      || typeof message !== "object"
      || message.type !== OUTPUT_ITEMS_THEME_MESSAGE
      || message.version !== OUTPUT_ITEMS_THEME_MESSAGE_VERSION
    ) return;
    const mode = normalizeThemeMode(message.mode);
    const resolvedTheme = normalizeResolvedTheme(message.resolvedTheme);
    if (!mode || !resolvedTheme) return;
    source = "companion";
    applyResolvedTheme(resolvedTheme, documentObject);
  };

  windowObject.addEventListener?.("openai:set_globals", onOpenAIGlobals);
  windowObject.addEventListener?.("message", onCompanionMessage);
  if (typeof mediaQuery?.addEventListener === "function") {
    mediaQuery.addEventListener("change", onSystemThemeChange);
  } else {
    mediaQuery?.addListener?.(onSystemThemeChange);
  }

  return () => {
    windowObject.removeEventListener?.("openai:set_globals", onOpenAIGlobals);
    windowObject.removeEventListener?.("message", onCompanionMessage);
    if (typeof mediaQuery?.removeEventListener === "function") {
      mediaQuery.removeEventListener("change", onSystemThemeChange);
    } else {
      mediaQuery?.removeListener?.(onSystemThemeChange);
    }
  };
}
