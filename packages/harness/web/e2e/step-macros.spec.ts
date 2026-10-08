/**
 * Step-click debug macros e2e coverage (SAP-1900).
 *
 * Contract under test — the board's chat panel (the 💬 toggle) in the agent
 * modal carries three debug-macro buttons and a free-form ask textarea. Each
 * is a macro (flow-map-chat-overlay.md 4.4b): it starts a NEW project-root
 * session with a first message tuned to the job, the step as context, and
 * opens it. Nothing is typed into an existing session.
 *
 * Coverage:
 *  - Picking a board node surfaces the step macros in the chat.
 *  - "Debug this step" starts a session whose first message is the step's
 *    context + question.
 *  - "Why is this step slow / stuck?" and "Explain this step" do the same.
 *  - Free-form textarea + Ask button send a custom question.
 *  - Cmd+Enter in the free-form textarea also sends.
 *  - A step with run data includes its status in the first message.
 *
 * All tests run in mock mode (VITE_MOCK=1). The bundled interactive board at
 * public/canvas/sess-boot/ is swapped into the modal's frame, and
 * window.__HARNESS_TEST__.createSessionCalls lets Playwright read the
 * session the macro starts.
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";
import { openAgentModal } from "./mock-navigation";


// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * leasing's board in its agent modal. The bundled interactive fixture board
 * is swapped into the pane's own `srcdoc` frame, so picks travel the same
 * gesture-layer / hit path a generated board answers.
 */
const openBoard = async (page: Page): Promise<void> => {
  await openAgentModal(page, "acme-app", "leasing");
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await page.evaluate(async () => {
    const html = await (await fetch("/canvas/sess-boot/index.html")).text();
    (document.querySelector(".canvas-iframe") as HTMLIFrameElement).srcdoc = html;
  });
};

/** A clean slate, then leasing's board. */
const loadBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openBoard(page);
};

/** Click a board node through the gesture layer to populate the inspector. */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const node = page.frameLocator(".canvas-iframe").locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  // Wait for auto-fit so the zoom isn't still 100%.
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const box = await node.boundingBox();
  if (!box) throw new Error(`${nodeId} node has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** Open the standalone chat panel (macros + ask) via the 💬 toggle — closed by
 *  default now, independent of the step inspector. */
const openChat = async (page: Page): Promise<void> => {
  await page.getByTestId("canvas-chat-toggle").click();
  await expect(page.getByTestId("canvas-chat-panel")).toBeVisible();
};

type CreateCall = { req: { cwd: string; initialPrompt?: string } };

/** The sessions created so far (MockApi.createSession records each). */
const createCalls = (page: Page): Promise<CreateCall[]> =>
  page.evaluate(
    () =>
      ((window as unknown as { __HARNESS_TEST__?: { createSessionCalls?: unknown[] } })
        .__HARNESS_TEST__?.createSessionCalls ?? []) as CreateCall[],
  );

/**
 * The session a macro just started: a new one at the project ROOT whose first
 * message is the macro's text, and the centre goes to it. Nothing was typed
 * into an existing session.
 */
const lastAsk = async (page: Page): Promise<{ cwd: string; text: string }> => {
  await expect
    .poll(async () => (await createCalls(page)).length, {
      timeout: 3000,
      message: "expected the macro to start a session",
    })
    .toBeGreaterThan(0);
  const req = (await createCalls(page)).at(-1)!.req;
  await expect(page.getByTestId("agent-modal")).toHaveCount(0);
  await expect(page.getByTestId("project-map-pane")).toHaveCount(0);
  const injected = await page.evaluate(
    () =>
      (window as unknown as { __HARNESS_TEST__?: { lastInjectInput?: unknown } }).__HARNESS_TEST__
        ?.lastInjectInput ?? null,
  );
  expect(injected).toBeNull();
  return { cwd: req.cwd, text: req.initialPrompt ?? "" };
};

/** Publish a bus message via the test hook. */
const publish = (page: Page, message: unknown): Promise<void> =>
  page.evaluate((msg) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish(msg);
  }, message);

/** Seed a custom RunView for MockApi.getRunState to return once. */
const seedRunState = (page: Page, executionId: string, view: RunView): Promise<void> =>
  page.evaluate(
    ([id, v]) => {
      const win = window as unknown as { __MOCK_RUN_STATE__?: Record<string, unknown> };
      win.__MOCK_RUN_STATE__ = { ...(win.__MOCK_RUN_STATE__ ?? {}), [id]: v };
    },
    [executionId, view] as [string, RunView],
  );

// ---------------------------------------------------------------------------
// Macro bar visibility
// ---------------------------------------------------------------------------

test.describe("chat panel visibility", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the chat is closed by default and opens via the 💬 toggle", async ({ page }) => {
    // Closed by default — no chat/macros on load.
    await expect(page.getByTestId("canvas-chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("canvas-inspector-macros")).toHaveCount(0);

    await openChat(page);
    // With no step selected the chat is a general ask — freeform only, no
    // step-specific macros.
    await expect(page.getByTestId("canvas-freeform-input")).toHaveAttribute(
      "placeholder",
      "Ask about this agent…",
    );
    await expect(page.getByTestId("canvas-macro-debug")).toHaveCount(0);
  });

  test("picking a step surfaces the step macros in the chat", async ({ page }) => {
    await openChat(page);
    await pickNode(page, "intake");
    // The chat names the picked step itself; the step card yields the corner.
    await expect(page.getByTestId("step-card")).toHaveCount(0);

    const macros = page.getByTestId("canvas-inspector-macros");
    await expect(macros.getByTestId("canvas-macro-debug")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-slow")).toBeVisible();
    await expect(macros.getByTestId("canvas-macro-explain")).toBeVisible();
    await expect(macros.getByTestId("canvas-freeform-input")).toBeVisible();
  });

  test("the chat closes on its own X, and the pick's step card comes back", async ({ page }) => {
    await pickNode(page, "intake");
    await expect(page.getByTestId("step-card")).toBeVisible();
    await openChat(page);
    // One card in the board's corner at a time: the chat, about the pick.
    await expect(page.getByTestId("canvas-chat-panel")).toBeVisible();
    await expect(page.getByTestId("step-card")).toHaveCount(0);

    // Closing the chat keeps the pick, so its step card returns.
    await page.getByTestId("canvas-chat-close").click();
    await expect(page.getByTestId("canvas-chat-panel")).toHaveCount(0);
    await expect(page.getByTestId("step-card-title")).toHaveText("intake");
  });
});

// ---------------------------------------------------------------------------
// Macro inject — no run data (graph-only / pre-run)
// ---------------------------------------------------------------------------

test.describe("debug macros — pre-run (no run data)", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
    await pickNode(page, "intake");
    await openChat(page);
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();
  });

  test("'Debug this step' starts a session with the step context + question", async ({ page }) => {
    await page.getByTestId("canvas-macro-debug").click();

    const ask = await lastAsk(page);
    // The step name must appear in the context block.
    expect(ask.text).toContain("Step: intake");
    // The question must be appended.
    expect(ask.text).toContain("Debug this step");
    // A new session at the project root, never one bound to the agent.
    expect(ask.cwd).toBe("/Users/demo/acme-app");
  });

  test("'Why is this step slow / stuck?' asks the right question", async ({ page }) => {
    await page.getByTestId("canvas-macro-slow").click();

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Step: intake");
    expect(ask.text).toContain("Why is this step slow / stuck?");
  });

  test("'Explain this step' asks the right question", async ({ page }) => {
    await page.getByTestId("canvas-macro-explain").click();

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Step: intake");
    expect(ask.text).toContain("Explain this step");
  });

  test("free-form Ask sends the typed question", async ({ page }) => {
    const freeform = page.getByTestId("canvas-freeform-input");
    await freeform.fill("What does this step produce?");

    // Ask button should be enabled now.
    const askBtn = page.getByTestId("canvas-freeform-ask");
    await expect(askBtn).toBeEnabled();
    await askBtn.click();

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Step: intake");
    expect(ask.text).toContain("What does this step produce?");
  });

  test("Cmd+Enter in the free-form textarea submits", async ({ page }) => {
    const freeform = page.getByTestId("canvas-freeform-input");
    await freeform.fill("Any edge cases?");

    await freeform.press("Meta+Enter");

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Any edge cases?");
  });

  test("Ask button is disabled when the freeform is empty", async ({ page }) => {
    const askBtn = page.getByTestId("canvas-freeform-ask");
    await expect(askBtn).toBeDisabled();
  });

  test("no $ cost appears in the sent context (cost-free contract)", async ({ page }) => {
    await page.getByTestId("canvas-macro-debug").click();
    const ask = await lastAsk(page);
    // The first message must contain no dollar signs (no spend/cost data).
    expect(ask.text).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Macro inject — with run data (prod run)
// ---------------------------------------------------------------------------

test.describe("debug macros — prod run data enriches the context", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("the step's run status appears in the first message", async ({ page }) => {
    // A prod run of leasing (sess-boot is bound to it when the run starts),
    // so its board, and the chat over it, carry run truth. The failed step is
    // the observable signal that the run landed: its Debug macro turns
    // primary.
    await seedRunState(page, "exec-status-intake", {
      executionId: "exec-status-intake",
      status: "failed",
      steps: [
        { id: "intake", name: "intake", status: "failed" as const, error: "Validation error" },
      ],
    });
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-status-intake",
      target: "prod",
    });

    await pickNode(page, "intake");
    await openChat(page);
    await expect(page.getByTestId("canvas-macro-debug")).toHaveClass(/btn-primary/, { timeout: 8000 });

    await page.getByTestId("canvas-macro-debug").click();

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Step: intake");
    expect(ask.text).toContain("Status: failed");
    expect(ask.text).not.toContain("$");
  });

  test("the 'Debug this step' button is styled primary on a failed step", async ({ page }) => {
    await seedRunState(page, "exec-fail-intake", {
      executionId: "exec-fail-intake",
      status: "failed",
      steps: [
        { id: "intake", name: "intake", status: "failed" as const, error: "Validation error" },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-fail-intake",
      target: "prod",
    });

    // The run is the agent's, so it reaches the modal's board directly.
    await pickNode(page, "intake");
    await openChat(page);
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();

    // "Debug this step" should be btn-primary on a failed step.
    await expect(page.getByTestId("canvas-macro-debug")).toHaveClass(/btn-primary/, { timeout: 8000 });
    // The other macros stay ghost.
    await expect(page.getByTestId("canvas-macro-slow")).toHaveClass(/btn-ghost/);
    await expect(page.getByTestId("canvas-macro-explain")).toHaveClass(/btn-ghost/);
  });
});

// ---------------------------------------------------------------------------
// Macro inject — offline stub run
// ---------------------------------------------------------------------------

test.describe("debug macros — offline stub run", () => {
  test("the macro bar appears after a local stub run and includes run status", async ({ page }) => {
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Run locally from leasing's modal header: the Run sheet, then launch.
    await openAgentModal(page, "acme-app", "leasing");
    await page.getByTestId("agent-modal-run-local").click();
    await page.getByTestId("run-sheet-submit").click();
    await expect(page.getByRole("dialog", { name: /^Run / })).toHaveCount(0);

    // The mock's local stub run streams for about a second; let it finish so
    // the board below is not re-rendered mid-pick.
    await page.waitForTimeout(1500);

    // Back on leasing's board (the launch moves the centre to the session it
    // ran in until runs are keyed by path, SAP-3839).
    if ((await page.getByTestId("agent-modal").count()) > 0)
      await page.getByTestId("agent-modal-close").click();
    await openBoard(page);
    await pickNode(page, "intake");
    await openChat(page);
    await expect(page.getByTestId("canvas-inspector-macros")).toBeVisible();

    await page.getByTestId("canvas-macro-debug").click();

    const ask = await lastAsk(page);
    expect(ask.text).toContain("Step: intake");
    // Local run sets status: "passed" for intake.
    expect(ask.text).toContain("Status: passed");
    expect(ask.text).not.toContain("$");
  });
});
