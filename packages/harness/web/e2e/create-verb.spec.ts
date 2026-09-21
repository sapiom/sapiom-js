/**
 * TWO VERBS, ONE SCREEN (flow-creation.md rev 4, §4.1, §4.2, §4.5; SAP-3573).
 *
 * These assert destinations and side effects, not menus opening:
 *
 *  1. New project runs the folder step and lands on the new-agent screen
 *     scoped to the folder; Add project runs the same step and stops. Neither
 *     creates a session (Q5).
 *  2. On desktop the OS picker is called DIRECTLY and no Studio dialog opens
 *     (D29). Playwright is the browser host, so the bridge is injected.
 *  3. A project row's New agent lands on the same screen, scoped to that
 *     project (§4.2), and so does an empty project's name (D36).
 *  4. Links and long pastes are intake, not text (§4.6 step 1).
 *  5. An install with no project sees the no-project home.
 *
 * Submit, intake, the empty project's door and the rail's history glyph are
 * guarded by the slices that add them (SAP-3574, SAP-3576, SAP-3575).
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  BLANK_PROJECT_ROOT,
  addProject,
  openNewAgentInProject,
  openNewAgentScreen,
} from "./mock-navigation";

interface Evidence {
  createSessionCalls: Array<{ req: Record<string, unknown> }>;
}

const evidence = (page: Page): Promise<Evidence> =>
  page.evaluate(() => {
    const state = (
      window as unknown as { __HARNESS_TEST__?: Record<string, unknown> }
    ).__HARNESS_TEST__ ?? {};
    return {
      createSessionCalls:
        (state.createSessionCalls as Array<{ req: Record<string, unknown> }>) ??
        [],
    };
  });

/** The desktop bridge as the Electron preload publishes it, recording picks. */
const installDesktopBridge = async (
  page: Page,
  picked: string | null,
): Promise<void> => {
  await page.addInitScript((choice: string | null) => {
    const calls: Array<string | undefined> = [];
    Object.assign(window, {
      __chooseCalls: calls,
      sapiomDesktop: {
        appVersion: "0.0.0-e2e",
        checkForUpdates: () =>
          Promise.resolve({ kind: "up-to-date", version: "0.0.0-e2e", channel: "e2e" }),
        chooseDirectory: (defaultPath?: string) => {
          calls.push(defaultPath);
          return Promise.resolve(choice);
        },
      },
    });
  }, picked);
};

const chooseCalls = (page: Page): Promise<Array<string | undefined>> =>
  page.evaluate(
    () => (window as unknown as { __chooseCalls: Array<string | undefined> }).__chooseCalls ?? [],
  );

test.describe("the two verbs", () => {
  test("New project (web): the folder step, then the screen scoped to the folder, and no session", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    // The rail top, in order (Q10): New project, Search, Templates, Projects.
    const nav = page.locator(".rail-nav > button");
    await expect(nav).toHaveCount(3);
    await expect(nav.nth(0)).toHaveAttribute("data-testid", "rail-new-project");
    await expect(nav.nth(0)).toHaveText("New project");
    await expect(nav.nth(1)).toHaveAttribute("data-testid", "palette-trigger");
    await expect(nav.nth(2)).toHaveAttribute("data-testid", "rail-templates");
    await expect(page.getByTestId("add-existing-agents")).toHaveCount(0);
    await expect(page.getByTestId("rail-create-new")).toHaveCount(0);

    await page.getByTestId("rail-new-project").click();
    // The web fallback: ONE field on the shared shell, titled for the verb.
    const dialog = page.getByTestId("project-folder-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".modal-title")).toHaveText("New project");
    await expect(dialog.getByTestId("folder-field-input")).toBeFocused();
    await expect(dialog.getByTestId("project-folder-continue")).toBeDisabled();
    // A folder that is not there cannot be a project, and says so.
    await dialog.getByTestId("folder-field-input").fill("/Users/demo/nope/not-yet");
    await expect(dialog.getByTestId("project-folder-hint")).toHaveText(
      "That folder doesn't exist yet.",
    );
    await expect(dialog.getByTestId("project-folder-continue")).toBeDisabled();

    await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
    await expect(dialog.getByTestId("project-folder-continue")).toBeEnabled();
    await dialog.getByTestId("project-folder-continue").click();

    // THE DESTINATION: the screen, stating the project in both places.
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("new-agent-project")).toHaveText(
      "New agent in blank-slate",
    );
    await expect(page.getByTestId("session-project-chip")).toContainText(
      "New agent in blank-slate",
    );
    // The folder is a project in the rail, with nothing under it yet.
    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
    // No right pane: nothing exists to project until submit.
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    // AND NO SESSION (Q5): the user types first.
    expect((await evidence(page)).createSessionCalls).toEqual([]);
    await expect(page.locator(".session-tabs-list > .session-tab")).toHaveCount(0);
  });

  test("New project (desktop): the OS picker directly, no Studio dialog, cancel returns", async ({
    page,
  }) => {
    await installDesktopBridge(page, BLANK_PROJECT_ROOT);
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-new-project").click();
    // The picker was asked, with no pre-chosen parent (Q8) ...
    await expect.poll(() => chooseCalls(page)).toEqual([undefined]);
    // ... and OUR dialog never opened beside it (D29), held for a window.
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
    await expect(page.locator(".modal-start")).toHaveCount(0);
    await expect(page.getByTestId("new-agent-project")).toContainText("blank-slate");
    expect((await evidence(page)).createSessionCalls).toEqual([]);
  });

  test("New project (desktop): a cancelled pick changes nothing", async ({ page }) => {
    await installDesktopBridge(page, null);
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    const rows = await page.locator('[data-testid^="project-row-"]').count();

    await page.getByTestId("rail-new-project").click();
    await expect.poll(() => chooseCalls(page)).toHaveLength(1);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await expect(page.locator('[data-testid^="project-row-"]')).toHaveCount(rows);
    // Back where they were: the boot session is still the one on screen.
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
  });

  test("Add project: the folder step and nothing after it", async ({ page }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-add-project").click();
    await expect(
      page.getByTestId("project-folder-dialog").locator(".modal-title"),
    ).toHaveText("Add project");
    await page.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
    await page.getByTestId("project-folder-continue").click();

    await expect(page.getByTestId("project-row-blank-slate")).toBeVisible();
    // No screen, no session (§4.5, Q5). The session on screen is unchanged.
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await page.waitForTimeout(300);
    expect((await evidence(page)).createSessionCalls).toEqual([]);
    await expect(page.getByText("Plan Agents", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      "sess-boot",
    );
  });

  test("New agent on a project row lands on the same screen, scoped to that project", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentInProject(page, "acme-app");
    await expect(page.getByTestId("new-agent-project")).toHaveText(
      "New agent in acme-app",
    );
    expect((await evidence(page)).createSessionCalls).toEqual([]);
  });

  test("an empty project's name is the door (D36)", async ({ page }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await addProject(page, BLANK_PROJECT_ROOT);
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);

    await page.getByTestId("project-select-blank-slate").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("new-agent-project")).toContainText("blank-slate");
    // Not a map with nothing drawn in it.
    await expect(page.getByTestId("agent-map-frame")).toHaveCount(0);
    expect((await evidence(page)).createSessionCalls).toEqual([]);
  });

  test("a fresh install shows the no-project home, and its one move is New project", async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("no-project-home")).toBeVisible();
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await page.getByTestId("home-new-project").click();
    await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  });
});

test.describe("intake", () => {
  test("links pasted into the box are sources; a long paste is a document", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentScreen(page);
    const input = page.getByTestId("composer-input");
    await input.fill("Summarise these every morning.");

    const paste = async (text: string): Promise<void> => {
      await page.evaluate((value) => {
        const transfer = new DataTransfer();
        transfer.setData("text/plain", value);
        document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        );
      }, text);
    };

    // Only links: listed, not typed.
    await paste("https://a.example/spec\nhttps://b.example/pricing");
    await expect(page.getByTestId("composer-source")).toHaveCount(2);
    await expect(input).toHaveValue("Summarise these every morning.");
    await expect(page.getByRole("status")).toHaveText("2 links attached.");
    // A wall of text: attached, not typed.
    await paste(Array.from({ length: 40 }, (_, i) => `Requirement ${i + 1}: something.`).join("\n"));
    // The chip says what it is (the design's "Pasted document, N words"); the
    // file it rides in keeps the pasted-N.md name on the chip's title.
    await expect(page.locator(".composer-file-name")).toContainText(["Pasted document"]);
    await expect(page.getByTestId("composer-source-document")).toContainText(/\d+ words/);
    await expect(input).toHaveValue("Summarise these every morning.");
    await expect(page.getByRole("status")).toHaveText("1 file and 2 links attached.");
    // One link can be removed like a file.
    await page.getByRole("button", { name: "Remove https://b.example/pricing" }).click();
    await expect(page.getByTestId("composer-source")).toHaveCount(1);
    // Nothing has been created or started: intake is not submit.
    expect((await evidence(page)).createSessionCalls).toEqual([]);
  });

  test("a pasted link reaches the session with the idea; it does not die with the screen", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentScreen(page);
    await page.getByTestId("composer-input").fill("Summarise this spec.");
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "https://a.example/spec");
      document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    });
    await expect(page.getByTestId("composer-source")).toHaveCount(1);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    const [call] = (await evidence(page)).createSessionCalls;
    expect(call?.req.initialPrompt).toBe("Summarise this spec.\nhttps://a.example/spec");
  });
});
