/**
 * Every privileged channel shares this guard: other windows, subframes, other local origins and pages
 * other than the SPA root must not get privileged IPC (SAP-4382). It fails closed and logs why.
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
