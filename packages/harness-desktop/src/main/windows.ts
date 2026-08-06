import { BrowserWindow, app, shell } from "electron";
import { APP_VERSION_ARG } from "./ipc.js";
import { desktopPreloadPath, setupHtmlPath, setupPreloadPath } from "./paths.js";

/**
 * The setup/onboarding window shown BEFORE the harness SPA — drives the boot
 * sequence UI (progress, agent-install, consent, errors). Uses a preload +
 * contextIsolation; no direct Node in the renderer.
 */
export function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 460,
    resizable: false,
    show: true,
    title: "Sapiom",
    webPreferences: {
      preload: setupPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // The setup window loads only our own bundled HTML (no remote/user
      // content), and its preload is ESM. Electron won't load an ESM preload in
      // a sandboxed renderer (sandboxed preloads must be CommonJS), so disable
      // the sandbox here — safe for this trusted local page. contextIsolation
      // stays on. Without this the bridge never loads and onboarding stalls at
      // the consent prompt (renderer can't send CONSENT_SUBMIT).
      sandbox: false,
    },
  });
  // Surface a failing preload loudly: without the bridge the renderer can't
  // show progress or send consent, which silently stalls the whole onboarding.
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error(`[setup] preload failed to load: ${preloadPath}\n${error?.stack ?? error}`);
  });
  void win.loadFile(setupHtmlPath());
  return win;
}

/**
 * The main window: loads the harness SPA from the local server at its
 * boot-token URL. External (non-localhost) links open in the system browser;
 * in-app navigation is confined to the local server.
 *
 * It carries a preload — a deliberately minimal one. The SPA is the same bundle
 * `npx @sapiom/harness` serves to a plain browser, so this window is the only
 * place it can offer anything desktop-specific (today: "Check for updates" in the
 * Settings popover). The SPA feature-detects `window.sapiomDesktop` and simply
 * omits those affordances in a browser — see `harness/web/src/lib/desktop.ts`.
 */
export function createMainWindow(loadUrl: string): BrowserWindow {
  // macOS only: drop the native title bar and inset the traffic lights so they
  // sit in the rail's 56px top line, which the SPA then treats as a drag region.
  // trafficLightPosition centres the ~14px light group vertically in that line;
  // the SPA is told it is this frame via ?frame=macos (below) and pads its brand
  // header to clear the lights. Windows/Linux keep their native frame for now.
  //
  // COUPLING: {x:19,y:21} and the SPA's `padding-left:78px`
  // (:root[data-window-frame="macos"] .brand-header) are both sized to the
  // 56px header line (--header-h in the design-system tokens). The main process
  // can't read CSS, so if --header-h ever changes, re-center y and re-check the
  // x/padding clearance here and in styles.css together.
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    // 35rem is the narrowest frame the SPA is composed for: it folds to the
    // one-column shell at 768px (styles.css "Mobile shell") and that column
    // still reads at 560. Below it the window was a strip of overlapping
    // labels, so the frame refuses to go there rather than the layout coping.
    minWidth: 560,
    minHeight: 480,
    show: false, // show on ready-to-show to avoid a white flash
    title: "Sapiom",
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 19, y: 21 } } : {}),
    webPreferences: {
      preload: desktopPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // Same constraint as the setup window: Electron will not load an ESM
      // preload in a sandboxed renderer. contextIsolation stays ON, so the page
      // still gets only the frozen bridge and never `ipcRenderer` itself.
      sandbox: false,
      // How the preload learns the app version. `process.env` would mean relying
      // on a renderer inheriting a variable mutated after startup; this is the
      // documented channel. See APP_VERSION_ARG.
      additionalArguments: [`${APP_VERSION_ARG}${app.getVersion()}`],
    },
  });

  // A silently-failing preload is the exact bug the setup window once had: the
  // window looks fine and the bridge is just absent. Here it would mean the
  // update button vanishing with no error anywhere, so say so.
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    console.error(`[main] preload failed to load: ${preloadPath}\n${error?.stack ?? error}`);
  });

  win.once("ready-to-show", () => win.show());

  // Anything that isn't our local server opens in the user's real browser
  // (OAuth continuations, docs links, agent-opened URLs).
  //
  // Local URLs get a window we build ourselves rather than `{ action: "allow" }`.
  // A window opened by `allow` INHERITS the parent's webPreferences — including
  // this window's preload — and "local" is not the same as "ours": the harness
  // serves agent-authored files at `/canvas/:sessionId/*` from
  // `<cwd>/.sapiom/canvas/`, on this very origin. xterm linkifies whatever the
  // agent prints, so a URL in the terminal is one click from a window holding
  // `window.sapiomDesktop` — i.e. an agent could call `restartToUpdate()` and kill
  // every live session. Denying and opening explicitly is deterministic; it
  // doesn't depend on override-merge semantics.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) {
      createPreviewWindow(url);
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // Hand the SPA its frame so it clears the traffic lights and drags by its top
  // line — only on the frameless-mac window; a browser (npx) never carries it.
  const framedUrl = isMac ? withFrameParam(loadUrl, "macos") : loadUrl;
  void win.loadURL(framedUrl);
  return win;
}

/** Append ?frame=<value> without disturbing the existing boot-token query. */
function withFrameParam(loadUrl: string, frame: string): string {
  try {
    const u = new URL(loadUrl);
    u.searchParams.set("frame", frame);
    return u.toString();
  } catch {
    return loadUrl;
  }
}

/**
 * A plain window for a local page the SPA or the agent asked to pop out (a canvas
 * preview, a dev server). Deliberately has NO preload and IS sandboxed: this is
 * where agent-authored content ends up, and it must not reach the main process.
 *
 * Everything the main window needs and this one must not have is absent by
 * construction rather than by override, which is the point — see the window-open
 * handler above.
 */
export function createPreviewWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    title: "Sapiom",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // A preview window is a leaf: it gets no bridge, and it cannot spawn further
  // windows that might. Off-origin links still go to the real browser.
  win.webContents.setWindowOpenHandler(({ url: next }) => {
    if (!isLocalUrl(next)) void shell.openExternal(next);
    return { action: "deny" };
  });
  void win.loadURL(url);
  return win;
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost")
    );
  } catch {
    return false;
  }
}
