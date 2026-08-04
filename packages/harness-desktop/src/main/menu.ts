/**
 * Installs the application menu. The template itself is pure data in
 * menu-template.ts (unit-tested there); this file is the electron-facing half.
 */
import { Menu, app, type BrowserWindow } from "electron";

import { OPEN_SETTINGS } from "./ipc.js";
import { buildAppMenuTemplate } from "./menu-template.js";

/**
 * macOS gets a real menu with Sapiom → Settings… (⌘,); every other platform
 * keeps the pre-existing "no menu at all" (the SPA is the whole UI, and the
 * File/Edit/View bar there is Electron's default, not ours).
 *
 * `getMainWindow` is a getter rather than a window: the menu is installed at
 * app-ready, before boot has a window to hand out, and a menu item chosen
 * before then must simply do nothing rather than capture a stale reference.
 */
export function installApplicationMenu(getMainWindow: () => BrowserWindow | undefined): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = buildAppMenuTemplate({
    appName: app.getName(),
    openSettings: () => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      // The SPA owns the Settings surface, so the menu item is a request, not
      // a second implementation of it — same panel, whichever entry point.
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send(OPEN_SETTINGS);
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
