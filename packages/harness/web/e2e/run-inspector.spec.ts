import { expect, test, type Page } from "@playwright/test";
import type { RunView } from "@shared/types";

async function loadSteps(page: Page): Promise<void> {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await page.getByTestId("right-tab-steps").click();
}

async function seedRun(page: Page, run: RunView, target: "prod" | "local" = "prod"): Promise<void> {
  await page.evaluate(([id, view]) => {
    const win = window as unknown as { __MOCK_RUN_STATE__?: Record<string, RunView> };
    win.__MOCK_RUN_STATE__ = { ...(win.__MOCK_RUN_STATE__ ?? {}), [id]: view };
  }, [run.executionId, run] as [string, RunView]);
  await page.evaluate(([executionId, nextTarget]) => {
    (window as unknown as { __HARNESS_TEST__: { publish: (message: unknown) => void } })
      .__HARNESS_TEST__.publish({
        type: "execution.started",
        harnessSessionId: "sess-boot",
        executionId,
        target: nextTarget,
      });
  }, [run.executionId, target] as const);
  await expect(page.getByTestId("run-workspace")).toBeVisible({ timeout: 8_000 });
}

test.beforeEach(async ({ page }) => {
  await loadSteps(page);
});

test("orders retries chronologically and exposes predictable, honest evidence tabs", async ({ page }) => {
  await seedRun(page, {
    executionId: "exec-retries",
    status: "completed",
    input: { topic: "leases" },
    output: { accepted: true },
    startedAt: "2026-08-13T10:00:00.000Z",
    finishedAt: "2026-08-13T10:00:03.000Z",
    steps: [
      {
        id: "screen-2",
        name: "screen",
        attempt: 2,
        status: "passed",
        startedAt: "2026-08-13T10:00:02.000Z",
        finishedAt: "2026-08-13T10:00:02.500Z",
        latencyMs: 500,
        input: { retry: true },
        output: { score: 720 },
        sharedState: { screened: true },
        directive: { kind: "continue", stepName: "approve" },
      },
      {
        id: "intake-1",
        name: "intake",
        attempt: 1,
        status: "passed",
        startedAt: "2026-08-13T10:00:00.100Z",
        finishedAt: "2026-08-13T10:00:00.300Z",
        latencyMs: 200,
        output: { parsed: true },
      },
      {
        id: "screen-1",
        name: "screen",
        attempt: 1,
        status: "failed",
        startedAt: "2026-08-13T10:00:01.000Z",
        finishedAt: "2026-08-13T10:00:01.400Z",
        latencyMs: 400,
        error: "Transient provider error",
        logSlice: "first attempt failed",
      },
    ],
  });

  const options = page.getByTestId("run-timeline").getByRole("option");
  await expect(options).toHaveCount(3);
  expect(await options.allTextContents()).toEqual([
    expect.stringMatching(/intake.*Attempt 1/),
    expect.stringMatching(/screen.*Attempt 1/),
    expect.stringMatching(/screen.*Attempt 2/),
  ]);

  await options.nth(2).click();
  const inspector = page.getByRole("region", { name: "screen attempt 2" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("tab")).toHaveText([
    "Input", "Output", "State", "Directive", "Logs", "Calls",
  ]);
  await inspector.getByRole("tab", { name: "State" }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText('"screened": true');
  await inspector.getByRole("tab", { name: "Directive" }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText('"stepName": "approve"');
  await inspector.getByRole("tab", { name: "Calls" }).click();
  await expect(inspector.getByRole("tabpanel")).toContainText("Calls not recorded");
  await inspector.getByRole("tab", { name: "Calls" }).press("ArrowLeft");
  await expect(inspector.getByRole("tab", { name: "Logs" })).toBeFocused();
  await expect(inspector.getByRole("tabpanel")).toContainText("Logs not recorded");
  await inspector.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("run-artifact")).toBeVisible();
});

test("a failed run automatically selects the failing attempt and Logs", async ({ page }) => {
  await seedRun(page, {
    executionId: "exec-failed",
    status: "failed",
    error: { message: "Execution stopped" },
    steps: [
      { id: "intake-1", name: "intake", attempt: 1, status: "passed", output: { ok: true } },
      {
        id: "screen-2",
        name: "screen",
        attempt: 2,
        status: "failed",
        error: "Validation failed",
        logSlice: "schema mismatch\nValidation failed",
      },
    ],
  });

  const inspector = page.getByRole("region", { name: "screen attempt 2" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("tabpanel")).toContainText("schema mismatch");
  await expect(inspector).toContainText("Validation failed");
});

test("manual inspection is preserved when a running execution later fails", async ({ page }) => {
  const running: RunView = {
    executionId: "exec-manual",
    status: "running",
    steps: [
      { id: "intake-1", name: "intake", attempt: 1, status: "passed", output: { ok: true } },
      { id: "screen-1", name: "screen", attempt: 1, status: "running" },
    ],
  };
  await seedRun(page, running);
  await page.getByRole("option", { name: /intake/ }).click();
  await expect(page.getByRole("region", { name: "intake attempt 1" })).toBeVisible();

  await page.evaluate(() => {
    const view: RunView = {
      executionId: "exec-manual",
      status: "failed",
      steps: [
        { id: "intake-1", name: "intake", attempt: 1, status: "passed", output: { ok: true } },
        { id: "screen-1", name: "screen", attempt: 1, status: "failed", error: "late failure", logSlice: "boom" },
      ],
    };
    (window as unknown as { __MOCK_RUN_STATE__?: Record<string, RunView> }).__MOCK_RUN_STATE__ = {
      "exec-manual": view,
    };
  });

  await expect(page.locator(".run-workspace-status")).toContainText("Failed", { timeout: 5_000 });
  await expect(page.getByRole("region", { name: "intake attempt 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Output" })).toHaveAttribute("aria-selected", "true");
});

test("uses canonical run output, then labels the successful-step fallback Latest output", async ({ page }) => {
  await seedRun(page, {
    executionId: "exec-canonical",
    status: "completed",
    output: { source: "canonical" },
    steps: [{ id: "deliver-1", name: "deliver", status: "passed", output: { source: "step" } }],
  });
  await expect(page.getByTestId("run-artifact")).toContainText("canonical");
  await expect(page.getByTestId("run-artifact")).not.toContainText("Latest output");

  await seedRun(page, {
    executionId: "exec-fallback",
    status: "completed",
    steps: [{ id: "deliver-1", name: "deliver", status: "passed", output: { source: "step" } }],
  });
  await expect(page.getByTestId("run-artifact")).toContainText("Latest output");
  await expect(page.getByTestId("run-artifact")).toContainText("step");
});

test("renders safe artifacts, collapses long collections, and falls back when media fails", async ({ page }) => {
  await seedRun(page, {
    executionId: "exec-artifact",
    status: "completed",
    output: {
      headline: "# Shipping report",
      body: "<img src=x onerror=alert(1)>\n\n[Documentation](https://example.com/docs)",
      image: "http://127.0.0.1:1/broken.png",
      items: Array.from({ length: 10 }, (_, index) => `item-${index + 1}`),
    },
    steps: [],
  });
  const artifact = page.getByTestId("run-artifact");
  await expect(artifact.getByRole("heading", { name: "Shipping report" })).toBeVisible();
  await expect(artifact.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(artifact.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "https://example.com/docs");
  await expect(artifact.getByText("Show 2 more")).toBeVisible();
  await expect(artifact.getByText(/Preview unavailable/)).toBeVisible({ timeout: 5_000 });
  await artifact.getByRole("tab", { name: "Raw" }).click();
  await expect(artifact.locator("pre")).toContainText("<img src=x onerror=alert(1)>");
});

test("Focus mode shows the timeline and shared inspector side by side", async ({ page }) => {
  await page.getByTestId("session-step-local").click();
  await page.getByTestId("run-sheet-submit").click();
  await expect(page.getByTestId("run-artifact")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Open Focus mode" }).click();
  await expect(page.getByTestId("run-workspace")).toHaveClass(/is-focus/);
  await page.getByRole("option", { name: /screen/ }).click();
  const timelineBox = await page.getByTestId("run-timeline").boundingBox();
  const inspectorBox = await page.getByRole("region", { name: "screen attempt 1" }).boundingBox();
  expect(timelineBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(timelineBox!.x).toBeLessThan(inspectorBox!.x);
  await page.getByTestId("run-workspace").getByRole("button", { name: "Exit Focus mode" }).click();
  await expect(page.getByTestId("run-workspace")).not.toHaveClass(/is-focus/);
});
