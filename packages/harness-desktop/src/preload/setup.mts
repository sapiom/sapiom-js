/**
 * Preload for the setup window. Exposes a tiny, typed bridge to the renderer
 * (no Node, no ipcRenderer directly) via contextBridge.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  BOOT_PROGRESS,
  BOOT_ERROR,
  CONSENT_SUBMIT,
  RETRY,
  type BootProgress,
  type BootErrorPayload,
} from "../main/ipc.js";

const api = {
  onProgress(cb: (p: BootProgress) => void): void {
    ipcRenderer.on(BOOT_PROGRESS, (_e, p: BootProgress) => cb(p));
  },
  onError(cb: (e: BootErrorPayload) => void): void {
    ipcRenderer.on(BOOT_ERROR, (_e, p: BootErrorPayload) => cb(p));
  },
  submitConsent(telemetryOptIn: boolean): Promise<void> {
    return ipcRenderer.invoke(CONSENT_SUBMIT, telemetryOptIn);
  },
  retry(): Promise<void> {
    return ipcRenderer.invoke(RETRY);
  },
};

export type SetupBridge = typeof api;

contextBridge.exposeInMainWorld("sapiomSetup", api);
