/**
 * The folder field, on both hosts.
 *
 * There is no in-app file browser any more: on the desktop app the OS folder
 * browser is the picker, and the `npx` browser host — which is what every other
 * spec here runs as — falls back to the field plus a native `<datalist>`.
 *
 * On desktop the bridge now decides whether our dialog opens AT ALL, not just
 * what renders inside it, so the two hosts no longer share one entrance: "Add
 * a project" asks the OS directly, while "Add existing agents" keeps the dialog
 * because it has to show what it found under the folder.
 *
 * The desktop half is covered by INJECTING the bridge the Electron preload
 * exposes (`window.sapiomDesktop`). That is the same shape
 * `harness-desktop/src/preload/desktop.mts` publishes and the desktop smoke run
 * asserts, so this exercises the branch a mock browser run otherwise never
 * reaches — the one that now carries the whole picker.
 */
import { expect, test } from "@playwright/test";

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
    await page.getByTestId("rail-add-project").click();
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
  test("Add a project skips our dialog and asks the OS, at the current root", async ({
    page,
  }) => {
    await installDesktopBridge(page, "/Users/demo/blank-slate");
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-add-project").click();

    // THE DIALOG NEVER OPENS on this host. Asserted first and asserted at all
    // because the failure this guards is showing BOTH — our modal wrapping a
    // text field, with the OS browser as a button inside it.
    await expect(page.locator(".modal-start")).toHaveCount(0);
    // Opened where the user already is, rather than at some default root.
    expect(await chooseCalls(page)).toEqual(["/Users/demo/acme-app/projects"]);
    // And the answer is the whole interaction: the project is added, with no
    // confirm step, because picking a folder in Finder already was the confirm.
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
  });

  test("cancelling the OS dialog adds nothing and opens nothing", async ({
    page,
  }) => {
    // `showOpenDialog` resolves null on cancel (harness-desktop/main/dialogs.ts).
    // A cancelled pick must not fall back into our dialog: the user declined
    // the question, not the way it was asked.
    await installDesktopBridge(page, null);
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-add-project").click();

    expect(await chooseCalls(page)).toHaveLength(1);
    await expect(page.locator(".modal-start")).toHaveCount(0);
    await expect(page.getByTestId("project-row-blank-slate")).toHaveCount(0);
  });

  test("a slow open does not yank the view off a project chosen while waiting", async ({
    page,
  }) => {
    /* THE DIALOG USED TO BE THE LOCK. While it was open the rail was behind a
       modal, so "add a folder" could not overlap "select a project". Opening
       the OS picker instead hands the rail back the moment it closes, and the
       scan behind it is the slow part — so the two DO overlap now, and the
       later choice has to win.

       Not a contrived window: the mock's scan takes 250ms, and a real one
       walks a tree. */
    await installDesktopBridge(page, "/Users/demo/blank-slate");
    // `mockStudioProjects=present` because the competing choice has to be a
    // durable project — a selectable map is what the finishing scan overrides.
    await page.goto("/?mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const other = page.getByTestId("project-select-acme-app");
    await expect(other).toBeVisible();

    // No awaits between these two: the second click has to land inside the
    // first one's scan, which is the whole point.
    await page.getByTestId("rail-add-project").click();
    await other.click();

    // The open still COMPLETES — the folder is added, because the user did ask
    // for it. Only the navigation to it is dropped.
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();

    /* SETTLE FIRST, THEN ASSERT, and that ordering is the test.
       `toHaveAttribute` retries until it matches and returns on the first
       pass, so asserting straight after the row appears is satisfied by the
       state BEFORE the stale navigation lands — it passed against the
       unfixed build. The override arrives a few frames later, after the
       preference read that follows the scan, so the wait is what gives it
       the chance to happen. */
    await page.waitForTimeout(1500);
    await expect(other).toHaveAttribute("aria-pressed", "true");
    // Stated from the other side too: the late arrival must not have taken
    // the selection for itself.
    await expect(
      page.getByTestId("project-select-blank-slate"),
    ).toHaveAttribute("aria-pressed", "false");
  });

  test("the field's own Choose still serves the entrance that keeps a dialog", async ({
    page,
  }) => {
    // "Add existing agents" has to show what it found under the folder, so the
    // picker is only its first step and the dialog stays on both hosts. That
    // keeps `FolderField`'s desktop branch reachable, so it is still covered
    // here rather than deleted with the entrance that stopped using it.
    await installDesktopBridge(page, "/Users/demo/blank-slate");
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("add-existing-agents").click();
    await expect(page.locator(".modal-start")).toBeVisible();

    const input = page.getByTestId("folder-field-input");
    // No datalist on desktop: the OS dialog IS the completion there.
    await expect(page.getByTestId("folder-field-options")).toHaveCount(0);

    await page.getByTestId("folder-field-choose").click();
    expect(await chooseCalls(page)).toHaveLength(1);
    await expect(input).toHaveValue("/Users/demo/blank-slate");
  });
});
