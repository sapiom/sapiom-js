/**
 * The folder step, on both hosts (flow-creation.md §4.1 step 2, D29).
 *
 * There is no in-app file browser: on the desktop app the OS folder browser
 * IS the folder step, called directly with no Studio dialog in front of it,
 * and the `npx` browser host (which is what every other spec here runs as)
 * falls back to the one-field dialog with a native `<datalist>`.
 *
 * The desktop half is covered by INJECTING the bridge the Electron preload
 * exposes (`window.sapiomDesktop`). That is the same shape
 * `harness-desktop/src/preload/desktop.mts` publishes and the desktop smoke run
 * asserts, so this exercises the branch a mock browser run otherwise never
 * reaches. `lib/folder-step.test.ts` is the pure half of the same proof.
 */
import { expect, test } from "@playwright/test";

/** Mirrors the preload's bridge, recording what the SPA asked for. */
const installDesktopBridge = async (
  page: import("@playwright/test").Page,
  picked: string | null,
): Promise<void> => {
  await page.addInitScript((choice: string | null) => {
    const calls: Array<string | undefined> = [];
    Object.assign(window, {
      __chooseCalls: calls,
      sapiomDesktop: {
        appVersion: "0.0.0-e2e",
        checkForUpdates: () =>
          Promise.resolve({ kind: "up-to-date", version: "0.0.0-e2e", channel: "e2e" }),
        chooseDirectory: (defaultPath?: string) => {
          calls.push(defaultPath);
          return Promise.resolve(choice);
        },
      },
    });
  }, picked);
};

const chooseCalls = (page: import("@playwright/test").Page): Promise<Array<string | undefined>> =>
  page.evaluate(() => (window as unknown as { __chooseCalls: Array<string | undefined> }).__chooseCalls ?? []);

test.describe("browser host (npx)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-add-project").click();
    await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
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
       own completion: no path bar, no folder list of ours to drift. The field
       opens EMPTY (Q8: no pre-chosen parent), so completion starts once a
       folder is typed. */
    await expect(page.getByTestId("folder-field-input")).toHaveValue("");
    await page.getByTestId("folder-field-input").fill("/Users/demo/acme-app/projects");
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
  test("Add project calls the OS folder browser directly and opens its answer as a project", async ({
    page,
  }) => {
    await installDesktopBridge(page, "/Users/demo/blank-slate");
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-add-project").click();

    // The picker was asked, with no pre-chosen parent (Q8) ...
    await expect.poll(() => chooseCalls(page)).toEqual([undefined]);
    // ... and no Studio dialog ever opened in front of it (D29).
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
    await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
    await expect(page.locator(".modal-start")).toHaveCount(0);
    // Add project stops there: no screen, no session.
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  });

  test("cancelling the OS dialog changes nothing", async ({ page }) => {
    // `showOpenDialog` resolves null on cancel (harness-desktop/main/dialogs.ts),
    // and a cancelled pick is not a choice of "nothing": no row, no dialog.
    await installDesktopBridge(page, null);
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const rows = await page.locator('[data-testid^="project-row-"]').count();
    await page.getByTestId("rail-add-project").click();

    await expect.poll(() => chooseCalls(page)).toHaveLength(1);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
    await expect(page.locator('[data-testid^="project-row-"]')).toHaveCount(rows);
  });
});
