/**
 * Which renderer may drive a privileged IPC channel.
 *
 * Only the harness SPA, running in the MAIN window's top frame at `/`, is trusted.
 * This guard is shared by every privileged channel (update checks, the native
 * folder picker) so the rule lives in exactly one place — copying a security check
 * is how one call site quietly drifts from the others.
 *
 * Two things could otherwise ask, and both are why an identity check alone is not
 * enough:
 *  - another window — a pop-out inherits `webPreferences` (preload included) unless
 *    the main process prevents it (`windows.ts` does; this is the check that still
 *    holds if that ever regresses);
 *  - the main window itself after navigating to a page other than the SPA root on
 *    this same origin, which an agent might control.
 *
 * Hence an identity check (the sender IS the main window's webContents), a frame
 * check (the call comes from its top frame), an origin check (the harness origin the
 * window loaded, not another localhost port such as an agent's dev server, SAP-4382)
 * and a path check (`/`). The SPA lives at `/` and never navigates its top frame over
 * http, so requiring `/` is exact today. If the SPA ever adopts routing this fails
 * CLOSED and logs why, rather than quietly widening.
 *
 * Electron is imported for TYPES ONLY (erased at build), so this module stays free
 * of a runtime `electron` dependency and can be unit-tested.
 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

/**
 * The window whose renderer is trusted, set once at boot by `index.ts`. Null until
 * then, and after the window is destroyed — both of which make every sender fail
 * closed.
 */
let trustedWindow: BrowserWindow | null = null;
/** The harness origin (`http://127.0.0.1:<port>`) the trusted window loaded. */
let trustedOrigin: string | null = null;

/**
 * Record the main window, and the harness origin it loaded, as the sole trusted
 * IPC sender. Called once, at boot.
 */
export function setTrustedWindow(win: BrowserWindow, origin: string): void {
  trustedWindow = win;
  trustedOrigin = origin;
}

function log(message: string): void {
  // Unconditional, on stderr: a rejected privileged IPC is rare and is the only
  // evidence when a real build's button "does nothing".
  console.error(`[ipc-guard] ${message}`);
}

/** True only for the harness SPA in the main window's top frame at `/`, on the harness origin. */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const win = trustedWindow;
  if (!win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) {
    log("rejected a privileged IPC from a non-main-window renderer");
    return false;
  }
  // A subframe must never qualify, even if `nodeIntegrationInSubFrames` is switched on later.
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) {
    log("rejected a privileged IPC from a subframe of the main window");
    return false;
  }
  const frameUrl = frame.url;
  try {
    const url = new URL(frameUrl);
    if (!trustedOrigin || url.origin !== trustedOrigin) {
      log(`rejected a privileged IPC from ${frameUrl}: not the harness origin`);
      return false;
    }
    if (url.pathname !== "/") {
      log(`rejected a privileged IPC from ${frameUrl} — only the SPA root may ask`);
      return false;
    }
  } catch {
    return false;
  }
  return true;
}
