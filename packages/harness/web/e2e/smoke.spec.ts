/**
 * Mock-mode UI smoke test — runs against `vite dev` with VITE_MOCK=1 (see
 * playwright.config.ts), no harness server required. Fixtures live in
 * ../src/lib/mock-data.ts: 3 workflows (one deployed), 2 sessions (both
 * start exited — a fresh launch has no running terminal yet), 5 macros.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("renders all four panes", async ({ page }) => {
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.locator(".center-pane")).toBeVisible();
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".canvas-pane")).toBeVisible();
  await expect(page.locator(".rail-actions")).toBeVisible();

  await page.screenshot({ path: "web/e2e/screenshots/app-shell.png", fullPage: true });
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
});

test("inject macros are disabled with a reason before any session is active", async ({ page }) => {
  // No session is active on load (fixtures start exited) — a workflow is auto-selected,
  // so the reason should be about the session, not the workflow.
  const runLocal = page.getByTestId("macro-run_local");
  await expect(runLocal).toBeDisabled();
  await expect(runLocal).toHaveAttribute("data-tooltip", "Start a session first");

  // The deploy-link macro doesn't touch a pty, so it isn't gated on a session.
  await expect(page.getByTestId("macro-open_prod")).toBeEnabled();

  await runLocal.hover();
  await page.screenshot({ path: "web/e2e/screenshots/action-rail-tooltip.png" });
});

test("new-session modal opens and validates the directory field", async ({ page }) => {
  await page.getByTestId("new-session-btn").click();
  await expect(page.getByText("New session")).toBeVisible();

  const startButton = page.getByRole("button", { name: "Start session" });
  const cwdInput = page.locator("#new-session-cwd");

  await cwdInput.fill("");
  await expect(startButton).toBeDisabled();

  await cwdInput.fill("/tmp/example-project");
  await expect(startButton).toBeEnabled();

  await page.screenshot({ path: "web/e2e/screenshots/new-session-modal.png" });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("New session")).toBeHidden();
});

test("canvas pane shows its empty state when there's no active session", async ({ page }) => {
  await expect(page.locator(".canvas-empty")).toContainText("Start a session to see its canvas here");
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
  // Resume a history entry so the session-gated macro is enabled.
  await page.getByTestId("session-dropdown-trigger").click();
  await page.getByTestId("history-8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f").click();
  await expect(page.getByTestId("macro-visualize")).toBeEnabled();

  await page.getByTestId("macro-visualize").click();
  await expect(page.getByText("Visualize")).toBeVisible();
  const subjectInput = page.getByPlaceholder("What should the agent visualize?");
  await expect(subjectInput).toBeVisible();

  await subjectInput.fill("the leasing pipeline");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(subjectInput).toBeHidden();
});
