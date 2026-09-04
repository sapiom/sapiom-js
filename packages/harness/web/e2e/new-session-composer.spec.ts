/**
 * The composer-first "new session" home (NewSessionComposer): describe an
 * outcome (or pick a template) and a session starts, seeded with that outcome —
 * the same create+inject path the "start from an idea" door uses. The screen
 * then gives way to the terminal, and the canvas stays hidden until it has
 * content. All in mock mode; the injected prompt is recorded on
 * window.__HARNESS_TEST__.lastInjectInput.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { selectMockSessionFromPalette } from "./mock-navigation";

const lastInjectText = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastInjectInput?: { req?: { text?: string } } };
        }
      ).__HARNESS_TEST__?.lastInjectInput?.req?.text ?? "",
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

const sessionEvidence = (
  page: Page,
): Promise<{
  activeSessionId: string | null;
  createSessionCalls: number;
  injectInputCalls: number;
  injectedSessionId: string | null;
  injectedText: string;
  openPlannerSessionCalls: number;
}> =>
  page.evaluate(() => {
    const testState = (
      window as unknown as {
        __HARNESS_TEST__?: {
          createSessionCalls?: unknown[];
          injectInputCalls?: unknown[];
          lastInjectInput?: { id?: string; req?: { text?: string } };
          openPlannerSessionCalls?: unknown[];
        };
      }
    ).__HARNESS_TEST__;
    return {
      activeSessionId:
        document
          .querySelector('[data-testid="session-context"]')
          ?.getAttribute("data-session-id") || null,
      createSessionCalls: testState?.createSessionCalls?.length ?? 0,
      injectInputCalls: testState?.injectInputCalls?.length ?? 0,
      injectedSessionId: testState?.lastInjectInput?.id ?? null,
      injectedText: testState?.lastInjectInput?.req?.text ?? "",
      openPlannerSessionCalls: testState?.openPlannerSessionCalls?.length ?? 0,
    };
  });

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("Create new opens the composer with no terminal or canvas, and a chip prefills the box", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  // No terminal, no canvas while composing.
  await expect(page.getByTestId("agent-view")).toHaveCount(0);
  await expect(page.locator(".right-pane")).toHaveClass(/is-collapsed/);

  // A quick-idea chip prefills the box (editable), it doesn't submit.
  const input = page.getByTestId("composer-input");
  await expect(input).toHaveValue("");
  await page.getByTestId("composer-chip-research-digest").click();
  await expect(input).toHaveValue(/digest/i);
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
});

test("describing an outcome starts a session and hands the agent that outcome", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
  await page
    .getByTestId("composer-input")
    .fill("Diff our competitors' pricing pages every morning.");
  await page.getByTestId("composer-send").click();

  // The composer gives way to the live workbench (a new session).
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("agent-view")).toBeVisible();

  // The typed outcome rode into the scaffold prompt handed to the agent.
  await expect
    .poll(() => lastInjectText(page))
    .toContain("Diff our competitors' pricing pages");
});

test("Enter keeps a new-agent prompt in its standalone builder until Plan Agents is explicitly selected", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockNoLiveSessions=1&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  // The parent project exists, but with no live session it has never restored
  // its default Plan Agents workspace. Creating beneath it must not give that
  // parent restore a head start over the explicit standalone builder intent.
  await expect(page.getByTestId("workspace-group-acme-app")).toBeVisible();
  const before = await sessionEvidence(page);
  expect(before.activeSessionId).toBeNull();
  expect(before.createSessionCalls).toBe(0);
  expect(before.openPlannerSessionCalls).toBe(0);

  await page.getByTestId("rail-create-new").click();
  const idea = "Build a sales outreach agent.";
  await page.getByTestId("composer-input").fill(idea);
  await page.getByTestId("composer-input").press("Enter");

  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect
    .poll(async () => (await sessionEvidence(page)).injectedText)
    .toContain(idea);

  const evidence = await sessionEvidence(page);
  expect(evidence.createSessionCalls).toBe(before.createSessionCalls + 1);
  expect(evidence.openPlannerSessionCalls).toBe(before.openPlannerSessionCalls);
  expect(evidence.injectedSessionId).not.toBeNull();
  expect(evidence.activeSessionId).toBe(evidence.injectedSessionId);
  expect(evidence.activeSessionId).not.toBe(before.activeSessionId);
  expect(evidence.injectInputCalls).toBe(before.injectInputCalls + 1);

  const project = page.getByTestId(
    "workspace-group-acme-app/projects/build-sales-outreach",
  );
  const planAgents = project.getByTestId("agent-map-select");
  await expect(planAgents).toHaveAttribute("aria-pressed", "false");

  await planAgents.click();
  await expect
    .poll(async () => (await sessionEvidence(page)).openPlannerSessionCalls)
    .toBe(before.openPlannerSessionCalls + 1);
  await expect(planAgents).toHaveAttribute("aria-pressed", "true");
});

test("returning to an in-progress standalone builder does not restore Plan Agents", async ({
  page,
}) => {
  await page.goto("/?seed=0&mockStudioProjects=present");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect
    .poll(async () => (await sessionEvidence(page)).openPlannerSessionCalls)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const evidence = await sessionEvidence(page);
      return evidence.createSessionCalls - evidence.openPlannerSessionCalls;
    })
    .toBe(0);
  const before = await sessionEvidence(page);

  await page.getByTestId("rail-create-new").click();
  const idea = "Build a revisit guard agent.";
  await page.getByTestId("composer-input").fill(idea);
  await page.getByTestId("composer-input").press("Enter");

  const pendingBuilder = page.locator('[data-testid^="workspace-pending-"]');
  await expect(pendingBuilder).toBeVisible();
  await expect
    .poll(async () => (await sessionEvidence(page)).createSessionCalls)
    .toBe(before.createSessionCalls + 1);
  await expect(pendingBuilder).toHaveCount(0);
  // createSession() has selected the builder but has not finished the catalog
  // refresh yet, so moving now exercises the intent's bounded lifetime.
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await selectMockSessionFromPalette(page, "scratch");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /.+/,
  );
  const awaySessionId = (await sessionEvidence(page)).activeSessionId!;
  await expect
    .poll(async () => (await sessionEvidence(page)).injectedText)
    .toContain(idea);
  // Let the session we deliberately visited finish its own normal restore;
  // only planner work caused by returning to the builder is under test.
  await page.waitForTimeout(500);
  const beforeReturn = await sessionEvidence(page);

  await selectMockSessionFromPalette(page, "build-revisit-guard");
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /.+/,
  );
  expect((await sessionEvidence(page)).activeSessionId).not.toBe(awaySessionId);
  await page.waitForTimeout(500);
  const afterReturn = await sessionEvidence(page);
  expect(afterReturn.openPlannerSessionCalls).toBe(
    beforeReturn.openPlannerSessionCalls,
  );
  await expect(
    page
      .getByTestId("workspace-group-acme-app/projects/build-revisit-guard")
      .getByTestId("agent-map-select"),
  ).toHaveAttribute("aria-pressed", "false");
});

test("a picked file reaches the first request without naming the project", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
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
    .poll(() => lastInjectText(page))
    .toContain('"/Users/test/My Files/requirements.pdf"');

  const createRequest = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastCreateSession?: { req?: { cwd?: string } } };
        }
      ).__HARNESS_TEST__?.lastCreateSession?.req,
  );
  expect(createRequest?.cwd).toMatch(/\/build-onboarding-flow$/);
  expect(createRequest?.cwd).not.toContain("requirements");
});

test("picker, drop, and pathless clipboard files reach one ordered first request", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
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
    .poll(() => lastInjectText(page))
    .toContain("mock-screenshot.png");
  const proof = await page.evaluate(() => {
    const testState = (
      window as unknown as {
        __HARNESS_TEST__?: {
          attachFileCalls?: unknown[];
          lastInjectInput?: { req?: { text?: string } };
          lastCreateSession?: { req?: { cwd?: string } };
        };
      }
    ).__HARNESS_TEST__;
    return {
      calls: testState?.attachFileCalls ?? [],
      text: testState?.lastInjectInput?.req?.text ?? "",
      cwd: testState?.lastCreateSession?.req?.cwd ?? "",
    };
  });
  expect(proof.calls).toHaveLength(1);
  expect(proof.cwd).toMatch(/\/build-mixed-context$/);
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
  await page.getByTestId("rail-create-new").click();
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
  await page.getByTestId("rail-create-new").click();
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
    "Start session",
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
  await page.getByTestId("rail-create-new").click();
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
  await page.getByTestId("rail-create-new").click();
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
    .poll(() => lastInjectText(page))
    .toContain("/Users/test/keep.pdf");
  expect(await lastInjectText(page)).not.toContain("remove.txt");
});

test("an attachment-only start uses the fallback project and sends the file", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
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
  await expect
    .poll(() => lastInjectText(page))
    .toContain("/Users/test/brief.pdf");
  const cwd = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { lastCreateSession?: { req?: { cwd?: string } } };
        }
      ).__HARNESS_TEST__?.lastCreateSession?.req?.cwd ?? "",
  );
  expect(cwd).toMatch(/\/sapiom-agent$/);
});

test("an upload failure rolls back, retains the queue, sends nothing, and retries once", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
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
    "Starting session with 1 file attached.",
  );
  await expect(page.getByTestId("composer-send")).toBeEnabled();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("composer-files")).toContainText(
    "retry-screenshot.png",
  );
  await expect(page.getByTestId("toast")).toContainText(
    /retry-screenshot\.png.*materialization failed/i,
  );

  const failedProof = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __HARNESS_TEST__?: {
          createSessionCalls?: unknown[];
          killSessionCalls?: unknown[];
          lastInjectInput?: unknown;
        };
      }
    ).__HARNESS_TEST__;
    return {
      creates: state?.createSessionCalls?.length ?? 0,
      kills: state?.killSessionCalls?.length ?? 0,
      injected: state?.lastInjectInput != null,
    };
  });
  expect(failedProof).toEqual({ creates: 1, kills: 1, injected: false });

  await page.getByTestId("composer-send").click();
  await expect
    .poll(() => lastInjectText(page))
    .toContain("mock-retry-screenshot.png");
  const createCount = await page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: { createSessionCalls?: unknown[] };
        }
      ).__HARNESS_TEST__?.createSessionCalls?.length ?? 0,
  );
  expect(createCount).toBe(2);
});

for (const agent of [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const) {
  test(`holds the prompt until ${agent.label} is ready, then sends it exactly once`, async ({
    page,
  }) => {
    // Make the next session never reach ready on its own — the stand-in for a
    // user still on an agent's login, trust, or onboarding screen.
    await page.addInitScript(() => {
      (window as unknown as { __MOCK_WITHHOLD_READY__?: boolean }).__MOCK_WITHHOLD_READY__ = true;
    });
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.getByTestId("rail-create-new").click();
    if (agent.id === "codex") {
      await page.getByTestId("composer-harness-select").click();
      await page.getByTestId("composer-harness-option-codex").click();
      await expect(page.getByTestId("composer-harness-select")).toContainText("Codex");
    }
    const prompt = `Summarise my ${agent.label} inbox every morning.`;
    await page.getByTestId("composer-input").fill(prompt);
    await page.getByTestId("composer-send").click();

    // The session exists (workbench shown) but the prompt is HELD, not
    // injected, because the session never became ready.
    await expect(page.getByTestId("agent-view")).toBeVisible();
    expect(await lastInjectText(page)).toBe("");
    expect(await injectCallCount(page)).toBe(0);
    const createdHarness = await page.evaluate(
      () =>
        (
          window as unknown as {
            __HARNESS_TEST__?: { lastCreateSession?: { req?: { harness?: string } } };
          }
        ).__HARNESS_TEST__?.lastCreateSession?.req?.harness,
    );
    expect(createdHarness).toBe(agent.id);

    // The provider-neutral hint points at terminal setup while preserving the
    // original prompt.
    await expect(page.getByTestId("toast")).toContainText(
      /signing in or dismiss any trust or setup prompt/i,
      { timeout: 8_000 },
    );
    expect(await lastInjectText(page)).toBe("");

    // A readiness status releases the prompt. Repeating the status event must
    // not inject the held intent a second time.
    await page.evaluate(() =>
      (
        window as unknown as { __HARNESS_TEST__?: { promoteReady?: () => void } }
      ).__HARNESS_TEST__?.promoteReady?.(),
    );
    await expect.poll(() => lastInjectText(page)).toContain(prompt);
    await expect.poll(() => injectCallCount(page)).toBe(1);

    await page.evaluate(() =>
      (
        window as unknown as { __HARNESS_TEST__?: { promoteReady?: () => void } }
      ).__HARNESS_TEST__?.promoteReady?.(),
    );
    await page.waitForTimeout(500);
    expect(await injectCallCount(page)).toBe(1);
  });
}

test("a new session opens terminal-only; the canvas stays hidden until it has content", async ({
  page,
}) => {
  await page.getByTestId("rail-create-new").click();
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

test("the new agent's folder appears in the rail at once and is never lost mid-creation", async ({
  page,
}) => {
  const groups = page.locator(".rail-list .workspace-group");
  const before = await groups.count();

  await page.getByTestId("rail-create-new").click();
  await page
    .getByTestId("composer-input")
    .fill("Diff competitor pricing pages every morning.");
  await page.getByTestId("composer-send").click();

  // It shows up immediately — before the session POST resolves and the workbench
  // settles — as a focusable "creating agent" placeholder, so switching away
  // mid-creation can never strand the in-progress agent.
  const pending = page.locator('[data-testid^="workspace-pending-"]').first();
  await expect(pending).toBeVisible();
  await expect(pending).toHaveAttribute("aria-busy", "true");

  // And it stays: as the session lands the placeholder becomes a real folder
  // row — one more group than before, continuously present (no vanish/flicker).
  await expect(page.getByTestId("agent-view")).toBeVisible();
  await expect(groups).toHaveCount(before + 1);
});

test("Back returns to the session the composer was opened over", async ({
  page,
}) => {
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();

  await page.getByTestId("composer-back").click();
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
});

test("the agent selector lists the coding agents", async ({ page }) => {
  await page.getByTestId("rail-create-new").click();
  const select = page.getByTestId("composer-harness-select");
  await expect(select).toContainText("Claude Code");

  await select.click();
  await expect(page.getByTestId("composer-harness-menu")).toBeVisible();
  await expect(
    page.getByTestId("composer-harness-option-claude-code"),
  ).toBeVisible();
  await expect(page.getByTestId("composer-harness-option-codex")).toBeVisible();
});
