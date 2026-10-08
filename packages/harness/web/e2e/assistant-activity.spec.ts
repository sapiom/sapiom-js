import { expect, test, type Page } from "@playwright/test";
import type {
  AssistantSessionSummary,
  AssistantStateSnapshot,
} from "../../src/shared/assistant-state";

const row = (
  harnessSessionId: string,
  changes: Partial<AssistantSessionSummary> = {},
): AssistantSessionSummary => ({
  harnessSessionId,
  conversationId: `ses_${harnessSessionId.replaceAll("-", "_")}`,
  activity: "busy",
  pendingPermissions: 0,
  pendingQuestions: 0,
  freshness: "current",
  ...changes,
});
const publish = (
  page: Page,
  revision: number,
  sessions: AssistantSessionSummary[],
  changes: Partial<AssistantStateSnapshot> = {},
) =>
  page.evaluate(
    (snapshot) => {
      (
        window as unknown as {
          __HARNESS_TEST__: { publish: (message: unknown) => void };
        }
      ).__HARNESS_TEST__.publish({ type: "assistant.state", snapshot });
    },
    {
      hostInstanceId: "host-a",
      authorityRevision: "authority-a",
      revision,
      enabled: true,
      sessions,
      ...changes,
    },
  );
const indicator = (page: Page, id = "sess-boot") =>
  page.getByTestId(`assistant-activity-${id}`);

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
});

test("keeps independent Assistant and Terminal activity per session as the rail switches between them", async ({
  page,
}) => {
  const rows = page.locator(".rail-session-row");
  const count = await rows.count();
  await publish(page, 1, [
    row("sess-boot"),
    row("sess-leasing-2", { pendingQuestions: 1 }),
    row("unknown-session"),
  ]);
  // The header carries the selected session's Assistant state.
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Working",
  );
  // An Assistant snapshot never adds or removes rail rows.
  await expect(rows).toHaveCount(count);
  await expect(indicator(page, "unknown-session")).toHaveCount(0);
  // Terminal activity is the session's own: the header's busy pulse.
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "session.activity",
      harnessSessionId: "sess-boot",
      at: new Date().toISOString(),
    }),
  );
  await expect(page.getByTestId("session-busy")).toBeVisible();
  // One click to the other session: its own Assistant state, not the first's.
  await page.getByTestId("rail-session-select-sess-leasing-2").click();
  await expect(indicator(page, "sess-leasing-2")).toHaveAttribute(
    "aria-label",
    "Assistant: Waiting for input",
  );
  await publish(page, 2, [
    row("sess-boot", { activity: "idle" }),
    row("sess-leasing-2", { activity: "retry" }),
  ]);
  await expect(indicator(page, "sess-leasing-2")).toHaveAttribute(
    "aria-label",
    "Assistant: Working",
  );
  await page.getByTestId("rail-session-select-sess-boot").click();
  await expect(indicator(page)).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: /Assistant: (Finished|Success)/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("independent-assistant-sessions.png"),
  });
});

test("prioritizes uncertainty, validates payloads, and replaces the complete authority-scoped set", async ({
  page,
}) => {
  await publish(page, 1, [
    row("sess-boot", { pendingPermissions: 1, freshness: "reconnecting" }),
  ]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Checking status",
  );
  await publish(page, 2, [row("sess-boot", { pendingPermissions: 1 })]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Waiting for input",
  );
  await publish(page, 3, [row("sess-boot", { pendingQuestions: null })]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Checking status",
  );
  await publish(page, 4, [row("sess-boot", { freshness: "unavailable" })]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Unavailable",
  );
  await publish(page, 3, [row("sess-boot")]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Unavailable",
  );
  await publish(page, 5, [row("sess-boot", { pendingQuestions: -1 })]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Checking status",
  );
  await publish(page, 5, [], { authorityRevision: "authority-b" });
  await expect(indicator(page)).toHaveCount(0);
  await publish(page, 6, [row("sess-boot")], {
    authorityRevision: "authority-b",
  });
  await expect(indicator(page)).toBeVisible();
  await publish(page, 7, [], {
    enabled: false,
    authorityRevision: "authority-c",
  });
  await expect(indicator(page)).toHaveCount(0);
});

test("clears on auth change and accepts the host's unchanged authorized confirmation", async ({
  page,
}) => {
  await publish(page, 1, [row("sess-boot")]);
  await expect(indicator(page)).toBeVisible();
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "auth.changed",
      authenticated: false,
      organizationName: null,
    }),
  );
  await expect(indicator(page)).toHaveCount(0);
  await publish(page, 1, [row("sess-boot")]);
  await expect(indicator(page)).toHaveAttribute(
    "aria-label",
    "Assistant: Working",
  );
});

test("retains Assistant activity in the exited-session header and history row", async ({
  page,
}) => {
  await publish(page, 1, [row("sess-boot", { pendingPermissions: 1 })]);
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
        agentMapIdentity: {
          projectId: "project_00000000-0000-4000-8000-000000000001",
          userId: "user_mock",
          sessionId: "sess-boot",
        },
        title: "acme-app",
        status: "exited",
        ready: false,
        exitCode: 0,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    }),
  );
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
  await expect(
    page
      .locator(".session-current")
      .getByRole("img", { name: "Assistant: Waiting for input" }),
  ).toBeVisible();
  await page.getByTestId("rail-history").click();
  await expect(
    page
      .getByTestId("exited-session-sess-boot")
      .getByRole("img", { name: "Assistant: Waiting for input" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("retained-assistant-session.png"),
  });
});

test("refreshes hovered Assistant text and removes it at the auth barrier", async ({
  page,
}) => {
  await publish(page, 1, [row("sess-boot")]);
  await indicator(page).hover();
  const tooltip = page.locator('.app-tooltip[data-show="true"]');
  await expect(tooltip).toHaveText("Assistant: Working");
  await publish(page, 2, [row("sess-boot", { pendingQuestions: 1 })]);
  await expect(tooltip).toHaveText("Assistant: Waiting for input");
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "auth.changed",
      authenticated: false,
      organizationName: null,
    }),
  );
  await expect(indicator(page)).toHaveCount(0);
  // Removing the child can transfer hover to the titled session button.
  await expect(page.locator(".app-tooltip")).not.toContainText("Assistant:");
});
