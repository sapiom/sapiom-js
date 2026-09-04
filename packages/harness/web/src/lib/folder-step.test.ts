import { describe, expect, it, vi } from "vitest";

import { chooseProjectFolder } from "./folder-step";

/**
 * The desktop branch cannot be reached by the e2e tier — there is no Electron
 * here, and the Playwright suite is the browser host by definition, so it can
 * only ever prove the fallback. These are the desktop half's only proof, which
 * is why they assert the NEGATIVE too: that the dialog never opens when the
 * bridge is there. A test that only checked `chooseDirectory` was called would
 * still pass on a build that opened both.
 */
describe("the create verb's folder step", () => {
  it("goes straight to the OS picker when the bridge is there", async () => {
    const chooseDirectory = vi.fn().mockResolvedValue("/Users/demo/acme-app");
    const openDialog = vi.fn();
    const onPicked = vi.fn();

    await chooseProjectFolder({
      chooseDirectory,
      startingAt: "/Users/demo",
      openDialog,
      onPicked,
    });

    expect(chooseDirectory).toHaveBeenCalledWith("/Users/demo");
    expect(onPicked).toHaveBeenCalledWith("/Users/demo/acme-app");
    // The whole point: our dialog is not also shown.
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("opens the folder dialog when there is no bridge", async () => {
    const openDialog = vi.fn();
    const onPicked = vi.fn();

    await chooseProjectFolder({
      chooseDirectory: null,
      startingAt: "/Users/demo",
      openDialog,
      onPicked,
    });

    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("treats a cancelled native pick as nothing happening", async () => {
    const openDialog = vi.fn();
    const onPicked = vi.fn();

    await chooseProjectFolder({
      chooseDirectory: vi.fn().mockResolvedValue(null),
      openDialog,
      onPicked,
    });

    expect(onPicked).not.toHaveBeenCalled();
    // Dismissing a folder browser must not fall back into our dialog: the user
    // said no to the question, not to the way it was asked.
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("swallows a failed native pick without falling back", async () => {
    const openDialog = vi.fn();
    const onPicked = vi.fn();

    await expect(
      chooseProjectFolder({
        chooseDirectory: vi.fn().mockRejectedValue(new Error("no window")),
        openDialog,
        onPicked,
      }),
    ).resolves.toBeUndefined();

    expect(onPicked).not.toHaveBeenCalled();
    expect(openDialog).not.toHaveBeenCalled();
  });

  it("omits the starting folder rather than passing an empty one", async () => {
    const chooseDirectory = vi.fn().mockResolvedValue(null);

    await chooseProjectFolder({
      chooseDirectory,
      startingAt: null,
      openDialog: vi.fn(),
      onPicked: vi.fn(),
    });

    expect(chooseDirectory).toHaveBeenCalledWith(undefined);
  });
});
