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
import { APP_VERSION_ARG, UPDATE_CHECK, type UpdateCheckOutcome } from "../main/ipc.js";

const api = {
  /** The desktop app's version — NOT the harness's (the SPA already knows that one). */
  appVersion:
    process.argv.find((arg) => arg.startsWith(APP_VERSION_ARG))?.slice(APP_VERSION_ARG.length) ?? "",
  /** Check now, on the user's behalf. Resolves with what happened; never rejects. */
  checkForUpdates(): Promise<UpdateCheckOutcome> {
    return ipcRenderer.invoke(UPDATE_CHECK) as Promise<UpdateCheckOutcome>;
  },
  // No restart method, on purpose — see ipc.ts. An update that is ready to install
  // is confirmed through a native dialog, so nothing the page can call ends a
  // user's sessions.
};

export type DesktopBridge = typeof api;

contextBridge.exposeInMainWorld("sapiomDesktop", api);
