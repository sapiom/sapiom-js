/**
 * TWO VERBS, ONE SCREEN, ONE SESSION TYPE (flow-creation.md rev 4, §4 and §5;
 * SAP-3143 E1 to E4, SAP-3153).
 *
 * These assert destinations and side effects, not menus opening:
 *
 *  1. New project runs the folder step and lands on the new-agent screen
 *     scoped to the folder; Add project runs the same step and stops. Neither
 *     creates a session (Q5).
 *  2. On desktop the OS picker is called DIRECTLY and no Studio dialog opens
 *     (D29). Playwright is the browser host, so the bridge is injected.
 *  3. Submit scaffolds through the endpoint first, then opens one ordinary
 *     session bound to the agent, whose first prompt is the idea, the
 *     resources, and the planning instructions as session setup. No English
 *     scaffold prompt is typed anywhere (D30).
 *  4. A refusal lands under the field and nothing starts (D31).
 *  5. Links and long pastes are intake, not text (§4.6 step 1).
 *  6. Template Use routes through the screen (CF-D11).
 *  7. An empty project's name lands on the screen (D36).
 *  8. A project row's New agent lands on the same screen, scoped to that
 *     project (§4.2).
 *  9. The options menu holds Group by and Sort by only; Past sessions opens
 *     from the history glyph (§4.7, Q9). An empty project's row says it is
 *     the door to the screen (D36).
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
  createOrder: string[];
  createSessionCalls: Array<{ req: Record<string, unknown> }>;
  lastCreateSession: { req: Record<string, unknown> } | null;
  lastInitialInput: { id: string; text: string } | null;
  lastInjectInput: { req?: { text?: string } } | null;
  bindWorkflowCalls: unknown[];
}

const evidence = (page: Page): Promise<Evidence> =>
  page.evaluate(() => {
    const state = (
      window as unknown as { __HARNESS_TEST__?: Record<string, unknown> }
    ).__HARNESS_TEST__ ?? {};
    return {
      createOrder: (state.createOrder as string[]) ?? [],
      createSessionCalls:
        (state.createSessionCalls as Array<{ req: Record<string, unknown> }>) ??
        [],
      lastCreateSession:
        (state.lastCreateSession as { req: Record<string, unknown> }) ?? null,
      lastInitialInput:
        (state.lastInitialInput as { id: string; text: string }) ?? null,
      lastInjectInput:
        (state.lastInjectInput as { req?: { text?: string } }) ?? null,
      bindWorkflowCalls: (state.bindWorkflowCalls as unknown[]) ?? [],
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

  test("New agent lands on the screen even over an exited session's pane", async ({
    page,
  }) => {
    // Measured on the real server: with a dead session on screen, pressing the
    // row's New agent showed nothing, because the dead pane outranked the
    // screen. Every entrance lands on the screen.
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-history").click();
    await page.getByTestId("exited-session-sess-leasing").click();
    await expect(page.getByTestId("dead-session-pane")).toBeVisible();

    await openNewAgentInProject(page, "acme-app");
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
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

test.describe("submit", () => {
  test("creation completes before the chat starts, and the first turn plans", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentScreen(page);

    const idea = "Watch our competitors' pricing pages and send a sourced digest every Monday.";
    await page.getByTestId("composer-input").fill(idea);
    await expect(page.getByTestId("composer-send")).toHaveAccessibleName("Create agent");
    await page.getByTestId("composer-send").click();

    // THE ORDER IS THE CRITERION (D30): scaffold in the project, then one
    // session in the project folder. The name is derived from the idea (D31).
    await expect
      .poll(async () => (await evidence(page)).createOrder)
      .toEqual([
        `scaffold:${BLANK_PROJECT_ROOT}/competitors-pricing`,
        `session:${BLANK_PROJECT_ROOT}`,
      ]);
    // The agent is a row in the rail under its project.
    await expect(page.getByTestId("workflow-competitors-pricing")).toBeVisible();
    // The screen gave way to the live workbench.
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await expect(page.getByTestId("agent-view")).toBeVisible();

    const after = await evidence(page);
    const req = after.lastCreateSession!.req;
    // An ORDINARY session: the ordinary request, with the idea as the first
    // prompt and the planning instructions as setup, never a scaffold option.
    expect(req.cwd).toBe(BLANK_PROJECT_ROOT);
    expect(req.initialPrompt).toBe(idea);
    expect(req.initialUserInputPending).toBe(true);
    expect(req).not.toHaveProperty("scaffold");
    expect(String(req.initialSetup)).toContain("already scaffolded");
    expect(String(req.initialSetup)).toContain("sapiom-agent-authoring");
    // The composed first turn: idea first, setup last, nothing typed later.
    const text = after.lastInitialInput!.text;
    expect(text.startsWith(idea)).toBe(true);
    expect(text).toContain("at most three clarifying questions");
    expect(text).toContain("Build only after the user says go");
    expect(text).not.toContain("sapiom_dev_agents_scaffold");
    expect(after.lastInjectInput).toBeNull();
    // Bound to the agent it created.
    expect(after.bindWorkflowCalls).toHaveLength(1);
    // The setup is disclosed quietly, not as the user's words.
    const setup = page.getByTestId("session-setup");
    await expect(setup).toBeVisible();
    await expect(setup.locator("summary")).toContainText("Planning instructions");
    await setup.locator("summary").click();
    await expect(page.getByTestId("session-setup-body")).toContainText(
      "Restate the outcome and the proof of success",
    );
  });

  test("a duplicate name is refused by the server, under the field, and nothing starts", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentInProject(page, "acme-app");

    // `leasing` is a fixture agent in acme-app; the idea derives to that name.
    const idea = "Build a leasing agent";
    await page.getByTestId("composer-input").fill(idea);
    await page.getByTestId("composer-send").click();

    const error = page.getByTestId("new-agent-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveText("acme-app already has an agent called leasing.");
    await expect(error).not.toContainText("/api/agents/scaffold");
    // The screen stays, holding what was typed, and NOTHING started.
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveValue(idea);
    await expect(page.getByTestId("composer-input")).toBeFocused();
    const after = await evidence(page);
    expect(after.createOrder).toEqual([]);
    expect(after.createSessionCalls).toEqual([]);
    // Editing clears the refusal.
    await page.getByTestId("composer-input").fill("Build a leasing renewals agent");
    await expect(error).toHaveCount(0);
  });

  test("an endpoint refusal is the server's sentence, not the wire shape", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present&mockError=scaffold");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentScreen(page);
    await page.getByTestId("composer-input").fill("Triage support tickets by urgency.");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("new-agent-error")).toHaveText(
      "Can't create an agent in blank-slate right now.",
    );
    expect((await evidence(page)).createSessionCalls).toEqual([]);
  });

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
    // A sentence with a link inside it still types.
    await expect(page.getByRole("status")).toHaveText("1 file and 2 links attached.");
    // One link can be removed like a file.
    await page.getByRole("button", { name: "Remove https://b.example/pricing" }).click();
    await expect(page.getByTestId("composer-source")).toHaveCount(1);

    await page.getByTestId("composer-send").click();
    await expect
      .poll(async () => (await evidence(page)).lastCreateSession?.req.initialSources)
      .toEqual(["https://a.example/spec"]);
    const req = (await evidence(page)).lastCreateSession!.req;
    expect(req.initialAttachments).toEqual([
      expect.objectContaining({ kind: "inline", filename: "pasted-1.md" }),
    ]);
    // The composed first turn lands once the mock has materialized the paste.
    await expect
      .poll(async () => (await evidence(page)).lastInitialInput?.text ?? "")
      .toContain("Linked sources");
    const text = (await evidence(page)).lastInitialInput!.text;
    expect(text).toContain("Linked sources (read each as context):\nhttps://a.example/spec");
    expect(text).toContain("mock-pasted-1.md");
    expect(text.indexOf("Attached files")).toBeLessThan(text.indexOf("Linked sources"));
    expect(text.indexOf("Linked sources")).toBeLessThan(text.indexOf("already scaffolded"));
  });

  test("a failed session start keeps the screen and reuses the created agent on retry", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentScreen(page);
    await page.getByTestId("composer-input").fill("Build from this screenshot.");
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["pixels"], "shot.png", { type: "image/png" }));
      document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
      );
    });
    await expect(page.locator(".composer-file-name")).toHaveText(["shot.png"]);
    await page.evaluate(() => {
      (window as unknown as { __MOCK_ATTACH_FILE_FAIL_ONCE__?: boolean }).__MOCK_ATTACH_FILE_FAIL_ONCE__ = true;
    });
    await page.getByTestId("composer-send").click();

    // The agent exists; the session did not start; the screen says exactly that.
    await expect(page.getByTestId("new-agent-error")).toContainText(
      "screenshot was created, but its session didn't start",
    );
    await expect(page.getByTestId("workflow-screenshot")).toBeVisible();
    await expect(page.locator(".composer-file-name")).toHaveText(["shot.png"]);
    expect((await evidence(page)).createOrder).toEqual([
      `scaffold:${BLANK_PROJECT_ROOT}/screenshot`,
    ]);

    // The retry does not scaffold a duplicate of our own work.
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
    await expect
      .poll(async () => (await evidence(page)).createOrder)
      .toEqual([
        `scaffold:${BLANK_PROJECT_ROOT}/screenshot`,
        `session:${BLANK_PROJECT_ROOT}`,
      ]);
  });
});

test.describe("templates route through the screen", () => {
  test("Use on a fresh install: the folder step, then the template as the idea", async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await page.getByTestId("template-card-open-coding-pause").click();
    await page.getByTestId("template-use-btn").click();

    // No project on screen: the folder comes first (§4.1), carrying the template.
    await expect(page.getByTestId("template-use-dialog")).toHaveCount(0);
    const dialog = page.getByTestId("project-folder-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
    await dialog.getByTestId("project-folder-continue").click();

    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expect(page.getByTestId("templates-panel")).toHaveCount(0);
    await expect(page.getByTestId("composer-input")).toHaveValue(
      /^Start from the Coding pause template\./,
    );
    await page.getByTestId("composer-send").click();
    // A starter is scaffolded AS that starter, and nobody was asked to clone.
    await expect
      .poll(async () => (await evidence(page)).createOrder)
      .toEqual([
        `scaffold:${BLANK_PROJECT_ROOT}/coding-pause`,
        `session:${BLANK_PROJECT_ROOT}`,
      ]);
    const created = (await evidence(page)).lastInitialInput!.text;
    expect(created).toContain("scaffolded from the Coding pause starter");
    expect(created).not.toContain("sapiom_dev_agents_scaffold");
  });

  test("Use with a project on screen lands there; a gallery template is named for build time", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openNewAgentInProject(page, "acme-app");
    await page.getByTestId("composer-browse-templates").click();
    await page.getByTestId("template-card-open-web-research-digest").click();
    await page.getByTestId("template-use-btn").click();

    await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
    await expect(page.getByTestId("new-agent-project")).toContainText("acme-app");
    await expect(page.getByTestId("composer-input")).toHaveValue(/^Start from the .* template\./);
    await page.getByTestId("composer-send").click();
    await expect
      .poll(async () => (await evidence(page)).lastInitialInput?.text ?? "")
      .toContain('templateId "web-research-digest"');
    expect((await evidence(page)).lastInitialInput!.text).toContain("sapiom_dev_agents_clone");
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
    // §4.4: the idea is the user's turn; the link is handed as a source, not
    // appended to the idea (the pre-slice-4 interim did that).
    const [call] = (await evidence(page)).createSessionCalls;
    expect(call?.req.initialPrompt).toBe("Summarise this spec.");
    expect(call?.req.initialSources).toEqual(["https://a.example/spec"]);
  });
});

test.describe("the rail top", () => {
  test("the options menu files the tree and nothing else; history has its own glyph", async ({
    page,
  }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    const options = page.getByTestId("rail-options");
    await expect(options).toHaveAttribute("aria-label", "Group and sort projects");
    await expect(options.locator("svg.lucide-sliders-horizontal")).toHaveCount(1);
    await options.click();
    const menu = page.getByTestId("rail-options-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("filing-group-by")).toBeVisible();
    await expect(menu.getByTestId("filing-sort-by")).toBeVisible();
    await expect(menu).not.toContainText("Past sessions");
    await expect(page.getByTestId("past-sessions-trigger")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    const history = page.getByTestId("rail-history");
    await expect(history).toHaveAttribute("aria-label", "Past sessions");
    await expect(history).toHaveAttribute("aria-haspopup", "dialog");
    await history.click();
    await expect(page.getByTestId("history-menu")).toBeVisible();
    // The promised popup IS a dialog, named by its heading.
    await expect(page.getByRole("dialog", { name: "Past sessions" })).toBeVisible();
    await expect(history).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("past-sessions-card")).toBeVisible();
    await expect(page.getByTestId("exited-session-sess-leasing")).toBeVisible();
    // Focus enters the dialog on open and returns to the glyph on Escape.
    await expect(
      page.getByTestId("history-menu").getByRole("button", { name: "Close" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("history-menu")).toBeHidden();
    await expect(history).toBeFocused();
    // Close does the same by hand: the focused control unmounts.
    await history.click();
    await page.getByTestId("history-menu").getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("history-menu")).toBeHidden();
    await expect(history).toBeFocused();
    await history.click();
    await expect(page.getByTestId("history-menu")).toBeVisible();
    // One flyer at a time: opening the options menu retires the card.
    await options.click();
    await expect(page.getByTestId("history-menu")).toBeHidden();
    await expect(menu).toBeVisible();
  });

  test("an empty project's row says it is the door to the screen (D36)", async ({
    page,
  }) => {
    await page.goto("/?seed=0&mockStudioProjects=present");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await addProject(page, BLANK_PROJECT_ROOT);
    // No agents, so no map to draw: the row's tooltip names what its name does.
    await expect(page.getByTestId("project-select-blank-slate")).toHaveAttribute(
      "data-tooltip",
      "Create this project's first agent",
    );
    // A project that holds agents keeps its map.
    await expect(page.getByTestId("project-select-acme-app")).toHaveAttribute(
      "data-tooltip",
      /Agent Map/,
    );
  });
});
