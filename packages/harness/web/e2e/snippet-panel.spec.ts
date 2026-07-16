/**
 * F1 "Trigger from your code" snippet panel — mock-mode UI tests.
 *
 * Fixtures (from mock-data.ts):
 *   - "leasing"  → deployed (definitionId: 4821, definitionSlug: "ic-diligence-orchestrator")
 *   - "rfq"      → undeployed (definitionId: null, definitionSlug: null)
 *   - "onboarding-flow" → deployed (definitionId: 9001, definitionSlug: "onboarding-flow")
 *
 * On initial load, "leasing" is pre-bound and pre-selected (the boot session's
 * boundWorkflowPath is "/Users/demo/acme-app/leasing"). The snippet panel
 * should be visible immediately.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  // Ensure the leasing workflow is selected (it's the default boot binding).
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-selected/);
});

test.describe("snippet panel visibility", () => {
  test("shows the snippet panel when a deployed workflow is bound", async ({ page }) => {
    // leasing is deployed — the panel should be visible on initial load.
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });

  test("hides the snippet panel when an undeployed workflow is selected", async ({ page }) => {
    // Click rfq (no definitionId) — panel must disappear.
    await page.getByTestId("workflow-rfq").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
  });

  test("shows the panel again after switching from undeployed back to deployed", async ({ page }) => {
    await page.getByTestId("workflow-rfq").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);

    await page.getByTestId("workflow-leasing").click();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });
});

test.describe("TypeScript tab (default)", () => {
  test("default tab is TypeScript and contains the SDK call with the correct slug", async ({ page }) => {
    const panel = page.getByTestId("snippet-panel");
    const code = panel.getByTestId("snippet-code");

    // TS tab is active by default.
    await expect(panel.getByTestId("snippet-tab-ts")).toHaveClass(/is-active/);
    await expect(panel.getByTestId("snippet-tab-curl")).not.toHaveClass(/is-active/);

    // Content assertions.
    await expect(code).toContainText('agents.run({');
    await expect(code).toContainText('definition: "ic-diligence-orchestrator"');
  });

  test("TypeScript snippet does NOT contain forbidden patterns", async ({ page }) => {
    const code = page.getByTestId("snippet-code");
    const text = await code.textContent();
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("api.sapiom.ai");
    expect(text).not.toContain("/triggers");
    expect(text).not.toMatch(/sk_[A-Za-z0-9]/);
  });
});

test.describe("cURL tab", () => {
  test("switching to the cURL tab shows the HTTP snippet with the correct endpoint and header", async ({ page }) => {
    const panel = page.getByTestId("snippet-panel");
    await panel.getByTestId("snippet-tab-curl").click();

    await expect(panel.getByTestId("snippet-tab-curl")).toHaveClass(/is-active/);
    await expect(panel.getByTestId("snippet-tab-ts")).not.toHaveClass(/is-active/);

    const code = panel.getByTestId("snippet-code");
    await expect(code).toContainText("POST https://tools.sapiom.ai/agents/v1/definitions/ic-diligence-orchestrator/executions");
    await expect(code).toContainText("x-sapiom-api-key: YOUR_SAPIOM_API_KEY");
  });

  test("cURL snippet does NOT contain forbidden patterns", async ({ page }) => {
    const panel = page.getByTestId("snippet-panel");
    await panel.getByTestId("snippet-tab-curl").click();

    const text = await panel.getByTestId("snippet-code").textContent();
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("api.sapiom.ai");
    expect(text).not.toContain("/triggers");
    expect(text).not.toMatch(/sk_[A-Za-z0-9]/);
  });
});

test.describe("slug input", () => {
  test("slug input is pre-filled with the workflow's definitionSlug", async ({ page }) => {
    const input = page.getByTestId("snippet-slug-input");
    await expect(input).toHaveValue("ic-diligence-orchestrator");
  });

  test("editing the slug updates the snippet code live", async ({ page }) => {
    const input = page.getByTestId("snippet-slug-input");
    await input.fill("my-custom-agent");

    const code = page.getByTestId("snippet-code");
    await expect(code).toContainText('definition: "my-custom-agent"');
  });

  test("clearing the slug falls back to the placeholder in the snippet", async ({ page }) => {
    const input = page.getByTestId("snippet-slug-input");
    await input.fill("");

    const code = page.getByTestId("snippet-code");
    await expect(code).toContainText('definition: "your-agent-slug"');
  });

  test("slug input has the correct placeholder attribute", async ({ page }) => {
    await expect(page.getByTestId("snippet-slug-input")).toHaveAttribute("placeholder", "your-agent-slug");
  });
});

test.describe("copy button", () => {
  test("copy button shows 'Copied' confirmation after click and reverts", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const panel = page.getByTestId("snippet-panel");
    const copyBtn = panel.getByTestId("snippet-copy");
    await expect(copyBtn).toHaveText("Copy");

    await copyBtn.click();

    // Brief confirmation appears.
    await expect(copyBtn).toHaveText("Copied");

    // After ~2s the button reverts — use a generous timeout.
    await expect(copyBtn).toHaveText("Copy", { timeout: 4_000 });
  });

  test("copy button writes the TS snippet to the clipboard (TS tab)", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const panel = page.getByTestId("snippet-panel");
    // TS tab is active by default.
    await expect(panel.getByTestId("snippet-tab-ts")).toHaveClass(/is-active/);

    await panel.getByTestId("snippet-copy").click();
    await expect(panel.getByTestId("snippet-copy")).toHaveText("Copied");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("agents.run");
    expect(clipboardText).toContain("ic-diligence-orchestrator");
  });

  test("copy button writes the cURL snippet to the clipboard when on the cURL tab", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const panel = page.getByTestId("snippet-panel");
    await panel.getByTestId("snippet-tab-curl").click();

    await panel.getByTestId("snippet-copy").click();
    await expect(panel.getByTestId("snippet-copy")).toHaveText("Copied");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("curl -X POST");
    expect(clipboardText).toContain("ic-diligence-orchestrator");
    expect(clipboardText).toContain("x-sapiom-api-key: YOUR_SAPIOM_API_KEY");
  });
});

test.describe("panel structure", () => {
  test("panel has the expected title", async ({ page }) => {
    await expect(page.getByTestId("snippet-panel")).toContainText("Trigger from your code");
  });

  test("panel includes the idempotencyKey helper hint", async ({ page }) => {
    await expect(page.getByTestId("snippet-panel")).toContainText("idempotencyKey");
  });
});
