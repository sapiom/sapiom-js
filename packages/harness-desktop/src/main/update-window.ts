/**
 * The custom "update ready" window.
 *
 * Replaces the native `dialog.showMessageBox` the updater used to raise: an OS
 * dialog can't be styled, so a genuinely better prompt has to be our own window.
 * It's built exactly like the setup window (see `windows.ts`) — a frameless card
 * that loads our own bundled, CSP-locked `update.html`, themed through the
 * design-system seam — so it reads as Sapiom instead of as a system alert.
 *
 * ## Why this is safe (the invariant `ipc.ts` documents)
 *
 * The main window must NOT be able to trigger a restart: it shares its origin with
 * agent-authored content served at `/canvas/:sessionId/*`, so a channel it could
 * reach, that content could reach too. This window sidesteps that entirely — it is
 * a SEPARATE, main-process-owned window that loads only `update.html`, carries its
 * own dedicated preload (no `sapiomDesktop`), and its two channels are gated on the
 * sender being THIS window's exact `webContents` and registered only while it is
 * open. No page — SPA or canvas — can reach them.
 */
import { BrowserWindow, ipcMain, nativeTheme, type IpcMainInvokeEvent } from "electron";
import {
  UPDATE_AUTO_ARG,
  UPDATE_DECIDE,
  UPDATE_SET_AUTO,
  UPDATE_VERSION_ARG,
  type UpdateChoice,
} from "./ipc.js";
import { updateHtmlPath, updatePreloadPath } from "./paths.js";

function log(message: string): void {
  console.error(`[update-window] ${message}`);
}

/** Coerce the renderer's answer to a known choice; anything unexpected defers. */
function toChoice(raw: unknown): UpdateChoice {
  return raw === "restart" || raw === "skip" ? raw : "later";
}

/**
 * The theme the SPA is CURRENTLY showing, read from the parent window's DOM.
 *
 * This window's file:// origin can't see the SPA's (http://localhost) localStorage,
 * so it can't resolve the app's chosen theme the way the SPA does — it would fall
 * back to the OS and drift out of sync whenever the user picked a non-OS theme. So
 * ask the SPA window directly for the `data-theme` it already resolved. Best-effort:
 * a destroyed window or an error falls back to the OS theme (nativeTheme).
 */
async function readParentTheme(parent: BrowserWindow): Promise<"dark" | "light" | undefined> {
  if (parent.isDestroyed()) return undefined;
  try {
    const value = await parent.webContents.executeJavaScript(
      "document.documentElement.dataset.theme",
      true,
    );
    return value === "dark" || value === "light" ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdatePromptOptions {
  version: string;
  /** Initial state of the "auto-install on quit" toggle. */
  autoUpdate: boolean;
  /**
   * Called when the toggle changes. `updater.ts` supplies this to persist the
   * preference AND apply it live to `autoUpdater.autoInstallOnAppQuit` (it owns
   * that reference). Awaited so the renderer's invoke resolves after the write.
   */
  onAutoUpdateChange?: (on: boolean) => void | Promise<void>;
}

/**
 * Show the update prompt and resolve with the user's choice. Closing the window
 * (traffic light / Esc / Later) resolves `"later"` — the same defer the old
 * dialog's `cancelId` meant. Resolves exactly once.
 */
export async function showUpdatePrompt(parent: BrowserWindow, opts: UpdatePromptOptions): Promise<UpdateChoice> {
  // Resolve the app's live theme up front: it drives BOTH the pre-paint background
  // (below) and the renderer's data-theme (via the loadFile query), so the window
  // is in sync with the app from the very first frame — not the OS default.
  const theme = await readParentTheme(parent);
  const dark = theme ? theme === "dark" : nativeTheme.shouldUseDarkColors;
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 560,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: true,
    title: "Sapiom",
    // Same frameless-card treatment as the setup window: on macOS drop the title
    // bar but keep the (inset) traffic lights so the card is closable/movable;
    // Windows/Linux keep their native frame. The renderer paints the card surface
    // (--s1) edge to edge.
    ...(isMac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    // Pre-paint in --bg for the RESOLVED theme so there's no flash before the
    // stylesheet loads. --bg (the app's base background), NOT --s1: the renderer
    // fills with --bg so the window is the same black as the app (see update.css).
    // window-background.test.ts pins these hexes to the ds --bg token.
    backgroundColor: dark ? "#0B0E13" : "#F8F9FA",
    webPreferences: {
      preload: updatePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload → sandbox must be off (same constraint as the setup window);
      // contextIsolation stays on, so the page only ever sees the frozen bridge.
      sandbox: false,
      additionalArguments: [
        `${UPDATE_VERSION_ARG}${opts.version}`,
        `${UPDATE_AUTO_ARG}${opts.autoUpdate ? "1" : "0"}`,
      ],
    },
  });

  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    log(`preload failed to load: ${preloadPath}\n${error?.stack ?? error}`);
  });
  // This window has no links; deny any window-open and off-page navigation outright.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise<UpdateChoice>((resolve) => {
    let settled = false;

    // Removing the handlers is not optional: they are global by channel name, and a
    // later prompt would throw "second handler for 'update:decide'" if this one left
    // them registered. removeHandler on an absent channel is a no-op, so this is safe
    // whether or not the handlers were ever hit.
    const cleanup = (): void => {
      ipcMain.removeHandler(UPDATE_DECIDE);
      ipcMain.removeHandler(UPDATE_SET_AUTO);
    };
    const settle = (choice: UpdateChoice): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(choice);
    };

    // Both handlers fail closed for any sender that is not THIS window's renderer.
    const fromThisWindow = (event: IpcMainInvokeEvent): boolean => {
      if (event.sender === win.webContents) return true;
      log("rejected an update IPC from a non-update-window renderer");
      return false;
    };

    // Defensive: clear any stale registration before adding ours (a prior prompt
    // that somehow didn't clean up would otherwise make handle() throw).
    cleanup();

    ipcMain.handle(UPDATE_SET_AUTO, async (event, on: unknown): Promise<void> => {
      if (!fromThisWindow(event)) return;
      await opts.onAutoUpdateChange?.(on === true);
    });

    ipcMain.handle(UPDATE_DECIDE, (event, choice: unknown): void => {
      if (!fromThisWindow(event)) return;
      settle(toChoice(choice));
      if (!win.isDestroyed()) win.close();
    });

    // Closing the window by any means (Later routes through here too, via close())
    // defers — the same outcome as the old dialog's cancelId. Guarded, so a decision
    // that closed the window doesn't get overwritten.
    win.on("closed", () => settle("later"));

    // Hand the resolved theme to the renderer's pre-paint script (it can't read the
    // SPA's cross-origin localStorage). Omitted when unknown, so the page falls back
    // to its own resolution.
    void win.loadFile(updateHtmlPath(), theme ? { query: { theme } } : undefined);
  });
}
