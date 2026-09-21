/**
 * The new-agent screen (NewSessionComposer), reached through New project on
 * the browser host (flow-creation.md §4.1, §4.3): describe the agent, attach
 * files, and submit. The harness scaffolds the agent in the project first and
 * one ordinary session opens on it, seeded with the idea, the resources and
 * the planning instructions as setup. The screen then gives way to the
 * terminal, and the canvas stays hidden until it has content. All in mock
 * mode; the first turn is recorded on window.__HARNESS_TEST__.lastInitialInput.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { BLANK_PROJECT_ROOT, openNewAgentScreen } from "./mock-navigation";

const initialTaskText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInitialInput?: { text?: string } };
        }
      ).__HARNESS_TEST__?.lastInitialInput?.text ?? "",
  );

const injectCallCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { injectInputCalls?: unknown[] };
        }
      ).__HARNESS_TEST__?.injectInputCalls?.length ?? 0,
  );

const createOrder = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createOrder?: string[] } })
        .__HARNESS_TEST__?.createOrder ?? []) as string[],
  );

const lastCreateRequest = (
  page: Page,
): Promise<Record<string, unknown> | undefined> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: {
            lastCreateSession?: { req?: Record<string, unknown> };
          };
        }
      ).__HARNESS_TEST__?.lastCreateSession?.req,
  );

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openNewAgentScreen(page);
});

test("New project opens the screen with no terminal or canvas, and a chip prefills the box", async ({
  page,
}) => {
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("composer-project")).toHaveText(
    "New agent in blank-slate",
  );

  // No terminal, no canvas while composing.
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // A quick-idea chip prefills the box (editable), it doesn't submit.
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveValue("");
  await page.getByTestId("composer-chip-research-digest").click();
  await expect(input).toHaveValue(/digest/i);
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  expect(await createOrder(page)).toEqual([]);
});

test("describing the agent creates it in the project, then one session opens on it", async ({
  page,
}) => {
  const idea = "Diff our competitors' pricing pages every morning.";
  await page.getByTestId("composer-input").fill(idea);
  await page.getByTestId("composer-send").click();

  // The screen gives way to the live workbench (a new session).
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();

  // Created first, then talked to, both in the project (flow-creation.md §4.4).
  await expect
    .poll(() => createOrder(page))
    .toEqual([
      `scaffold:${BLANK_PROJECT_ROOT}/diff-competitors`,
      `session:${BLANK_PROJECT_ROOT}`,
    ]);
  // The exact user task leads the launch argument; the planning instructions
  // follow it as setup; nothing is injected afterwards.
  await expect
    .poll(() => initialTaskText(page))
    .toMatch(new RegExp(`^${escapeRegExp(idea)}\n\n`));
  expect(await initialTaskText(page)).toContain("Session setup.");
  expect(await initialTaskText(page)).not.toContain("sapiom_dev_agents_scaffold");
  expect(await injectCallCount(page)).toBe(0);
  const req = await lastCreateRequest(page);
  expect(req?.cwd).toBe(BLANK_PROJECT_ROOT);
  expect(req?.initialUserInputPending).toBe(true);
  expect(req).not.toHaveProperty("scaffold");
});

test("a picked file reaches the first request, and the session is rooted at the project", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) => `/Users/test/My Files/${file.name}`,
    };
  });

  await page.getByTestId("composer-input").fill("Build an onboarding flow.");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "requirements.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("requirements"),
  });

  const files = page.getByTestId("composer-files");
  await expect(files).toContainText("requirements.pdf");
  await page.getByTestId("composer-send").click();

  await expect
    .poll(() => initialTaskText(page))
    .toContain('"/Users/test/My Files/requirements.pdf"');

  const createRequest = await lastCreateRequest(page);
  expect(createRequest?.cwd).toBe(BLANK_PROJECT_ROOT);
  await expect(
    page.getByTestId("workspace-group-blank-slate").getByTestId("workflow-onboarding-flow"),
  ).toBeVisible();
});

test("picker, drop, and pathless clipboard files reach one ordered first request", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) =>
        file.name === "screenshot.png"
          ? ""
          : `/Users/test/Drop Zone/${file.name}`,
    };
  });

  await page.getByTestId("composer-input").fill("Build mixed context.");
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "requirements.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("requirements"),
  });

  const composerBox = page.getByTestId("composer-box");
  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(
      "[data-testid='composer-box']",
    )!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["brief"], "brief.txt", { type: "text/plain" }),
    );
    box.dispatchEvent(
      new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(composerBox).toHaveClass(/is-dragging-files/);
  await expect(page.getByRole("status")).toHaveText("Drop files to attach.");
  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(
      "[data-testid='composer-box']",
    )!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["brief"], "brief.txt", { type: "text/plain" }),
    );
    box.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(composerBox).not.toHaveClass(/is-dragging-files/);

  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='composer-input']",
    )!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["pixels"], "screenshot.png", { type: "image/png" }),
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });

  await expect(page.locator(".composer-file-name")).toHaveText([
    "requirements.pdf",
    "brief.txt",
    "screenshot.png",
  ]);
  await page.getByTestId("composer-send").click();

  await expect
    .poll(() => initialTaskText(page))
    .toContain("mock-screenshot.png");
  const proof = await page.evaluate(() => {
    const testState = (
      window as unknown as {
        __HARNESS_TEST__?: {
          attachFileCalls?: unknown[];
          lastInitialInput?: { text?: string };
          lastCreateSession?: { req?: { cwd?: string } };
        };
      }
    ).__HARNESS_TEST__;
    return {
      calls: testState?.attachFileCalls ?? [],
      text: testState?.lastInitialInput?.text ?? "",
      cwd: testState?.lastCreateSession?.req?.cwd ?? "",
    };
  });
  expect(proof.calls).toHaveLength(1);
  expect(proof.cwd).toBe(BLANK_PROJECT_ROOT);
  expect(proof.text.indexOf("requirements.pdf")).toBeLessThan(
    proof.text.indexOf("brief.txt"),
  );
  expect(proof.text.indexOf("brief.txt")).toBeLessThan(
    proof.text.indexOf("mock-screenshot.png"),
  );
});

test("ordinary clipboard text pastes natively without creating an attachment", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("pasted plain text"));

  const input = page.getByTestId("composer-input");
  await input.focus();
  await page.keyboard.press("ControlOrMeta+V");

  await expect(input).toHaveValue("pasted plain text");
  await expect(page.getByTestId("composer-files")).toHaveCount(0);
});

test("attachment controls expose names, live status, and keyboard removal", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) => `/Users/test/${file.name}`,
    };
  });

  await expect(page.getByTestId("composer-attach-files")).toHaveAccessibleName(
    "Attach files",
  );
  await expect(page.getByTestId("composer-send")).toHaveAccessibleName(
    "Create agent",
  );
  await expect(page.getByRole("status")).toHaveText("No files attached.");

  await page.getByTestId("composer-file-input").setInputFiles({
    name: "keyboard.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("keyboard"),
  });
  await expect(page.getByRole("status")).toHaveText("1 file attached.");

  const remove = page.getByRole("button", { name: "Remove keyboard.pdf" });
  await page.getByTestId("composer-input").focus();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  expect(
    await remove.evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("No files attached.");
});

test("attachment rows stay contained with touch-sized removal at a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) => `/Users/test/Very Long Folder/${file.name}`,
    };
  });
  await page.getByTestId("composer-file-input").setInputFiles([
    {
      name: "a-very-long-requirements-document-name.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("one"),
    },
    {
      name: "another-very-long-reference-document-name.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("two"),
    },
  ]);
  await expect(page.getByRole("status")).toHaveText("2 files attached.");

  const layout = await page.getByTestId("composer-box").evaluate((box) => {
    const rows = Array.from(
      box.querySelectorAll<HTMLElement>(".composer-file"),
    );
    const boxRect = box.getBoundingClientRect();
    return {
      contained:
        box.scrollWidth <= box.clientWidth + 1 &&
        rows.every((row) => {
          const rect = row.getBoundingClientRect();
          return rect.left >= boxRect.left && rect.right <= boxRect.right + 1;
        }),
      removeWidths: Array.from(
        box.querySelectorAll<HTMLElement>(".composer-file-remove"),
        (button) => button.getBoundingClientRect().width,
      ),
    };
  });
  expect(layout.contained).toBe(true);
  expect(layout.removeWidths.every((width) => width >= 44)).toBe(true);
});

test("re-adding and removing files keeps only the intended first-request paths", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) => `/Users/test/${file.name}`,
    };
  });
  const input = page.getByTestId("composer-file-input");
  const repeated = {
    name: "keep.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("same"),
  };
  await input.setInputFiles(repeated);
  await input.setInputFiles(repeated);
  await input.setInputFiles({
    name: "remove.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("remove"),
  });

  await expect(page.locator(".composer-file-name")).toHaveText([
    "keep.pdf",
    "remove.txt",
  ]);
  await page.getByRole("button", { name: "Remove remove.txt" }).click();
  await expect(page.locator(".composer-file-name")).toHaveText(["keep.pdf"]);

  await page.getByTestId("composer-input").fill("Use selected context.");
  await page.getByTestId("composer-send").click();
  await expect
    .poll(() => initialTaskText(page))
    .toContain("/Users/test/keep.pdf");
  expect(await initialTaskText(page)).not.toContain("remove.txt");
});

test("an attachment-only submit is refused: the idea is what names the agent", async ({
  page,
}) => {
  // The screen has ONE field, and the agent's name comes from it (D31). With
  // nothing typed there is no name to derive, and the server, the judge,
  // refuses under the field. Nothing starts; the file stays queued.
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: (file: File) => `/Users/test/${file.name}`,
    };
  });
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "brief.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("brief"),
  });

  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("composer-error")).toHaveText(
    "Give the agent a name.",
  );
  await expect(page.locator(".composer-file-name")).toHaveText(["brief.pdf"]);
  expect(await createOrder(page)).toEqual([]);
});

test("an upload failure keeps the screen and its queue; the retry reuses the created agent", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.sapiomDesktop = {
      appVersion: "test",
      checkForUpdates: async () => ({ kind: "disabled" }),
      pathForFile: () => "",
    };
  });
  await page.getByTestId("composer-input").fill("Build from this screenshot.");
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-testid='composer-input']",
    )!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["pixels"], "retry-screenshot.png", { type: "image/png" }),
    );
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(page.getByTestId("composer-files")).toContainText(
    "retry-screenshot.png",
  );
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

  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText(
    "Creating the agent with 1 file attached.",
  );
  // The agent exists (creation completed first); the SESSION did not start,
  // and the screen says exactly that under the field, keeping the queue.
  await expect(page.getByTestId("composer-send")).toBeEnabled();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("composer-error")).toContainText(
    "screenshot was created, but its session didn't start",
  );
  await expect(page.getByTestId("composer-error")).toContainText(
    /materialization failed/i,
  );
  await expect(page.getByTestId("composer-files")).toContainText(
    "retry-screenshot.png",
  );
  await expect(page.getByTestId("workflow-screenshot")).toBeVisible();

  const failedProof = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __HARNESS_TEST__?: {
          createSessionCalls?: unknown[];
          killSessionCalls?: unknown[];
          lastInjectInput?: unknown;
          createOrder?: string[];
        };
      }
    ).__HARNESS_TEST__;
    return {
      creates: state?.createSessionCalls?.length ?? 0,
      kills: state?.killSessionCalls?.length ?? 0,
      injected: state?.lastInjectInput != null,
      order: state?.createOrder ?? [],
    };
  });
  expect(failedProof).toEqual({
    creates: 1,
    kills: 0,
    injected: false,
    order: [`scaffold:${BLANK_PROJECT_ROOT}/screenshot`],
  });

  // The retry does not scaffold a duplicate of the agent it already made.
  await page.getByTestId("composer-send").click();
  await expect
    .poll(() => initialTaskText(page))
    .toContain("mock-retry-screenshot.png");
  await expect
    .poll(() => createOrder(page))
    .toEqual([
      `scaffold:${BLANK_PROJECT_ROOT}/screenshot`,
      `session:${BLANK_PROJECT_ROOT}`,
    ]);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
});

for (const agent of [
  { id: "claude-code", label: "Claude Code", name: "claude-code" },
  { id: "codex", label: "Codex", name: "codex-inbox" },
] as const) {
  test(`passes the first task at ${agent.label} launch without pasting before or after readiness`, async ({
    page,
  }) => {
    // Make the next session never reach ready on its own — the stand-in for a
    // user still on an agent's login, trust, or onboarding screen.
    await page.evaluate(() => {
      (
        window as unknown as { __MOCK_WITHHOLD_READY__?: boolean }
      ).__MOCK_WITHHOLD_READY__ = true;
    });

    if (agent.id === "codex") {
      await page.getByTestId("composer-harness-select").click();
      await page.getByTestId("composer-harness-option-codex").click();
      await expect(page.getByTestId("composer-harness-select")).toContainText(
        "Codex",
      );
    }
    const prompt = `Summarise my ${agent.label} inbox every morning.`;
    await page.getByTestId("composer-input").fill(prompt);
    await page.getByTestId("composer-send").click();

    // The session exists (workbench shown) but the prompt is HELD, not
    // injected, because the session never became ready.
    await expect(page.getByTestId("agent-view")).toBeVisible();
    await expect(page.getByTestId(`workflow-${agent.name}`)).toBeVisible();
    expect(await initialTaskText(page)).toMatch(
      new RegExp(`^${escapeRegExp(prompt)}\n\n`),
    );
    expect(await injectCallCount(page)).toBe(0);
    const createdHarness = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__?: {
              lastCreateSession?: { req?: { harness?: string } };
            };
          }
        ).__HARNESS_TEST__?.lastCreateSession?.req?.harness,
    );
    expect(createdHarness).toBe(agent.id);

    // The native CLI, not a browser readiness timer, owns the pending task.
    // Repeated readiness notifications must never paste or re-submit it.
    await page.evaluate(() =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { promoteReady?: () => void };
        }
      ).__HARNESS_TEST__?.promoteReady?.(),
    );
    await expect.poll(() => initialTaskText(page)).toContain(prompt);
    await expect.poll(() => injectCallCount(page)).toBe(0);

    await page.evaluate(() =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { promoteReady?: () => void };
        }
      ).__HARNESS_TEST__?.promoteReady?.(),
    );
    await page.waitForTimeout(500);
    expect(await injectCallCount(page)).toBe(0);
  });
}

test("a new session opens terminal-only; the canvas stays hidden until it has content", async ({
  page,
}) => {
  await page.getByTestId("composer-input").fill("Build a small thing.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("agent-view")).toBeVisible();

  // Terminal-only: a fresh mock session has no bundled doc, so the auto-reveal
  // never fires and the pane stays collapsed — but the manual show is offered.
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);
  await expect(page.getByTestId("right-expand")).toBeVisible();
  // Manual override still works. The new session settles asynchronously (mock
  // create → running/ready promotion), and an expand click landing inside that
  // ~1s transition can be undone by the settle before it takes — a real CI
  // flake, not a broken affordance (the trace shows the pane open for a frame
  // then snap shut). The button stays offered, so retry until the pane holds
  // open, exactly as a user would; once the session is settled it sticks.
  await expect(async () => {
    if (
      (await page.locator(".right-pane").getAttribute("class"))?.includes(
        "is-collapsed",
      )
    ) {
      await page.getByTestId("right-expand").click();
    }
    await expect(page.locator(".right-pane")).not.toHaveClass(/is-collapsed/, {
      timeout: 1_500,
    });
  }).toPass({ timeout: 10_000 });
});

test("the new agent appears in the rail under its project before the workbench settles", async ({
  page,
}) => {
  await page
    .getByTestId("composer-input")
    .fill("Diff competitor pricing pages every morning.");
  await page.getByTestId("composer-send").click();

  // The server rescanned before answering the scaffold, so the row is there
  // before the session POST resolves and the workbench settles.
  const group = page.getByTestId("workspace-group-blank-slate");
  await expect(group.getByTestId("workflow-diff-competitor")).toBeVisible();
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(group.getByTestId("workflow-diff-competitor")).toBeVisible();
});

test("Back returns to the session the screen was opened over", async ({
  page,
}) => {
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  await page.getByTestId("composer-back").click();
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
});

test("the agent selector lists the coding agents", async ({ page }) => {
  const select = page.getByTestId("composer-harness-select");
  await expect(select).toContainText("Claude Code");

  await select.click();
  await expect(page.getByTestId("composer-harness-menu")).toBeVisible();
  await expect(
    page.getByTestId("composer-harness-option-claude-code"),
  ).toBeVisible();
  await expect(page.getByTestId("composer-harness-option-codex")).toBeVisible();
});
