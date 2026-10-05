/**
 * Canvas board animation bridge — regression guard.
 *
 * The served canvas board listens for a run-state message
 * ({ type: "sapiom:run-state", steps, status, target }) and applies
 * is-running / is-passed / is-failed / is-pending to each [data-step-name]
 * SVG node. The parent (CanvasPane) must post that message whenever the run
 * changes and re-post on iframe load.
 *
 * The reverse click channel: the served board posts
 * { type: "sapiom:node-click", stepName } when a node is clicked; the
 * parent maps that to the graph node's id and shows the step's card.
 *
 * The board is the agent modal's (flow-map-chat-overlay.md 4.2b): served by
 * path, so its runs are the agent's, attributed by the session's binding when
 * the run started (`ObservedRun.workflowPath`).
 *
 * This spec covers the PARENT producer side (the postMessage bridge) and the
 * reverse click channel.
 *
 * Run-state bridge strategy: the mock board does NOT implement the
 * sapiom:run-state listener (it predates the SVG board format). We swap the
 * modal frame's document for a minimal HTML page that:
 *   (a) listens for sapiom:run-state and echoes a receipt back to the parent
 *       as { type: "sapiom:run-state-received", ... }, AND
 *   (b) posts its graph and size data so the rest of CanvasPane's wiring works.
 * We then assert the parent receives the echo — verifying the bridge fires
 * with the correct payload without relying on cross-origin DOM access.
 *
 * Reverse-click channel strategy: use Playwright's frame() accessor to
 * dispatch the node-click message FROM WITHIN the iframe's frame context so
 * event.source === iframe.contentWindow passes the guard in CanvasPane.
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";
import { openAgentModal } from "./mock-navigation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const publish = (page: Page, message: unknown): Promise<void> =>
  page.evaluate((msg) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish(msg);
  }, message);

const seedRunState = (page: Page, executionId: string, view: RunView): Promise<void> =>
  page.evaluate(
    ([id, v]) => {
      const win = window as unknown as { __MOCK_RUN_STATE__?: Record<string, unknown> };
      win.__MOCK_RUN_STATE__ = { ...(win.__MOCK_RUN_STATE__ ?? {}), [id]: v };
    },
    [executionId, view] as [string, RunView],
  );

/**
 * A minimal canvas document that:
 * - Posts its graph so CanvasPane gets the step list (needed for sapiom:node-click lookup).
 * - Posts its size so the fit-to-view logic can run.
 * - Listens for sapiom:run-state and echoes a receipt to the parent.
 * - Listens for sapiom-canvas:view (the board contract) so CanvasPane doesn't error.
 */
const INSTRUMENTED_CANVAS_DOC = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body>
<script>
  // Post graph so CanvasPane builds its step list.
  var graph = {
    name: "leasing",
    entry: "intake",
    nodes: [
      { id: "intake", kind: "entry", label: "intake", role: "entry", description: "Logs the incoming order.", timeoutMs: null, inputSchema: null, capabilities: [] },
      { id: "screen", kind: "step", label: "screen", role: "step", description: "Screens the applicant.", timeoutMs: null, inputSchema: null, capabilities: [] },
      { id: "approve", kind: "step", label: "approve?", role: "step", description: "Branching gate.", timeoutMs: null, inputSchema: null, capabilities: [] }
    ],
    edges: [
      { from: "intake", to: "screen", kind: "sequential", label: "" },
      { from: "screen", to: "approve", kind: "sequential", label: "" }
    ],
    groups: [],
    warnings: []
  };
  parent.postMessage({ type: "sapiom-canvas:graph", graph: graph }, "*");
  parent.postMessage({ type: "sapiom-canvas:size", width: 320, height: 480, insetTop: 0, insetBottom: 0, insetX: 0 }, "*");

  // Listen for sapiom:run-state and echo a receipt so the test can verify the bridge fired.
  window.addEventListener("message", function(e) {
    var d = e && e.data;
    if (!d) return;
    if (d.type === "sapiom:run-state") {
      // Echo the full message with a distinguishable type.
      parent.postMessage({
        type: "sapiom:run-state-received",
        steps: d.steps,
        status: d.status,
        target: d.target
      }, "*");
    }
  });
</script>
</body>
</html>`;

/** (Re)load the modal frame with the instrumented document, as a served
 *  board's own load would. */
const swapInInstrumentedBoard = (page: Page): Promise<void> =>
  page.evaluate((doc) => {
    (document.querySelector(".agent-modal .canvas-iframe") as HTMLIFrameElement).srcdoc = doc;
  }, INSTRUMENTED_CANVAS_DOC);

/** leasing's agent modal, its board swapped for the instrumented document. */
const loadWithInstrumentedBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await openAgentModal(page, "acme-app", "leasing");
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await expect(page.locator(".canvas-loading--overlay")).toHaveCount(0, { timeout: 8_000 });
  await swapInInstrumentedBoard(page);
  // Wait for the skeleton to clear so frameLoading is false (the bridge guards on this).
  await expect(page.locator(".canvas-loading--overlay")).toHaveCount(0, { timeout: 8_000 });
};

/** Collect all sapiom:run-state-received messages posted by the instrumented document. */
const collectRunStateReceipts = (page: Page): Promise<Array<{ steps: unknown; status: string; target: string }>> =>
  page.evaluate(() => {
    const win = window as unknown as { __RUN_STATE_RECEIPTS__?: Array<{ steps: unknown; status: string; target: string }> };
    return win.__RUN_STATE_RECEIPTS__ ?? [];
  });

/** Install a parent-side message listener that records run-state-received echoes. */
const installReceiptListener = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const win = window as unknown as { __RUN_STATE_RECEIPTS__?: Array<{ steps: unknown; status: string; target: string }> };
    win.__RUN_STATE_RECEIPTS__ = [];
    window.addEventListener("message", (e) => {
      const d = e && (e.data as { type?: string; steps?: unknown; status?: string; target?: string } | null);
      if (d && d.type === "sapiom:run-state-received") {
        win.__RUN_STATE_RECEIPTS__!.push({ steps: d.steps, status: d.status ?? "", target: d.target ?? "" });
      }
    });
  });

// ---------------------------------------------------------------------------
// Run-state bridge: producer side
// ---------------------------------------------------------------------------

test.describe("run-state bridge — CanvasPane posts sapiom:run-state into the iframe", () => {
  test("posts sapiom:run-state to the iframe when a run becomes active", async ({ page }) => {
    await loadWithInstrumentedBoard(page);
    await installReceiptListener(page);

    const executionId = "exec-anim-test-1";
    await seedRunState(page, executionId, {
      executionId,
      status: "running",
      steps: [
        { id: "intake", name: "intake", status: "running" },
        { id: "screen", name: "screen", status: "pending" },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId,
      target: "prod",
    });

    await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");

    // The run-state bridge fires when the run lands in state and frameLoading is false.
    // Poll until the instrumented document echoes back the receipt.
    await expect
      .poll(
        async () => {
          const receipts = await collectRunStateReceipts(page);
          return receipts.length > 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const receipts = await collectRunStateReceipts(page);
    expect(receipts[0]).toMatchObject({
      status: expect.any(String),
      target: "prod",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "intake" }),
      ]),
    });
  });

  test("re-posts sapiom:run-state on iframe reload when a run is active", async ({ page }) => {
    await loadWithInstrumentedBoard(page);

    const executionId = "exec-anim-reload";
    await seedRunState(page, executionId, {
      executionId,
      status: "completed",
      steps: [
        { id: "intake", name: "intake", status: "passed", latencyMs: 120 },
        { id: "screen", name: "screen", status: "passed", latencyMs: 340 },
      ],
    });

    // Start a run so run state lands in the component.
    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId,
      target: "local",
    });
    // The run lands on the agent's board: the bridge posts it.
    await installReceiptListener(page);
    await expect
      .poll(async () => (await collectRunStateReceipts(page)).length > 0, { timeout: 10_000 })
      .toBe(true);

    // Install the receipt listener BEFORE the reload so it is already in place
    // when the new document loads and echoes back the re-posted run state.
    await installReceiptListener(page);

    // Now reload the frame's document — its onLoad handler must re-post the
    // current run state to the new document; the new document echoes it back;
    // the parent listener above records the echo.
    await swapInInstrumentedBoard(page);

    // Poll for the receipt — the instrumented doc's echo arrives once the new
    // document has loaded and the onLoad re-post has fired.
    await expect
      .poll(
        async () => {
          const receipts = await collectRunStateReceipts(page);
          return receipts.length > 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const receipts = await collectRunStateReceipts(page);
    expect(receipts[0]).toMatchObject({
      status: expect.any(String),
      target: "local",
      steps: expect.arrayContaining([
        expect.objectContaining({ name: "intake", status: expect.any(String) }),
      ]),
    });
  });

  test("does NOT post sapiom:run-state when there is no active run", async ({ page }) => {
    await loadWithInstrumentedBoard(page);
    await installReceiptListener(page);

    // No run started — the bridge must be silent.
    // Allow some time for any spurious messages.
    await page.waitForTimeout(500);

    const receipts = await collectRunStateReceipts(page);
    expect(receipts).toHaveLength(0);
  });

  test("run-state message carries the correct shape: type, steps, status, target", async ({
    page,
  }) => {
    await loadWithInstrumentedBoard(page);
    await installReceiptListener(page);

    const executionId = "exec-shape-check";
    await seedRunState(page, executionId, {
      executionId,
      status: "running",
      steps: [
        { id: "intake", name: "intake", status: "running" },
        { id: "screen", name: "screen", status: "pending" },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId,
      target: "local",
    });

    await expect
      .poll(async () => (await collectRunStateReceipts(page)).length > 0, { timeout: 10_000 })
      .toBe(true);

    const receipts = await collectRunStateReceipts(page);
    const msg = receipts[0];
    // The exact fields the served board's bootCanvasRunState listener expects:
    expect(msg.status).toBe("running");
    expect(msg.target).toBe("local");
    expect(Array.isArray(msg.steps)).toBe(true);
    const steps = msg.steps as Array<{ name: string; status: string }>;
    expect(steps.find((s) => s.name === "intake")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sapiom:node-click reverse channel — served board node click shows the step card
// ---------------------------------------------------------------------------

/** The graph the instrumented document posts, as data the node-click tests
 *  can post from inside the entered page's board. */
const INSTRUMENTED_GRAPH = {
  name: "leasing",
  entry: "intake",
  nodes: [
    { id: "intake", kind: "entry", label: "intake", role: "entry", description: "Logs the incoming order.", timeoutMs: null, inputSchema: null, capabilities: [] },
    { id: "screen", kind: "step", label: "screen", role: "step", description: "Screens the applicant.", timeoutMs: null, inputSchema: null, capabilities: [] },
    { id: "approve", kind: "step", label: "approve?", role: "step", description: "Branching gate.", timeoutMs: null, inputSchema: null, capabilities: [] },
  ],
  edges: [
    { from: "intake", to: "screen", kind: "sequential", label: "" },
    { from: "screen", to: "approve", kind: "sequential", label: "" },
  ],
  groups: [],
  warnings: [],
};

test.describe("sapiom:node-click reverse channel — board click shows the step card", () => {
  test.beforeEach(async ({ page }) => {
    // leasing's modal: the board by path, served as the frame's document.
    await page.goto("/?seed=0");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await openAgentModal(page, "acme-app", "leasing");
    await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
    await expect(page.locator(".canvas-loading--overlay")).toHaveCount(0, { timeout: 8_000 });
    // The instrumented graph (an `approve` node labelled `approve?`), posted
    // FROM the frame so it passes the pane's event.source guard, as a served
    // board posts its own.
    await page.frameLocator(".canvas-iframe").locator("body").evaluate((_, graph) => {
      window.parent.postMessage({ type: "sapiom-canvas:graph", graph }, "*");
    }, INSTRUMENTED_GRAPH);
  });

  /** Send a sapiom:node-click message FROM WITHIN the iframe's frame context.
   *  Playwright's frameLocator gives us access to the iframe's window so the
   *  message source passes CanvasPane's event.source === frameRef.contentWindow guard. */
  const sendNodeClickFromFrame = async (page: Page, stepName: string): Promise<void> => {
    const frameHandle = page.frameLocator(".canvas-iframe");
    // Use the frame's evaluate context so postMessage originates from the iframe's window.
    await frameHandle.locator("body").evaluate((_, name) => {
      window.parent.postMessage({ type: "sapiom:node-click", stepName: name }, "*");
    }, stepName);
  };

  test("a sapiom:node-click message from the iframe selects the step in its card", async ({
    page,
  }) => {
    await sendNodeClickFromFrame(page, "intake");

    await expect(page.getByTestId("step-card-title")).toHaveText("intake", { timeout: 5_000 });
    await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  });

  test("sapiom:node-click for a step label that differs from its id still resolves correctly", async ({
    page,
  }) => {
    // The instrumented graph has node id="approve", label="approve?" — the board
    // posts stepName="approve?" and the handler must resolve to node id "approve".
    await sendNodeClickFromFrame(page, "approve?");

    await expect(page.getByTestId("step-card-title")).toContainText("approve", { timeout: 5_000 });
    await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  });

  test("sapiom:node-click with an unknown step name does nothing", async ({ page }) => {
    await sendNodeClickFromFrame(page, "nonexistent-step");

    await page.waitForTimeout(200);
    await expect(page.getByTestId("step-card-title")).toHaveCount(0);
    await expect(page.getByTestId("step-card")).toHaveCount(0);
  });

  test("a sapiom:node-click message from the parent window (not the iframe) is ignored", async ({
    page,
  }) => {
    // The handler checks event.source === frameRef.current?.contentWindow.
    // A message posted from the parent window itself must be ignored.
    await page.evaluate(() => {
      window.postMessage({ type: "sapiom:node-click", stepName: "intake" }, "*");
    });

    await page.waitForTimeout(200);
    await expect(page.getByTestId("step-card-title")).toHaveCount(0);
  });
});
