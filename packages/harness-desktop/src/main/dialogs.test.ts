/**
 * The REVEAL_PATH handler's gate. `isTrustedSender` is the only thing keeping
 * agent-authored content served on the SPA's origin (`/canvas/:sessionId/*`)
 * from popping file-manager windows, so an untrusted sender must never reach
 * `shell.showItemInFolder`. Electron is mocked at the module boundary only;
 * the trusted-sender guard is the real one. The CHOOSE_DIRECTORY tests pin
 * the picker's start folder, which Electron 43+ no longer leaves to the OS.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const showItemInFolder = vi.fn();
const showOpenDialog = vi.fn();
vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: { showOpenDialog },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder },
}));

const { chooseDirectory, initDialogs, revealPath } = await import("./dialogs.js");
const { setTrustedWindow } = await import("./trusted-sender.js");

function fakeWindow(url: string): { win: BrowserWindow; event: IpcMainInvokeEvent } {
  const webContents = { mainFrame: { url } };
  const win = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  return { win, event: { sender: webContents } as unknown as IpcMainInvokeEvent };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-reveal-"));

describe("revealPath (REVEAL_PATH handler)", () => {
  const main = fakeWindow("http://localhost:5400/?token=t");
  setTrustedWindow(main.win);

  beforeEach(() => {
    showItemInFolder.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reveals an existing absolute path for the SPA at the top frame /", () => {
    expect(revealPath(main.event, dir)).toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(dir);
  });

  it("refuses a sender that is not the main window", () => {
    const other = fakeWindow("http://localhost:5400/");
    expect(revealPath(other.event, dir)).toBe(false);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("refuses the main window once it has navigated to agent-authored content", () => {
    const webContents = main.win.webContents as unknown as { mainFrame: { url: string } };
    webContents.mainFrame.url = "http://localhost:5400/canvas/s1/index.html";
    try {
      expect(revealPath(main.event, dir)).toBe(false);
      expect(showItemInFolder).not.toHaveBeenCalled();
    } finally {
      webContents.mainFrame.url = "http://localhost:5400/?token=t";
    }
  });

  it("refuses a relative, missing, or non-string path", () => {
    // Relative to the cwd, and it exists: only isAbsolute refuses it.
    expect(revealPath(main.event, path.relative(process.cwd(), dir))).toBe(false);
    expect(revealPath(main.event, path.join(dir, "nope"))).toBe(false);
    expect(revealPath(main.event, 42)).toBe(false);
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("refuses a 31st reveal within a minute, then allows one after it", () => {
    // Past the window of the reveals earlier tests made at Date.now().
    const start = Date.now() + 10 * 60_000;
    let accepted = 0;
    for (let i = 0; i < 31; i++) if (revealPath(main.event, dir, start + i)) accepted += 1;
    expect(accepted).toBe(30);
    expect(revealPath(main.event, dir, start + 31)).toBe(false);
    expect(revealPath(main.event, dir, start + 61_000)).toBe(true);
  });
});

describe("chooseDirectory (CHOOSE_DIRECTORY handler)", () => {
  const main = fakeWindow("http://localhost:5400/?token=t");

  const startFolder = (): unknown => showOpenDialog.mock.lastCall?.[1]?.defaultPath;

  beforeEach(() => {
    setTrustedWindow(main.win);
    initDialogs({ mainWindow: main.win });
    showOpenDialog.mockReset();
  });

  // One sequence: the remembered folder is module state carried between picks.
  it("starts at home, then at the parent of the last pick, and lets a hint win", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/a/b/c"] });
    expect(await chooseDirectory(main.event, undefined)).toBe("/a/b/c");
    expect(startFolder()).toBe(os.homedir());

    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await chooseDirectory(main.event, "")).toBeNull();
    expect(startFolder()).toBe("/a/b");

    // A canceled pick leaves the remembered folder alone.
    expect(await chooseDirectory(main.event, undefined)).toBeNull();
    expect(startFolder()).toBe("/a/b");

    expect(await chooseDirectory(main.event, "/x/y")).toBeNull();
    expect(startFolder()).toBe("/x/y");
  });
});
