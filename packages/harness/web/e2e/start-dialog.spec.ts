/**
 * Start dialog — one detection-driven surface.
 *
 * The old flow put two different intents ("New session…" and "Open a folder")
 * behind a popover of doors that both landed on the SAME folder picker. These
 * tests pin the fix: the + opens ONE dialog with ONE picker, detection says what
 * the folder is, and the single ink CTA becomes the one action that folder
 * implies — never a mode the user guessed.
 *
 * Runs in the same mock mode as smoke.spec.ts. The mock filesystem gives a
 * deliberate spread under /Users/demo: `rfq-agent` and `onboarding-flow` hold
 * agent projects, `acme-app` is a container whose child `leasing` is one, and
 * `scratch` is a plain folder.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("add-workspace").click();
  await expect(page.locator(".modal-start")).toBeVisible();
});

test.describe("opening", () => {
  test("the + opens the dialog directly — no intent popover, no doors", async ({ page }) => {
    // The old two-layer nesting (a popover of intents that opened a dialog of the
    // same intents) is gone: the + IS the dialog.
    await expect(page.getByTestId("add-menu")).toHaveCount(0);
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);
    await expect(page.getByTestId("new-session-btn")).toHaveCount(0);
    // One folder picker, always present — the structural cure for two identical
    // picker screens.
    await expect(page.locator(".dir-picker")).toBeVisible();
  });

  test("the rail's Create-new CTA opens the same dialog", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-start")).toHaveCount(0);
    await page.getByTestId("rail-create-new").click();
    await expect(page.locator(".modal-start")).toBeVisible();
    await expect(page.locator(".dir-picker")).toBeVisible();
  });
});

test.describe("detection drives the action", () => {
  test("an agent project → Add workspace, and never scaffold", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "good");
    await expect(result).toContainText("This is an agent project");
    await expect(page.getByTestId("aw-add")).toBeVisible();
    await expect(page.getByTestId("aw-scaffold-here")).toHaveCount(0);
  });

  test("a container of projects → Add all N", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    // `leasing` is the one project inside; acme-app itself is not one.
    await expect(page.getByTestId("aw-result")).toContainText("under this folder");
    await expect(page.getByTestId("aw-add-all")).toContainText("Add all 1");
  });

  test("a plain folder → Scaffold (primary) + the Start-from tray", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("No agent project in this folder");
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    // Scaffold stays the primary default, with the tray defaulting to Empty.
    await expect(page.getByTestId("aw-scaffold-here")).toBeVisible();
    await expect(page.getByTestId("start-from-empty")).toHaveAttribute("aria-checked", "true");
    // Registering the bare folder without scaffolding stays possible.
    await expect(page.getByTestId("aw-add-anyway")).toBeVisible();
    // And the MCP setup offer appears for an existing, unwired folder.
    await expect(page.getByTestId("mcp-install")).toBeVisible();
  });

  test("a not-yet-existing folder → New, scaffold still primary, nothing to register", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/brand-new-thing");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("doesn't exist yet");
    await expect(page.getByTestId("aw-scaffold-here")).toBeVisible();
    // Nothing exists to register, and no terminal-setup offer for a missing folder.
    await expect(page.getByTestId("aw-add-anyway")).toHaveCount(0);
    await expect(page.getByTestId("mcp-install")).toHaveCount(0);
  });

  test("the CTA relabels as the folder changes — intent is a consequence, not a guess", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    await expect(page.getByTestId("aw-add")).toBeVisible();

    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");
    await expect(page.getByTestId("aw-scaffold-here")).toBeVisible();
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
  });
});

test.describe("start from", () => {
  test("the idea tile reveals a prompt and switches the CTA to Scaffold it", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/new-idea");
    await expect(page.getByTestId("aw-result")).toContainText("doesn't exist yet");
    // Empty is the default; the idea prompt is hidden until chosen.
    await expect(page.getByTestId("aw-idea")).toHaveCount(0);
    await expect(page.getByTestId("aw-scaffold-here")).toBeVisible();

    await page.getByTestId("start-from-idea").click();
    await expect(page.getByTestId("aw-idea")).toBeVisible();
    // The primary can't scaffold an empty idea.
    await expect(page.getByTestId("aw-scaffold-it")).toBeDisabled();
    await page.getByTestId("aw-idea").fill("diff competitor pricing every morning");
    await expect(page.getByTestId("aw-scaffold-it")).toBeEnabled();
  });

  test("the templates tile hands off to the catalog", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/x");
    await expect(page.getByTestId("aw-result")).toContainText("doesn't exist yet");
    await page.getByTestId("start-from-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
  });
});

test.describe("entry points", () => {
  // The welcome panel's primary CTA and the rail's + must reach the SAME dialog —
  // the whole point is that "add" means one thing everywhere now.
  test("the welcome panel's primary CTA opens the same Start dialog", async ({ page }) => {
    await page.keyboard.press("Escape");
    await page.goto("/?mockState=fresh");
    const welcome = page.getByTestId("welcome-panel");
    await expect(welcome).toBeVisible();

    await welcome.getByTestId("welcome-start-project").click();

    await expect(page.locator(".modal-start")).toBeVisible();
    await expect(page.locator(".dir-picker")).toBeVisible();
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);
  });
});
