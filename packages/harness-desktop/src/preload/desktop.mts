/**
 * Preload for the MAIN window — the one running the harness SPA.
 *
 * The SPA is not ours alone: the identical bundle is served to a plain browser by
 * `npx @sapiom/harness`, where none of this exists. So this bridge is strictly
 * additive and the SPA must feature-detect it (`harness/web/src/lib/desktop.ts`)
 * rather than assume it. Presence of `window.sapiomDesktop` IS the answer to "am I
 * running inside the desktop app?", which is why `appVersion` is included even
 * though nothing needs it yet: it makes the object self-describing in a bug report.
 *
 * Kept deliberately tiny. This is the only channel from remote-ish page code into
 * the main process, so every addition is attack surface — `contextIsolation` stays
 * on and `ipcRenderer` is never handed to the page.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  APP_VERSION_ARG,
  CHOOSE_DIRECTORY,
  DEEP_LINK_NAVIGATE,
  UPDATE_CHECK,
  type DeepLinkTarget,
  type UpdateCheckOutcome,
} from "../main/ipc.js";

const api = {
  /** The desktop app's version — NOT the harness's (the SPA already knows that one). */
  appVersion:
    process.argv.find((arg) => arg.startsWith(APP_VERSION_ARG))?.slice(APP_VERSION_ARG.length) ?? "",
  /** Check now, on the user's behalf. Resolves with what happened; never rejects. */
  checkForUpdates(): Promise<UpdateCheckOutcome> {
    return ipcRenderer.invoke(UPDATE_CHECK) as Promise<UpdateCheckOutcome>;
  },
  /**
   * Open the OS-native folder chooser, optionally starting at `defaultPath`.
   * Resolves with the chosen absolute path, or null when cancelled. Read-only: it
   * only returns a path the user picked — the main process opens no file.
   */
  chooseDirectory(defaultPath?: string): Promise<string | null> {
    return ipcRenderer.invoke(CHOOSE_DIRECTORY, defaultPath) as Promise<string | null>;
  },
  /**
   * Subscribe to `sapiom://` deep links that arrive while the app is running.
   * Returns an unsubscribe fn. RECEIVE-only (main → renderer push): the page
   * still never gets `ipcRenderer`, and there is nothing to invoke — a link is a
   * target the SPA may act on or ignore. Cold-start links arrive via the `agent=`
   * load-URL param instead, so the one that opened the app isn't re-delivered here.
   */
  onDeepLink(callback: (target: DeepLinkTarget) => void): () => void {
    const listener = (_event: unknown, target: DeepLinkTarget): void => callback(target);
    ipcRenderer.on(DEEP_LINK_NAVIGATE, listener);
    return () => {
      ipcRenderer.removeListener(DEEP_LINK_NAVIGATE, listener);
    };
  },
  // No restart method, on purpose — see ipc.ts. An update that is ready to install
  // is confirmed through a native dialog, so nothing the page can call ends a
  // user's sessions.
};

export type DesktopBridge = typeof api;

contextBridge.exposeInMainWorld("sapiomDesktop", api);
