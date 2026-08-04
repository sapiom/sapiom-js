/**
 * The menu is data (menu-template.ts) so this can be tested without electron —
 * vitest.config.ts only picks up modules that don't import it.
 */
import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

import { buildAppMenuTemplate } from "./menu-template.js";

function submenuOf(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((entry) => entry.label === label);
  return (item?.submenu ?? []) as MenuItemConstructorOptions[];
}

describe("buildAppMenuTemplate", () => {
  const build = (openSettings = vi.fn()): MenuItemConstructorOptions[] =>
    buildAppMenuTemplate({ appName: "Sapiom", openSettings });

  it("puts Settings… under the app menu on ⌘, — where macOS users look for it", () => {
    const template = build();
    // The app menu is first: macOS renders template[0] as the bold app menu
    // whatever it is called, so its position is part of the contract.
    expect(template[0]?.label).toBe("Sapiom");
    const settings = submenuOf(template, "Sapiom").find((item) => item.label === "Settings…");
    expect(settings?.accelerator).toBe("CmdOrCtrl+,");
  });

  it("invokes the handler when Settings… is chosen", () => {
    const openSettings = vi.fn();
    const settings = submenuOf(build(openSettings), "Sapiom").find(
      (item) => item.label === "Settings…",
    );
    settings?.click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the Edit roles, without which ⌘C/⌘V do nothing in the SPA on macOS", () => {
    const roles = submenuOf(build(), "Edit").map((item) => item.role);
    expect(roles).toEqual(
      expect.arrayContaining(["undo", "redo", "cut", "copy", "paste", "selectAll"]),
    );
  });

  it("keeps quit reachable from the menu it lives in on macOS", () => {
    expect(submenuOf(build(), "Sapiom").map((item) => item.role)).toContain("quit");
  });
});
