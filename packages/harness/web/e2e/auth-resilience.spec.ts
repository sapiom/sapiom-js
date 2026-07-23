/**
 * Auth-resilience Playwright e2e (SAP-1786).
 *
 * Scope: RESILIENCE only — recovery from a transient 401 and graceful
 * offline degrade/recover. This is DISTINCT from auth.spec.ts (D7), which
 * covers the in-app sign-in flow (settings Connect → auth.changed → chip
 * update). Nothing here exercises the sign-in flow or overlaps with D7.
 *
 * Two scenario groups:
 *
 *   1. 401 → no lockout
 *      The boot fetch fails once with a 401 (simulated via ?mockBoot401=1, a
 *      query param read by MockApi.getState() on its second call — which is the
 *      real boot fetch under React 18 StrictMode's double-effect invocation).
 *      The ConnectivityScreen appears with data-status="auth" — the honest
 *      "session needs a refresh" copy. Clicking Retry re-runs the boot fetch,
 *      which now succeeds (the call-count sentinel moves past 2). The shell
 *      loads normally: no white-screen, no hard lockout, no crash.
 *
 *   2. Offline → graceful degrade → recover
 *      After the shell loads, a browser offline event is dispatched. The
 *      ConnectivityBanner appears; the existing app content stays legible (no
 *      crash). Dismissing the banner closes it. A subsequent online event
 *      restores the expected connected state. The app is still interactive
 *      throughout — the shell never crashes or white-screens.
 *
 * Implementation notes:
 *   - Tests run in mock mode (VITE_MOCK=1, as configured in playwright.config.ts)
 *     so no harness server or real network is needed.
 *   - The 401 is triggered via ?mockBoot401=1, a query-param flag read by
 *     MockApi.getState() on its first call. The param is consumed exactly once
 *     (via a window flag) so clicking Retry drives a normal success, matching
 *     the real server-side withKeyRefreshRetry behaviour.
 *   - The offline/online events are dispatched inside page.evaluate() which
 *     runs in the page context — the browser-native events reach the
 *     useConnectivity hook's event listeners exactly as a real network drop
 *     would, without any window.fetch interception needed.
 */
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Suite 1: 401 boot → ConnectivityScreen(auth) → Retry → no lockout
// ---------------------------------------------------------------------------

test.describe("401 on boot → no lockout", () => {
  test.beforeEach(async ({ page }) => {
    // ?mockBoot401=1 makes MockApi.getState() throw ApiError(401) on its first
    // call (see api.ts). The flag is consumed once via a window sentinel so the
    // Retry-triggered second call succeeds and the shell loads normally.
    await page.goto("/?seed=0&mockBoot401=1");
  });

  test("a 401 boot shows the auth ConnectivityScreen, not a white-screen or hard lockout", async ({
    page,
  }) => {
    // The boot fetch failed with a 401 → the ConnectivityScreen must be
    // rendered with the auth status, not a blank page.
    const screen = page.getByTestId("connectivity-screen");
    await expect(screen).toBeVisible({ timeout: 5_000 });
    await expect(screen).toHaveAttribute("data-status", "auth");

    // The copy is honest: "Session needs a refresh" — not "Failed to load" or a
    // blank white-screen, not a cryptic JS stack trace.
    await expect(screen).toContainText("Session needs a refresh");

    // A Retry button is always present so the user has a path forward.
    const retryBtn = page.getByTestId("connectivity-retry");
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toBeEnabled();

    // The main shell is NOT rendered — the screen blocks, but doesn't crash.
    await expect(page.locator(".rail-workflows")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/auth-resilience-401-screen.png" });
  });

  test("clicking Retry after a 401 recovers: the ConnectivityScreen clears and the shell loads", async ({
    page,
  }) => {
    // Wait for the auth ConnectivityScreen (from the first failed boot).
    const screen = page.getByTestId("connectivity-screen");
    await expect(screen).toBeVisible({ timeout: 5_000 });
    await expect(screen).toHaveAttribute("data-status", "auth");

    // Retry re-runs the boot fetch. The flag was consumed on the first call,
    // so this second call succeeds and the shell loads normally.
    const retryBtn = page.getByTestId("connectivity-retry");
    await expect(retryBtn).toBeEnabled();
    await retryBtn.click();

    // Recovery: the ConnectivityScreen clears.
    await expect(screen).toHaveCount(0, { timeout: 6_000 });

    // The full shell renders — no lockout, no white-screen, no crash.
    await expect(page.locator(".rail-workflows")).toBeVisible({ timeout: 6_000 });

    await page.screenshot({ path: "web/e2e/screenshots/auth-resilience-after-retry.png" });
  });

  test("while the ConnectivityScreen is up the Retry button is not disabled (retryable, not stuck)", async ({
    page,
  }) => {
    const screen = page.getByTestId("connectivity-screen");
    await expect(screen).toBeVisible({ timeout: 5_000 });

    const retryBtn = page.getByTestId("connectivity-retry");
    await expect(retryBtn).toBeEnabled();
    // Not showing "Reconnecting…" — only disabled mid-flight, so the user can
    // always see the path forward before clicking.
    await expect(retryBtn).toHaveText("Retry");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: offline during session → ConnectivityBanner → dismiss → recover
// ---------------------------------------------------------------------------

test.describe("offline mid-session → graceful degrade", () => {
  test.beforeEach(async ({ page }) => {
    // Load normally (no 401 flag) — we want the full shell up before going offline.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible({ timeout: 8_000 });
  });

  test("going offline while the shell is loaded shows the ConnectivityBanner without crashing", async ({
    page,
  }) => {
    // Simulate a network drop: override navigator.onLine to false and dispatch
    // the native browser offline event — the same signals a real drop produces.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });

    // The ConnectivityBanner must appear — it is the only honest affordance for
    // a mid-session offline drop (the ConnectivityScreen is boot-only).
    const banner = page.getByTestId("connectivity-banner");
    await expect(banner).toBeVisible({ timeout: 3_000 });
    await expect(banner).toContainText("You're offline");

    // The shell stays intact: the rail and terminal pane are still rendered.
    // The app degrades gracefully — no crash, no white-screen.
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.locator(".center-pane")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/auth-resilience-offline-banner.png" });
  });

  test("the offline banner does not block the main shell: rail and pane remain visible", async ({
    page,
  }) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });

    const banner = page.getByTestId("connectivity-banner");
    await expect(banner).toBeVisible({ timeout: 3_000 });

    // The banner is non-blocking — it overlays as a thin strip, never a full-
    // screen blocker. The rail and main pane stay visible and interactive.
    // App.tsx does not pass onDismiss (the banner self-clears on reconnect).
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.locator(".center-pane")).toBeVisible();
    await expect(page.getByTestId("connectivity-banner-dismiss")).toHaveCount(0);
  });

  test("restoring connectivity after an offline drop clears the ConnectivityBanner", async ({
    page,
  }) => {
    // Go offline.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });

    const banner = page.getByTestId("connectivity-banner");
    await expect(banner).toBeVisible({ timeout: 3_000 });

    // Come back online: dispatch the native online event so useConnectivity
    // re-reads navigator.onLine = true and the banner unmounts.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      window.dispatchEvent(new Event("online"));
    });

    // Banner clears — connectivity is restored, no manual action needed.
    await expect(banner).toHaveCount(0, { timeout: 3_000 });

    // Shell is still fully usable after the drop+recover cycle.
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.locator(".center-pane")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/auth-resilience-online-recovered.png" });
  });

  test("an offline drop does not render the ConnectivityScreen (screen is boot-only)", async ({
    page,
  }) => {
    // The ConnectivityScreen is only shown when the BOOT fetch fails — a
    // mid-session drop must never replace the loaded shell with the full-screen
    // blocker. The ConnectivityBanner is the correct degraded surface here.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });

    const banner = page.getByTestId("connectivity-banner");
    await expect(banner).toBeVisible({ timeout: 3_000 });

    // The ConnectivityScreen must NOT appear during a mid-session offline drop.
    await expect(page.getByTestId("connectivity-screen")).toHaveCount(0);
  });

  test("the shell remains interactive while offline: focus agent, read session info", async ({
    page,
  }) => {
    // Go offline.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      window.dispatchEvent(new Event("offline"));
    });

    await expect(page.getByTestId("connectivity-banner")).toBeVisible({ timeout: 3_000 });

    // Shell interactions still work against last-known state — focus rfq agent.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-focused/);

    // Session context shows the honest "no session" state — offline doesn't
    // corrupt the UI or hide session information.
    await expect(page.getByTestId("session-context-title")).toHaveText("rfq");
    await expect(page.getByTestId("session-status-tag")).toContainText("no session");
  });
});
