/**
 * Display mode (Settings → Display mode), in mock mode (VITE_MOCK=1).
 *
 * What only a browser can prove: that the choice reaches `[data-theme]` — the
 * attribute the whole stylesheet keys on — and that "System" then tracks the
 * OS appearance changing WHILE the app is open, rather than being read once at
 * startup. Persistence across a real quit is the server's half and is covered
 * in src/cli/settings.test.ts and src/server/static.test.ts.
 */
import { expect, test, type Page } from "@playwright/test";

const openSettings = async (page: Page): Promise<void> => {
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("settings-trigger").click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();
};

const theme = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.dataset.theme ?? null);

test.describe("display mode", () => {
  test("Light and Dark pin the theme, whatever the OS is doing", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openSettings(page);

    await page.getByTestId("display-mode-light").click();
    await expect.poll(() => theme(page)).toBe("light");
    await expect(page.getByTestId("display-mode-light")).toHaveAttribute("aria-checked", "true");

    await page.getByTestId("display-mode-dark").click();
    await expect.poll(() => theme(page)).toBe("dark");

    // Still dark with a light OS: pinned means pinned.
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => theme(page)).toBe("dark");
  });

  test("System follows the OS, and keeps following it while the app runs", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openSettings(page);

    await page.getByTestId("display-mode-system").click();
    await expect.poll(() => theme(page)).toBe("light");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => theme(page)).toBe("dark");
    // The SETTING is still "system" — it is a different fact from the theme it
    // currently resolves to, and the panel must go on showing the choice.
    await expect(page.getByTestId("display-mode-system")).toHaveAttribute("aria-checked", "true");
  });
});
