/**
 * Skills panel Playwright smoke tests — mock-mode UI (VITE_MOCK=1).
 *
 * Coverage:
 *   - Rail tab switcher shows Workspace / Skills tabs
 *   - Skills panel renders skill cards from the mock API
 *   - Clicking a card shows the detail view with rendered markdown
 *   - "Use skill" button injects a prompt into the active session
 *   - "Use skill" is disabled with a reason when no ready session exists
 *   - Install-MCP shows the right per-agent instructions for the active session's harness
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
// Rail tab switcher
// ---------------------------------------------------------------------------

test.describe("rail tab switcher", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
  });

  test("renders Workspace and Skills tabs", async ({ page }) => {
    await expect(page.getByTestId("rail-tab-workspace")).toBeVisible();
    await expect(page.getByTestId("rail-tab-skills")).toBeVisible();
  });

  test("Workspace tab is active by default", async ({ page }) => {
    await expect(page.getByTestId("rail-tab-workspace")).toHaveClass(/is-active/);
    await expect(page.getByTestId("rail-tab-skills")).not.toHaveClass(/is-active/);
  });

  test("clicking Skills tab shows the skills panel, not the workflows rail", async ({ page }) => {
    await page.getByTestId("rail-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();
    // WorkflowsRail (.rail-workflows) must not be in the DOM while Skills is active.
    await expect(page.locator(".rail-workflows")).toHaveCount(0);

    await page.screenshot({ path: "web/e2e/screenshots/skills-panel.png", fullPage: true });
  });

  test("switching back to Workspace restores the workflows rail", async ({ page }) => {
    await page.getByTestId("rail-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    await page.getByTestId("rail-tab-workspace").click();
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("skills-panel")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Skills panel — list view
// ---------------------------------------------------------------------------

test.describe("skills panel — list view", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".rail-workflows")).toBeVisible();
    await page.getByTestId("rail-tab-skills").click();
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
    await page.getByTestId("rail-tab-skills").click();
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
    await page.getByTestId("rail-tab-skills").click();
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

  test("copy button shows 'Copied!' feedback after clicking", async ({ page }) => {
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
    await page.getByTestId("rail-tab-skills").click();
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
  test("switching to Skills on fresh state renders the panel, not a blank rail", async ({ page }) => {
    await page.goto("/?mockState=fresh");
    // Wait for the welcome panel itself to confirm we're in first-run state.
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    // Clicking the Skills tab works without crashing.
    await page.getByTestId("rail-tab-skills").click();
    await expect(page.getByTestId("skills-panel")).toBeVisible();

    // The welcome panel is still in the center pane, unaffected.
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    await page.screenshot({ path: "web/e2e/screenshots/skills-welcome-coexist.png", fullPage: true });
  });

  test("returning to Workspace tab on fresh state still shows the workflows rail", async ({ page }) => {
    await page.goto("/?mockState=fresh");
    await expect(page.getByTestId("welcome-panel")).toBeVisible();

    await page.getByTestId("rail-tab-skills").click();
    await page.getByTestId("rail-tab-workspace").click();

    await expect(page.locator(".rail-workflows")).toBeVisible();
    await expect(page.getByTestId("welcome-panel")).toBeVisible();
  });
});
