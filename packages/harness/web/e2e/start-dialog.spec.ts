/**
 * Add existing agents — one detection-driven dialog.
 *
 * Reached from the rail's "Add existing agents" button (and the composer's
 * "Open a folder"). Point at a folder; detection relabels the single ink action:
 * Add workspace (an agent project), Add all N (a folder of them), or a disabled
 * "No agent in this folder" when it holds none. Creating a NEW agent is a
 * different surface ("Create new" → the composer).
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
  await page.getByTestId("add-existing-agents").click();
  await expect(page.locator(".modal-start")).toBeVisible();
});

test.describe("opening", () => {
  test("opens one dialog with one picker — no intent popover, no doors", async ({ page }) => {
    // The old two-layer nesting (a popover of intents that opened a dialog of the
    // same intents) is gone.
    await expect(page.getByTestId("add-menu")).toHaveCount(0);
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);
    await expect(page.getByTestId("new-session-btn")).toHaveCount(0);
    await expect(page.locator(".dir-picker")).toBeVisible();
  });

  test("Create new opens the composer, not this dialog", async ({ page }) => {
    // Adding what exists and creating something new are different surfaces now.
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-start")).toHaveCount(0);
    await page.getByTestId("rail-create-new").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.locator(".modal-start")).toHaveCount(0);
  });
});

test.describe("detection drives the action", () => {
  test("an agent project → Add workspace", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "good");
    await expect(result).toContainText("This is an agent project");
    await expect(page.getByTestId("aw-add")).toBeVisible();
  });

  test("a container of projects → Add all N", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    // `leasing` is the one project inside; acme-app itself is not one.
    await expect(page.getByTestId("aw-result")).toContainText("under this folder");
    await expect(page.getByTestId("aw-add-all")).toContainText("Add all 1");
  });

  test("a plain folder → No agent, and the action is disabled", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("No agent in this folder");
    // Nothing to add: the primary is present but deactivated. This dialog only
    // registers agents that already exist.
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    await expect(page.getByTestId("start-primary")).toBeDisabled();
  });

  test("a not-yet-existing folder → No agent, disabled", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/brand-new-thing");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("No agent in this folder");
    await expect(page.getByTestId("start-primary")).toBeDisabled();
  });

  test("the action relabels as the folder changes — a consequence, not a guess", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    await expect(page.getByTestId("aw-add")).toBeVisible();

    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");
    await expect(page.getByTestId("aw-result")).toContainText("No agent in this folder");
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    await expect(page.getByTestId("start-primary")).toBeDisabled();
  });
});
