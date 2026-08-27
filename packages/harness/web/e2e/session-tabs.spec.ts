import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface SessionTestState {
  createSessionCalls?: Array<{
    req?: Record<string, unknown> & { cwd?: string; harness?: string };
  }>;
  lastCreateSession?: {
    req?: Record<string, unknown> & { cwd?: string; harness?: string };
  };
  bindWorkflowCalls?: Array<{
    req?: { sessionId?: string; workflowPath?: string | null };
  }>;
  lastBindWorkflow?: {
    req?: { sessionId?: string; workflowPath?: string | null };
  };
  publish?: (message: unknown) => void;
}

const testState = (page: Page): Promise<SessionTestState> =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __HARNESS_TEST__?: SessionTestState;
        }
      ).__HARNESS_TEST__ ?? {},
  );

test.beforeEach(async ({ page }) => {
  await page.goto("/?seed=0");
  await expect(page.locator(".rail-workflows")).toBeVisible();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
});

test("renders oldest-first accessible tabs with provider tooltips", async ({
  page,
}) => {
  const tablist = page.getByRole("tablist", { name: "Sessions" });
  const tabs = tablist.getByRole("tab");

  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).toHaveText("acme-app");
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toHaveAttribute("title", "acme-app · Claude Code");
  await expect(tabs.nth(1)).toHaveText("acme-app 2");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "false");
  await expect(tabs.nth(1)).toHaveAttribute("title", "acme-app 2 · Codex");
  await expect(page.getByTestId("session-tab-new")).toHaveAttribute(
    "aria-label",
    "New session on leasing",
  );
});

test("starts a fresh Claude sibling in the same folder and binding", async ({
  page,
}) => {
  const newSession = page.getByTestId("session-tab-new");
  await newSession.click();
  await expect(newSession).toHaveAttribute("aria-busy", "true");

  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(3);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect(page.getByTestId("session-context-title")).toHaveText(
    "acme-app 3",
  );

  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req)
    .toMatchObject({
      cwd: "/Users/demo/acme-app",
      harness: "claude-code",
    });
  const create = (await testState(page)).lastCreateSession?.req ?? {};
  expect(create).not.toHaveProperty("prompt");
  expect(create).not.toHaveProperty("rehydrateFrom");
  expect(create).not.toHaveProperty("agentSessionId");

  await expect
    .poll(async () => (await testState(page)).lastBindWorkflow?.req)
    .toMatchObject({ workflowPath: "/Users/demo/acme-app/leasing" });
  await expect(newSession).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("session-tab-sess-boot")).toBeVisible();
  await expect(page.getByTestId("session-tab-sess-leasing-2")).toBeVisible();
});

test("inherits Codex from the selected source tab", async ({ page }) => {
  await page.getByTestId("session-tab-main-sess-leasing-2").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );

  await page.getByTestId("session-tab-new").click();
  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req)
    .toMatchObject({
      cwd: "/Users/demo/acme-app",
      harness: "codex",
    });
  await expect
    .poll(
      async () => (await testState(page)).lastBindWorkflow?.req?.workflowPath,
    )
    .toBe("/Users/demo/acme-app/leasing");
});

test("guards rapid same-frame clicks with one create request", async ({
  page,
}) => {
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      "[data-testid='session-tab-new']",
    );
    button?.click();
    button?.click();
  });

  await expect
    .poll(async () => (await testState(page)).createSessionCalls?.length ?? 0)
    .toBe(1);
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(3);
});

test("creates an unbound sibling without issuing a bind request", async ({
  page,
}) => {
  await page.getByTestId("workspace-focus-scratch").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-bg",
  );

  await page.getByTestId("session-tab-new").click();
  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req)
    .toMatchObject({
      cwd: "/Users/demo/scratch",
      harness: "claude-code",
    });
  await expect
    .poll(async () => (await testState(page)).createSessionCalls?.length ?? 0)
    .toBe(1);
  expect((await testState(page)).bindWorkflowCalls ?? []).toHaveLength(0);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
});

test("creation failure restores the source tab and shows the scoped error", async ({
  page,
}) => {
  await page.evaluate(() => {
    (
      window as unknown as {
        __MOCK_CREATE_SESSION_FAIL_ONCE__?: boolean;
      }
    ).__MOCK_CREATE_SESSION_FAIL_ONCE__ = true;
  });

  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Couldn't start the session.",
  );
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-boot",
  );
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(2);
  await expect(page.getByTestId("session-tab-new")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("binding failure keeps the new session active and unbound", async ({
  page,
}) => {
  await page.evaluate(() => {
    (
      window as unknown as {
        __MOCK_BIND_WORKFLOW_FAIL_ONCE__?: boolean;
      }
    ).__MOCK_BIND_WORKFLOW_FAIL_ONCE__ = true;
  });

  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Session started, but couldn't attach it to leasing.",
  );
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /^sess-mock-/,
  );
  await expect(page.getByTestId("session-workflow-chip")).toHaveCount(0);
  await expect(page.getByTestId("new-session-composer")).toHaveCount(0);
  await expect
    .poll(async () => (await testState(page)).bindWorkflowCalls?.length ?? 0)
    .toBe(1);
});

test("an exited active session can start fresh with its provider and binding", async ({
  page,
}) => {
  await page.evaluate(() => {
    const publish = (
      window as unknown as {
        __HARNESS_TEST__?: SessionTestState;
      }
    ).__HARNESS_TEST__?.publish;
    publish?.({
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
        title: "acme-app",
        status: "exited",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        lastActiveAt: new Date().toISOString(),
        exitCode: 0,
        ready: false,
      },
    });
  });

  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await expect(page.getByTestId("session-tabs")).toHaveCount(0);
  await expect(page.getByTestId("session-tab-new")).toBeVisible();
  await page.getByTestId("session-tab-new").click();

  await expect
    .poll(async () => (await testState(page)).lastCreateSession?.req)
    .toMatchObject({
      cwd: "/Users/demo/acme-app",
      harness: "claude-code",
    });
  await expect
    .poll(
      async () => (await testState(page)).lastBindWorkflow?.req?.workflowPath,
    )
    .toBe("/Users/demo/acme-app/leasing");
  await expect(page.getByTestId("dead-session-pane")).toHaveCount(0);
});

test("switching tabs dismisses active-session menu state", async ({ page }) => {
  await page.getByTestId("session-menu").click();
  await expect(page.getByTestId("session-menu-popover")).toBeVisible();

  await page.keyboard.press("Meta+2");
  await expect(page.getByTestId("session-menu-popover")).toHaveCount(0);
  await expect(
    page.getByTestId("session-tab-main-sess-leasing-2"),
  ).toHaveAttribute("aria-selected", "true");
});

test("long tab sets scroll internally while + and actions remain reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await page.evaluate(() => {
    const publish = (
      window as unknown as {
        __HARNESS_TEST__?: SessionTestState;
      }
    ).__HARNESS_TEST__?.publish;
    for (let index = 0; index < 8; index += 1) {
      publish?.({
        type: "session.status",
        session: {
          id: `sess-overflow-${index}`,
          agentSessionId: null,
          boundWorkflowPath: "/Users/demo/acme-app/leasing",
          harness: index % 2 === 0 ? "claude-code" : "codex",
          cwd: "/Users/demo/acme-app",
          title: `Investigate overflow scenario ${index + 1}`,
          status: "running",
          createdAt: new Date(Date.now() + index * 1_000).toISOString(),
          lastActiveAt: new Date().toISOString(),
          ready: true,
        },
      });
    }
  });

  const list = page.locator(".session-tabs-list");
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(10);
  await expect(page.getByTestId("session-tab-new")).toBeVisible();
  expect(
    await list.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);

  await page.getByTestId("session-tab-new").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    /^sess-mock-/,
  );
  // Wait for the STRIP to settle, not just for the session to become active.
  // Creating a sibling lands in two commits — the session appears unbound, then
  // its binding does — and since SAP-2931 the strip is keyed to the active
  // session's own agent, so the second commit is what puts the eleventh tab
  // back and re-runs the scroll-into-view. Measuring geometry off the
  // `data-session-id` attribute alone read the strip mid-flip.
  await expect(
    page.getByRole("tablist", { name: "Sessions" }).getByRole("tab"),
  ).toHaveCount(11);
  // Polled, not sampled: the containment is produced by a scroll-into-view
  // effect, so a single read races the commit that scrolls. The claim is that
  // the tab ENDS UP reachable inside the scrolling list.
  await expect
    .poll(() =>
      page.locator(".session-tab.is-active").evaluate((tab) => {
        const tabRect = tab.getBoundingClientRect();
        const listRect = tab.parentElement!.getBoundingClientRect();
        return tabRect.left >= listRect.left && tabRect.right <= listRect.right;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId("session-tab-new")).toBeInViewport();
});
