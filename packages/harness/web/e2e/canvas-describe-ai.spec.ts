/**
 * "Describe with AI" — the board overview's action that hands a coding agent
 * the job of authoring the deterministic `description` fields in the agent's
 * source. Since verbs went by path (flow-map-chat-overlay.md 4.4b, SAP-3839)
 * it follows the macro rule: a NEW session at the project root whose first
 * message carries the describe prompt and the agent as context, opened in the
 * full view. The source watcher re-renders the board once it saves.
 *
 * These tests assert the affordance on the agent modal's board, that the click
 * starts that session with the right first message, and that the Rewrite
 * variant's confirm can stop it. We verify the launch via
 * __HARNESS_TEST__.createSessionCalls.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAgentModal } from "./mock-navigation";

/** Navigate to a clean slate with leasing's board open in its agent modal. */
const loadBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, "acme-app", "leasing");
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

/** Every session the mock was asked to create, oldest first. */
const createCalls = (page: Page) =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createSessionCalls?: unknown[] } }).__HARNESS_TEST__
        ?.createSessionCalls ?? []) as Array<{ req: { cwd: string; initialPrompt?: string } }>,
  );

test.describe("Describe with AI", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the overview offers a Describe-with-AI action for the bound workflow", async ({ page }) => {
    // leasing's modal: the board is the agent's, by path, so the
    // button renders. (leasing's mock overview already has copy, so the label is
    // the 'Rewrite' variant — the affordance is what matters here.)
    const btn = page.getByTestId("canvas-describe-ai");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/with AI/i);
    await expect(btn).toHaveAttribute(
      "data-tooltip",
      "Runs a hidden coding-agent session that writes descriptions into the agent source — the canvas updates when it saves",
    );
  });

  test("clicking starts a project-root session whose first message is the describe job", async ({ page }) => {
    // leasing already has a description → the Rewrite variant confirms first; accept it.
    page.on("dialog", (d) => void d.accept());
    const before = (await createCalls(page)).length;
    await page.getByTestId("canvas-describe-ai").click();

    // A new session at the PROJECT root, never bound, with the agent's
    // identity and the source-editing prompt as its first message.
    await expect.poll(async () => (await createCalls(page)).length).toBe(before + 1);
    const { req } = (await createCalls(page)).at(-1)!;
    expect(req.cwd).toBe("/Users/demo/acme-app");
    const prompt = req.initialPrompt ?? "";
    expect(prompt).toContain("leasing");
    expect(prompt).toContain("/Users/demo/acme-app/leasing");
    expect(prompt.toLowerCase()).toContain("description");
    expect(prompt).toContain("defineStep");
    expect(prompt).toContain("whole agent");
    expect(prompt.toLowerCase()).not.toContain("workflow");
    // It opens in the full view, leaving the map.
    await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  });

  test("the Rewrite variant confirms first — dismissing it runs nothing", async ({ page }) => {
    // leasing has an existing description, so the button is the destructive
    // Rewrite. Dismissing the confirm must launch no run and leave the button idle.
    const before = (await createCalls(page)).length;
    page.on("dialog", (d) => {
      expect(d.message()).toBe(
        "Rewrite this agent's descriptions? The coding agent will edit the source and may replace text you wrote by hand.",
      );
      void d.dismiss();
    });
    await page.getByTestId("canvas-describe-ai").click();
    // Past any async start — if a session were going to be made, it has.
    await page.waitForTimeout(500);
    expect((await createCalls(page)).length).toBe(before);
    await expect(page.getByTestId("agent-modal")).toBeVisible();
    await expect(page.getByTestId("canvas-describe-ai")).toBeEnabled();
  });
});
