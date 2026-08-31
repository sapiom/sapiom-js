/**
 * Add existing agents — one detection-driven dialog.
 *
 * Reached from the rail's "Add existing agents" button (and the composer's
 * "Open a folder"). Point at a folder; detection relabels the single ink action:
 * Add agent (the folder is one), or Add agents (walk the tree below it).
 * Creating a NEW agent is a different surface ("Create new" → the composer).
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
    await expect(page.locator(".folder-field")).toBeVisible();
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
  test("an agent project → Add agent", async ({ page }) => {
    await page.getByTestId("folder-field-input").fill("/Users/demo/rfq-agent");

    await expect(page.getByTestId("start-hint")).toHaveText("This folder is an agent project.");
    await expect(page.getByTestId("aw-add")).toBeVisible();
    await expect(page.getByTestId("aw-add")).toHaveText("Add agent");
  });

  test("a container of projects → the bulk action, with no count on it", async ({ page }) => {
    await page.getByTestId("folder-field-input").fill("/Users/demo/acme-app");
    // `leasing` is the one project inside; acme-app itself is not one.
    /* NO COUNT ANYWHERE. This asserted `Add all 1`, then a readout saying
       "1 agent project directly inside". Both were the shallow probe speaking
       for the deep scan — a button reading `Add all 1` over a click that
       registered dozens. The button is a verb, and the one hint line states the
       reach instead of apologising for the probe. */
    await expect(page.getByTestId("aw-add-all")).toHaveText("Add agents");
    await expect(page.getByTestId("start-hint")).toHaveText(
      "Adds every agent below this folder.",
    );
  });

  /* THE APOLOGY IS GONE. This block used to assert a readout headed "No agent
     directly inside this folder" plus three sentences explaining that detection
     probes one level while adding walks the whole tree. That is the scanner
     describing itself to justify a warning nobody could act on. The behaviour
     it protected is unchanged and still asserted here: the shallow probe never
     decides that a folder has no agents, so the deep scan is always offered. */
  test("a plain folder is not a dead end — the deep scan is still offered", async ({ page }) => {
    await page.getByTestId("folder-field-input").fill("/Users/demo/scratch");

    // No readout block at all, and no marker filename in the copy.
    await expect(page.getByTestId("aw-result")).toHaveCount(0);
    await expect(page.locator(".modal-start")).not.toContainText("sapiom.json");
    await expect(page.getByTestId("start-hint")).toHaveText(
      "Adds every agent below this folder.",
    );
    // The immediate-child probe cannot register anything, so its button is gone
    // rather than disabled…
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    // …and the action that CAN answer "are there agents under here?" is offered.
    await expect(page.getByTestId("aw-add-all")).toBeEnabled();
  });

  test("a not-yet-existing folder has nothing to scan, and says so", async ({ page }) => {
    await page.getByTestId("folder-field-input").fill("/Users/demo/scratch/brand-new-thing");

    await expect(page.getByTestId("start-hint")).toHaveText("That folder doesn't exist yet.");
    // A folder that is not there cannot be walked — this is the one case where
    // the disabled primary is the honest answer.
    await expect(page.getByTestId("start-primary")).toBeDisabled();
    await expect(page.getByTestId("aw-add-all")).toHaveCount(0);
  });

  test("the action relabels as the folder changes — a consequence, not a guess", async ({ page }) => {
    await page.getByTestId("folder-field-input").fill("/Users/demo/rfq-agent");
    await expect(page.getByTestId("aw-add")).toBeVisible();

    await page.getByTestId("folder-field-input").fill("/Users/demo/scratch");
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    await expect(page.getByTestId("aw-add-all")).toBeEnabled();
  });
});
