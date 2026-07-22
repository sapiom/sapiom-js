/**
 * Code tab — "Trigger from your code" snippets (UP-03), mock-mode UI tests,
 * same fixtures as smoke.spec.ts:
 *   - "leasing" → deployed (definitionId: 4821, definitionSlug: "leasing"), the
 *     boot session's binding, so opening the Code tab shows the snippet panel.
 *     The re-vendored contract carries definitionSlug, so the slug is the one
 *     the server resolved from the deployment (no inferred fallback).
 *   - "rfq" → undeployed (definitionId: null) — binding it swaps the tab to
 *     its honest "deploy first" empty state.
 * The tab is the bound agent's integration projection (docs/IA.md: the right
 * pane is Canvas | Steps | Code | Skills); the Canvas tab stays a pure board.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  await page.getByTestId("right-tab-code").click();
});

test.describe("the Code tab follows the BOUND workflow's deploy state", () => {
  test("shows the snippet panel when the bound workflow is deployed", async ({ page }) => {
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
    // Same subheader anatomy as Canvas/Steps: agent name left, the one
    // server-provable status right.
    const header = page.getByTestId("code-panel-header");
    await expect(header.locator(".workflow-actions-name")).toHaveText("leasing");
    await expect(header.getByTestId("code-panel-status")).toContainText("Deployed");
  });

  test("an undeployed binding swaps to the deploy-first empty state; a deployed one brings the panel back", async ({
    page,
  }) => {
    // Opening rfq (no session in its workspace) swaps the tab to the honest
    // "no session" state — no other agent's snippets leak in.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toContainText("No running session for rfq");

    // Starting the session binds rfq (undeployed) — the deploy-first state.
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toContainText("Deploy to trigger from code");

    // Opening leasing again binds + switches back to the boot session's
    // deployed agent, bringing the snippet panel back.
    await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });

  test("the snippets live in the Code tab only — Canvas stays a pure board and Steps a pure list", async ({
    page,
  }) => {
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("snippet-panel")).not.toBeVisible();
    await page.getByTestId("right-tab-steps").click();
    await expect(page.getByTestId("snippet-panel")).not.toBeVisible();
    await page.getByTestId("right-tab-code").click();
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
  });
});

test.describe("slug", () => {
  test("is read-only (a chip, not an input) and shows the deployment's resolved slug", async ({
    page,
  }) => {
    const slug = page.getByTestId("snippet-slug");
    // The re-vendored contract carries definitionSlug, so leasing's slug is the
    // one the server resolved from the deployment ("leasing") — not an inferred
    // fallback, so the "inferred" note does not show.
    await expect(slug).toHaveText("leasing");
    // READ-ONLY: the slug is the deployed agent's stable handle — never an
    // editable field (editing it could only produce a 404 call).
    const tag = await slug.evaluate((el) => el.tagName.toLowerCase());
    expect(tag).not.toBe("input");
    await expect(page.getByTestId("snippet-slug-inferred")).toHaveCount(0);
  });
});

test.describe("snippet content", () => {
  test("defaults to the TypeScript SDK tab with the executions call", async ({ page }) => {
    await expect(page.getByTestId("snippet-tab-ts")).toHaveClass(/is-active/);
    const code = page.getByTestId("snippet-code");
    await expect(code).toContainText("agents.run({");
    await expect(code).toContainText('definition: "leasing"');
  });

  test("the cURL tab shows the same endpoint with the placeholder key, never a real one", async ({ page }) => {
    await page.getByTestId("snippet-tab-curl").click();
    await expect(page.getByTestId("snippet-tab-curl")).toHaveClass(/is-active/);
    const code = page.getByTestId("snippet-code");
    await expect(code).toContainText("/agents/v1/definitions/leasing/executions");
    await expect(code).toContainText("x-sapiom-api-key: YOUR_SAPIOM_API_KEY");
    const text = await code.textContent();
    expect(text).not.toContain("Bearer");
    expect(text).not.toMatch(/sk_[A-Za-z0-9]/);
  });

  test("links to the dashboard's API keys page for the real credential", async ({ page }) => {
    const link = page.getByTestId("snippet-api-key-link");
    await expect(link).toHaveAttribute("href", "https://app.sapiom.ai/settings?tab=api-keys");
    await expect(link).toHaveAttribute("target", "_blank");
  });
});

test.describe("copy", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copies the active snippet and confirms with a label change", async ({ page }) => {
    const copy = page.getByTestId("snippet-copy");
    await expect(copy).toHaveText("Copy");
    await copy.click();
    await expect(copy).toHaveText("Copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("agents.run({");
  });
});
