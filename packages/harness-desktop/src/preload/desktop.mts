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
import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  APP_VERSION_ARG,
  CHOOSE_DIRECTORY,
  DEEP_LINK_NAVIGATE,
  UPDATE_CHECK,
  UPDATE_STATE,
  type DeepLinkTarget,
  type UpdateCheckOutcome,
  type UpdateStatePayload,
} from "../main/ipc.js";

/**
 * UPDATE_STATE is consumed here in the preload, not lazily on subscribe: the
 * main process pushes on `did-finish-load`, which fires BEFORE the SPA's mount
 * effects run, so a subscription-time `ipcRenderer.on` would miss that push
 * and a reload during a pending update would silently drop the "Update now"
 * card. The preload evaluates before any page code, so listening from here and
 * replaying the latest payload to each new subscriber closes the gap.
 */
let latestUpdateState: UpdateStatePayload | null = null;
const updateStateSubscribers = new Set<(state: UpdateStatePayload) => void>();
ipcRenderer.on(UPDATE_STATE, (_event, state: UpdateStatePayload) => {
  latestUpdateState = state;
  for (const subscriber of updateStateSubscribers) subscriber(state);
});

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
  /**
   * Subscribe to downloaded-update state (main → renderer push); returns an
   * unsubscribe fn. RECEIVE-only, like onDeepLink: it drives the rail's
   * "Update now" card and nothing else. Subscribing at mount is the whole
   * handshake: the preload listens from before any page code runs and REPLAYS
   * the latest state to a new subscriber — the main process's re-push on
   * `did-finish-load` lands in the gap before React's effects have subscribed,
   * so without the replay a reload while an update is pending would lose the
   * card. Applying the update still goes through checkForUpdates(), whose
   * pending branch re-raises the main-process-owned update window (see
   * ipc.ts — page code has no restart channel, deliberately).
   */
  onUpdateState(callback: (state: UpdateStatePayload) => void): () => void {
    updateStateSubscribers.add(callback);
    if (latestUpdateState) callback(latestUpdateState);
    return () => {
      updateStateSubscribers.delete(callback);
    };
  },
  /**
   * The absolute filesystem path of a dropped/picked File, or "" when Electron
   * can't resolve one (e.g. a file synthesized by the page). What makes
   * drag-and-drop into the terminal possible at all: a web renderer's File
   * object exposes no path, so the SPA cannot type it into the pty the way a
   * native terminal emulator does without this. Synchronous and local — no IPC,
   * nothing crosses into the main process.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // No restart method, on purpose — see ipc.ts. An update that is ready to install
  // is confirmed through a native dialog, so nothing the page can call ends a
  // user's sessions.
};

export type DesktopBridge = typeof api;

contextBridge.exposeInMainWorld("sapiomDesktop", api);
