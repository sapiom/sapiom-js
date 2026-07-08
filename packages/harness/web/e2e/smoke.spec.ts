/**
 * Mock-mode UI smoke test — runs against `vite dev` with VITE_MOCK=1 (see
 * playwright.config.ts), no harness server required. Fixtures live in
 * ../src/lib/mock-data.ts: 3 workflows (one deployed), a running "boot"
 * session (the server auto-creates one at launch) plus 2 exited sessions
 * kept around as resumable history, 5 macros, and a small fake filesystem
 * for the new-session directory picker.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders all four panes plus the brand header", async ({ page }) => {
  await expect(page.locator(".brand-header")).toBeVisible();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();
  await expect(page.locator(".rail-actions")).toBeVisible();

  await page.screenshot({ path: "web/e2e/screenshots/app-shell.png", fullPage: true });
});

test("viewport-locked shell: the page never scrolls even when terminal content overflows", async ({ page }) => {
  // Simulate a terminal that's rendered far more than the pane can show —
  // injected as a raw sibling in .terminal-slot (bypassing Terminal.tsx's own
  // overflow:hidden wrapper) so this also exercises the grid/flex containment
  // chain above it (.app, .center-pane), not just the terminal's own clipping.
  await page.evaluate(() => {
    const slot = document.querySelector(".terminal-slot");
    const filler = document.createElement("div");
    filler.setAttribute("data-testid", "scroll-stress-filler");
    filler.style.height = "6000px";
    slot?.appendChild(filler);
  });

  const root = await page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(root.scrollHeight).toBe(root.clientHeight);
});

test("theme: defaults to light, toggles to dark, and the choice persists across reload", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: "web/e2e/screenshots/theme-light.png", fullPage: true });

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "web/e2e/screenshots/theme-dark.png", fullPage: true });

  await page.reload();
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test.describe("theme — system preference", () => {
  test.use({ colorScheme: "dark" });

  test("honors prefers-color-scheme when there's no stored preference yet", async ({ page }) => {
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test("brand header shows the Sapiom wordmark and signed-in identity", async ({ page }) => {
  await expect(page.locator(".brand-name")).toHaveText("Sapiom");
  await expect(page.locator(".brand-product")).toHaveText("Harness");
  const identity = page.getByTestId("brand-identity");
  await expect(identity).toContainText("Acme (mock)");
  await expect(page.locator(".identity-dot")).toHaveAttribute("data-authenticated", "true");
});

test("auto-selects the running boot session on initial load", async ({ page }) => {
  // The server auto-creates a session in launchDir at boot — the app should
  // never open to an empty terminal pane.
  await expect(page.locator(".terminal-empty")).toHaveCount(0);
  await expect(page.getByTestId("session-dropdown-trigger")).not.toContainText("No session");
  await expect(page.locator(".session-dot[data-status='running']")).toBeVisible();
});

test("workflows rail lists the fixtures and selecting one drives macro gating", async ({ page }) => {
  await expect(page.locator(".workflow-item")).toHaveCount(3);

  // "leasing" is deployed (has a definitionId) — selecting it enables the deploy-link macro.
  const openProd = page.getByTestId("macro-open_prod");
  await page.getByTestId("workflow-leasing").click();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-selected/);
  await expect(openProd).toBeEnabled();

  // "rfq" has no definitionId — selecting it should disable the deploy-link macro again,
  // with a reason distinct from "no workflow selected".
  await page.getByTestId("workflow-rfq").click();
  await expect(page.getByTestId("workflow-rfq")).toHaveClass(/is-selected/);
  await expect(openProd).toBeDisabled();
  await expect(openProd).toHaveAttribute("data-tooltip", "Not deployed yet");

  await openProd.hover();
  await page.screenshot({ path: "web/e2e/screenshots/action-rail-tooltip.png" });
});

test("inject macros are enabled once the boot session and a deployed workflow are active", async ({ page }) => {
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-selected/);
  await expect(page.getByTestId("macro-run_local")).toBeEnabled();
  await expect(page.getByTestId("macro-deploy")).toBeEnabled();
});

test("new-session modal: directory picker navigates and validates", async ({ page }) => {
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByText("New session")).toBeVisible();

  const startButton = page.getByRole("button", { name: "Start session" });
  const input = page.getByTestId("dir-picker-input");

  // Seeded from launchDir; browsing shows its subdirectories.
  await expect(input).toHaveValue("/Users/demo/acme-app");
  await expect(page.getByTestId("dir-picker-item-leasing")).toBeVisible();

  // Type-ahead: an unrecognized tail filters the nearest real ancestor's children.
  await input.fill("/Users/demo/rf");
  await expect(page.getByTestId("dir-picker-item-rfq-workflows")).toBeVisible();
  await expect(page.getByTestId("dir-picker-item-onboarding-flow")).toHaveCount(0);

  // Clicking a listed directory drills into it.
  await page.getByTestId("dir-picker-item-rfq-workflows").click();
  await expect(input).toHaveValue("/Users/demo/rfq-workflows");
  await expect(page.getByTestId("dir-picker-item-src")).toBeVisible();

  // "Up" walks to the parent.
  await page.getByTestId("dir-picker-up").click();
  await expect(input).toHaveValue("/Users/demo");
  await expect(page.getByTestId("dir-picker-item-acme-app")).toBeVisible();

  await page.screenshot({ path: "web/e2e/screenshots/new-session-modal.png" });

  await input.fill("");
  await expect(startButton).toBeDisabled();
  await input.fill("/tmp/example-project");
  await expect(startButton).toBeEnabled();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("New session")).toBeHidden();
});

test("resuming a history entry switches the active session", async ({ page }) => {
  await page.getByTestId("session-dropdown-trigger").click();
  await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
  await expect(page.getByTestId("session-dropdown-trigger")).toContainText("Build the leasing pipeline");
});

test("canvas pane shows its empty state for the active session", async ({ page }) => {
  await expect(page.locator(".canvas-empty")).toContainText("Nothing rendered yet");
});

test("settings popover: identity, telemetry toggle, and it persists across close/reopen", async ({ page }) => {
  const trigger = page.getByTestId("settings-trigger");
  const toggle = page.getByTestId("telemetry-toggle");

  await trigger.click();
  const popover = page.getByTestId("settings-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("Acme (mock)");
  await expect(popover).toContainText("events.ndjson");
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Close" }).click();
  await expect(popover).toBeHidden();

  // Reopening should reflect the same (mutated) state, not reset to the fixture default.
  await trigger.click();
  await expect(page.getByTestId("telemetry-toggle")).toHaveAttribute("aria-checked", "true");
});

test("visualize macro prompts for a subject before running", async ({ page }) => {
  await expect(page.getByTestId("macro-visualize")).toBeEnabled();

  await page.getByTestId("macro-visualize").click();
  await expect(page.getByText("Visualize")).toBeVisible();
  const subjectInput = page.getByPlaceholder("What should the agent visualize?");
  await expect(subjectInput).toBeVisible();

  await subjectInput.fill("the leasing pipeline");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(subjectInput).toBeHidden();
});
