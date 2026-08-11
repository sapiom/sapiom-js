/**
 * Preload for the update window. Exposes a tiny, typed bridge (no Node, no raw
 * `ipcRenderer`) via contextBridge — mirroring the setup preload.
 *
 * Unlike the main window's `sapiomDesktop`, this bridge lives ONLY in a window the
 * main process created and loads only `update.html` into. That containment is what
 * makes a `choose` channel — which can end running sessions — safe to expose here;
 * see the note in `ipc.ts`.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  UPDATE_AUTO_ARG,
  UPDATE_DECIDE,
  UPDATE_SET_AUTO,
  UPDATE_VERSION_ARG,
  type UpdateChoice,
} from "../main/ipc.js";

/** Read a value handed in via `webPreferences.additionalArguments` (see ipc.ts). */
const argValue = (prefix: string): string =>
  process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";

const api = {
  /** The version being offered, passed in at window-creation time. */
  version: argValue(UPDATE_VERSION_ARG),
  /** Initial state of the "auto-install on quit" toggle. */
  autoUpdate: argValue(UPDATE_AUTO_ARG) === "1",
  /**
   * Persist a toggle change immediately — independent of the eventual button
   * choice, so flipping it and then just closing the window still keeps the change.
   */
  setAutoUpdate(on: boolean): Promise<void> {
    return ipcRenderer.invoke(UPDATE_SET_AUTO, on) as Promise<void>;
  },
  /** Report the user's choice; the main process resolves the prompt and closes. */
  choose(choice: UpdateChoice): Promise<void> {
    return ipcRenderer.invoke(UPDATE_DECIDE, choice) as Promise<void>;
  },
};

export type UpdateBridge = typeof api;

contextBridge.exposeInMainWorld("sapiomUpdate", api);
