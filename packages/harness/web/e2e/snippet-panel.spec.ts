/**
 * Code tab — "Trigger from your code" snippets, mock-mode UI tests,
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
    // Opening rfq (no session in its workspace) swaps the tab to rfq's own
    // deploy-first state — no other agent's snippets leak in. Since SAP-2931
    // the tab follows the rail SELECTION, not the binding: how you trigger an
    // agent from code has nothing to do with which session is live, so an
    // unsessioned undeployed agent reads the same as a bound one. It used to
    // say "no running session for rfq", which described the session rather than
    // the question the tab answers. Selecting it reveals a real board, so the
    // pane is already open.
    await page.getByTestId("workflow-rfq").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toContainText("Deploy to trigger from code");

    // Starting the session binds rfq and changes nothing here — the tab was
    // already about rfq.
    await page.getByTestId("open-agent-start-session").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toContainText("Deploy to trigger from code");

    // Opening leasing again switches back to a leasing (deployed) session. It
    // lands on the most-recent leasing tab, which has an empty board and so
    // collapses the pane — reopen it to see the deployed agent's snippet panel.
    //
    // The reopen has to be sequenced, not fired blind. `right-expand` renders
    // ONLY while the pane is collapsed (App.tsx: `rightCollapsed ?
    // expandRightPane : null`), and rfq already left it collapsed — so a blind
    // click expands the pane BEFORE leasing's empty board has collapsed it, and
    // that collapse then undoes the expand. The panel is invisible and the
    // failure names the panel rather than the ordering. Locally the collapse
    // wins the race and this passed 3/3; CI is slower and lost it.
    //
    // So: force the pane OPEN first, so the next collapse is unambiguously
    // leasing's, wait for that collapse, and only then reopen.
    if (await page.getByTestId("right-expand").isVisible()) {
      await page.getByTestId("right-expand").click();
    }
    await expect(page.getByTestId("right-expand")).toHaveCount(0);

    await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("right-expand")).toBeVisible();
    await page.getByTestId("right-expand").click();
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
    // Security guard: the TS snippet must never leak auth material or
    // internal endpoints.
    const text = await code.textContent();
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("api.sapiom.ai");
    expect(text).not.toContain("/triggers");
    expect(text).not.toContain("Bearer");
    expect(text).not.toMatch(/sk_[A-Za-z0-9]/);
    const hint = page.getByTestId("snippet-hint");
    await expect(hint).toContainText("Install @sapiom/tools");
    await expect(hint).toContainText("SAPIOM_API_KEY");
    await expect(hint).toContainText("waits for a terminal run");
    await expect(hint).not.toContainText("YOUR_SAPIOM_API_KEY");
  });

  test("the cURL tab shows the same endpoint with the placeholder key, never a real one", async ({ page }) => {
    await page.getByTestId("snippet-tab-curl").click();
    await expect(page.getByTestId("snippet-tab-curl")).toHaveClass(/is-active/);
    const code = page.getByTestId("snippet-code");
    await expect(code).toContainText("/agents/v1/definitions/leasing/executions");
    await expect(code).toContainText("x-sapiom-api-key: YOUR_SAPIOM_API_KEY");
    // Security guard: the cURL snippet must never leak auth material or
    // internal endpoints.
    const text = await code.textContent();
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("api.sapiom.ai");
    expect(text).not.toContain("/triggers");
    expect(text).not.toContain("Bearer");
    expect(text).not.toMatch(/sk_[A-Za-z0-9]/);
    const hint = page.getByTestId("snippet-hint");
    await expect(hint).toContainText("YOUR_SAPIOM_API_KEY");
    await expect(hint).toContainText("starts a run");
    await expect(hint).toContainText("execution ID");
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
