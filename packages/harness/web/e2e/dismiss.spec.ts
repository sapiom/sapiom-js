/**
 * Light-dismiss behavior for the popovers/dropdowns (and the new-session
 * modal): clicking anywhere outside or pressing Escape closes them, and
 * Escape hands focus back to the trigger. Runs in the same mock mode as
 * smoke.spec.ts.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test.describe("session history dropdown", () => {
  test("closes on a click anywhere outside", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    const menu = page.getByTestId("history-menu");
    await expect(menu).toBeVisible();

    // Clicking inside the menu must NOT dismiss it (section headers are inert).
    await menu.getByText("Exited", { exact: true }).click();
    await expect(menu).toBeVisible();

    await page.locator(".brand-name").click();
    await expect(menu).toBeHidden();
  });

  test("closes on Escape and returns focus to the trigger", async ({ page }) => {
    await page.getByTestId("history-trigger").click();
    await expect(page.getByTestId("history-menu")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("history-menu")).toBeHidden();
    await expect(page.getByTestId("history-trigger")).toBeFocused();
  });

  test("the trigger still toggles it closed", async ({ page }) => {
    const trigger = page.getByTestId("history-trigger");
    await trigger.click();
    await expect(page.getByTestId("history-menu")).toBeVisible();
    await trigger.click();
    await expect(page.getByTestId("history-menu")).toBeHidden();
  });
});

test.describe("settings popover", () => {
  test("closes on a click anywhere outside", async ({ page }) => {
    await page.getByTestId("settings-trigger").click();
    const popover = page.getByTestId("settings-popover");
    await expect(popover).toBeVisible();

    // Interacting inside (the telemetry toggle) must NOT dismiss it.
    await page.getByTestId("telemetry-toggle").click();
    await expect(popover).toBeVisible();

    await page.locator(".brand-name").click();
    await expect(popover).toBeHidden();
  });

  test("closes on Escape and returns focus to the trigger", async ({ page }) => {
    await page.getByTestId("settings-trigger").click();
    await expect(page.getByTestId("settings-popover")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-popover")).toBeHidden();
    await expect(page.getByTestId("settings-trigger")).toBeFocused();
  });
});

test.describe("new-session modal", () => {
  test("closes on Escape and returns focus to the trigger", async ({ page }) => {
    await page.getByTestId("new-session-btn").click();
    await expect(page.getByText("New session")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText("New session")).toBeHidden();
    await expect(page.getByTestId("new-session-btn")).toBeFocused();
  });

  test("still closes on a backdrop click, but not on clicks inside the panel", async ({ page }) => {
    await page.getByTestId("new-session-btn").click();
    await expect(page.getByText("New session")).toBeVisible();

    await page.getByTestId("dir-picker-input").click();
    await expect(page.getByText("New session")).toBeVisible();

    // The panel is centered, so the backdrop's top-left corner is outside it.
    await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.getByText("New session")).toBeHidden();
  });
});
