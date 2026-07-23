import { BrowserWindow, shell } from "electron";
import { setupHtmlPath, setupPreloadPath } from "./paths.js";

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
    },
  });
  void win.loadFile(setupHtmlPath());
  return win;
}

/**
 * The main window: loads the harness SPA from the local server at its
 * boot-token URL. No preload — it is just the harness web app. External
 * (non-localhost) links open in the system browser; in-app navigation is
 * confined to the local server.
 */
export function createMainWindow(loadUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false, // show on ready-to-show to avoid a white flash
    title: "Sapiom",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Anything that isn't our local server opens in the user's real browser
  // (OAuth continuations, docs links, agent-opened URLs).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isLocalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void win.loadURL(loadUrl);
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
