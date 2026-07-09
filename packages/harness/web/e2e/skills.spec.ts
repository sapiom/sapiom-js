/**
 * Skills panel Playwright smoke tests — mock-mode UI (VITE_MOCK=1).
 *
 * The skills panel lives in the RIGHT pane alongside the canvas, behind a
 * segmented switch: Canvas (default) | Skills. The canvas is always mounted
 * (CSS display:none when hidden) so a running Visualize enrichment is never
 * disturbed by a tab flip.
 *
 * Coverage:
 *   - Segmented switch renders Canvas / Skills tabs, Canvas is default
 *   - Flipping to Skills shows the skills panel; canvas pane is hidden via CSS
 *   - Switching back to Canvas restores the canvas visible, skills panel gone
 *   - Skills panel renders skill cards from the mock API
 *   - Clicking a card shows the detail view with rendered markdown
 *   - "Use skill" button injects a prompt into the active session
 *   - "Use skill" is disabled with a reason when no ready session exists
 *   - Install-MCP shows the right per-agent instructions for the active session's harness
 *   - Canvas keep-alive: a running Visualize survives a tab round-trip
 *   - WelcomePanel coexistence: skills tab renders on fresh state too
 */
import { expect, test } from "@playwright/test";

// The mock harness helper type — matches what MockApi exposes via window.
type TestHarness = {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    lastInjectInput?: { id: string; req: { text: string; submit?: boolean } };
  };
};

const publish = (page: import("@playwright/test").Page, message: unknown): Promise<void> =>
  page.evaluate((m) => {
    (window as unknown as TestHarness).__HARNESS_TEST__.publish(m);
  }, message);

// ---------------------------------------------------------------------------
// Right-pane segmented switch
// ---------------------------------------------------------------------------

test.describe("right-pane segmented switch", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("renders Canvas and Skills tabs in the right pane", async ({ page }) => {
    await expect(page.getByTestId("right-tab-canvas")).toBeVisible();
    await expect(page.getByTestId("right-tab-skills")).toBeVisible();
  });

  test("Canvas tab is active by default", async ({ page }) => {
    await expect(page.getByTestId("right-tab-canvas")).toHaveClass(/is-active/);
    await expect(page.getByTestId("right-tab-skills")).not.toHaveClass(/is-active/);
  });

  test("left rail (WorkflowsRail) is always visible regardless of right-pane tab", async ({ page }) => {
    // Left rail must be present on Canvas tab.
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Left rail must remain visible after switching to Skills.
    await page.getByTestId("right-tab-skills").click();
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // And after switching back.
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/right-pane-tabs.png", fullPage: true });
  });

  test("clicking Skills tab shows the skills panel inside the right pane", async ({ page }) => {
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("right-panel-skills")).toBeVisible();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/skills-panel.png", fullPage: true });
  });

  test("canvas panel is in the DOM but hidden via CSS when Skills tab is active", async ({ page }) => {
    await page.getByTestId("right-tab-skills").click();
    // The canvas panel element stays mounted (keep-alive), just not displayed.
    await expect(page.getByTestId("right-panel-canvas")).toBeAttached();
    // Must not be visually visible while Skills is active.
    await expect(page.getByTestId("right-panel-canvas")).not.toBeVisible();
  });

  test("switching back to Canvas tab restores the canvas and removes the skills panel", async ({ page }) => {
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    // Skills panel is conditionally rendered — no longer in the DOM.
    await expect(page.getByTestId("right-panel-skills")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Canvas keep-alive: running Visualize survives a tab round-trip
// ---------------------------------------------------------------------------

test.describe("canvas keep-alive across tab flips", () => {
  const baseTask = {
    id: "task-keepalive",
    macroId: "visualize",
    label: "Visualize",
    harnessSessionId: "sess-boot",
    cwd: "/Users/demo/acme-app",
    workflowPath: "/Users/demo/acme-app/leasing",
    startedAt: new Date().toISOString(),
    endedAt: null as string | null,
    exitCode: null as number | null,
    statusLines: [] as string[],
    resultText: null as string | null,
    errorTail: null as string | null,
  };

  // Publish a task.status bus message (mirrors the smoke.spec.ts helper pattern).
  const publishTask = (page: import("@playwright/test").Page, task: unknown): Promise<void> =>
    page.evaluate((t) => {
      (window as unknown as TestHarness).__HARNESS_TEST__.publish({ type: "task.status", task: t });
    }, task);

  test("a running Visualize task survives a Skills tab round-trip and completes correctly", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Start a running Visualize task — canvas shows the activity state.
    await publishTask(page, { ...baseTask, status: "running" });
    const activity = page.getByTestId("canvas-task-activity");
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Visualize is running");

    // Flip to Skills — canvas stays mounted (CSS hidden), task is still running.
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();
    // Canvas DOM is present, just hidden — the task hasn't been destroyed.
    await expect(page.getByTestId("right-panel-canvas")).toBeAttached();

    // Flip back to Canvas — activity state must still be showing.
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    await expect(page.getByTestId("canvas-task-activity")).toBeVisible();
    await expect(page.getByTestId("canvas-task-activity")).toContainText("Visualize is running");

    // Task completes — activity clears; a canvas.reload swaps in the iframe.
    await publishTask(page, { ...baseTask, status: "completed", endedAt: new Date().toISOString(), exitCode: 0 });
    await expect(page.getByTestId("canvas-task-activity")).toHaveCount(0);

    await page.evaluate(() => {
      (window as unknown as TestHarness).__HARNESS_TEST__.publish({
        type: "canvas.reload",
        harnessSessionId: "sess-boot",
      });
    });
    await expect(page.locator(".canvas-iframe")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/canvas-keepalive-tab-flip.png", fullPage: true });
  });

  test("status lines streamed while on the Skills tab are visible once you switch back", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await publishTask(page, { ...baseTask, status: "running", statusLines: ["Started"] });
    await expect(page.getByTestId("canvas-task-activity")).toBeVisible();

    // Flip to Skills while task is running.
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    // Publish more status lines while on the Skills tab (canvas is CSS-hidden).
    await publishTask(page, {
      ...baseTask,
      status: "running",
      statusLines: ["Started", "Processing intake.ts", "Writing output"],
    });

    // Flip back — latest lines must all be visible.
    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("canvas-task-lines")).toContainText("Writing output");

    await page.screenshot({ path: "web/e2e/screenshots/canvas-keepalive-statuslines.png", fullPage: true });
  });
});

// ---------------------------------------------------------------------------
// Skills panel — list view
// ---------------------------------------------------------------------------

test.describe("skills panel — list view", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();
  });

  test("renders skill cards from the mock API", async ({ page }) => {
    // The mock returns 3 skills: Agent Authoring (pkg), Frontend Design (user), Code Review (user).
    const list = page.getByTestId("skills-list");
    await expect(list).toBeVisible({ timeout: 5_000 });

    // Verify at least one known skill card is present.
    await expect(page.getByTestId("skill-card-sapiom-agent-authoring")).toBeVisible();
    await expect(page.getByTestId("skill-card-frontend-design")).toBeVisible();
    await page.screenshot({ path: "web/e2e/screenshots/skills-list.png", fullPage: true });
  });

  test("shows the Install Sapiom MCP button in the footer", async ({ page }) => {
    await expect(page.getByTestId("install-mcp-trigger")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Skills panel — detail view
// ---------------------------------------------------------------------------

test.describe("skills panel — detail view", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking a skill card shows the detail view with rendered markdown", async ({ page }) => {
    await page.getByTestId("skill-card-sapiom-agent-authoring").click();

    const detail = page.getByTestId("skill-detail");
    await expect(detail).toBeVisible({ timeout: 3_000 });

    // The rendered markdown body contains headings and content from MOCK_SKILL_BODIES.
    await expect(detail).toContainText("Agent Authoring");

    // Back button is present.
    await expect(page.getByTestId("skill-back")).toBeVisible();
    await page.screenshot({ path: "web/e2e/screenshots/skill-detail.png", fullPage: true });
  });

  test("back button returns to the skill list", async ({ page }) => {
    await page.getByTestId("skill-card-frontend-design").click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });

    await page.getByTestId("skill-back").click();
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("skill-detail")).toHaveCount(0);
  });

  test("'Use skill' button injects a prompt into the active session", async ({ page }) => {
    await page.getByTestId("skill-card-sapiom-agent-authoring").click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });

    // Boot session is running+ready — the Use button must be enabled.
    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeEnabled({ timeout: 3_000 });
    await useBtn.click();

    // MockApi records the injected input.
    await page.waitForFunction(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );
    const captured = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__.lastInjectInput,
    );
    // The prompt includes the skill name.
    expect(captured?.req.text).toContain("Agent Authoring");
    // ANALYTICS_SEAM: skill.used fires here (verify once SAP-analytics lands).

    await page.screenshot({ path: "web/e2e/screenshots/skill-used.png", fullPage: true });
  });

  test("'Use skill' is disabled when no session is ready", async ({ page }) => {
    // Flip the active session to not-ready.
    await publish(page, {
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
        title: "acme-app",
        status: "starting",
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        ready: false,
      },
    });

    await page.getByTestId("skill-card-sapiom-agent-authoring").click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });

    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeDisabled({ timeout: 3_000 });
    // A reason tooltip/text is shown.
    await expect(page.locator(".skill-use-reason")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Install-MCP modal
// ---------------------------------------------------------------------------

test.describe("Install Sapiom MCP modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("install-mcp-trigger")).toBeVisible({ timeout: 5_000 });
  });

  test("opens the modal when the install trigger is clicked", async ({ page }) => {
    await page.getByTestId("install-mcp-trigger").click();
    await expect(page.locator(".install-mcp-modal")).toBeVisible();
    await page.screenshot({ path: "web/e2e/screenshots/install-mcp-modal.png", fullPage: true });
  });

  test("shows Claude Code instructions for the active claude-code session", async ({ page }) => {
    // Boot session harness is claude-code (fixture default).
    await page.getByTestId("install-mcp-trigger").click();
    const instructions = page.getByTestId("install-mcp-instructions");
    await expect(instructions).toBeVisible();
    // Claude Code specific text.
    await expect(instructions).toContainText("sapiom-dev");
    await expect(instructions).toContainText("npx -y @sapiom/mcp");
  });

  test("copy button shows 'Copy instructions' text", async ({ page }) => {
    await page.getByTestId("install-mcp-trigger").click();
    const copyBtn = page.getByTestId("install-mcp-copy");
    await expect(copyBtn).toBeVisible();
    await expect(copyBtn).toHaveText("Copy instructions");
    // ANALYTICS_SEAM: mcp.install fires here (verify once SAP-analytics lands).
  });

  test("closes when the backdrop is clicked", async ({ page }) => {
    await page.getByTestId("install-mcp-trigger").click();
    await expect(page.locator(".install-mcp-modal")).toBeVisible();

    // Click the backdrop (outside the modal panel).
    await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".install-mcp-modal")).toHaveCount(0);
  });

  test("closes when the Close button is clicked", async ({ page }) => {
    await page.getByTestId("install-mcp-trigger").click();
    await expect(page.locator(".install-mcp-modal")).toBeVisible();

    // Use the modal's own Close button (inside the modal-actions div).
    await page.locator(".install-mcp-modal .modal-actions button:last-child").click();
    await expect(page.locator(".install-mcp-modal")).toHaveCount(0);
  });

  test("shows a harness picker when no session is active (fresh state)", async ({ page }) => {
    // Navigate to fresh state — no sessions, so session is null and picker shows.
    await page.goto("/?mockState=fresh");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await page.getByTestId("install-mcp-trigger").click();

    // Picker renders two tabs: Claude Code, Codex.
    await expect(page.locator(".install-mcp-tab")).toHaveCount(2);
    await expect(page.locator(".install-mcp-tab").first()).toContainText("Claude Code");
  });
});

// ---------------------------------------------------------------------------
// WelcomePanel coexistence
// ---------------------------------------------------------------------------

test.describe("skills panel + WelcomePanel coexistence", () => {
  test("switching to Skills on fresh state renders the panel, not a blank right pane", async ({ page }) => {
    await page.goto("/?mockState=fresh");
    // Wait for the welcome panel itself to confirm we're in first-run state.
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    // The WorkflowsRail remains visible (left rail is untouched).
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Clicking the Skills tab works without crashing.
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    // The welcome panel is still in the center pane, unaffected.
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    // The left rail is still visible.
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/skills-welcome-coexist.png", fullPage: true });
  });

  test("returning to Canvas tab on fresh state shows the canvas empty state", async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    await page.getByTestId("right-tab-skills").click();
    await page.getByTestId("right-tab-canvas").click();

    // Canvas panel is visible again.
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    // Welcome panel in center pane — untouched.
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
    // Left rail — untouched.
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });
});
