/**
 * Playwright specs for consent-UI surfaces (Part 1b + 1c + 2f tracking assertions).
 *
 * Runs in mock mode (VITE_MOCK=1) — no harness server required.
 * Uses mockConsentSource and mockEnvReason query params to exercise all
 * consent states without a real server.
 *
 * Coverage:
 *   - Consent setting in the settings popover (off / on / env-forced-off);
 *     the account menu carries NO analytics chip anymore
 *   - TelemetryNotice shown for "default-silent", dismissed permanently
 *   - TelemetryNotice NOT shown for other consent sources
 *   - track("consent.changed") fires on toggle
 *   - track("session.created") fires on new session creation
 */
import { expect, test } from "@playwright/test";

type TestHarnessWindow = {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    trackEvents?: Array<{ event: string; data?: Record<string, unknown>; harnessSessionId?: string }>;
  };
};

/** Wait for at least one track event matching the given event name. */
async function waitForTrackEvent(page: import("@playwright/test").Page, eventName: string) {
  await page.waitForFunction(
    (name: string) => {
      const win = window as unknown as TestHarnessWindow;
      return (win.__HARNESS_TEST__?.trackEvents ?? []).some((e) => e.event === name);
    },
    eventName,
    { timeout: 5_000 },
  );
}

/** Read all captured track events. */
async function getTrackEvents(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    return (window as unknown as TestHarnessWindow).__HARNESS_TEST__?.trackEvents ?? [];
  });
}

// Consent lives in the settings popover, reached through the account menu.
const openSettings = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.getByTestId("brand-identity").click();
  await expect(page.getByTestId("profile-menu")).toBeVisible();
  await page.getByTestId("settings-trigger").click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();
};

test.describe("consent setting in the settings popover", () => {
  test("the account menu carries no analytics chip; consent lives in settings", async ({ page }) => {
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // The chip is gone from every surface, including the account menu.
    await page.getByTestId("brand-identity").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await expect(page.getByTestId("telemetry-chip")).toHaveCount(0);

    // The setting itself is one more click away, in the settings popover.
    await page.getByTestId("settings-trigger").click();
    await expect(page.getByTestId("settings-popover")).toBeVisible();
    await expect(page.getByTestId("telemetry-toggle")).toBeVisible();
  });

  test("stored-explicit off: the toggle is off and editable", async ({ page }) => {
    // Default mock: telemetryOptIn=false, consentSource=stored-explicit.
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openSettings(page);
    const toggle = page.getByTestId("telemetry-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    await expect(page.getByTestId("telemetry-env-note")).toHaveCount(0);
  });

  test("env-forced-off: the toggle is off, locked, and the note names the env var", async ({ page }) => {
    await page.goto("/?mockConsentSource=env-forced-off&mockEnvReason=SAPIOM_TELEMETRY_DISABLED");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openSettings(page);
    const toggle = page.getByTestId("telemetry-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeDisabled();
    // A locked control always says why and names the way out.
    const note = page.getByTestId("telemetry-env-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("$SAPIOM_TELEMETRY_DISABLED");
    await expect(note).toContainText("Unset it");
  });

  test("prompted: the toggle reflects the yes answered at the CLI", async ({ page }) => {
    // "prompted" sets telemetryOptIn:true in the mock — mirrors a user who answered yes at the CLI.
    await page.goto("/?mockConsentSource=prompted");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openSettings(page);
    const toggle = page.getByTestId("telemetry-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toBeEnabled();
    await expect(page.getByTestId("telemetry-env-note")).toHaveCount(0);
  });

  test("the toggle reflects live telemetryOptIn after switching it on", async ({ page }) => {
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await openSettings(page);
    const toggle = page.getByTestId("telemetry-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();

    // The settings PATCH is async in mock; the switch settles on.
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 3_000 });
  });
});

test.describe("TelemetryNotice — first-run notice", () => {
  test("shows TelemetryNotice when consentSource is default-silent", async ({ page }) => {
    await page.goto("/?mockConsentSource=default-silent");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await expect(page.getByTestId("telemetry-notice")).toBeVisible();
  });

  test("does NOT show TelemetryNotice when consentSource is stored-explicit", async ({ page }) => {
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await expect(page.getByTestId("telemetry-notice")).toHaveCount(0);
  });

  test("does NOT show TelemetryNotice when consentSource is env-forced-off", async ({ page }) => {
    await page.goto("/?mockConsentSource=env-forced-off");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await expect(page.getByTestId("telemetry-notice")).toHaveCount(0);
  });

  test("does NOT show TelemetryNotice when consentSource is prompted", async ({ page }) => {
    await page.goto("/?mockConsentSource=prompted");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await expect(page.getByTestId("telemetry-notice")).toHaveCount(0);
  });

  test("dismissing the notice hides it immediately", async ({ page }) => {
    await page.goto("/?mockConsentSource=default-silent");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const notice = page.getByTestId("telemetry-notice");
    await expect(notice).toBeVisible();

    await page.getByTestId("telemetry-notice-dismiss").click();
    await expect(notice).toHaveCount(0);
  });

  test("notice 'Settings' link opens the settings popover and closes the notice", async ({ page }) => {
    await page.goto("/?mockConsentSource=default-silent");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await expect(page.getByTestId("telemetry-notice")).toBeVisible();
    await expect(page.getByTestId("settings-popover")).toHaveCount(0);

    // Click the "Settings" link inside the notice.
    await page.locator(".telemetry-notice-settings-link").click();

    // Popover opens, notice closes.
    await expect(page.getByTestId("settings-popover")).toBeVisible();
    await expect(page.getByTestId("telemetry-notice")).toHaveCount(0);
  });
});

test.describe("UI event tracking (track() calls)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("telemetry toggle emits track('consent.changed') with optIn value", async ({ page }) => {
    await page.getByTestId("brand-identity").click();
    await page.getByTestId("settings-trigger").click();
    await expect(page.getByTestId("settings-popover")).toBeVisible();

    // Toggle is off by default in mock mode; clicking turns it on.
    await page.getByTestId("telemetry-toggle").click();

    await waitForTrackEvent(page, "consent.changed");
    const events = await getTrackEvents(page);
    const toggleEvent = events.find((e) => e.event === "consent.changed");
    expect(toggleEvent).toBeDefined();
    expect(toggleEvent?.data?.optIn).toBe(true);
  });

  test("new session creation emits track('session.created')", async ({ page }) => {
    // Open new session modal.
    await page.getByTestId("history-trigger").click();
    await page.getByTestId("new-session-btn").click();
    await expect(page.locator(".modal-new-session")).toBeVisible();

    // Use the existing MOCK_LAUNCH_DIR path from the picker.
    // The directory field is prefilled — just click Start.
    const startBtn = page.locator(".modal-new-session .btn-primary");
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // Wait for the modal to close (session created successfully in mock).
    await expect(page.locator(".modal-new-session")).toHaveCount(0, { timeout: 3_000 });

    await waitForTrackEvent(page, "session.created");
    const events = await getTrackEvents(page);
    expect(events.some((e) => e.event === "session.created")).toBe(true);
  });
});
