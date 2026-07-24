/**
 * E2E tests for the run-first input flow:
 *
 *  Run-first behavior:
 *   - Clicking Local Run / Prod Run fires immediately using last-used input
 *     (or {}); the dialog does NOT open for a normal run.
 *   - When a run fails with a missing-input validation error, the dialog opens
 *     prefilled with a skeleton for the missing fields plus a hint naming them.
 *   - Submitting the dialog re-runs with the entered input; saveLastInput is
 *     called so the next direct-fire run uses the new value.
 *   - If the re-run still fails input validation, the dialog stays open (is
 *     re-opened with the new error state) so the user can correct the input.
 *   - If the re-run succeeds (or fails for a non-input reason), the dialog
 *     closes and the existing result/error UI handles it.
 *
 *  The dialog is reached ONLY via the run-first failure path — there is no
 *  proactive "Edit input" affordance.
 *
 *  Validation (reachable via the reactive dialog):
 *   - Invalid JSON shows an inline error; the run does NOT fire.
 *   - The error message includes an example JSON object.
 *   - The error clears when the user edits the JSON.
 *
 *  Last-used persistence:
 *   - After a dialog run, the next direct run uses the stored input.
 *
 * All tests run in mock mode (VITE_MOCK=1) with no real server.
 * Mock escape hatches:
 *   ?mockError=runLocalInput  — MockApi.runLocal emits an input-validation error
 *   ?mockError=prodRunInput   — MockApi.run() rejects with an input-validation error
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
// Run-first: no dialog on a successful / non-input-error run
// ---------------------------------------------------------------------------

test.describe("run-first: no dialog for a clean run", () => {
  test("clicking Local Run fires immediately — no dialog opens", async ({ page }) => {
    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();
    await localBtn.click();

    // The run fires directly; the dialog must NOT appear.
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();

    // Wait for the action to settle.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("runLocal");
  });

  test("clicking Prod Run fires immediately — no dialog opens", async ({ page }) => {
    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // The run fires directly; the dialog must NOT appear.
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();

    // Wait for the action to settle.
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("run");
  });

  test("the 'Edit input' button does not exist in the action bar", async ({ page }) => {
    await expect(page.getByTestId("session-edit-input")).not.toBeAttached();
  });
});

// ---------------------------------------------------------------------------
// Run-first: input-validation failure opens dialog (mocked via ?mockError=)
// ---------------------------------------------------------------------------

test.describe("run-first: input-validation failure opens dialog reactively", () => {
  test("local run: an input-validation error opens the dialog prefilled with the missing field", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    const localBtn = page.getByTestId("session-step-local");
    await expect(localBtn).toBeEnabled();
    await localBtn.click();

    // The run fires, fails with an input-validation error, and the dialog
    // opens reactively.
    const dialog = page.getByTestId("run-input-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The hint line should name the missing field ("topic").
    await expect(page.getByTestId("run-input-hint")).toContainText("topic");

    // The editor should be prefilled with a skeleton that includes the field.
    const editor = page.getByTestId("run-input-editor");
    const editorValue = await editor.inputValue();
    expect(editorValue).toContain("topic");

    // Cancel without firing.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("prod run: an input-validation error opens the dialog prefilled with the missing field", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockError=prodRunInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    const runBtn = page.getByTestId("session-step-run");
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    // The run fires, fails with an input-validation error, and the dialog
    // opens reactively.
    const dialog = page.getByTestId("run-input-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The hint line should name the missing field ("topic").
    await expect(page.getByTestId("run-input-hint")).toContainText("topic");

    // Cancel without firing.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("local run: submitting from the reactive dialog re-runs with the entered input", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-local").click();

    const dialog = page.getByTestId("run-input-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Fill in the missing field and submit.
    const editor = page.getByTestId("run-input-editor");
    await editor.fill('{"topic": "AI research"}');
    await page.getByTestId("run-input-submit").click();

    // Dialog closes immediately after submit (the re-run is async).
    await expect(dialog).not.toBeVisible({ timeout: 2_000 });

    // The re-run fires with the new input — wait for a second directAction.
    await page.waitForFunction(
      () => {
        const actions = (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.directActions;
        return actions && actions.length >= 2;
      },
      { timeout: 8_000 },
    );
    const allActions = await page.evaluate(
      () => (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.directActions,
    );
    const reRun = allActions?.find(
      (a) => a.action === "runLocal" && (a.req.input as Record<string, unknown>)?.topic === "AI research",
    );
    expect(reRun).toBeDefined();
  });

  test("Escape closes the reactive dialog without firing a run", async ({ page }) => {
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-local").click();

    const dialog = page.getByTestId("run-input-dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The first directAction fired (the initial failed run); record it.
    const hookBefore = await readTestHook(page);
    const countBefore = hookBefore?.directActions?.length ?? 1;

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 2_000 });

    // No additional run should have fired after Escape.
    const hookAfter = await readTestHook(page);
    expect(hookAfter?.directActions?.length ?? 0).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Validation — invalid JSON shows inline error, no run fires
// ---------------------------------------------------------------------------

test.describe("JSON validation (via reactive dialog)", () => {
  test("invalid JSON shows inline error and does NOT fire the run", async ({ page }) => {
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 5_000 });

    const editor = page.getByTestId("run-input-editor");
    await editor.fill("{bad json");

    await page.getByTestId("run-input-submit").click();

    // Inline error must appear with an example.
    await expect(page.getByTestId("run-input-error")).toBeVisible({ timeout: 2_000 });
    await expect(page.getByTestId("run-input-error")).toContainText(/Enter a JSON object/i);
    await expect(page.getByTestId("run-input-error")).toContainText(/\{.*".*"/);

    // Dialog must still be open.
    await expect(page.getByTestId("run-input-dialog")).toBeVisible();

    // No additional direct action should have fired after the submit attempt.
    const hook = await readTestHook(page);
    // Only the initial failed run should be recorded (1 action).
    expect(hook?.directActions?.length ?? 0).toBe(1);
  });

  test("error clears when the user edits the JSON", async ({ page }) => {
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 5_000 });

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
// Last-used persistence (localStorage)
// ---------------------------------------------------------------------------

test.describe("last-used input persists for the next run", () => {
  test("after a dialog run, the next direct Local Run uses the stored input", async ({ page }) => {
    // Trigger the reactive dialog, enter a value, and submit.
    await page.goto("/?seed=0&mockError=runLocalInput");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    await page.getByTestId("session-step-local").click();
    await expect(page.getByTestId("run-input-dialog")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("run-input-editor").fill('{"topic": "birds"}');
    await page.getByTestId("run-input-submit").click();
    await expect(page.getByTestId("run-input-dialog")).not.toBeVisible();

    // Wait for the re-run to settle.
    await page.waitForFunction(
      () => {
        const actions = (window as unknown as HarnessTestWindow).__HARNESS_TEST__?.directActions;
        return actions && actions.length >= 2;
      },
      { timeout: 8_000 },
    );

    // Clear the recorded action list so we can identify the next fresh direct run.
    await page.evaluate(() => {
      const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
      if (win.__HARNESS_TEST__) {
        delete win.__HARNESS_TEST__["lastDirectAction"];
        win.__HARNESS_TEST__["directActions"] = [];
      }
    });

    // Navigate away from the mock-error URL so the next Local Run succeeds directly.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("session-steps")).toBeVisible();

    // Direct Local Run should use the stored {"topic": "birds"}.
    await page.getByTestId("session-step-local").click();
    const direct = await waitForDirectAction(page);
    expect(direct.action).toBe("runLocal");
    expect((direct.req.input as Record<string, unknown>)?.topic).toBe("birds");
  });
});
