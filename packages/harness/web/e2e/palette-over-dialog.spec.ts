/**
 * The command palette's shortcut over an open dialog.
 *
 * Recovered from #803 (e2ec3112f, f91127314), which never reached `main`.
 * `App.tsx`'s hotkey handler owns both ⌘K and ⌘P and opened the palette on
 * either, unconditionally. Over an open dialog that stacked one focus-trapping
 * surface on another, and native Tab then walked out of the palette into the
 * dialog behind it. The guard keeps the shortcut inert while a dialog is up,
 * swallows the key rather than handing it to the browser (⌘P is PRINT), and
 * leaves the Overview alone: the palette is deliberately reachable over it.
 */
import { expect, test } from "@playwright/test";

test.describe("⌘K over an open dialog", () => {
  test.beforeEach(async ({ page }) => {
    // The legacy payload, because it is the one that still offers a dialog
    // from the rail: the row's New agent opens `CreateAgentDialog`.
    await page.goto("/?seed=0&mockStudioProjects=absent");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("the palette does not stack on top of a dialog", async ({ page }) => {
    // Found by the dialog-shell work (#800), which stopped at `App.tsx` rather
    // than reaching into it. The pane-collapse hotkey directly above the ⌘K
    // handler already bails when a layer is open; ⌘K did not, so the palette
    // opened over the dialog and native Tab then walked out of the palette into
    // the dialog behind it. `CommandPalette` carries no `role`, so the guard has
    // to match `.modal-backdrop` — a role-only selector cannot see it.
    await page.getByTestId("project-create-agent-acme-app").click();
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette-input")).toHaveCount(0);
    // The dialog is still the top layer and still the thing that has focus.
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    // And the shortcut is not broken — it works again once the layer is gone.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("create-agent-dialog")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette-input")).toBeVisible();
  });

  test("⌘P over a dialog is swallowed, not handed to the browser", async ({
    page,
  }) => {
    // THE SAME HANDLER OWNS ⌘P, and ⌘P is the browser's PRINT shortcut. A guard
    // that returns early WITHOUT preventing the event stops the palette and
    // hands ⌘P to the browser, which opens a native print preview over the
    // dialog — worse than the stacking it was added to stop, and invisible to a
    // spec that only presses ⌘K.
    //
    // `defaultPrevented` IS THE ASSERTION, not `beforeprint`. Headless Chromium
    // never fires `beforeprint` for an unhandled Ctrl+P, so a spec written that
    // way passes whether or not the event was prevented — measured: it survived
    // its own mutation. This listener is registered after the app's (same
    // target, `window`, so registration order decides), and reads what the app
    // left behind.
    await page.evaluate(() => {
      const win = window as unknown as { __printKey?: boolean | null };
      win.__printKey = null;
      window.addEventListener("keydown", (event) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        if (event.key.toLowerCase() !== "p") return;
        // READ AFTER DISPATCH, not during. The app re-subscribes its handler on
        // re-render, so a listener added from a spec is not reliably last and
        // reading `defaultPrevented` inline can sample before the app has acted.
        // The flag stays set on the event object once dispatch completes.
        setTimeout(() => {
          win.__printKey = event.defaultPrevented;
        }, 0);
      });
    });

    await page.getByTestId("project-create-agent-acme-app").click();
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+p");
    await expect(page.getByTestId("command-palette-input")).toHaveCount(0);
    await expect(page.getByTestId("create-agent-dialog")).toBeVisible();
    // Seen by the listener, and prevented by the app during dispatch.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __printKey?: boolean | null }).__printKey,
        ),
      )
      .toBe(true);
  });

  test("the Overview is carved out: ⌘K still opens the palette over it", async ({
    page,
  }) => {
    // The Overview wears `role="dialog"` and `aria-modal="true"` like any
    // dialog, and the palette is deliberately reachable over it — navigating
    // from the palette dismisses the Overview rather than stacking behind it
    // (`welcome.spec.ts`). A guard written on roles alone would break that; the
    // carve-out is per clause, and this is the spec that fails if it is dropped.
    await page.getByTestId("brand-identity").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await page.getByTestId("rail-overview").click();
    await expect(page.getByTestId("overview-modal")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette-input")).toBeVisible();
  });
});
