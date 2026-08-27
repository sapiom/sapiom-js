/**
 * Add existing agents — one detection-driven dialog.
 *
 * Reached from the rail's "Add existing agents" button (and the composer's
 * "Open a folder"). Point at a folder; detection relabels the single ink action:
 * Add workspace (an agent project), a bulk add (a folder of them), or a disabled
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

  test("a container of projects → the bulk action, with no count on it", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/acme-app");
    // `leasing` is the one project inside; acme-app itself is not one.
    /* RE-POINTED IN ROUND 2. This asserted `Add all 1`. The `1` was the number
       of agent projects DIRECTLY inside the folder, printed on a control that
       registers everything eight levels down: on a real install the button read
       `Add all 1` and the click wrote 87 registry rows, which is where the
       user's whole "outside your projects" flood came from. The count stays,
       where it is true — the readout — and the button stops promising it. */
    await expect(page.getByTestId("aw-add-all")).toContainText("Add every agent under this folder");
    await expect(page.getByTestId("aw-add-all")).not.toContainText("1");
    await expect(page.getByTestId("aw-result")).toContainText("1 agent project directly inside");
    await expect(page.getByTestId("aw-scan-reach")).toContainText("searches the whole tree");
  });

  /* RE-POINTED IN ROUND 2, all three, and they were asserting the defect.
     Detection probes exactly ONE directory down — that is all `GET /api/fs/list`
     reports — so "No agent in this folder" was a claim it had never checked, and
     disabling every action on the strength of it REFUSED any folder whose agents
     sit deeper. On the user's real install that is `design-eng`, whose agent
     lives at `design-eng/ari/orchestration`: the folder could not be added at
     all, which is their "there is no way to move from one state to the other"
     in its most literal form.

     The shallow probe keeps its honest job — saying what is directly inside —
     and stops speaking for the deep scan in either direction. (The same
     mismatch, from the other side, is what printed `Add all 1` on a click that
     registered 87 agents.) */
  test("a plain folder says what it CHECKED, and still offers the deep scan", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("No agent directly inside this folder");
    await expect(page.getByTestId("aw-scan-reach")).toContainText("only looks one level down");
    // The immediate-child probe cannot register anything, so its button is gone
    // rather than disabled…
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    // …and the action that CAN answer "are there agents under here?" is offered.
    await expect(page.getByTestId("aw-add-all")).toBeEnabled();
  });

  test("a not-yet-existing folder has nothing to scan, and says so", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch/brand-new-thing");

    const result = page.getByTestId("aw-result");
    await expect(result).toHaveAttribute("data-tone", "todo");
    await expect(result).toContainText("This folder doesn't exist yet");
    // A folder that is not there cannot be walked — this is the one case where
    // the disabled primary is the honest answer.
    await expect(page.getByTestId("start-primary")).toBeDisabled();
    await expect(page.getByTestId("aw-add-all")).toHaveCount(0);
  });

  test("the action relabels as the folder changes — a consequence, not a guess", async ({ page }) => {
    await page.getByTestId("dir-picker-input").fill("/Users/demo/rfq-agent");
    await expect(page.getByTestId("aw-add")).toBeVisible();

    await page.getByTestId("dir-picker-input").fill("/Users/demo/scratch");
    await expect(page.getByTestId("aw-result")).toContainText("No agent directly inside this folder");
    await expect(page.getByTestId("aw-add")).toHaveCount(0);
    await expect(page.getByTestId("aw-add-all")).toBeEnabled();
  });
});
