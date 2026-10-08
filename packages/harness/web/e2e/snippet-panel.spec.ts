/**
 * "Trigger from your code" snippets, behind the agent modal's `</>`
 * (flow-map-chat-overlay.md 4.7.2) — mock-mode UI tests, same fixtures as
 * smoke.spec.ts:
 *   - "leasing" → deployed (definitionId: 4821, definitionSlug: "leasing").
 *     The re-vendored contract carries definitionSlug, so the slug is the one
 *     the server resolved from the deployment (no inferred fallback).
 *   - "rfq" → undeployed (definitionId: null) — only a READY cloud build has
 *     anything to copy, so its `</>` says why there is nothing yet.
 *
 * SAP-2980 removed the Code tab and moved the snippets to the deploy surface
 * beside the bound session; P4.0 removed that surface. They live in the
 * modal's header now, one click from the agent they call.
 */
import { expect, test, type Page } from "@playwright/test";

import { openAgentModal } from "./mock-navigation";

async function openSnippets(page: Page): Promise<void> {
  await page.getByTestId("agent-modal-snippets").click();
  await expect(page.getByTestId("agent-modal-snippets")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.getByTestId("agent-modal-snippets-popover")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, "acme-app", "leasing");
  await openSnippets(page);
});

test.describe("the snippets follow the SUBJECT's deploy state", () => {
  test("the Code tab is gone, and the snippets are not gone with it", async ({ page }) => {
    await expect(page.getByTestId("right-tab-code")).toHaveCount(0);
    await expect(page.getByTestId("right-panel-code")).toHaveCount(0);
    await expect(
      page.getByTestId("agent-modal-snippets-popover").getByTestId("snippet-panel"),
    ).toBeVisible();
  });

  test("only a READY cloud build offers them — an undeployed agent has nothing to copy", async ({
    page,
  }) => {
    // rfq's modal: no other agent's snippets leak in, and a snippet for an
    // agent with no ready build could only produce a 404 call, so `</>`
    // says why instead.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-modal-snippets-popover")).toHaveCount(0);
    await page.getByTestId("agent-modal-close").click();
    await openAgentModal(page, "rfq-agent", "rfq");
    await openSnippets(page);
    await expect(page.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(page.getByTestId("agent-modal-snippets-pending")).toHaveText(
      "Deploy rfq first. Its snippets appear once it has a ready cloud build.",
    );

    // Back on leasing: its own snippets, and only one panel.
    await page.keyboard.press("Escape");
    await page.getByTestId("agent-modal-close").click();
    await openAgentModal(page, "acme-app", "leasing");
    // The popover is the modal's: a fresh modal opens with it closed.
    await expect(page.getByTestId("agent-modal-snippets-popover")).toHaveCount(0);
    await openSnippets(page);
    await expect(page.getByTestId("snippet-panel")).toHaveCount(1);
    await expect(page.getByTestId("snippet-slug")).toHaveText("leasing");
  });

  test("a first deploy's snippets wait for the ready build, never an empty popover", async ({
    page,
  }) => {
    /* Linking sets a definitionId BEFORE the build is ready, so linkage alone
       must not offer snippets: during the build `</>` names the build, and
       once it is ready the snippets are there. */
    await page.keyboard.press("Escape");
    await page.getByTestId("agent-modal-close").click();
    await openAgentModal(page, "rfq-agent", "rfq");
    await page.getByTestId("agent-modal-deploy").click();
    await expect(page.getByTestId("agent-modal-state")).toHaveText(/^Deployed/);
    await openSnippets(page);
    const popover = page.getByTestId("agent-modal-snippets-popover");
    await expect(
      popover.getByTestId("agent-modal-snippets-pending").or(
        popover.getByTestId("snippet-panel"),
      ),
    ).toBeVisible();
    await expect(page.getByTestId("agent-modal-progress")).toHaveText("Deployed", {
      timeout: 6_000,
    });
    await expect(popover.getByTestId("snippet-panel")).toBeVisible();
    await expect(popover.getByTestId("agent-modal-snippets-pending")).toHaveCount(0);
  });

  test("they live behind </> only: Canvas stays a pure board, and Escape closes them first", async ({
    page,
  }) => {
    const modal = page.getByTestId("agent-modal");
    await expect(modal.getByTestId("snippet-panel")).toHaveCount(0);
    await expect(modal.getByTestId("steps-snippets")).toHaveCount(0);
    // One layer per Escape: the popover, then the modal.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-modal-snippets-popover")).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("agent-modal-snippets")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
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
