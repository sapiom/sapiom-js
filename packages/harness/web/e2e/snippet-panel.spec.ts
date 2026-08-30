/**
 * "Trigger from your code" snippets, on the DEPLOY surface — mock-mode UI
 * tests, same fixtures as smoke.spec.ts:
 *   - "leasing" → deployed (definitionId: 4821, definitionSlug: "leasing"), the
 *     boot session's binding, so the Steps surface offers the disclosure. The
 *     re-vendored contract carries definitionSlug, so the slug is the one the
 *     server resolved from the deployment (no inferred fallback).
 *   - "rfq" → undeployed (definitionId: null) — only a READY cloud build has
 *     anything to copy, so the disclosure is simply not offered for it.
 *
 * SAP-2980 removed the Code tab. The snippets were NOT removed with it: a
 * permanent tab spent standing IA on a question asked once, just after a
 * deploy, so they moved to where that question is actually asked — the Steps
 * surface, directly under the deploy banner that reports the build that made
 * the agent callable. The Canvas tab stays a pure board.
 */
import { expect, test } from "@playwright/test";

import { focusRfqAgent } from "./mock-navigation";

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
  await page.getByTestId("right-tab-steps").click();
  await page.getByTestId("steps-snippets-toggle").click();
});

test.describe("the snippets follow the SUBJECT's deploy state", () => {
  test("the Code tab is gone, and the snippets are not gone with it", async ({ page }) => {
    await expect(page.getByTestId("right-tab-code")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toHaveCount(0);
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
    await expect(page.getByTestId("steps-snippets-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("only a READY cloud build offers them — an undeployed agent has nothing to copy", async ({
    page,
  }) => {
    // Opening rfq (no session in its workspace) drops the disclosure entirely:
    // no other agent's snippets leak in, and a snippet for an agent with no
    // ready build could only produce a 404 call. Since SAP-2931 this follows
    // the rail SELECTION, not the binding — how you trigger an agent from code
    // has nothing to do with which session is live.
    await focusRfqAgent(page);
    await page.getByTestId("right-tab-steps").click();
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("steps-snippets")).toHaveCount(0);

    // Opening leasing again switches back to its most-recent deployed session.
    // Wait for that session transition before inspecting the pane: its board
    // may collapse the pane.
    await page.getByTestId("workflow-leasing").locator(".workflow-item-trigger").click();
    await expect(page.getByTestId("workflow-leasing")).toHaveClass(/is-focused/);
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-leasing-2",
    );
    // The disclosure is keyed to the AGENT, not to a flag, so leasing's own
    // section comes back open exactly as it was left. Asserted on the DOM
    // rather than on visibility: an empty board auto-collapses the pane, and
    // whether that lands before or after this line is a race that says nothing
    // about the snippets.
    await expect(page.getByTestId("steps-snippets-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("snippet-panel")).toHaveCount(1);
  });

  test("they live on the Steps surface only — Canvas stays a pure board", async ({
    page,
  }) => {
    await expect(page.getByTestId("snippet-panel")).toBeVisible();
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("snippet-panel")).not.toBeVisible();
    await page.getByTestId("right-tab-steps").click();
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
