/**
 * Action-strip macros — what a click actually DISPATCHES (mock-mode, VITE_MOCK=1).
 *
 * These are the buttons that run real commands in the user's terminal: "Run
 * local" (`sapiom agents run --target local`), "Deploy" (`sapiom agents
 * deploy`), "Prod run" (`--target prod`), plus "Open prod" which navigates to a
 * live workflow, and "Visualize" which re-renders the canvas server-side.
 *
 * What already exists elsewhere, deliberately not repeated here:
 *   - strip layout/anchoring, button presence, enabled/disabled gating and the
 *     hover reasons → web/e2e/smoke.spec.ts
 *   - Visualize dispatch (one click, no subject) → web/e2e/smoke.spec.ts
 *   - resolving a macro into a shell command, placeholder substitution, POSIX
 *     single-quoting and shell-injection hardening → src/core/macro-runner.test.ts
 *   - the run endpoint, workflowPath precedence and error cases → src/server/macros.test.ts
 *
 * The gap those leave: nothing checks that clicking "Deploy" (or Run local, or
 * Prod run) fires THAT macro against THE SELECTED workflow and the ACTIVE
 * session. A swapped id, a stale workflow from a previous selection, or a
 * dropped payload field would deploy the wrong project and every existing test
 * would still pass — the server tests can only verify what they're handed.
 */
import { expect, test, type Page } from "@playwright/test";

type LastMacroRun = {
  id: string;
  req: { harnessSessionId: string; workflowPath?: string; subject?: string };
};

/** The boot session is the active one in the mock fixture. */
const ACTIVE_SESSION = "sess-boot";
/** Fixture workflows: leasing is deployed (definitionId 4821), rfq is not. */
const LEASING = { row: "workflow-leasing", path: "/Users/demo/acme-app/leasing", definitionId: 4821 };
const RFQ = { row: "workflow-rfq", path: "/Users/demo/rfq-workflows" };

/** Clears the recorded dispatch so each assertion can't read a previous click's. */
async function resetLastRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as { __HARNESS_TEST__?: Record<string, unknown> };
    if (win.__HARNESS_TEST__) delete win.__HARNESS_TEST__.lastMacroRun;
  });
}

async function lastRun(page: Page): Promise<LastMacroRun> {
  await page.waitForFunction(
    () => (window as unknown as { __HARNESS_TEST__?: { lastMacroRun?: unknown } }).__HARNESS_TEST__?.lastMacroRun,
  );
  return page.evaluate(
    () => (window as unknown as { __HARNESS_TEST__: { lastMacroRun: LastMacroRun } }).__HARNESS_TEST__.lastMacroRun,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId(`session-tab-${ACTIVE_SESSION}`)).toBeVisible();
});

// Each command macro must fire its own id — a swap between these three is the
// difference between running locally and deploying to production.
for (const macro of [
  { id: "run_local", label: "Run local" },
  { id: "deploy", label: "Deploy" },
  { id: "prod_run", label: "Prod run" },
] as const) {
  test(`"${macro.label}" dispatches ${macro.id} for the selected workflow and active session`, async ({ page }) => {
    await page.getByTestId(LEASING.row).click();
    const button = page.getByTestId(`macro-${macro.id}`);
    await expect(button).toBeEnabled();
    await resetLastRun(page);

    await button.click();

    const run = await lastRun(page);
    expect(run.id).toBe(macro.id);
    expect(run.req.harnessSessionId).toBe(ACTIVE_SESSION);
    expect(run.req.workflowPath).toBe(LEASING.path);
  });
}

test("a command macro targets the workflow selected NOW, not the one selected before", async ({ page }) => {
  // The stale-closure bug this guards against is silent and expensive: the
  // strip re-anchors to the new row while the handler still closes over the
  // old workflow, so "Deploy" ships the previous project.
  await page.getByTestId(LEASING.row).click();
  await expect(page.getByTestId("macro-deploy")).toBeEnabled();
  await resetLastRun(page);
  await page.getByTestId("macro-deploy").click();
  expect((await lastRun(page)).req.workflowPath).toBe(LEASING.path);

  await page.getByTestId(RFQ.row).click();
  await expect(page.getByTestId(RFQ.row)).toHaveClass(/is-selected/);
  await resetLastRun(page);
  await page.getByTestId("macro-deploy").click();

  const run = await lastRun(page);
  expect(run.id).toBe("deploy");
  expect(run.req.workflowPath).toBe(RFQ.path);
});

test("running a command binds the workflow to the session first", async ({ page }) => {
  // Commands `cd` into the workflow and act on it, so the session's binding
  // must follow — otherwise the canvas and the snippet panel keep describing a
  // different workflow than the one the terminal is operating on.
  await page.getByTestId(RFQ.row).click();
  const bind = page.getByTestId("workflow-bind");
  await expect(bind).toHaveAttribute("aria-pressed", "false");

  await resetLastRun(page);
  await page.getByTestId("macro-run_local").click();
  await lastRun(page);

  await expect(bind).toHaveAttribute("aria-pressed", "true");
});

test("\"Open prod\" opens the deployed workflow's resolved URL in a new tab", async ({ page, context }) => {
  // open-url is the one macro that doesn't touch the session — it navigates.
  // An unsubstituted or wrong definitionId sends the user to someone else's
  // workflow (or a 404), and nothing else in the suite reads the final URL.
  await page.getByTestId(LEASING.row).click();
  const openProd = page.getByTestId("macro-open_prod");
  await expect(openProd).toBeEnabled();

  const popupPromise = context.waitForEvent("page");
  await openProd.click();
  const popup = await popupPromise;

  const url = popup.url();
  expect(url).toContain(`/workflows/${LEASING.definitionId}`);
  expect(url).not.toContain("{{");
  expect(url).not.toContain("undefined");
  await popup.close();
});

test("an undeployed workflow's \"Open prod\" is disabled and navigates nowhere", async ({ page, context }) => {
  await page.getByTestId(RFQ.row).click();
  const openProd = page.getByTestId("macro-open_prod");
  await expect(openProd).toBeDisabled();
  await expect(openProd).toHaveAttribute("aria-label", "Open prod: Not deployed yet");

  const pagesBefore = context.pages().length;
  // force: a disabled button ignores real clicks, so this asserts the guard is
  // the button's disabled state and not merely a hidden pointer-events trick.
  await openProd.click({ force: true }).catch(() => {
    /* a truly inert control may reject the click outright — also acceptable */
  });
  await page.waitForTimeout(300);
  expect(context.pages().length).toBe(pagesBefore);
});
