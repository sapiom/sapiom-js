/**
 * Rich step detail e2e coverage.
 *
 * Contract under test — three areas, all exercised in mock mode
 * (VITE_MOCK=1) with the sess-boot canvas document:
 *
 * (a) BOARD-CLICK INSPECTOR — GAP 2 completion. A board node click must now
 *     show Input, Output, and Logs in the inspector (CanvasStepInspector),
 *     mirroring the full-pane CanvasStepDetail. Each is gated: only shows
 *     when the run step carries the value; no fabrication.
 *
 * (b) CAPABILITY CALLS block. A run step whose calls carry a stubbed result
 *     shows the "Capability calls" section in both the inspector and the
 *     full-pane detail. Each call shows the dotted capability id, the
 *     "(stubbed)" chip when stubUsed, and the result behind a per-call
 *     disclosure. The block is absent for prod runs without call traces.
 *
 * (c) LINKS block. A step whose output or logs contain an image URL renders
 *     a thumbnail (<img src>); a non-image URL renders an Open link (<a>).
 *     The block appears in both surfaces.
 *
 * Pattern: announce execution.started, then navigate to the Steps tab first
 * to confirm the run chip appeared (reliable location), then switch to the
 * Canvas board and pick the target node. This is the same reliable sequence
 * the step-macros.spec.ts suite uses and avoids races with canvas.reload.
 */
import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Navigate to a clean slate with the Canvas board visible. */
const loadBoard = async (page: Page): Promise<void> => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __HARNESS_TEST__: { publish: (m: unknown) => void } }).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

/** Click a board node through the gesture layer. */
const pickNode = async (page: Page, nodeId: string): Promise<void> => {
  const node = page.frameLocator(".canvas-iframe").locator(`[data-node-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await expect(page.getByTestId("canvas-zoom-reset")).not.toHaveText("100%");
  const box = await node.boundingBox();
  if (!box) throw new Error(`${nodeId} node has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** Publish a bus event via the test hook. */
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

/**
 * Announce a run, wait for the chip on the Steps tab (most reliable location),
 * then switch back to the Canvas board. Returns the run chip locator.
 */
const announceRunAndWait = async (
  page: Page,
  executionId: string,
  target: "prod" | "local",
  expectedChipText: string,
): Promise<void> => {
  await publish(page, {
    type: "execution.started",
    harnessSessionId: "sess-boot",
    executionId,
    target,
  });

  // Navigate to the Steps tab — the run chip is always visible there.
  await page.getByTestId("right-tab-steps").click();
  const chip = page.getByTestId("canvas-run-chip");
  await expect(chip).toBeVisible({ timeout: 8000 });
  await expect(chip).toContainText(expectedChipText, { timeout: 8000 });

  // Back to the Canvas board. No second loadBoard — re-triggering canvas.reload
  // races with node picks and clears run state from the inspector.
  await page.getByTestId("right-tab-canvas").click();
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute("data-view", "board");
};

// ---------------------------------------------------------------------------
// (a) Board-click inspector — Input / Output / Logs (GAP 2 completion)
// ---------------------------------------------------------------------------

test.describe("board-click inspector shows Input, Output, and Logs", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("inspector shows Input and Output disclosures when a run step carries them", async ({
    page,
  }) => {
    await seedRunState(page, "exec-io-test", {
      executionId: "exec-io-test",
      status: "completed",
      steps: [
        {
          id: "intake",
          name: "intake",
          status: "passed" as const,
          latencyMs: 210,
          input: { applicant: "Ada" },
          output: { ok: true, score: 720 },
        },
      ],
    });

    await announceRunAndWait(page, "exec-io-test", "prod", "completed");

    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
    // Run data must land in the inspector before asserting IO.
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");

    // Input disclosure must be present.
    const inputDetail = inspector.getByTestId("canvas-inspector-run-input-intake");
    await expect(inputDetail).toBeVisible();
    await inputDetail.click();
    await expect(inputDetail).toContainText("Ada");

    // Output disclosure must be present.
    const outputDetail = inspector.getByTestId("canvas-inspector-run-output-intake");
    await expect(outputDetail).toBeVisible();
    await outputDetail.click();
    await expect(outputDetail).toContainText("720");
  });

  test("inspector shows a Logs disclosure when the run step carries logSlice", async ({
    page,
  }) => {
    await seedRunState(page, "exec-logs-test", {
      executionId: "exec-logs-test",
      status: "completed",
      steps: [
        {
          id: "screen",
          name: "screen",
          status: "passed" as const,
          latencyMs: 310,
          logSlice: "INFO: scoring complete",
        },
      ],
    });

    await announceRunAndWait(page, "exec-logs-test", "prod", "completed");

    await pickNode(page, "screen");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("screen");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    const logsDetail = inspector.getByTestId("canvas-inspector-run-logs-screen");
    await expect(logsDetail).toBeVisible();
    await logsDetail.click();
    await expect(logsDetail).toContainText("scoring complete");
  });

  test("inspector does not show Input/Output/Logs blocks when the step has none", async ({
    page,
  }) => {
    // Default mock run (exec-demo-1): no input/output/logSlice on any step.
    await announceRunAndWait(page, "exec-demo-1", "prod", "prod run completed");

    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    // No input/output/logs disclosures — honest absence, no fabrication.
    await expect(inspector.getByTestId("canvas-inspector-run-input-intake")).toHaveCount(0);
    await expect(inspector.getByTestId("canvas-inspector-run-output-intake")).toHaveCount(0);
    await expect(inspector.getByTestId("canvas-inspector-run-logs-intake")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Capability calls block — steps with calls show stubs; absent otherwise
// ---------------------------------------------------------------------------

test.describe("Capability calls block", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("step with calls shows the Capability calls block with served stub values", async ({
    page,
  }) => {
    // Seed a run view with capability calls on the 'screen' step.
    await seedRunState(page, "exec-calls-test", {
      executionId: "exec-calls-test",
      status: "completed",
      stubbed: true,
      steps: [
        {
          id: "screen",
          name: "screen",
          status: "passed" as const,
          latencyMs: 450,
          input: { ok: true },
          output: { score: 720 },
          calls: [
            {
              capability: "records.read",
              stubUsed: true,
              result: { creditScore: 720, passed: true },
            },
          ],
        },
      ],
    });

    await announceRunAndWait(page, "exec-calls-test", "local", "completed");

    await pickNode(page, "screen");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("screen");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");

    // The Capability calls section must be visible.
    const callsSection = inspector.getByTestId("canvas-detail-capability-calls");
    await expect(callsSection).toBeVisible();

    // The call must show the capability dotted id.
    await expect(callsSection).toContainText("records.read");

    // The "(stubbed)" chip must be present.
    const stubChip = callsSection.getByTestId("canvas-call-stub-chip-records.read");
    await expect(stubChip).toBeVisible();
    await expect(stubChip).toContainText("stubbed");

    // The result disclosure must be present; open it to see the served value.
    const resultDetail = callsSection.getByTestId("canvas-call-result-records.read");
    await expect(resultDetail).toBeVisible();
    await resultDetail.click();
    await expect(resultDetail).toContainText("720");
    await expect(resultDetail).toContainText("creditScore");
  });

  test("a prod run step without calls does NOT show the Capability calls block", async ({
    page,
  }) => {
    // Default mock run (exec-demo-1): no calls field on any step.
    await announceRunAndWait(page, "exec-demo-1", "prod", "prod run completed");

    await pickNode(page, "credit-check");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("credit-check");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    // No capability calls section for a prod run with no call trace.
    await expect(inspector.getByTestId("canvas-detail-capability-calls")).toHaveCount(0);
  });

  test("Capability calls block appears in the full-pane detail (Steps tab drill)", async ({
    page,
  }) => {
    await seedRunState(page, "exec-calls-fullpane", {
      executionId: "exec-calls-fullpane",
      status: "completed",
      stubbed: true,
      steps: [
        {
          id: "approve",
          name: "approve",
          status: "passed" as const,
          latencyMs: 200,
          calls: [
            {
              capability: "records.write",
              stubUsed: true,
              result: { written: true },
            },
          ],
        },
      ],
    });

    await publish(page, {
      type: "execution.started",
      harnessSessionId: "sess-boot",
      executionId: "exec-calls-fullpane",
      target: "local",
    });

    // Navigate to Steps tab and wait for the run chip.
    await page.getByTestId("right-tab-steps").click();
    const chip = page.getByTestId("canvas-run-chip");
    await expect(chip).toBeVisible({ timeout: 8000 });
    await expect(chip).toContainText("completed", { timeout: 8000 });

    // Expand the 'approve' row then open full-pane detail.
    await page.getByTestId("canvas-step-row-approve").click();
    await page.getByTestId("canvas-step-open-approve").click();

    const detail = page.getByTestId("canvas-step-detail");
    await expect(detail).toBeVisible({ timeout: 5000 });

    const callsSection = detail.getByTestId("canvas-detail-capability-calls");
    await expect(callsSection).toBeVisible();
    await expect(callsSection).toContainText("records.write");
  });
});

// ---------------------------------------------------------------------------
// (c) Links block — image thumbnails and Open links
// ---------------------------------------------------------------------------

test.describe("Links block", () => {
  test.beforeEach(async ({ page }) => {
    await loadBoard(page);
  });

  test("a step whose output has an image URL renders a thumbnail in the inspector", async ({
    page,
  }) => {
    await seedRunState(page, "exec-links-image", {
      executionId: "exec-links-image",
      status: "completed",
      steps: [
        {
          id: "intake",
          name: "intake",
          status: "passed" as const,
          latencyMs: 180,
          output: {
            previewUrl: "https://cdn.example.com/preview.png",
          },
        },
      ],
    });

    await announceRunAndWait(page, "exec-links-image", "prod", "completed");

    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    const linksSection = inspector.getByTestId("canvas-detail-links");
    await expect(linksSection).toBeVisible();

    // The image thumbnail must be rendered as an <img> inside an <a>.
    const imageLink = linksSection.getByTestId("canvas-link-image");
    await expect(imageLink).toBeVisible();
    await expect(imageLink).toHaveAttribute("href", "https://cdn.example.com/preview.png");
    await expect(imageLink.locator("img")).toHaveAttribute("src", "https://cdn.example.com/preview.png");
  });

  test("a step whose logs contain a non-image URL renders an Open link in the inspector", async ({
    page,
  }) => {
    await seedRunState(page, "exec-links-other", {
      executionId: "exec-links-other",
      status: "completed",
      steps: [
        {
          id: "screen",
          name: "screen",
          status: "passed" as const,
          latencyMs: 320,
          logSlice: "INFO: report at https://reports.example.com/run-123",
        },
      ],
    });

    await announceRunAndWait(page, "exec-links-other", "prod", "completed");

    await pickNode(page, "screen");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("screen");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    const linksSection = inspector.getByTestId("canvas-detail-links");
    await expect(linksSection).toBeVisible();

    // Non-image URLs render as text links.
    const otherLink = linksSection.getByTestId("canvas-link-other");
    await expect(otherLink).toBeVisible();
    await expect(otherLink).toHaveAttribute("href", "https://reports.example.com/run-123");
    await expect(otherLink).toHaveAttribute("target", "_blank");
    await expect(otherLink).toHaveAttribute("rel", "noreferrer");

    // No image thumbnail for a non-image URL.
    await expect(linksSection.getByTestId("canvas-link-image")).toHaveCount(0);
  });

  test("a step's call result containing a URL produces a link in the inspector", async ({
    page,
  }) => {
    await seedRunState(page, "exec-links-calls", {
      executionId: "exec-links-calls",
      status: "completed",
      stubbed: true,
      steps: [
        {
          id: "approve",
          name: "approve",
          status: "passed" as const,
          latencyMs: 200,
          calls: [
            {
              capability: "records.write",
              stubUsed: true,
              result: { downloadUrl: "https://storage.example.com/lease.pdf" },
            },
          ],
        },
      ],
    });

    await announceRunAndWait(page, "exec-links-calls", "local", "completed");

    await pickNode(page, "approve");
    // The demo canvas labels this node "approve?" — allow either form.
    await expect(page.getByTestId("canvas-inspector-title")).toContainText("approve");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    const linksSection = inspector.getByTestId("canvas-detail-links");
    await expect(linksSection).toBeVisible();

    // The URL from the call result renders as a non-image Open link.
    const otherLink = linksSection.getByTestId("canvas-link-other");
    await expect(otherLink).toBeVisible();
    await expect(otherLink).toHaveAttribute("href", "https://storage.example.com/lease.pdf");
  });

  test("a step with no URLs shows no Links block", async ({ page }) => {
    // Default run — no URLs in any step's output/logs.
    await announceRunAndWait(page, "exec-demo-1", "prod", "prod run completed");

    await pickNode(page, "intake");
    await expect(page.getByTestId("canvas-inspector-title")).toHaveText("intake");
    await expect(page.getByTestId("canvas-inspector-run")).toBeVisible({ timeout: 5000 });

    const inspector = page.getByTestId("canvas-step-inspector");
    await expect(inspector.getByTestId("canvas-detail-links")).toHaveCount(0);
  });
});
