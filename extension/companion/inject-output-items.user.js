(() => {
  "use strict";

  const VERSION = "1.0.0";
  const SENTINEL = "__codexOutputItemsInjection__";
  const ENTRY_ID = "codex-output-items-entry";
  const PAGE_ID = "codex-output-items-page";
  const FRAME_ID = "codex-output-items-frame";
  const STYLE_ID = "codex-output-items-style";
  const OWNED = "data-codex-output-items-owned";
  const HIDDEN = "data-codex-output-items-native-hidden";
  const HEADER_HIDDEN = "data-codex-output-items-native-header-hidden";
  const HOST = "data-codex-output-items-page-host";
  const NATIVE_SELECTED = "data-codex-output-items-native-selected";
  const THEME_MESSAGE = "output-items:theme";
  const THEME_MESSAGE_VERSION = 1;
  const HEADER_CONTEXT_SELECTOR = [
    '[data-testid="app-shell-header-context-menu-surface"]',
    '[data-test-id="app-shell-header-context-menu-surface"]',
  ].join(",");
  const HEADER_SLOT_SELECTOR = [
    '[data-testid="header-shell-slot"]',
    '[data-test-id="header-shell-slot"]',
  ].join(",");
  const HOST_INTERACTIVE_SELECTOR = [
    "button",
    "a",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='tab']",
    "[data-app-action-sidebar-thread-id]",
    "[data-app-action-sidebar-project-row]",
  ].join(",");
  const PLUGIN_LABELS = new Set(["插件", "plugins"]);
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const configuredUrl = String(window.__CODEX_OUTPUT_ITEMS_UI_URL__ || "").trim();

  if (!configuredUrl) return;

  let uiUrl;
  try {
    uiUrl = new URL(configuredUrl);
  } catch (_) {
    return;
  }

  const previous = window[SENTINEL];
  if (previous && typeof previous.destroy === "function") {
    try {
      previous.destroy();
    } catch (_) {}
  }

  let entry = null;
  let entryLabel = null;
  let page = null;
  let frame = null;
  let observer = null;
  let refreshTimer = null;
  let active = false;
  let destroyed = false;
  let lastFocusedElement = null;
  let frameName = "";
  let activeSurface = null;
  let activeRouteKey = "";
  let lastThemeSignature = "";
  const themeMediaQuery = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const mutedSelections = new Map();
  const hiddenNativeNodes = new Set();
  const hiddenHeaderNodes = new Set();
  const hostSurfaceNodes = new Set();

  function normalizedLabel(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function normalizeThemeMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "dark" || normalized === "light") return normalized;
    if (normalized === "system" || normalized === "auto") return "system";
    return null;
  }

  function explicitThemeMode() {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      for (const attribute of ["data-theme", "data-color-theme"]) {
        const mode = normalizeThemeMode(node.getAttribute(attribute));
        if (mode) return mode;
      }
      const classMatch = String(node.className || "").match(
        /(?:^|\s)(?:theme[-_:])?(dark|light)(?:-mode)?(?:\s|$)/i,
      );
      if (classMatch) return classMatch[1].toLowerCase();
    }
    return null;
  }

  function themeFromColorScheme() {
    try {
      const tokens = String(window.getComputedStyle(document.documentElement).colorScheme || "")
        .toLowerCase()
        .match(/\b(?:dark|light)\b/g);
      const unique = [...new Set(tokens || [])];
      return unique.length === 1 ? unique[0] : null;
    } catch (_) {
      return null;
    }
  }

  function themeFromHostBackground() {
    const candidates = [
      document.querySelector("[data-app-shell-main-content-layout]"),
      document.querySelector("main"),
      document.body,
      document.documentElement,
    ];
    for (const node of candidates) {
      if (!node) continue;
      try {
        const match = String(window.getComputedStyle(node).backgroundColor || "")
          .match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/i);
        if (!match || (match[4] !== undefined && Number(match[4]) <= 0.05)) continue;
        const channels = match.slice(1, 4).map((channel) => {
          const value = Math.max(0, Math.min(255, Number(channel))) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        return luminance < 0.32 ? "dark" : "light";
      } catch (_) {}
    }
    return null;
  }

  function themeSnapshot() {
    const mode = explicitThemeMode() || "system";
    const resolvedTheme = mode === "dark" || mode === "light"
      ? mode
      : themeFromColorScheme()
        || themeFromHostBackground()
        || (themeMediaQuery?.matches ? "dark" : "light");
    return { mode, resolvedTheme };
  }

  function syncFrameTheme(force = false) {
    const snapshot = themeSnapshot();
    const signature = `${snapshot.mode}:${snapshot.resolvedTheme}`;
    if (!frame?.contentWindow || (!force && signature === lastThemeSignature)) return snapshot;
    try {
      frame.contentWindow.postMessage({
        type: THEME_MESSAGE,
        version: THEME_MESSAGE_VERSION,
        ...snapshot,
      }, "*");
      lastThemeSignature = signature;
    } catch (_) {}
    return snapshot;
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
        color: var(--color-token-foreground, inherit);
      }
      #${ENTRY_ID}:focus-visible {
        outline: 2px solid var(--color-token-focus-ring, currentColor);
        outline-offset: -2px;
      }
      html[data-codex-output-items-open="true"] [${HIDDEN}="true"],
      html[data-codex-output-items-open="true"] [${HEADER_HIDDEN}="true"] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      #${PAGE_ID} {
        position: absolute;
        inset: 0;
        z-index: 3;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: var(--color-token-main-surface-primary, Canvas);
        color: var(--color-token-foreground, CanvasText);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      #${PAGE_ID}[hidden] {
        display: none !important;
      }
      #${FRAME_ID} {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
        background: var(--color-token-main-surface-primary, Canvas);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buttonMatches(button) {
    if (!button) return false;
    return PLUGIN_LABELS.has(normalizedLabel(button.textContent || button.getAttribute("aria-label")));
  }

  function findPluginButton() {
    const scope = document.querySelector("[data-app-action-sidebar-scroll]")
      || document.querySelector('aside nav[role="navigation"]');
    if (!scope) return null;
    return Array.from(scope.querySelectorAll("button")).find(buttonMatches) || null;
  }

  function replaceEntryIcon(button) {
    const icon = button.querySelector("svg");
    if (!icon) return;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.innerHTML = [
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4l1.5 2h7.5A1.5 1.5 0 0 1 20 7.5v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"></path>',
      '<path d="M8 11h8M8 14h6"></path>',
    ].join("");
  }

  function syncEntryText() {
    if (!entry) return;
    if (entry.getAttribute("aria-label") !== "打开产出项") entry.setAttribute("aria-label", "打开产出项");
    if (entry.getAttribute("title") !== "产出项") entry.setAttribute("title", "产出项");
    if (entryLabel && entryLabel.textContent !== "产出项") entryLabel.textContent = "产出项";
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.removeAttribute("disabled");
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("data-state");
    button.setAttribute(OWNED, "true");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    entryLabel = button.querySelector(".text-fade-truncate")
      || Array.from(button.querySelectorAll("span")).find(buttonMatches)
      || null;
    syncEntryText();
    replaceEntryIcon(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openOutputItems();
    });
    return button;
  }

  function syncEntryState() {
    if (!entry) return;
    if (active && entry.getAttribute("aria-current") !== "page") entry.setAttribute("aria-current", "page");
    else if (!active && entry.hasAttribute("aria-current")) entry.removeAttribute("aria-current");
  }

  function ensureEntry() {
    if (destroyed || !document.body) return false;
    installStyles();
    const reference = findPluginButton();
    if (!reference?.parentElement) return false;
    if (!entry) entry = createEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    syncEntryText();
    syncEntryState();
    return true;
  }

  function findPageMount() {
    const frameHost = document.querySelector(".app-shell-main-content-frame");
    const layout = frameHost?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = layout?.parentElement;
    if (surface?.closest?.("main")) return surface;
    const main = document.querySelector("main");
    return main || null;
  }

  function currentRouteKey() {
    return `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
  }

  function createPage() {
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", "产出项");

    const nextFrame = document.createElement("iframe");
    nextFrame.id = FRAME_ID;
    nextFrame.title = "产出项";
    frameName = `codex-output-items-${typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    nextFrame.name = frameName;
    nextFrame.src = "about:blank";
    nextFrame.referrerPolicy = "no-referrer";
    nextFrame.setAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-modals allow-downloads",
    );
    nextFrame.setAttribute("allow", "clipboard-read; clipboard-write");
    nextFrame.addEventListener("load", () => {
      try {
        nextFrame.contentWindow?.postMessage(
          { type: "output-items:host-ready", host: "codex-companion" },
          "*",
        );
      } catch (_) {}
      syncFrameTheme(true);
    });
    frame = nextFrame;
    section.appendChild(nextFrame);
    return section;
  }

  function muteNativeSelection() {
    if (!active) return;
    document.querySelectorAll('aside nav[role="navigation"] [aria-current]')
      .forEach((node) => {
        if (node === entry || node.closest(`#${ENTRY_ID}`)) return;
        if (!mutedSelections.has(node)) {
          mutedSelections.set(node, node.getAttribute("aria-current"));
        }
        node.removeAttribute("aria-current");
        node.setAttribute(NATIVE_SELECTED, "true");
      });
  }

  function restoreNativeSelection() {
    mutedSelections.forEach((value, node) => {
      if (value === null) node.removeAttribute("aria-current");
      else node.setAttribute("aria-current", value);
      node.removeAttribute(NATIVE_SELECTED);
    });
    mutedSelections.clear();
    document.querySelectorAll(`[${NATIVE_SELECTED}="true"]`)
      .forEach((node) => node.removeAttribute(NATIVE_SELECTED));
  }

  function directChildWithin(node, ancestor) {
    let current = node;
    while (current?.parentElement && current.parentElement !== ancestor) {
      current = current.parentElement;
    }
    return current?.parentElement === ancestor ? current : null;
  }

  function markNode(node, attribute, registry) {
    if (!node) return;
    node.setAttribute(attribute, "true");
    registry.add(node);
  }

  function hideNativeHeaderChrome() {
    document.querySelectorAll("[data-app-shell-application-menu-bar]")
      .forEach((header) => {
        const contextSurface = header.querySelector(HEADER_CONTEXT_SELECTOR);
        const homeModeToggle = header.querySelector('[class*="home-mode-toggle"]');
        const contextRoot = directChildWithin(contextSurface, header);
        const homeRoot = directChildWithin(homeModeToggle, header);

        // Codex renders the contextual controls, the centered home-mode control
        // and the trailing header slot as siblings. They sit above our page at
        // z-index 30, so hiding only contextSurface.children leaves the centered
        // globe and the right-side panel buttons visible over the iframe. Codex
        // currently ships both data-testid and data-test-id spellings, so both
        // variants must participate in the same structural range check.
        markNode(contextSurface, HEADER_HIDDEN, hiddenHeaderNodes);
        markNode(homeRoot, HEADER_HIDDEN, hiddenHeaderNodes);

        const structuralAnchor = contextRoot || homeRoot;
        if (!structuralAnchor) return;
        header.querySelectorAll(HEADER_SLOT_SELECTOR)
          .forEach((slot) => {
            const slotRoot = directChildWithin(slot, header);
            if (!slotRoot || slotRoot === structuralAnchor) return;
            const followsContext = Boolean(
              structuralAnchor.compareDocumentPosition(slotRoot)
                & Node.DOCUMENT_POSITION_FOLLOWING,
            );
            if (followsContext) markNode(slot, HEADER_HIDDEN, hiddenHeaderNodes);
          });
      });
  }

  function hideNativeContent(surface) {
    markNode(surface, HOST, hostSurfaceNodes);
    Array.from(surface.children).forEach((child) => {
      if (child !== page && child.getAttribute(OWNED) !== "true") {
        markNode(child, HIDDEN, hiddenNativeNodes);
      }
    });
    hideNativeHeaderChrome();
  }

  function restoreNativeContent() {
    hiddenNativeNodes.forEach((node) => node.removeAttribute(HIDDEN));
    hiddenNativeNodes.clear();
    hiddenHeaderNodes.forEach((node) => node.removeAttribute(HEADER_HIDDEN));
    hiddenHeaderNodes.clear();
    hostSurfaceNodes.forEach((node) => node.removeAttribute(HOST));
    hostSurfaceNodes.clear();
    document.querySelectorAll(`[${HIDDEN}="true"]`)
      .forEach((node) => node.removeAttribute(HIDDEN));
    document.querySelectorAll(`[${HEADER_HIDDEN}="true"]`)
      .forEach((node) => node.removeAttribute(HEADER_HIDDEN));
    document.querySelectorAll(`[${HOST}="true"]`)
      .forEach((node) => node.removeAttribute(HOST));
  }

  function mountActivePage() {
    if (!active || destroyed) return false;
    const surface = findPageMount();
    const contextChanged = (
      !surface
      || !activeSurface
      || !activeSurface.isConnected
      || surface !== activeSurface
      || currentRouteKey() !== activeRouteKey
      || !page
      || page.parentElement !== activeSurface
    );
    if (contextChanged) {
      // An active output page belongs to exactly the host surface and route on
      // which it was explicitly opened. Never follow a Codex navigation into a
      // replacement task/settings surface: close and restore the host instead.
      closeOutputItems(false);
      return false;
    }
    hideNativeContent(activeSurface);
    muteNativeSelection();
    page.hidden = false;
    document.documentElement.setAttribute("data-codex-output-items-open", "true");
    return true;
  }

  function openOutputItems() {
    if (destroyed) return { opened: false, frameName: null };
    const surface = findPageMount();
    if (!surface?.isConnected) return { opened: false, frameName: null };
    lastFocusedElement = document.activeElement;
    if (!page) page = createPage();
    if (page.parentElement !== surface) {
      restoreNativeContent();
      surface.appendChild(page);
    }
    activeSurface = surface;
    activeRouteKey = currentRouteKey();
    active = true;
    ensureEntry();
    syncEntryState();
    const mounted = mountActivePage();
    syncFrameTheme();
    frame?.focus?.();
    return { opened: mounted && Boolean(frame?.isConnected), frameName: frame?.name || null };
  }

  function frameRequest() {
    if (destroyed || !active || !frame?.isConnected || !frame.name) return null;
    return { frameName: frame.name };
  }

  function closeOutputItems(restoreFocus = true) {
    if (!active && page?.hidden !== false) return false;
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    restoreNativeSelection();
    document.documentElement.removeAttribute("data-codex-output-items-open");
    syncEntryState();
    activeSurface = null;
    activeRouteKey = "";
    if (restoreFocus) lastFocusedElement?.focus?.();
    lastFocusedElement = null;
    return true;
  }

  function isHostInteraction(target) {
    const clickable = target?.closest?.(HOST_INTERACTIVE_SELECTOR);
    if (!clickable || clickable === entry || entry?.contains?.(clickable)) return false;
    if (page && (clickable === page || page.contains(clickable))) return false;
    return true;
  }

  function onDocumentClick(event) {
    // The dashboard lives in a separate iframe document, so its interactions do
    // not bubble here. Any other host control is allowed to continue handling
    // the click after we synchronously restore Codex's native surface.
    if (active && isHostInteraction(event.target)) closeOutputItems(false);
  }

  function threadRow(threadId) {
    const normalizedThreadId = String(threadId || "").toLowerCase();
    return Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((row) => String(row.getAttribute("data-app-action-sidebar-thread-id") || "").toLowerCase() === normalizedThreadId)
      || null;
  }

  function threadIsSelected(threadId) {
    const row = threadRow(threadId);
    if (
      row
      && (
        row.getAttribute("data-app-action-sidebar-thread-active") === "true"
        || ["page", "true"].includes(row.getAttribute("aria-current"))
      )
    ) return true;
    const routeText = `${window.location.pathname || ""}${window.location.search || ""}${window.location.hash || ""}`;
    return routeText.includes(`/local/${encodeURIComponent(threadId)}`) || routeText.includes(threadId);
  }

  async function waitForThread(threadId, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (threadIsSelected(threadId)) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return threadIsSelected(threadId);
  }

  function postThreadResult(source, requestId, threadId, ok, error = undefined) {
    try {
      source?.postMessage({
        type: "output-items:open-thread-result",
        requestId,
        threadId,
        ok,
        ...(error ? { error } : {}),
      }, "*");
    } catch (_) {}
  }

  async function navigateToThread(threadId) {
    const row = threadRow(threadId);
    if (row?.isConnected && typeof row.click === "function") {
      closeOutputItems(false);
      row.click();
      if (await waitForThread(threadId)) return { ok: true };
      openOutputItems();
    }

    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      return { ok: false, error: "当前 Codex 版本没有提供原生任务导航能力。" };
    }

    closeOutputItems(false);
    try {
      window.postMessage({
        type: "navigate-to-route",
        path: `/local/${encodeURIComponent(threadId)}`,
      }, window.location.origin);
    } catch (error) {
      openOutputItems();
      return { ok: false, error: error instanceof Error ? error.message : "无法请求 Codex 打开任务。" };
    }

    if (await waitForThread(threadId)) return { ok: true };
    openOutputItems();
    return { ok: false, error: "Codex 未确认已打开对应任务。" };
  }

  async function onFrameMessage(event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== "null") return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.type !== "output-items:open-thread") return;
    const requestId = typeof message.requestId === "string" && message.requestId.length <= 128
      ? message.requestId
      : "";
    const threadId = typeof message.threadId === "string" ? message.threadId.trim().toLowerCase() : "";
    if (!requestId) return;
    if (!UUID_PATTERN.test(threadId)) {
      postThreadResult(event.source, requestId, threadId, false, "任务 ID 不是有效 UUID。重定向已拒绝。");
      return;
    }
    const result = await navigateToThread(threadId);
    postThreadResult(event.source, requestId, threadId, result.ok, result.error);
  }

  function scheduleRefresh() {
    if (destroyed || refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      ensureEntry();
      mountActivePage();
      syncFrameTheme();
    }, 80);
  }

  function mount() {
    document.removeEventListener("DOMContentLoaded", mount);
    if (destroyed || observer || !document.documentElement) return;
    ensureEntry();
    mountActivePage();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-theme", "data-resolved-theme", "aria-current", "aria-label"],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = null;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("DOMContentLoaded", mount);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("message", onFrameMessage);
    window.removeEventListener("popstate", onNativeRouteChange);
    window.removeEventListener("hashchange", onNativeRouteChange);
    window.removeEventListener("resize", scheduleRefresh);
    if (typeof themeMediaQuery?.removeEventListener === "function") {
      themeMediaQuery.removeEventListener("change", scheduleRefresh);
    } else {
      themeMediaQuery?.removeListener?.(scheduleRefresh);
    }
    closeOutputItems(false);
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
    entry = null;
    entryLabel = null;
    page = null;
    frame = null;
    frameName = "";
    activeSurface = null;
    activeRouteKey = "";
    lastThemeSignature = "";
  }

  function onNativeRouteChange() {
    if (active) closeOutputItems(false);
  }

  const api = {
    version: VERSION,
    open: openOutputItems,
    frameRequest,
    close: closeOutputItems,
    refresh: scheduleRefresh,
    themeSnapshot,
    destroy,
    get active() {
      return active;
    },
  };

  window[SENTINEL] = api;
  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("message", onFrameMessage);
  window.addEventListener("popstate", onNativeRouteChange);
  window.addEventListener("hashchange", onNativeRouteChange);
  window.addEventListener("resize", scheduleRefresh);
  if (typeof themeMediaQuery?.addEventListener === "function") {
    themeMediaQuery.addEventListener("change", scheduleRefresh);
  } else {
    themeMediaQuery?.addListener?.(scheduleRefresh);
  }
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
