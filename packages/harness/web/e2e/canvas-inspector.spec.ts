/**
 * The board in the agent modal: the bottom overview panel, and the small step
 * card a board pick shows (flow-map-chat-overlay.md 4.2b.4).
 *
 * Contract under test:
 * - A board node pick (the document's {type:"sapiom-canvas:node"} answer)
 *   shows that step's small card IN PLACE, over the board; nothing navigates.
 * - Deselect (the card's close, or empty board space) restores the general
 *   workflow overview unchanged.
 * - A tall step card scrolls inside itself.
 * - Dragging the overview panel's top edge sets a manual height (persisted
 *   in ui-prefs); double-clicking the handle resets to auto-hug.
 */
import { expect, test, type Page } from "@playwright/test";
import { openAgentModal } from "./mock-navigation";

/**
 * leasing's board in its agent modal. The pane serves the agent's document
 * through `srcdoc`; the bundled interactive fixture board (the one that
 * answers hit / pick / node) is swapped into that same frame, so the pane's
 * source-window guard sees exactly what a generated board would send.
 */
const loadBoard = async (page: Page): Promise<void> => {
  if ((await page.getByTestId("agent-modal").count()) === 0)
    await openAgentModal(page, "acme-app", "leasing");
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await page.evaluate(async () => {
    const html = await (await fetch("/canvas/sess-boot/index.html")).text();
    (document.querySelector(".canvas-iframe") as HTMLIFrameElement).srcdoc = html;
  });
};

/** Waits out the auto-fit (the document posts its size async), then clicks
 *  the node's center through the gesture layer. */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const node = page.frameLocator(".canvas-iframe").locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const box = await node.boundingBox();
  if (!box) throw new Error(`${nodeId} node has no box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** Post a Canvas document message from the iframe so the source-window guard
 *  exercises the same path as a generated board. */
const postFromCanvas = (page: Page, message: unknown): Promise<void> =>
  page.frameLocator(".canvas-iframe").locator("body").evaluate((_, payload) => {
    window.parent.postMessage(payload, "*");
  }, message);

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await loadBoard(page);
});

test("a board pick shows the step's small card in place, over the board", async ({ page }) => {
  // The overview panel shows the workflow-level copy before any pick.
  const panel = page.getByTestId("canvas-overview");
  await expect(panel).toContainText("Overview");
  await expect(panel).toContainText("Handles lease applications end to end");
  await expect(page.getByTestId("canvas-overview-toggle")).toHaveAttribute(
    "aria-label",
    "Collapse agent overview",
  );
  await expect(page.getByTestId("canvas-chat-toggle")).toHaveAttribute(
    "data-tooltip",
    "Chat — ask about this agent or the selected step",
  );

  await pickNode(page, "intake");

  // The picked step's small card, and the board stays on screen: no step
  // page, no inspector, no Steps surface (4.2b.4).
  const card = page.getByTestId("step-card");
  await expect(card.getByTestId("step-card-title")).toHaveText("intake");
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
  await expect(card.getByTestId("step-card-desc")).toContainText("Logs the incoming order");
  await expect(page.getByTestId("step-card-close")).toHaveAttribute("aria-label", "Close step");
  await expect(page.getByTestId("canvas-step-inspector")).toHaveCount(0);
  // The capability it calls comes from the posted graph.
  await expect(card.getByTestId("step-card-calls")).toContainText("records.read");
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", "leasing");
});

test("a generic render failure names the agent graph", async ({ page }) => {
  await postFromCanvas(page, {
    type: "sapiom-canvas:error",
    title: "Could not extract graph",
    reason: "x",
  });

  const error = page.getByTestId("canvas-render-error");
  await expect(error).toContainText("The agent graph could not be extracted. Open the terminal for details.");
  await expect(error).not.toContainText("workflow graph");
  await expect(page.getByRole("button", { name: "Ask coding agent to fix" })).toBeVisible();
});

test("Retry re-reads the agent's graph route: no macro, no session (flow 4.4b)", async ({
  page,
}) => {
  await postFromCanvas(page, {
    type: "sapiom-canvas:error",
    title: "leasing",
    reason: "TypeScript extraction failed",
  });
  await expect(page.getByTestId("canvas-render-error")).toBeVisible();

  // What the route answers NOW. Only a refetch can put it in the frame: the
  // frame holds the swapped-in fixture board until the pane reads the route
  // again. `preparing` because it is a status the pane keeps framed.
  await page.evaluate(() => {
    (
      window as unknown as {
        __MOCK_WORKFLOW_GRAPH__?: Record<string, { status: string; reason: string | null }>;
      }
    ).__MOCK_WORKFLOW_GRAPH__ = {
      "/Users/demo/acme-app/leasing": { status: "preparing", reason: "re-read from the graph route" },
    };
  });
  const before = await page.evaluate(() => {
    const t = (window as unknown as { __HARNESS_TEST__?: Record<string, unknown[] | undefined> })
      .__HARNESS_TEST__;
    return { created: t?.createSessionCalls?.length ?? 0, bound: t?.bindWorkflowCalls?.length ?? 0 };
  });

  // Retry is Visualize by path (4.4b): the modal re-reads the board, so the
  // failed document is replaced, and no session macro runs.
  await page.getByTestId("canvas-error-retry").click();
  await expect(page.getByTestId("agent-modal-progress")).toContainText("Render");
  await expect
    .poll(() =>
      page.locator(".canvas-iframe").evaluate((frame) => (frame as HTMLIFrameElement).srcdoc),
    )
    .toContain("re-read from the graph route");

  const after = await page.evaluate(() => {
    const t = (
      window as unknown as {
        __HARNESS_TEST__?: Record<string, unknown> & {
          createSessionCalls?: unknown[];
          bindWorkflowCalls?: unknown[];
        };
      }
    ).__HARNESS_TEST__;
    return {
      created: t?.createSessionCalls?.length ?? 0,
      bound: t?.bindWorkflowCalls?.length ?? 0,
      macro: t?.lastMacroRun ?? null,
    };
  });
  expect(after).toEqual({ created: before.created, bound: before.bound, macro: null });
});

test("a launched-agent node keeps its private identifiers and names the agent it launches", async ({ page }) => {
  await postFromCanvas(page, {
    type: "sapiom-canvas:graph",
    graph: {
      name: "leasing",
      entry: "intake",
      nodes: [
        {
          id: "intake",
          kind: "entry",
          label: "intake",
          role: "entry",
          description: "Logs the incoming order.",
          timeoutMs: null,
          inputSchema: null,
          capabilities: [],
        },
        {
          id: "launch:rfq",
          kind: "launched-workflow",
          label: "rfq",
          role: "launches another agent",
          description: "Hands off quote generation.",
          timeoutMs: null,
          inputSchema: null,
          capabilities: [],
        },
      ],
      edges: [{ from: "intake", to: "launch:rfq", kind: "launch", label: "launch()" }],
      groups: [],
      warnings: [],
    },
  });

  await postFromCanvas(page, { type: "sapiom:node-click", stepName: "rfq" });

  const card = page.getByTestId("step-card");
  await expect(card.getByTestId("step-card-title")).toHaveText("rfq");
  await expect(card).toHaveAttribute("data-step", "launch:rfq");
  // The node's private id stays out of what the card shows.
  await expect(card).not.toContainText("launch:rfq");
  await expect(card.getByTestId("step-card-calls")).toContainText("Launches rfq");

  // MAP-CHAT.md: "A launched child agent opens in the same modal in its
  // place". The Calls row carries the one door.
  const open = card.getByTestId("step-card-open-agent");
  await expect(open).toHaveAttribute("data-tooltip", "Open agent");
  await expect(open.locator("svg.lucide-arrow-up-right")).toHaveCount(1);
  await open.click();
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-agent", "rfq");
  await expect(page.getByTestId("agent-modal")).toHaveAttribute("data-tab", "canvas");
  await expect(page.getByTestId("step-card")).toHaveCount(0);
});

test("deselect restores the overview: the card's close, and empty board space", async ({ page }) => {
  const panel = page.getByTestId("canvas-overview");

  // The card's own close clears the pick back to the overview. The step
  // card stands in for the whole bottom panel while it shows.
  await pickNode(page, "intake");
  await expect(page.getByTestId("step-card-title")).toHaveText("intake");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("step-card-close").click();
  await expect(page.getByTestId("step-card")).toHaveCount(0);
  await expect(panel).toContainText("Handles lease applications end to end");

  // Clicking empty board space deselects too. Hover the empty point first
  // so the document's hit answer (no node) lands before the click.
  await pickNode(page, "intake");
  await expect(page.getByTestId("step-card-title")).toHaveText("intake");
  const board = await page.getByTestId("canvas-pan-layer").boundingBox();
  if (!board) throw new Error("board has no box");
  const emptyX = board.x + board.width - 12;
  const emptyY = board.y + 12;
  await page.mouse.move(emptyX, emptyY, { steps: 2 });
  await expect(page.getByTestId("canvas-pan-layer")).not.toHaveAttribute("data-over-node", "true");
  await page.mouse.click(emptyX, emptyY);
  await expect(page.getByTestId("step-card")).toHaveCount(0);
  await expect(panel).toContainText("Handles lease applications end to end");
});

test("the step card stays small over a short board; taller content scrolls inside it", async ({ page }) => {
  // A short window makes the card's cap bite for a contract-heavy step.
  // Collapse the overview first so the whole cascade stays clickable.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.getByTestId("canvas-overview-toggle").click();
  await pickNode(page, "credit-check");
  await expect(page.getByTestId("step-card-title")).toHaveText("credit-check");

  const metrics = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="step-card"]') as HTMLElement;
    const panel = document.querySelector('[data-testid="agent-modal-panel-canvas"]') as HTMLElement;
    const body = card.querySelector(".step-card-body") as HTMLElement;
    const c = card.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      inside: c.top >= p.top && c.bottom <= p.bottom,
      scrollable: body.scrollHeight > body.clientHeight,
    };
  });
  expect(metrics.inside).toBe(true);
  expect(metrics.scrollable).toBe(true);

  // Deselecting leaves the collapsed overview collapsed: the panel yields
  // to its ⓘ reopen affordance, exactly the pre-pick arrangement.
  await page.getByTestId("step-card-close").click();
  await expect(page.getByTestId("step-card")).toHaveCount(0);
  await expect(page.getByTestId("canvas-overview")).toHaveCount(0);
  await expect(page.getByTestId("canvas-overview-toggle")).toHaveAttribute(
    "aria-label",
    "Show agent overview",
  );
});

// The panel is capped at half the canvas pane, so the drag-grow assertion
// needs vertical headroom the default CI viewport (720px) doesn't give — the
// natural height sits within ~20px of the cap there. Pin a tall viewport via
// the page fixture so the page is BORN at this size; resizing mid-test would
// race the layout the drag's handle position depends on.
test.describe("canvas overview drag-resize", () => {
  test.use({ viewport: { width: 1280, height: 1024 } });

  test("dragging the top edge resizes the panel and persists; double-click resets to auto", async ({
    page,
  }) => {
    const panel = page.getByTestId("canvas-overview");
    const handle = page.getByTestId("canvas-overview-resize");
    await expect(handle).toHaveAttribute("role", "separator");
    await expect(handle).toHaveCSS("cursor", "row-resize");

    const before = (await panel.boundingBox())?.height ?? 0;
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("resize handle has no box");
    const x = handleBox.x + handleBox.width / 2;
    const y = handleBox.y + handleBox.height / 2;

    // Drag up 80px: the panel grows (clamped to half the pane). Move in two
    // segments with several steps so every pointermove reaches the resize
    // handler even under CI load.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 8 });
    await page.mouse.move(x, y - 80, { steps: 8 });
    await page.mouse.up();
    // Poll for the grown height rather than reading it once — defensive against a
    // frame of settle after mouse-up.
    await expect
      .poll(async () => (await panel.boundingBox())?.height ?? 0)
      .toBeGreaterThan(before + 40);
    const grown = (await panel.boundingBox())?.height ?? 0;

    // The manual height persists in ui-prefs alongside the rest of the
    // arrangement.
    const stored = await page.evaluate(
      () =>
        (JSON.parse(window.localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
          canvasInspectorHeight?: number | null;
        }).canvasInspectorHeight,
    );
    expect(typeof stored).toBe("number");
    expect(Math.abs((stored as number) - grown)).toBeLessThanOrEqual(2);

    // Double-click the handle: back to auto-hug (the pre-drag height).
    await handle.dblclick();
    await expect
      .poll(async () => (await panel.boundingBox())?.height ?? 0)
      .toBeLessThanOrEqual(before + 2);
    const cleared = await page.evaluate(
      () =>
        (JSON.parse(window.localStorage.getItem("sapiom-harness-ui-prefs") ?? "{}") as {
          canvasInspectorHeight?: number | null;
        }).canvasInspectorHeight,
    );
    expect(cleared).toBeNull();
  });
});
