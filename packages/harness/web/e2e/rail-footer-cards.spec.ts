/**
 * Mock-tier Playwright e2e for the rail footer's two cards.
 *
 * Plan card: MockApi.getAccountPlan() serves the demo fixture (Free plan,
 * $12.40 / $50 — the spend-vs-limit readout), so mock mode renders the card's
 * fullest honest state: name + money line + Upgrade pill + overflow menu of
 * billing deep links.
 *
 * Update card: browsers have no desktop bridge, so the card must be absent by
 * default. To exercise it we inject a FAKE window.sapiomDesktop before the app
 * loads (addInitScript — the same slot the Electron preload occupies) whose
 * onUpdateState hands us the push callback. That mirrors the real protocol:
 * the desktop app pushes downloaded-state; the card renders; a click calls
 * checkForUpdates() (which in the real app re-raises the main-process-owned
 * update window — there is no in-page apply, by design); a `none` push
 * retracts it.
 */
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Plan card
// ---------------------------------------------------------------------------

test.describe("plan card", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("renders the mock plan with the spend-vs-limit readout", async ({ page }) => {
    const card = page.getByTestId("plan-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Free plan");
    await expect(page.getByTestId("plan-balance")).toHaveText("$12.40 / $50");
  });

  test("Upgrade is a billing deep link", async ({ page }) => {
    const upgrade = page.getByTestId("plan-upgrade");
    await expect(upgrade).toBeVisible();
    await expect(upgrade).toHaveText("Upgrade");
    await expect(upgrade).toHaveAttribute(
      "href",
      "https://app.sapiom.ai/settings?tab=billing",
    );
    // New tab, never a navigation that tears down live sessions.
    await expect(upgrade).toHaveAttribute("target", "_blank");
  });

  test("the overflow menu offers the two billing links and dismisses", async ({ page }) => {
    await page.getByTestId("plan-menu-trigger").click();
    const menu = page.getByTestId("plan-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("plan-manage-billing")).toBeVisible();
    await expect(page.getByTestId("plan-view-usage")).toBeVisible();
    // Escape dismisses (the shared AnchoredPopover contract).
    await page.keyboard.press("Escape");
    await expect(menu).not.toBeVisible();
  });

  test("keeps the readout clear of the Upgrade pill at the rail's minimum width", async ({
    page,
  }) => {
    await page.evaluate(() => {
      localStorage.setItem("sapiom-harness-pane-widths", JSON.stringify({ rail: 180 }));
    });
    await page.reload();
    await expect(page.getByTestId("plan-card")).toBeVisible();

    // The copy column shrinks with the rail, so the money line has to clip:
    // painted at full length it runs straight under the CTA beside it.
    const readout = page.getByTestId("plan-balance");
    const clipped = await readout.evaluate((el) => el.scrollWidth > el.clientWidth);
    const readoutBox = (await readout.boundingBox())!;
    const upgradeBox = (await page.getByTestId("plan-upgrade").boundingBox())!;
    expect(readoutBox.x + readoutBox.width, "readout ends before the pill").toBeLessThanOrEqual(
      upgradeBox.x + 0.5,
    );
    expect(clipped, "a value with nowhere to go is ellipsised, not overflowing").toBe(true);
  });

  test("sits above the account row inside one footer block", async ({ page }) => {
    const footer = page.locator(".rail-footer");
    await expect(footer.getByTestId("plan-card")).toBeVisible();
    await expect(footer.getByTestId("brand-identity")).toBeVisible();
    const cardBox = await footer.getByTestId("plan-card").boundingBox();
    const accountBox = await footer.getByTestId("brand-identity").boundingBox();
    expect(cardBox && accountBox && cardBox.y < accountBox.y).toBe(true);
    await footer.screenshot({ path: "web/e2e/screenshots/rail-footer-plan-card.png" });
  });
});

// ---------------------------------------------------------------------------
// Update card
// ---------------------------------------------------------------------------

/** The fake bridge's bookkeeping, visible to page.evaluate. */
declare global {
  interface Window {
    __updateChecks?: number;
    __pushUpdateState?: (state: { kind: string; version?: string }) => void;
  }
}

test.describe("update card", () => {
  test("is absent in a plain browser (no bridge)", async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("update-card")).toHaveCount(0);
  });

  test("appears on a downloaded push, clicks through the bridge, retracts on none", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__updateChecks = 0;
      (window as unknown as { sapiomDesktop: unknown }).sapiomDesktop = {
        appVersion: "0.4.1",
        checkForUpdates: () => {
          window.__updateChecks = (window.__updateChecks ?? 0) + 1;
          // The expected answer while an update is pending — the real main
          // process ALSO re-raises its update window here, which a page test
          // can't see and doesn't need to.
          return Promise.resolve({ kind: "downloaded", version: "0.4.2" });
        },
        onUpdateState: (cb: (state: { kind: string; version?: string }) => void) => {
          window.__pushUpdateState = cb;
          return () => {};
        },
      };
    });
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Nothing pushed yet — no card, even with a bridge present.
    await expect(page.getByTestId("update-card")).toHaveCount(0);

    // The desktop app announces a downloaded update → the card appears with
    // the TARGET version (not the running appVersion).
    await page.evaluate(() =>
      window.__pushUpdateState?.({ kind: "downloaded", version: "0.4.2" }),
    );
    const card = page.getByTestId("update-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Update now");
    await expect(page.getByTestId("update-card-version")).toHaveText("v0.4.2");
    // Both cards settled (the plan card's mock fetch resolves ~150ms after
    // load) before the footer portrait — the screenshot is the full stack.
    await expect(page.getByTestId("plan-card")).toBeVisible();
    await page
      .locator(".rail-footer")
      .screenshot({ path: "web/e2e/screenshots/rail-footer-update-card.png" });

    // Click → exactly one checkForUpdates() round-trip, and the card STAYS
    // (it outlives "Later"; only a state push removes it).
    await card.click();
    await expect
      .poll(() => page.evaluate(() => window.__updateChecks))
      .toBe(1);
    await expect(card).toBeVisible();

    // A `none` push (failed apply cleared pending) retracts the card.
    await page.evaluate(() => window.__pushUpdateState?.({ kind: "none" }));
    await expect(page.getByTestId("update-card")).toHaveCount(0);
  });
});
