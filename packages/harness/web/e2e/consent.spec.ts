/**
 * Playwright specs for consent-UI surfaces (Part 1b + 1c + 2f tracking assertions).
 *
 * Runs in mock mode (VITE_MOCK=1) — no harness server required.
 * Uses mockConsentSource and mockEnvReason query params to exercise all
 * chip states without a real server.
 *
 * Coverage:
 *   - Telemetry chip in BrandHeader (on / off / env states)
 *   - Chip click opens settings popover
 *   - TelemetryNotice shown for "default-silent", dismissed permanently
 *   - TelemetryNotice NOT shown for other consent sources
 *   - track("prompt.submitted") fires on prompt-bar submit
 *   - track("consent.changed") fires on toggle
 *   - track("session.created") fires on new session creation
 */
import { expect, test } from "@playwright/test";

type TestHarnessWindow = {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    trackEvents?: Array<{ event: string; data?: Record<string, unknown>; harnessSessionId?: string }>;
    lastInjectInput?: { id: string; req: { text: string; submit?: boolean } };
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

test.describe("telemetry chip in BrandHeader", () => {
  test("shows 'analytics off' chip when telemetryOptIn is false (stored-explicit)", async ({ page }) => {
    // Default mock: telemetryOptIn=false, consentSource=stored-explicit.
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const chip = page.getByTestId("telemetry-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-state", "off");
    await expect(chip.locator(".telemetry-chip-label")).toHaveText("analytics off");
  });

  test("shows 'analytics off (env)' chip when consentSource is env-forced-off", async ({ page }) => {
    await page.goto("/?mockConsentSource=env-forced-off&mockEnvReason=SAPIOM_TELEMETRY_DISABLED");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const chip = page.getByTestId("telemetry-chip");
    await expect(chip).toHaveAttribute("data-state", "env");
    await expect(chip.locator(".telemetry-chip-label")).toHaveText("analytics off (env)");
  });

  test("chip click opens the settings popover", async ({ page }) => {
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Settings popover should not be visible yet.
    await expect(page.getByTestId("settings-popover")).toHaveCount(0);

    // Click the chip.
    await page.getByTestId("telemetry-chip").click();

    // Settings popover should now be open.
    await expect(page.getByTestId("settings-popover")).toBeVisible();
  });

  test("chip reflects live telemetryOptIn — toggles on when the toggle is switched on", async ({ page }) => {
    await page.goto("/?mockConsentSource=stored-explicit");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const chip = page.getByTestId("telemetry-chip");
    await expect(chip).toHaveAttribute("data-state", "off");

    // Open settings and toggle telemetry on.
    await page.getByTestId("settings-trigger").click();
    await expect(page.getByTestId("settings-popover")).toBeVisible();
    await page.getByTestId("telemetry-toggle").click();

    // Wait for the chip to update (settings PATCH is async in mock).
    await expect(chip).toHaveAttribute("data-state", "on", { timeout: 3_000 });
    await expect(chip.locator(".telemetry-chip-label")).toHaveText("analytics on");
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

  test("prompt bar submit emits track('prompt.submitted') with length", async ({ page }) => {
    const textarea = page.locator(".prompt-bar-textarea");
    await textarea.click();
    await textarea.fill("Hello agent");
    await textarea.press("Enter");

    // Wait for the submit to record.
    await page.waitForFunction(
      () =>
        (window as unknown as TestHarnessWindow).__HARNESS_TEST__?.lastInjectInput?.req.text === "Hello agent",
    );

    // Now wait for the track event.
    await waitForTrackEvent(page, "prompt.submitted");
    const events = await getTrackEvents(page);
    const submitEvent = events.find((e) => e.event === "prompt.submitted");
    expect(submitEvent).toBeDefined();
    // Length should be the character count, never the text itself.
    expect(submitEvent?.data?.length).toBe("Hello agent".length);
    expect(submitEvent?.data?.text).toBeUndefined();
  });

  test("telemetry toggle emits track('consent.changed') with optIn value", async ({ page }) => {
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
