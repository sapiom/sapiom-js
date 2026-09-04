/**
 * The folder field, on both hosts.
 *
 * There is no in-app file browser any more: on the desktop app the OS folder
 * browser is the picker, and the `npx` browser host — which is what every other
 * spec here runs as — falls back to the field plus a native `<datalist>`.
 *
 * The desktop half is covered by INJECTING the bridge the Electron preload
 * exposes (`window.sapiomDesktop`). That is the same shape
 * `harness-desktop/src/preload/desktop.mts` publishes and the desktop smoke run
 * asserts, so this exercises the branch a mock browser run otherwise never
 * reaches — the one that now carries the whole picker.
 */
import { expect, test } from "@playwright/test";
import { openAddExistingAgents, openFolderStep } from "./mock-navigation";

/** Mirrors the preload's bridge, recording what the SPA asked for. */
const installDesktopBridge = async (
  page: import("@playwright/test").Page,
  picked: string | null,
): Promise<void> => {
  await page.addInitScript((choice: string | null) => {
    const calls: string[] = [];
    Object.assign(window, {
      __chooseCalls: calls,
      sapiomDesktop: {
        appVersion: "0.0.0-e2e",
        checkForUpdates: () =>
          Promise.resolve({ kind: "up-to-date", version: "0.0.0-e2e", channel: "e2e" }),
        chooseDirectory: (defaultPath?: string) => {
          calls.push(defaultPath ?? "");
          return Promise.resolve(choice);
        },
      },
    });
  }, picked);
};

const chooseCalls = (page: import("@playwright/test").Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __chooseCalls: string[] }).__chooseCalls ?? []);

test.describe("browser host (npx)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openFolderStep(page);
    await expect(page.locator(".modal-start")).toBeVisible();
  });

  test("no Choose button — a control that cannot work is never shown", async ({ page }) => {
    await expect(page.getByTestId("folder-field-choose")).toHaveCount(0);
  });

  test("the fallback still completes a path: the folder's children are offered", async ({
    page,
  }) => {
    /* THE SMALLEST FALLBACK THAT KEEPS THE FEATURE. A browser has no native
       dialog, so losing the in-app listing would otherwise leave a user
       reciting an absolute path from memory. A `<datalist>` is the browser's
       own completion — no path bar, no folder list of ours to drift. */
    const options = page.getByTestId("folder-field-options");
    await expect(
      options.locator('option[value="/Users/demo/acme-app/projects/leasing"]'),
    ).toHaveCount(1);

    // And it follows the field: retype, and the offered children change.
    await page.getByTestId("folder-field-input").fill("/Users/demo");
    await expect(
      page.getByTestId("folder-field-options").locator('option[value="/Users/demo/acme-app"]'),
    ).toHaveCount(1);
  });
});

test.describe("desktop host", () => {
  /* REACHED THROUGH THE ⋮, not the create verb. The verb's folder step now
     goes STRAIGHT to the OS folder browser when the bridge is there and opens
     no dialog at all (`lib/folder-step.ts`, unit-tested — Electron cannot run
     here). The detection dialog behind "Add existing agents" is a different
     question and still asks it in a panel, which is where `FolderField`'s own
     desktop behaviour — a Choose button and no datalist — still shows. */
  test("Choose opens the OS folder browser at the current folder, and takes its answer", async ({
    page,
  }) => {
    await installDesktopBridge(page, "/Users/demo/blank-slate");
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openAddExistingAgents(page);

    const input = page.getByTestId("folder-field-input");
    await expect(input).toHaveValue("/Users/demo/acme-app/projects");
    // No datalist on desktop: the OS dialog IS the completion there.
    await expect(page.getByTestId("folder-field-options")).toHaveCount(0);

    await page.getByTestId("folder-field-choose").click();
    // Opened where the user already is, rather than at some default root.
    expect(await chooseCalls(page)).toEqual(["/Users/demo/acme-app/projects"]);
    await expect(input).toHaveValue("/Users/demo/blank-slate");

    // And the choice drives the dialog, not just the field.
    await expect(page.getByTestId("open-project")).toBeEnabled();
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  });

  test("cancelling the OS dialog leaves the folder alone", async ({ page }) => {
    // `showOpenDialog` resolves null on cancel (harness-desktop/main/dialogs.ts),
    // and null must never be written into the field — a cancelled pick is not a
    // choice of "nothing".
    await installDesktopBridge(page, null);
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openAddExistingAgents(page);

    const input = page.getByTestId("folder-field-input");
    await page.getByTestId("folder-field-choose").click();
    expect(await chooseCalls(page)).toHaveLength(1);
    await expect(input).toHaveValue("/Users/demo/acme-app/projects");
    await expect(page.getByTestId("open-project")).toBeEnabled();
  });
});
