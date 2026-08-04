/**
 * The application menu, as data.
 *
 * Pure and electron-free (the `MenuItemConstructorOptions` import is types
 * only, erased at build time) so it can be unit-tested the way env.ts and
 * paths.ts are — the runtime half lives in menu.ts.
 *
 * Only macOS gets a menu. On Linux/Windows the SPA is the whole UI and the app
 * deliberately runs with `Menu.setApplicationMenu(null)`; macOS keeps its menu
 * bar no matter what, so there the choice is between our items and Electron's
 * bare default — and Settings has to be where the platform says it is
 * (Sapiom → Settings…, ⌘,), not only inside the window.
 */
import type { MenuItemConstructorOptions } from "electron";

export interface AppMenuHandlers {
  /** Chosen Sapiom → Settings… (or pressed ⌘,). */
  openSettings: () => void;
  appName: string;
}

export function buildAppMenuTemplate({ openSettings, appName }: AppMenuHandlers): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          // The platform shortcut for preferences. Electron does not add this
          // item for us — an app that wants ⌘, has to declare it.
          accelerator: "CmdOrCtrl+,",
          click: openSettings,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      // Not decoration: without the Edit roles, ⌘C/⌘V/⌘A do nothing in the SPA
      // on macOS — the keystrokes are menu-driven there.
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }],
    },
  ];
}
