import { expect, test, type Page } from "@playwright/test";
import type { CreateSessionRequest } from "../../src/shared/types";

import { BLANK_PROJECT_ROOT, openNewAgentScreen } from "./mock-navigation";

interface CreationEvidence {
  createSessionCalls?: { req: CreateSessionRequest }[];
  createOrder?: string[];
  lastInitialInput?: { id: string; text: string };
  injectInputCalls?: unknown[];
}

const creationEvidence = (page: Page): Promise<CreationEvidence> =>
  page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: CreationEvidence })
        .__HARNESS_TEST__ ?? {},
  );

async function queueFiles(page: Page, desktop: boolean): Promise<void> {
  if (desktop) {
    await page.evaluate(() => {
      window.sapiomDesktop = {
        appVersion: "test",
        checkForUpdates: async () => ({ kind: "disabled" }),
        pathForFile: (file: File) =>
          file.name === "notes.txt" ? "/Users/test/input/notes.txt" : "",
      };
    });
  }
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Source notes"),
  });
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["pixels"], "screenshot.png", { type: "image/png" }),
    );
    document.querySelector("[data-testid='composer-input']")!.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(page.locator(".composer-file-name")).toHaveText([
    "notes.txt",
    "screenshot.png",
  ]);
}

/**
 * A FRESH INSTALL has no project, so the first thing is New project (the
 * folder step), and the new-agent screen it lands on is where these files are
 * queued. Creation completes before the chat starts: the agent is scaffolded
 * first, and a failure materializing the files is a SESSION failure that
 * leaves the agent in the rail, the screen mounted, and the queue intact for
 * the retry, which reuses the agent instead of scaffolding a second one.
 */
for (const scenario of [
  {
    name: "browser uploads",
    desktop: false,
    idea: "Build from these files.",
    harness: "claude-code",
  },
  {
    name: "a desktop clipboard image",
    desktop: true,
    idea: "Build from these files.",
    harness: "codex",
  },
] as const) {
  test(`the screen retains ${scenario.name} after failure and retries once`, async ({
    page,
  }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("no-project-home")).toBeVisible();
    await openNewAgentScreen(page);
    const composer = page.getByTestId("new-session-composer");
    await composer.evaluate((node) => {
      node.setAttribute("data-original-draft", "true");
    });
    await page.getByTestId("composer-harness-select").click();
    await page
      .getByTestId(`composer-harness-option-${scenario.harness}`)
      .click();
    await page.getByTestId("composer-input").fill(scenario.idea);
    await queueFiles(page, scenario.desktop);
    await page.evaluate(() => {
      (
        window as unknown as { __MOCK_ATTACH_FILE_FAIL_ONCE__?: boolean }
      ).__MOCK_ATTACH_FILE_FAIL_ONCE__ = true;
      const send = document.querySelector<HTMLButtonElement>(
        "[data-testid='composer-send']",
      )!;
      send.click();
      send.click();
    });

    // The refusal lands under the field and names both facts: the agent was
    // created, its session did not start.
    await expect(page.getByTestId("new-agent-error")).toContainText(
      /materialization failed/i,
    );
    await expect(page.getByTestId("new-agent-error")).toContainText(
      "files was created, but its session didn't start",
    );
    // Reopening an empty screen after the error is not recovery: its local
    // text and queue must survive on the original mounted instance.
    await expect(composer).toHaveAttribute("data-original-draft", "true");
    await expect(page.getByTestId("composer-input")).toHaveValue(scenario.idea);
    await expect(page.getByTestId("composer-input")).toBeFocused();
    await expect(page.locator(".composer-file-name")).toHaveText([
      "notes.txt",
      "screenshot.png",
    ]);
    await expect(
      page.getByRole("button", { name: "Remove screenshot.png" }),
    ).toBeEnabled();
    await expect(page.getByTestId("composer-send")).toBeEnabled();
    await expect(page.getByTestId("composer-harness-select")).toContainText(
      scenario.harness === "codex" ? "Codex" : "Claude Code",
    );

    const failed = await creationEvidence(page);
    expect(failed.createSessionCalls).toHaveLength(1);
    expect(failed.lastInitialInput).toBeUndefined();
    expect(failed.injectInputCalls ?? []).toHaveLength(0);
    const firstRequest = failed.createSessionCalls![0]!.req;
    expect(firstRequest.cwd).toBe(BLANK_PROJECT_ROOT);
    expect(failed.createOrder).toEqual([`scaffold:${BLANK_PROJECT_ROOT}/files`]);
    // The agent is a row under its project already.
    await expect(
      page.getByTestId("workspace-group-blank-slate").getByTestId("workflow-files"),
    ).toBeVisible();

    await page.getByTestId("composer-send").click();
    await expect(composer).toHaveCount(0);
    const completed = await creationEvidence(page);
    expect(completed.createSessionCalls).toHaveLength(2);
    const retry = completed.createSessionCalls![1]!.req;
    // The retry reuses the agent the first attempt created: one scaffold,
    // then the session, in the same project folder.
    expect(retry.cwd).toBe(BLANK_PROJECT_ROOT);
    expect(retry.harness).toBe(scenario.harness);
    expect(retry.initialPrompt ?? "").toBe(scenario.idea);
    expect(retry.initialAttachments).toEqual(firstRequest.initialAttachments);
    expect(completed.createOrder).toEqual([
      `scaffold:${BLANK_PROJECT_ROOT}/files`,
      `session:${BLANK_PROJECT_ROOT}`,
    ]);
    const paths = [
      scenario.desktop
        ? "/Users/test/input/notes.txt"
        : `${BLANK_PROJECT_ROOT}/.sapiom/uploads/mock-notes.txt`,
      `${BLANK_PROJECT_ROOT}/.sapiom/uploads/mock-screenshot.png`,
    ];
    // Idea, then files, then the planning instructions as setup.
    expect(completed.lastInitialInput?.text.startsWith(
      [
        scenario.idea,
        `Attached files (read each as context):\n${paths.join("\n")}`,
      ].join("\n\n"),
    )).toBe(true);
    expect(completed.lastInitialInput?.text).toContain("already scaffolded");
    expect(completed.injectInputCalls ?? []).toHaveLength(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      completed.lastInitialInput!.id,
    );
  });
}

test("the screen stays mounted until a delayed first request is prepared", async ({
  page,
}) => {
  await page.goto("/?mockState=fresh");
  await openNewAgentScreen(page);
  await page.getByTestId("composer-input").fill("Use both files.");
  await queueFiles(page, false);
  await page.evaluate(() => {
    const testWindow = window as unknown as {
      __MOCK_CREATE_SESSION_DELAY_MS__?: number;
      __HARNESS_TEST__?: CreationEvidence;
      __COMPOSER_PREPARATION__?: {
        detachedEarly: boolean;
        sawScaffold: boolean;
      };
    };
    testWindow.__MOCK_CREATE_SESSION_DELAY_MS__ = 600;
    const composer = document.querySelector(
      "[data-testid='new-session-composer']",
    )!;
    const observation = { detachedEarly: false, sawScaffold: false };
    testWindow.__COMPOSER_PREPARATION__ = observation;
    const observer = new MutationObserver(() => {
      if (testWindow.__HARNESS_TEST__?.lastInitialInput) {
        observer.disconnect();
        return;
      }
      observation.detachedEarly ||= !composer.isConnected;
      observation.sawScaffold ||=
        testWindow.__HARNESS_TEST__?.createOrder?.some((entry) =>
          entry.startsWith("scaffold:"),
        ) ?? false;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  const completed = await creationEvidence(page);
  expect(completed.createSessionCalls).toHaveLength(1);
  expect(completed.lastInitialInput?.text).toContain("Use both files.");
  expect(completed.lastInitialInput?.text).toContain("mock-notes.txt");
  expect(completed.lastInitialInput?.text).toContain("mock-screenshot.png");
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __COMPOSER_PREPARATION__?: {
              detachedEarly: boolean;
              sawScaffold: boolean;
            };
          }
        ).__COMPOSER_PREPARATION__,
    ),
  ).toEqual({ detachedEarly: false, sawScaffold: true });
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    completed.lastInitialInput!.id,
  );
});
