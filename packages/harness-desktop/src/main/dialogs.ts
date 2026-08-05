/**
 * Native OS dialogs the SPA can open.
 *
 * Currently just the "choose folder" picker behind the folder field's Browse
 * button. It is a desktop-only shortcut: the same SPA served by
 * `npx @sapiom/harness` has no bridge and keeps its in-app directory listing, so
 * this is never a dependency — `harness/web/src/lib/desktop.ts` feature-detects it.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHOOSE_DIRECTORY } from "./ipc.js";
import { isTrustedSender } from "./trusted-sender.js";

/** The window a dialog is parented to (a sheet on macOS). Set on every boot. */
let mainWindow: BrowserWindow | null = null;

/** Idempotent: `ipcMain.handle` throws if a channel is registered twice. */
let handlersRegistered = false;

/**
 * Register the native-dialog IPC handlers.
 *
 * Call on EVERY boot path, including `--smoke` — `ipcRenderer.invoke` on an
 * unhandled channel REJECTS, so a Browse click in a build that skipped
 * registration would surface as a dead button (the same trap `initUpdater`
 * documents). The `--smoke` run never invokes this channel (it would open a real
 * OS dialog and block), so registration here is what keeps the contract honest.
 */
export function initDialogs(deps: { mainWindow: BrowserWindow }): void {
  mainWindow = deps.mainWindow;
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle(CHOOSE_DIRECTORY, (event, defaultPath): Promise<string | null> =>
    chooseDirectory(event, defaultPath),
  );
}

async function chooseDirectory(event: IpcMainInvokeEvent, defaultPath: unknown): Promise<string | null> {
  // Same gate as the update check: a folder chooser opened by same-origin
  // agent-authored content (served at `/canvas/:sessionId/*`) would be an
  // escalation, so only the SPA at the top frame `/` may open it.
  if (!isTrustedSender(event)) return null;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a folder",
    // `createDirectory` gives the macOS sheet its "New Folder" button, which fits
    // the "start in a folder that doesn't exist yet" flow. `defaultPath` opens the
    // picker where the user already is — the OS dialog remains the trust boundary,
    // so a bad hint is simply ignored.
    properties: ["openDirectory", "createDirectory"],
    defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
