/**
 * The guard every privileged renderer→main channel shares. A sender qualifies only
 * as the main window, on the harness origin it loaded, at the SPA root `/`: a page
 * on another localhost port (an agent's dev server) or agent content on the harness
 * origin must both be refused.
 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Fake = { win: BrowserWindow; event: IpcMainInvokeEvent; setUrl(url: string): void; destroy(): void };

function fakeWindow(url: string): Fake {
  const webContents = { mainFrame: { url } };
  let destroyed = false;
  const win = { isDestroyed: () => destroyed, webContents } as unknown as BrowserWindow;
  return {
    win,
    event: { sender: webContents } as unknown as IpcMainInvokeEvent,
    setUrl: (next) => {
      webContents.mainFrame.url = next;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

const HARNESS = "http://127.0.0.1:5400";

/** Fresh module per test: the trusted window is module state. */
async function guard() {
  vi.resetModules();
  return import("./trusted-sender.js");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isTrustedSender", () => {
  it("accepts the main window at the harness origin's root", async () => {
    const { setTrustedWindow, isTrustedSender } = await guard();
    const main = fakeWindow(`${HARNESS}/?uiToken=t`);
    setTrustedWindow(main.win, HARNESS);
    expect(isTrustedSender(main.event)).toBe(true);
  });

  it.each([
    ["the localhost alias of the harness port", "http://localhost:5400/"],
    ["another port on 127.0.0.1", "http://127.0.0.1:3000/"],
    ["https on the harness port", "https://127.0.0.1:5400/"],
    ["agent content on the harness origin", `${HARNESS}/canvas/s1/index.html`],
    ["a file URL", "file:///index.html"],
    ["an unparseable URL", "not a url"],
  ])("rejects the main window on %s", async (_label, url) => {
    const { setTrustedWindow, isTrustedSender } = await guard();
    const main = fakeWindow(`${HARNESS}/`);
    setTrustedWindow(main.win, HARNESS);
    main.setUrl(url);
    expect(isTrustedSender(main.event)).toBe(false);
  });

  it("rejects a renderer that is not the main window, even at the harness root", async () => {
    const { setTrustedWindow, isTrustedSender } = await guard();
    const main = fakeWindow(`${HARNESS}/`);
    const other = fakeWindow(`${HARNESS}/`);
    setTrustedWindow(main.win, HARNESS);
    expect(isTrustedSender(other.event)).toBe(false);
  });

  it("rejects everything once the main window is destroyed", async () => {
    const { setTrustedWindow, isTrustedSender } = await guard();
    const main = fakeWindow(`${HARNESS}/`);
    setTrustedWindow(main.win, HARNESS);
    main.destroy();
    expect(isTrustedSender(main.event)).toBe(false);
  });

  it("rejects everything before a trusted window is recorded", async () => {
    const { isTrustedSender } = await guard();
    expect(isTrustedSender(fakeWindow(`${HARNESS}/`).event)).toBe(false);
  });
});
