/**
 * "Describe with AI" — the canvas overview action that hands the bound agent the
 * job of authoring the deterministic `description` fields in the workflow
 * source. It injects an engineered prompt into the active session; the source
 * watcher re-renders the canvas once the agent saves (no manual render step).
 *
 * These tests assert the affordance shows for a bound workflow and that the
 * inject carries the workflow's identity + a source-editing instruction. The
 * actual file edit is the agent's job (a real PTY), out of scope for the mock —
 * we verify the payload via the same __HARNESS_TEST__.lastInjectInput hook the
 * step-macro suite uses.
 */
import { expect, test, type Page } from "@playwright/test";

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

/** Poll for the last inject recorded by MockApi.injectInput (mock delay ~180ms). */
const lastInject = async (page: Page): Promise<{ id: string; req: { text: string; submit: boolean } }> => {
  let result: { id: string; req: { text: string; submit: boolean } } | null = null;
  await expect
    .poll(
      async () => {
        result = await page.evaluate(() => {
          const win = window as unknown as {
            __HARNESS_TEST__?: { lastInjectInput?: { id: string; req: { text: string; submit: boolean } } };
          };
          return win.__HARNESS_TEST__?.lastInjectInput ?? null;
        });
        return result;
      },
      { timeout: 3000, message: "expected lastInjectInput to be set after the mock delay" },
    )
    .not.toBeNull();
  return result!;
};

/** Clear the recorded inject so a "nothing was injected" assertion is unambiguous. */
const clearLastInject = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
    if (win.__HARNESS_TEST__) delete win.__HARNESS_TEST__["lastInjectInput"];
  });

test.describe("Describe with AI", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the overview offers a Describe-with-AI action for the bound workflow", async ({ page }) => {
    // leasing is bound with a live boot session, so the inject target exists
    // and the button renders. (leasing's mock overview already has copy, so the
    // label is the 'Rewrite' variant — the affordance is what matters here.)
    const btn = page.getByTestId("canvas-describe-ai");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/with AI/i);
  });

  test("clicking it injects a source-editing prompt that names the workflow + path", async ({ page }) => {
    // leasing already has a description → the Rewrite variant, which confirms
    // first (it can overwrite hand-written text). Accept it, then assert the inject.
    page.on("dialog", (d) => void d.accept());
    await page.getByTestId("canvas-describe-ai").click();
    const inject = await lastInject(page);

    // Identity of the workflow being described.
    expect(inject.req.text).toContain("leasing");
    expect(inject.req.text).toContain("/Users/demo/acme-app/leasing");
    // The job: author `description` fields on the agent + steps.
    expect(inject.req.text.toLowerCase()).toContain("description");
    expect(inject.req.text).toContain("defineStep");
    // It targets a real (boot) session.
    expect(inject.id).toBeTruthy();
  });

  test("the Rewrite variant confirms first — dismissing it injects nothing", async ({ page }) => {
    // leasing has an existing description, so the button is the destructive
    // Rewrite. Dismissing the confirm must send no prompt to the agent.
    await clearLastInject(page);
    page.on("dialog", (d) => void d.dismiss());
    await page.getByTestId("canvas-describe-ai").click();
    // Well past the mock inject delay (~180ms) — if it were going to fire, it has.
    await page.waitForTimeout(500);
    const injected = await page.evaluate(() => {
      const win = window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: unknown } };
      return win.__HARNESS_TEST__?.lastInjectInput ?? null;
    });
    expect(injected).toBeNull();
  });
});
