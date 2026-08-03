/**
 * "Describe with AI" — the canvas overview action that hands the bound agent the
 * job of authoring the deterministic `description` fields in the workflow
 * source. It runs a HIDDEN background macro (headless `claude -p`, never the
 * interactive terminal); the source watcher re-renders the canvas once the
 * agent saves. The button shows an optimistic loading state on click.
 *
 * These tests assert the affordance shows for a bound workflow, that the click
 * runs the background "describe" macro carrying the workflow identity + the
 * source-editing prompt (as the macro `subject`), and that the button reflects a
 * loading state. The actual file edit is the agent's job (a real headless run),
 * out of scope for the mock — we verify the launch via __HARNESS_TEST__.lastMacroRun.
 */
import { expect, test, type Page } from "@playwright/test";

type MacroRun = { id: string; req: { harnessSessionId: string; workflowPath?: string; subject?: string } };

/** Navigate to a clean slate with the Canvas board (and its overview) visible. */
const loadBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }
    ).__HARNESS_TEST__.publish({ type: "canvas.reload", harnessSessionId: "sess-boot" });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

/** Poll for the last macro run recorded by MockApi.runMacro. */
const lastMacroRun = async (page: Page): Promise<MacroRun> => {
  let result: MacroRun | null = null;
  await expect
    .poll(
      async () => {
        result = await page.evaluate(() => {
          const win = window as unknown as {
            __HARNESS_TEST__?: {
              lastMacroRun?: { id: string; req: { harnessSessionId: string; workflowPath?: string; subject?: string } };
            };
          };
          return win.__HARNESS_TEST__?.lastMacroRun ?? null;
        });
        return result;
      },
      { timeout: 3000, message: "expected lastMacroRun to be set" },
    )
    .not.toBeNull();
  return result!;
};

/** Clear the recorded macro run so a "nothing ran" assertion is unambiguous. */
const clearLastMacroRun = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
    if (win.__HARNESS_TEST__) delete win.__HARNESS_TEST__["lastMacroRun"];
  });

test.describe("Describe with AI", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the overview offers a Describe-with-AI action for the bound workflow", async ({ page }) => {
    // leasing is bound with a live boot session, so a run target exists and the
    // button renders. (leasing's mock overview already has copy, so the label is
    // the 'Rewrite' variant — the affordance is what matters here.)
    const btn = page.getByTestId("canvas-describe-ai");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/with AI/i);
  });

  test("clicking runs the hidden describe macro (workflow + prompt) and shows a loading state", async ({ page }) => {
    // leasing already has a description → the Rewrite variant confirms first; accept it.
    page.on("dialog", (d) => void d.accept());
    const btn = page.getByTestId("canvas-describe-ai");
    await btn.click();

    // It runs the background "describe" macro (not a terminal inject), carrying
    // the workflow identity + the source-editing prompt as `subject`.
    const run = await lastMacroRun(page);
    expect(run.id).toBe("describe");
    expect(run.req.workflowPath).toBe("/Users/demo/acme-app/leasing");
    expect(run.req.subject ?? "").toContain("leasing");
    expect(run.req.subject ?? "").toContain("/Users/demo/acme-app/leasing");
    expect((run.req.subject ?? "").toLowerCase()).toContain("description");
    expect(run.req.subject ?? "").toContain("defineStep");

    // Instant feedback: the button flips to a disabled loading state.
    await expect(btn).toBeDisabled();
    await expect(btn).toContainText(/describing/i);
  });

  test("the Rewrite variant confirms first — dismissing it runs nothing", async ({ page }) => {
    // leasing has an existing description, so the button is the destructive
    // Rewrite. Dismissing the confirm must launch no run and leave the button idle.
    await clearLastMacroRun(page);
    page.on("dialog", (d) => {
      expect(d.message()).toBe(
        "Rewrite this agent's descriptions? The agent will edit the source and may replace text you wrote by hand.",
      );
      void d.dismiss();
    });
    await page.getByTestId("canvas-describe-ai").click();
    // Past the mock's macro delay — if it were going to run, it has.
    await page.waitForTimeout(500);
    const run = await page.evaluate(() => {
      const win = window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } };
      return win.__HARNESS_TEST__?.lastMacroRun ?? null;
    });
    expect(run).toBeNull();
    await expect(page.getByTestId("canvas-describe-ai")).toBeEnabled();
  });
});
