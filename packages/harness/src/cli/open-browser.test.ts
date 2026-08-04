import { afterEach, describe, expect, it, vi } from "vitest";

import { openStudioInBrowser } from "./open-browser.js";

describe("openStudioInBrowser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true after the platform opener succeeds", async () => {
    const openUrl = vi.fn(async () => undefined);

    await expect(
      openStudioInBrowser("http://localhost:4100/?token=secret", openUrl),
    ).resolves.toBe(true);
    expect(openUrl).toHaveBeenCalledWith("http://localhost:4100/?token=secret");
  });

  it("keeps opener failure nonfatal and does not repeat the boot token", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const openUrl = vi.fn(async () => {
      throw new Error("could not open http://localhost:4100/?token=secret");
    });

    await expect(
      openStudioInBrowser("http://localhost:4100/?token=secret", openUrl),
    ).resolves.toBe(false);
    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("Open the full URL printed above");
    expect(printed).not.toContain("secret");
  });
});
