/** SAP-3121: every template launch keeps the user's selected coding agent.
 * Mock sessions record the actual create request; telemetry alone would not
 * prove which adapter the server is asked to launch.
 *
 * Templates route through the new-agent screen now (flow-creation.md §5,
 * CF-D11): Use makes the template the idea on the screen, scoped to the
 * project on screen or to the folder the folder step picks, and the harness
 * picker on that screen is the one choice every launch honours. */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BLANK_PROJECT_ROOT, openNewAgentScreen } from "./mock-navigation";

type LaunchSurface =
  | "composer"
  | "gallery-detail"
  | "starter-detail"
  | "gallery-card";

async function chooseCodex(page: Page): Promise<void> {
  await page.getByTestId("composer-harness-select").click();
  await page.getByTestId("composer-harness-option-codex").click();
  await expect(page.getByTestId("composer-harness-select")).toContainText(
    "Codex",
  );
}

/** Use a template from the gallery. With no project on screen the folder
 *  step runs first (the web dialog here); either way it ends on the screen
 *  with the template as the idea. */
async function confirmTemplate(
  page: Page,
  id: string,
  fromCard = false,
): Promise<void> {
  if (fromCard) {
    await page.getByTestId(`template-card-info-${id}`).click();
    await page.getByTestId(`template-facts-use-${id}`).click();
  } else {
    await page.getByTestId(`template-card-open-${id}`).click();
    await page.getByTestId("template-use-btn").click();
  }
  const dialog = page.getByTestId("project-folder-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
    await dialog.getByTestId("project-folder-continue").click();
  }
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toHaveValue(/template/i);
}

async function launchTemplate(
  page: Page,
  surface: LaunchSurface,
): Promise<void> {
  if (surface === "composer") {
    await page.getByTestId("composer-template-hello-agent").click();
    await expect(page.getByTestId("composer-input")).toHaveValue(/template/i);
    return;
  }
  await page.getByTestId("composer-browse-templates").click();
  const id = surface.startsWith("starter") ? "coding-pause" : "hello-agent";
  await confirmTemplate(page, id, surface.endsWith("card"));
}

/** Submit the screen and prove the session was asked for with `harness`. */
async function expectTemplateSession(
  page: Page,
  harness: "claude-code" | "codex",
  starter = false,
): Promise<void> {
  await expect(page.getByTestId("composer-harness-select")).toContainText(
    harness === "codex" ? "Codex" : "Claude",
  );
  await page.getByTestId("composer-send").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __HARNESS_TEST__?: {
                createSessionCalls?: Array<{
                  req: { cwd: string; harness: string };
                }>;
              };
            }
          ).__HARNESS_TEST__?.createSessionCalls?.map(({ req }) => ({
            cwd: req.cwd,
            harness: req.harness,
          })) ?? [],
      ),
    )
    .toEqual([{ cwd: BLANK_PROJECT_ROOT, harness }]);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("templates-panel")).toHaveCount(0);
  if (starter) {
    // A starter is scaffolded AS that starter, under the project.
    await expect(page.getByTestId("workflow-coding-pause")).toBeVisible();
  } else {
    // A gallery template is named in the setup for build time; nothing is
    // typed at the pty after launch.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __HARNESS_TEST__?: {
                  lastInitialInput?: { text?: string };
                };
              }
            ).__HARNESS_TEST__?.lastInitialInput?.text ?? "",
        ),
      )
      .toContain('templateId "hello-agent"');
  }
}

for (const surface of [
  "composer",
  "gallery-detail",
  "starter-detail",
  "gallery-card",
] as const) {
  test(`selected Codex is preserved from ${surface} on a fresh install`, async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await chooseCodex(page);
    await launchTemplate(page, surface);
    await expectTemplateSession(page, "codex", surface.startsWith("starter"));
  });
}

for (const surface of [
  "composer",
  "gallery-detail",
  "starter-detail",
] as const) {
  test(`no harness preference keeps the Claude default from ${surface}`, async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await expect(page.getByTestId("composer-harness-select")).toContainText(
      "Claude",
    );
    await launchTemplate(page, surface);
    await expectTemplateSession(
      page,
      "claude-code",
      surface.startsWith("starter"),
    );
  });
}

for (const surface of [
  "composer",
  "gallery-detail",
  "starter-detail",
] as const) {
  test(`automatically selected Codex is preserved from ${surface}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (
        window as unknown as { __MOCK_UNINSTALLED_HARNESSES__: string[] }
      ).__MOCK_UNINSTALLED_HARNESSES__ = ["claude-code"];
    });
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await expect(page.getByTestId("composer-harness-select")).toContainText(
      "Codex",
    );
    await launchTemplate(page, surface);
    await expectTemplateSession(page, "codex", surface === "starter-detail");
  });

  test(`selected Codex is preserved from ${surface} when preferences cannot be saved`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value): void {
        if (key === "sapiom-harness-ui-prefs") {
          throw new DOMException(
            "Storage quota exceeded",
            "QuotaExceededError",
          );
        }
        setItem.call(this, key, value);
      };
    });
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await chooseCodex(page);
    await launchTemplate(page, surface);
    await expectTemplateSession(page, "codex", surface === "starter-detail");
  });
}

for (const entry of ["rail", "palette", "deep-link"] as const) {
  test(`saved Codex preference is preserved when entering templates from ${entry}`, async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await chooseCodex(page);
    if (entry === "deep-link") {
      await page.goto("/?mockState=fresh&template=hello-agent");
      await page.getByTestId("template-use-btn").click();
    } else {
      // Reload to verify the saved preference, independent of composer state.
      await page.reload();
      if (entry === "rail") {
        await page.getByTestId("rail-templates").click();
      } else {
        await page.getByTestId("palette-trigger").click();
        await page.getByTestId("command-palette-input").fill("templates");
        await page
          .getByTestId("command-palette-list")
          .getByText("Browse templates")
          .click();
      }
      await page.getByTestId("template-card-open-hello-agent").click();
      await page.getByTestId("template-use-btn").click();
    }
    // A fresh mock forgets its projects on reload, so Use runs the folder
    // step first; the saved preference still drives the screen it lands on.
    const dialog = page.getByTestId("project-folder-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
    await dialog.getByTestId("project-folder-continue").click();
    await expect(page.getByTestId("new-session-composer")).toBeVisible();
    await expectTemplateSession(page, "codex");
  });
}

test("a direct gallery visit uses the current selection after leaving the composer", async ({
  page,
}) => {
  await page.goto("/?mockState=fresh");
  await openNewAgentScreen(page);
  await chooseCodex(page);
  await page.getByTestId("composer-browse-templates").click();
  await page.getByTestId("templates-exit").click();
  await page.getByTestId("composer-harness-select").click();
  await page.getByTestId("composer-harness-option-claude-code").click();
  await page.getByTestId("rail-templates").click();
  await confirmTemplate(page, "hello-agent");
  await expectTemplateSession(page, "claude-code");
});

for (const entry of ["rail", "palette", "deep-link"] as const) {
  test(`only Codex installed launches Codex through ${entry}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (
        window as unknown as { __MOCK_UNINSTALLED_HARNESSES__: string[] }
      ).__MOCK_UNINSTALLED_HARNESSES__ = ["claude-code"];
    });
    await page.goto(
      entry === "deep-link"
        ? "/?mockState=fresh&template=hello-agent"
        : "/?mockState=fresh",
    );
    if (entry === "deep-link") {
      await page.getByTestId("template-use-btn").click();
      const dialog = page.getByTestId("project-folder-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("folder-field-input").fill(BLANK_PROJECT_ROOT);
      await dialog.getByTestId("project-folder-continue").click();
      await expect(page.getByTestId("new-session-composer")).toBeVisible();
    } else {
      await openNewAgentScreen(page);
      await expect(page.getByTestId("composer-harness-select")).toContainText(
        "Codex",
      );
      if (entry === "rail") {
        await page.getByTestId("rail-templates").click();
      } else {
        await page.getByTestId("palette-trigger").click();
        await page.getByTestId("command-palette-input").fill("templates");
        await page
          .getByTestId("command-palette-list")
          .getByText("Browse templates")
          .click();
      }
      await confirmTemplate(page, "hello-agent");
    }
    await expectTemplateSession(page, "codex");
  });
}

for (const navigation of ["exit-back", "back-forward"] as const) {
  test(`gallery uses the current selection after ${navigation} when preference writes fail`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value): void {
        if (key === "sapiom-harness-ui-prefs") {
          throw new DOMException(
            "Storage quota exceeded",
            "QuotaExceededError",
          );
        }
        original.call(this, key, value);
      };
    });
    await page.goto("/?mockState=fresh");
    await openNewAgentScreen(page);
    await chooseCodex(page);
    await page.getByTestId("composer-browse-templates").click();
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    if (navigation === "exit-back") {
      await page.getByTestId("templates-exit").click();
      // Returning to the gallery uses the new choice, even without storage.
      await page.getByTestId("composer-harness-select").click();
      await page.getByTestId("composer-harness-option-claude-code").click();
      await page.getByRole("button", { name: "Go back", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Go back", exact: true }).click();
      await page
        .getByRole("button", { name: "Go forward", exact: true })
        .click();
    }
    await expect(page.getByTestId("templates-panel")).toBeVisible();
    await confirmTemplate(page, "hello-agent");
    await expectTemplateSession(
      page,
      navigation === "exit-back" ? "claude-code" : "codex",
    );
  });
}

test("a registry failure still launches the selected harness from the composer", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as unknown as { __MOCK_HARNESS_REGISTRY_FAIL__: boolean }
    ).__MOCK_HARNESS_REGISTRY_FAIL__ = true;
  });
  await page.goto("/?mockState=fresh");
  await openNewAgentScreen(page);
  await chooseCodex(page);
  await launchTemplate(page, "composer");
  await expectTemplateSession(page, "codex");
});
