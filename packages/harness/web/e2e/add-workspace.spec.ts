/**
 * Add workspace — three doors.
 *
 * The old dialog put five jobs on screen at once (register · scaffold ·
 * template · bulk-scan · install-MCP) with 17 controls to answer one question.
 * These tests pin the properties that fix was for: the resting state is three
 * intents and nothing else, door 1 says WHAT IT FOUND before offering an
 * action, and door 3 cannot submit a name that would break the scaffold.
 *
 * Runs in the same mock mode as smoke.spec.ts. The mock filesystem gives a
 * deliberate spread under /Users/demo: `rfq-workflows` and `onboarding-flow`
 * hold agent projects, `acme-app` is a container whose child `leasing` is one,
 * and `scratch` is a plain folder.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("add-workspace").click();
});

test.describe("the resting state", () => {
  test("offers exactly three doors and no path field", async ({ page }) => {
    const doors = page.getByTestId("aw-doors");
    await expect(doors).toBeVisible();
    await expect(doors.locator(".aw-door")).toHaveCount(3);

    // The point of the redesign: nothing is asked for until an intent is picked.
    await expect(page.locator(".dir-picker")).toBeHidden();
    // And none of the old permanent escape hatches are present.
    await expect(page.getByTestId("mcp-install")).toHaveCount(0);
    await expect(page.getByTestId("modal-scan-btn")).toHaveCount(0);
    await expect(page.getByTestId("modal-browse-templates")).toHaveCount(0);
  });

  test("a door can be entered and backed out of", async ({ page }) => {
    await page.getByTestId("aw-door-have").click();
    await expect(page.locator(".dir-picker")).toBeVisible();
    await expect(page.getByTestId("aw-doors")).toHaveCount(0);

    await page.getByTestId("aw-back").click();
    await expect(page.getByTestId("aw-doors")).toBeVisible();
  });

  test("the template door hands straight off to the templates dialog", async ({ page }) => {
    await page.getByTestId("aw-door-template").click();
    // No intermediate step — the door IS the gallery.
    await expect(page.getByTestId("template-dest-input")).toBeVisible();
  });
});

test.describe("entry points", () => {
  // Both "add a workspace" entries must reach the SAME dialog. The welcome
  // panel's CTA says "New workspace" and used to open the one-question SESSION
  // modal instead — the most prominent button on a first-run screen delivering
  // the wrong thing.
  test("the welcome panel's New workspace opens the three doors, not the session modal", async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    const welcome = page.getByTestId("welcome-panel");
    await expect(welcome).toBeVisible();

    await welcome.getByRole("button", { name: "New workspace" }).click();

    await expect(page.locator(".modal-add-workspace")).toBeVisible();
    await expect(page.getByTestId("aw-doors")).toBeVisible();
    await expect(page.locator(".modal-new-session")).toHaveCount(0);
  });
});

test.describe("door 1 — I have a project", () => {
  test("states that the picked folder is an agent project, then offers one action", async ({ page }) => {
    await page.getByTestId("aw-door-have").click();

    const input = page.locator(".dir-picker-input");
    await input.fill("/Users/demo/rfq-workflows");
    await page.getByTestId("aw-have-continue").click();

    const result = page.getByTestId("aw-result");
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute("data-tone", "good");
    await expect(result).toContainText("This is an agent project");

    // Exactly the action the finding implies — not scaffold, not template.
    await expect(page.getByTestId("aw-add")).toBeVisible();
    await expect(page.getByTestId("aw-scaffold-here")).toHaveCount(0);
  });

  test("counts the projects inside a container folder and offers to add them all", async ({ page }) => {
    await page.getByTestId("aw-door-have").click();

    await page.locator(".dir-picker-input").fill("/Users/demo/acme-app");
    await page.getByTestId("aw-have-continue").click();

    const result = page.getByTestId("aw-result");
    await expect(result).toContainText("under this folder");
    // `leasing` is the one project inside; acme-app itself is not one.
    await expect(page.getByTestId("aw-add-all")).toContainText("Add all 1");
  });

  test("offers scaffold and template — not Add — for a folder with no project", async ({ page }) => {
    await page.getByTestId("aw-door-have").click();

    await page.locator(".dir-picker-input").fill("/Users/demo/scratch");
    await page.getByTestId("aw-have-continue").click();

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("No agent project in this folder");
    await expect(page.getByTestId("aw-scaffold-here")).toBeVisible();
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
  });

  test("Change returns to the picker without losing the path", async ({ page }) => {
    await page.getByTestId("aw-door-have").click();
    await page.locator(".dir-picker-input").fill("/Users/demo/rfq-workflows");
    await page.getByTestId("aw-have-continue").click();
    await expect(page.getByTestId("aw-result")).toBeVisible();

    await page.getByRole("button", { name: "Change" }).click();
    await expect(page.locator(".dir-picker-input")).toHaveValue("/Users/demo/rfq-workflows");
  });
});

test.describe("door 3 — start from an idea", () => {
  test("derives the name from the idea as it is typed", async ({ page }) => {
    await page.getByTestId("aw-door-idea").click();

    await page
      .getByTestId("aw-idea")
      .fill("Every morning, diff our competitors' pricing pages and Slack me");

    // Filler and cadence words dropped; the identity kept.
    await expect(page.getByTestId("aw-name")).toHaveValue("diff-competitors-pricing");
    // The resolved path is shown as a statement, built from root + name.
    await expect(page.getByTestId("aw-target")).toContainText("diff-competitors-pricing");
  });

  test("stops tracking the idea once the name is edited by hand", async ({ page }) => {
    await page.getByTestId("aw-door-idea").click();
    await page.getByTestId("aw-idea").fill("watch competitor pricing");

    const name = page.getByTestId("aw-name");
    await name.fill("price-watch");
    await page.getByTestId("aw-idea").fill("something else entirely now");

    await expect(name).toHaveValue("price-watch");
  });

  test("blocks a name that would break the scaffold's package.json", async ({ page }) => {
    await page.getByTestId("aw-door-idea").click();
    await page.getByTestId("aw-idea").fill("watch competitor pricing");

    await page.getByTestId("aw-name").fill("Bad Name!");

    await expect(page.getByTestId("aw-name")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("aw-scaffold-it")).toBeDisabled();
    await expect(page.locator(".modal-field-hint[data-invalid='true']")).toContainText(
      "Lowercase letters, numbers and dashes only",
    );
  });

  test("cannot submit with no idea", async ({ page }) => {
    await page.getByTestId("aw-door-idea").click();
    await expect(page.getByTestId("aw-scaffold-it")).toBeDisabled();
  });

  test("the root is changeable from inside the door", async ({ page }) => {
    await page.getByTestId("aw-door-idea").click();
    await page.getByTestId("aw-change-root").click();
    await expect(page.locator(".dir-picker")).toBeVisible();
  });
});
