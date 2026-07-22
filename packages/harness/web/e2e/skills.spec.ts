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
 *   - Skills list is re-fetched each time the Skills tab becomes active
 *   - Dead session with no agentSessionId: Resume disabled, Close works
 *   - Dead session with agentSessionId: Resume enabled and works
 *   - Canvas keep-alive: a running Visualize survives a tab round-trip
 *   - WelcomePanel coexistence: skills tab renders on fresh state too
 */
import { expect, test } from "@playwright/test";

// The mock harness helper type — matches what MockApi exposes via window.
type TestHarness = {
  __HARNESS_TEST__: {
    publish: (message: unknown) => void;
    lastInjectInput?: { id: string; req: { text: string; submit?: boolean } };
    trackEvents?: Array<{ event: string; data?: Record<string, unknown> }>;
    listSkillsCallCount?: number;
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

  test("switching back to Canvas tab restores canvas visibility; skills panel stays in DOM but hidden", async ({ page }) => {
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    await page.getByTestId("right-tab-canvas").click();
    await expect(page.getByTestId("right-panel-canvas")).toBeVisible();
    // Skills panel is lazy-mounted and kept alive via CSS display:none — it
    // stays attached to the DOM once opened, just not visible.
    await expect(page.getByTestId("right-panel-skills")).toBeAttached();
    await expect(page.getByTestId("right-panel-skills")).not.toBeVisible();
  });

  test("skills list is re-fetched when switching to the Skills tab (tab-activate refetch)", async ({ page }) => {
    // The Skills panel re-fetches when its isActive prop flips to true on each
    // tab switch. MockApi.listSkills() records each call via listSkillsCallCount
    // on window.__HARNESS_TEST__.

    // First open — triggers initial fetch.
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 5_000 });

    const countAfterFirst = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.listSkillsCallCount ?? 0,
    );
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    // Flip away and back — should trigger a second fetch.
    await page.getByTestId("right-tab-canvas").click();
    await page.getByTestId("right-tab-skills").click();

    // Wait for the list to be visible again (post-refetch).
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 3_000 });

    const countAfterSecond = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.listSkillsCallCount ?? 0,
    );
    // Each tab activation must trigger a new fetch — count strictly increases.
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst);
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

  test("detail view shows the 'Use skill' button", async ({ page }) => {
    await page.getByTestId("skill-card-sapiom-agent-authoring").click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });

    // The Use skill button is present in the detail view.
    await expect(page.getByTestId("skill-use-btn")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Dead session pane — Resume/Close hardening
// ---------------------------------------------------------------------------

test.describe("dead session pane — resume and close", () => {
  // Publish a session.status to make the active session look exited.
  const makeSessionExited = (
    page: import("@playwright/test").Page,
    agentSessionId: string | null,
  ): Promise<void> =>
    page.evaluate((sid) => {
      (window as unknown as TestHarness).__HARNESS_TEST__.publish({
        type: "session.status",
        session: {
          id: "sess-boot",
          agentSessionId: sid,
          boundWorkflowPath: "/Users/demo/acme-app/leasing",
          harness: "claude-code",
          cwd: "/Users/demo/acme-app",
          title: "acme-app",
          status: "exited",
          exitCode: 1,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          ready: false,
        },
      });
    }, agentSessionId);

  test("dead session with agentSessionId=null: Resume is disabled with a reason", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Make the active session exit without an agentSessionId (exited before
    // the agent established its session).
    await makeSessionExited(page, null);

    // The dead-session overlay must appear.
    await expect(page.getByTestId("dead-session-pane")).toBeVisible({ timeout: 3_000 });

    // Resume button must be disabled.
    const resumeBtn = page.getByTestId("dead-session-resume");
    await expect(resumeBtn).toBeDisabled();

    // A human-readable reason must be visible to explain why.
    await expect(page.getByTestId("dead-session-resume-reason")).toBeVisible();
    await expect(page.getByTestId("dead-session-resume-reason")).toContainText("can't be resumed");

    await page.screenshot({ path: "web/e2e/screenshots/dead-session-null-agent.png", fullPage: true });
  });

  test("dead session with agentSessionId=null: Close removes the session overlay", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    await makeSessionExited(page, null);
    await expect(page.getByTestId("dead-session-pane")).toBeVisible({ timeout: 3_000 });

    // Close must work even when Resume is disabled.
    await page.getByTestId("dead-session-close").click();
    await expect(page.getByTestId("dead-session-pane")).toHaveCount(0, { timeout: 3_000 });
  });

  test("dead session with a valid agentSessionId: Resume button is enabled", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Exit with a real agentSessionId — Resume should be available.
    await makeSessionExited(page, "8f2b1c6a-4d3e-4a11-9c2f-1a2b3c4d5e6f");
    await expect(page.getByTestId("dead-session-pane")).toBeVisible({ timeout: 3_000 });

    const resumeBtn = page.getByTestId("dead-session-resume");
    await expect(resumeBtn).toBeEnabled();

    // No disabled reason text should be shown.
    await expect(page.getByTestId("dead-session-resume-reason")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Use skill button
// ---------------------------------------------------------------------------

test.describe("Use skill button", () => {
  // Navigate to a skill detail view.
  const openSkillDetail = async (page: import("@playwright/test").Page, skillId: string): Promise<void> => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId(`skill-card-${skillId}`).click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });
  };

  test("clicking Use on a package skill calls injectInput with submit:false and /<id> text", async ({ page }) => {
    await openSkillDetail(page, "sapiom-agent-authoring");

    // The mock default has a ready running session (sess-boot, ready:true).
    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeEnabled();

    await useBtn.click();

    // Wait for the mock async delay to complete and the record to be set.
    await page.waitForFunction(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );

    // Assert that MockApi.injectInput was called with submit:false and the slash-command text.
    const record = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );
    expect(record).toBeDefined();
    expect(record!.req.submit).toBe(false);
    expect(record!.req.text).toBe("/sapiom-agent-authoring ");

    await page.screenshot({ path: "web/e2e/screenshots/skill-use-package.png", fullPage: true });
  });

  test("clicking Use on a user skill calls injectInput with submit:false and NL text", async ({ page }) => {
    await openSkillDetail(page, "frontend-design");

    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeEnabled();

    await useBtn.click();

    // Wait for the mock async delay to complete and the record to be set.
    await page.waitForFunction(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );

    const record = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );
    expect(record).toBeDefined();
    expect(record!.req.submit).toBe(false);
    // User skill → natural-language invocation with name and description.
    expect(record!.req.text).toContain("Frontend Design");
    expect(record!.req.text).toMatch(/^Use the "/);

    await page.screenshot({ path: "web/e2e/screenshots/skill-use-user.png", fullPage: true });
  });

  test("Use skill button is disabled when the active session is not ready", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();

    // Make the active session (sess-boot) exit — the active tab stays on it,
    // so activeSession in SkillsPanel reflects an exited (not ready) session.
    await page.evaluate(() => {
      (window as unknown as TestHarness).__HARNESS_TEST__.publish({
        type: "session.status",
        session: {
          id: "sess-boot",
          agentSessionId: null,
          boundWorkflowPath: "/Users/demo/acme-app/leasing",
          harness: "claude-code",
          cwd: "/Users/demo/acme-app",
          title: "acme-app",
          status: "exited",
          exitCode: 0,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          ready: false,
        },
      });
    });

    await page.getByTestId("right-tab-skills").click();
    await expect(page.getByTestId("skills-list")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("skill-card-sapiom-agent-authoring").click();
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 3_000 });

    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeDisabled();

    // A visible reason for the disabled state must be present.
    await expect(page.getByTestId("skill-use-disabled-reason")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/skill-use-disabled.png", fullPage: true });
  });

  test("Use skill does NOT auto-submit (no Enter / CR sent)", async ({ page }) => {
    await openSkillDetail(page, "sapiom-agent-authoring");

    const useBtn = page.getByTestId("skill-use-btn");
    await expect(useBtn).toBeEnabled();
    await useBtn.click();

    // Wait for the async mock delay to complete.
    await page.waitForFunction(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );

    const record = await page.evaluate(
      () => (window as unknown as TestHarness).__HARNESS_TEST__?.lastInjectInput,
    );
    // submit must be false — the API must not send a carriage return.
    expect(record?.req.submit).toBe(false);

    await page.screenshot({ path: "web/e2e/screenshots/skill-use-no-submit.png", fullPage: true });
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
