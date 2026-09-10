import { expect, test, type Page } from "@playwright/test";
import type { CreateSessionRequest } from "../../src/shared/types";

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
  {
    name: "an attachment-only request",
    desktop: false,
    idea: "",
    harness: "claude-code",
  },
] as const) {
  test(`the automatic home retains ${scenario.name} after failure and retries once`, async ({
    page,
  }) => {
    // Do not click Create new: that explicitly activates the composer and
    // would hide the automatic-home state bug this test must exercise.
    await page.goto("/?mockState=fresh");
    const composer = page.getByTestId("new-session-composer");
    await expect(composer).toBeVisible();
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

    await expect(page.getByTestId("toast")).toContainText(
      /materialization failed/i,
    );
    // Reopening an empty composer after the error is not recovery: its local
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
    expect(failed.createOrder).toEqual([`scaffold:${firstRequest.cwd}`]);
    // Discovery has reached the UI even though the unrooted section is
    // collapsed by default on a fresh install.
    await expect(page.getByTestId("unrooted-count")).toHaveText("1");

    await page.getByTestId("composer-send").click();
    await expect(composer).toHaveCount(0);
    const completed = await creationEvidence(page);
    expect(completed.createSessionCalls).toHaveLength(2);
    const retry = completed.createSessionCalls![1]!.req;
    // The first scaffold stays registered. Retry uses the existing next-name
    // rule rather than overwriting the completed folder from the failed try.
    expect(retry.cwd).toBe(`${firstRequest.cwd}-2`);
    expect(retry.harness).toBe(scenario.harness);
    expect(retry.initialPrompt ?? "").toBe(scenario.idea);
    expect(retry.initialAttachments).toEqual(firstRequest.initialAttachments);
    expect(completed.createOrder).toEqual([
      `scaffold:${firstRequest.cwd}`,
      `scaffold:${retry.cwd}`,
      `session:${retry.cwd}`,
    ]);
    const paths = [
      scenario.desktop
        ? "/Users/test/input/notes.txt"
        : `${retry.cwd}/.sapiom/uploads/mock-notes.txt`,
      `${retry.cwd}/.sapiom/uploads/mock-screenshot.png`,
    ];
    expect(completed.lastInitialInput?.text).toBe(
      [
        scenario.idea,
        `Attached files (read each as context):\n${paths.join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    expect(completed.injectInputCalls ?? []).toHaveLength(0);
    await expect(page.getByTestId("session-context")).toHaveAttribute(
      "data-session-id",
      completed.lastInitialInput!.id,
    );
  });
}

test("the automatic home stays mounted until a delayed first request is prepared", async ({
  page,
}) => {
  await page.goto("/?mockState=fresh");
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
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
