/**
 * E2E tests for the run-input dialog:
 *  - Clicking Local Run / Prod Run opens the dialog (not a direct fire).
 *  - Dialog opens prefilled (default: '{}' when no last-used, no graph).
 *  - User can type custom JSON and run — dialog fires with that input.
 *  - Invalid JSON shows an inline error; the run does NOT fire.
 *  - Cancel closes the dialog without firing.
 *  - Pressing Escape closes the dialog.
 *  - Last-used input is shown on reopen (localStorage persistence).
 *  - Prod Run: input flows through to the mock api.run() call.
 *  - Local Run: input flows through to the mock api.runLocal() call.
 *
 * All tests run in mock mode (VITE_MOCK=1 — see playwright.config.ts) with
 * no real server, no agent process, and no API key.
 */
import { expect, test } from "@playwright/test";

type HarnessTestWindow = {
  __HARNESS_TEST__?: {
    lastDirectAction?: { action: string; req: Record<string, unknown> };
    directActions?: Array<{ action: string; req: Record<string, unknown> }>;
    lastMacroRun?: { id: string; req: Record<string, unknown> };
  };
};

async function readTestHook(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as HarnessTestWindow).__HARNESS_TEST__);
}

async function waitForDirectAction(
  page: import("@playwright/test").Page,
): Promise<{ action: string; req: Record<string, unknown> }> {
  await page.waitForFunction(
    () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.lastDirectAction,
    { timeout: 8_000 },
  );
  const hook = await readTestHook(page);
  return hook!.lastDirectAction!;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  // The boot session is bound to leasing (deployed) — action bar is live.
  await expect(page.getByTestId("session-steps")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
});

// ---------------------------------------------------------------------------
// Dialog opens on button click (not direct fire)
// ---------------------------------------------------------------------------

test.describe("dialog opens on button click", () => {
  test("clicking Local Run opens the run-input dialog", async ({ page }) => {
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();
    await localBtn.click();

    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });
    // Cancelling closes the dialog without firing.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();
  });

  test("clicking Prod Run opens the run-input dialog", async ({ page }) => {
    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });
    // Cancelling closes the dialog.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();
  });

  test("dialog is prefilled with '{}' by default (no last-used, no graph)", async ({ page }) => {
    await page.getByTestId("session-step-local").click();
    const dialog = page.getByTestId("run-input-dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const editor = page.getByTestId("run-input-editor");
    const value = await editor.inputValue();
    // Default is {} — should parse successfully as an empty object.
    expect(() => JSON.parse(value)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation — invalid JSON shows inline error, no run fires
// ---------------------------------------------------------------------------

test.describe("JSON validation", () => {
  test("invalid JSON shows inline error and does NOT fire the run", async ({ page }) => {
    const localBtn = page.getByTestId("session-step-local");
    await localBtn.click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    // Type invalid JSON into the editor.
    const editor = page.getByTestId("run-input-editor");
    await editor.fill("{bad json");

    // Click Run — should show an error, not fire.
    await page.getByTestId("run-input-submit").click();

    // Inline error must appear.
    await expect(page.getByTestId("run-input-error")).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId("run-input-error")).toContainText(/Invalid JSON/i);

    // Dialog must still be open.
    await expect(page.getByTestId("run-input-dialog")).toBeVisible();

    // No direct action should have fired.
    const hook = await readTestHook(page);
    expect(hook?.lastDirectAction).toBeUndefined();
  });

  test("error clears when the user edits the JSON", async ({ page }) => {
    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    const editor = page.getByTestId("run-input-editor");
    await editor.fill("{bad");
    await page.getByTestId("run-input-submit").click();
    await expect(page.getByTestId("run-input-error")).toBeVisible();

    // Fix the JSON — error should clear.
    await editor.fill('{"topic": "birds"}');
    await expect(page.getByTestId("run-input-error")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Input flows through to the run — Prod Run
// ---------------------------------------------------------------------------

test.describe("Prod Run — input flows through to the mock", () => {
  test("Run with custom JSON: the mock api.run() receives the input", async ({ page }) => {
    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    // Replace the prefilled input with a custom payload.
    const editor = page.getByTestId("run-input-editor");
    await editor.fill('{"topic": "birds"}');

    await page.getByTestId("run-input-submit").click();

    // Dialog closes.
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible({ timeout: 2_000 });

    // Wait for the direct action to land.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("run");
    // The mock records the full req object; input must be present.
    expect(direct.req.input).toEqual({ topic: "birds" });
    expect(direct.req.definitionId).toBe("4821");
  });

  test("Run with default '{}': the mock api.run() receives an empty object", async ({ page }) => {
    await page.getByTestId("session-step-run").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    // The editor is prefilled with '{}' — submit without changing it.
    await page.getByTestId("run-input-submit").click();

    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("run");
    expect(direct.req.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Input flows through to the run — Local Run
// ---------------------------------------------------------------------------

test.describe("Local Run — input flows through to the mock", () => {
  test("Run with custom JSON: the mock api.runLocal() receives the input", async ({ page }) => {
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();
    await localBtn.click();

    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    const editor = page.getByTestId("run-input-editor");
    await editor.fill('{"topic": "cats"}');

    await page.getByTestId("run-input-submit").click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible({ timeout: 2_000 });

    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("runLocal");
    expect(direct.req.input).toEqual({ topic: "cats" });
  });
});

// ---------------------------------------------------------------------------
// Cancel and Escape close the dialog without firing
// ---------------------------------------------------------------------------

test.describe("cancel / dismiss without run", () => {
  test("Cancel button closes dialog without firing", async ({ page }) => {
    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible({ timeout: 2_000 });

    const hook = await readTestHook(page);
    expect(hook?.lastDirectAction).toBeUndefined();
  });

  test("Escape key closes dialog without firing", async ({ page }) => {
    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible({ timeout: 2_000 });

    const hook = await readTestHook(page);
    expect(hook?.lastDirectAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Last-used persistence (localStorage)
// ---------------------------------------------------------------------------

test.describe("last-used input persists across dialog opens", () => {
  test("on reopen after a run, the dialog shows the previous input", async ({ page }) => {
    // First run with a custom input.
    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });
    await page.getByTestId("run-input-editor").fill('{"topic": "birds"}');
    await page.getByTestId("run-input-submit").click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();

    // Wait for the run to settle (so there's no race with dialog reopen).
    await waitForDirectAction(page);

    // Reopen the dialog — it should show the last-used input.
    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 3_000 });

    const editorValue = await page.getByTestId("run-input-editor").inputValue();
    // The stored value may be reformatted, but must parse to the same object.
    const parsed = JSON.parse(editorValue);
    expect(parsed).toEqual({ topic: "birds" });

    // Clean up.
    await page.keyboard.press("Escape");
  });
});
