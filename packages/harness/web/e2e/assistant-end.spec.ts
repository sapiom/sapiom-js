import { expect, test, type Page, type Route } from "@playwright/test";
import type { AssistantLifecycle } from "../../src/shared/assistant-session";
import type { HarnessSession } from "../../src/shared/types";
import { selectMockSessionFromPalette } from "./mock-navigation";

const lifecycle = (
  id: string,
  state: AssistantLifecycle["lifecycle"] = "open",
  revision = 1,
): AssistantLifecycle => ({
  version: 1,
  harnessSessionId: id,
  revision,
  lifecycle: state,
  execution: "paused",
  updatedAt: Date.now(),
});
const session = (
  id: string,
  changes: Partial<HarnessSession> = {},
): HarnessSession => ({
  id,
  agentSessionId: null,
  boundWorkflowPath: "/Users/demo/acme-app/leasing",
  harness: "claude-code",
  cwd: "/Users/demo/acme-app",
  title: id,
  status: "running",
  ready: true,
  exitCode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:01.000Z",
  ...changes,
});
const publish = (page: Page, message: unknown) =>
  page.evaluate((message) => {
    (window as any).__HARNESS_TEST__.publish(message);
  }, message);
const project = (
  page: Page,
  revision: number,
  lifecycles: AssistantLifecycle[],
) =>
  publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "host-end",
      authorityRevision: "authority-end",
      revision,
      enabled: true,
      sessions: [],
      lifecycles,
    },
  });
const selected = (page: Page) => page.getByTestId("session-context");
const openEnd = async (page: Page) => {
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-end-btn").click();
};

/** Keep the real hook/dialog while controlling the DELETE boundary. */
async function openStudio(page: Page) {
  const requests: Route[] = [];
  const unexpected: string[] = [];
  page.on("pageerror", (error) => unexpected.push(error.message));
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    requests.push(route);
  });
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
      )!.name;
    const { MockApi, ApiError } = await import(url);
    const kill = MockApi.prototype.killSession;
    MockApi.prototype.killSession = async function (id: string) {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok)
        throw new ApiError(response.status, "controlled cleanup response");
      return kill.call(this, id);
    };
  });
  return {
    requests,
    unexpected,
    settle: async (status: number) => {
      await expect.poll(() => requests.length).toBe(1);
      await requests[0]!.fulfill({
        status,
        json:
          status === 200
            ? { ok: true }
            : { failure: { code: "cleanup_unconfirmed" } },
      });
    },
  };
}

test("End stays available after Terminal exit and incomplete cleanup retains A and B", async ({
  page,
}, testInfo) => {
  const fixture = await openStudio(page);
  await project(page, 1, [lifecycle("sess-boot"), lifecycle("sess-leasing-2")]);
  await publish(page, {
    type: "session.status",
    session: session("sess-leasing-2", {
      title: "Unaffected B",
      harness: "codex",
    }),
  });
  await publish(page, {
    type: "session.status",
    session: session("sess-boot", { status: "exited", ready: false }),
  });
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  await openEnd(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Terminal and Assistant work");
  await expect(dialog).toContainText("saved history remains available");
  await page.screenshot({
    path: testInfo.outputPath("managed-end-confirmation.png"),
  });
  await expect(
    page.getByRole("button", { name: "Keep session", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(fixture.requests).toHaveLength(0);
  await openEnd(page);
  await page.getByTestId("end-session-confirm-btn").click();
  await project(page, 2, [
    lifecycle("sess-boot", "ending", 2),
    lifecycle("sess-leasing-2"),
  ]);
  await page.getByTestId("session-menu").click();
  await expect(page.getByTestId("session-end-btn")).toBeDisabled();
  await expect(page.getByTestId("session-end-btn")).toHaveText(
    "Ending session…",
  );
  await fixture.settle(409);
  await expect(page.getByText(/Session cleanup is incomplete/)).toBeVisible();
  await expect(selected(page)).toHaveAttribute("data-session-id", "sess-boot");
  await expect(page.getByTestId("session-end-btn")).toBeEnabled();
  await project(page, 1, [lifecycle("sess-boot", "ended", 3)]);
  await expect(page.getByTestId("session-end-btn")).toHaveText(
    "Retry End session…",
  );
  expect(new URL(fixture.requests[0]!.request().url()).pathname).toBe(
    "/api/sessions/sess-boot",
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: testInfo.outputPath("cleanup-incomplete.png"),
  });
  await selectMockSessionFromPalette(page, "Unaffected B");
  await expect(selected(page)).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );
  await expect(page.locator(".harness-terminal")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("confirmed End retains Assistant history and preserves newer rows and navigation", async ({
  page,
}, testInfo) => {
  const fixture = await openStudio(page);
  await project(page, 1, [lifecycle("sess-boot")]);
  await openEnd(page);
  await page.getByTestId("end-session-confirm-btn").click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await publish(page, {
    type: "session.status",
    session: session("sess-leasing-2", { title: "B changed during End" }),
  });
  await publish(page, {
    type: "session.status",
    session: session("sess-new", { title: "New session during End" }),
  });
  await page.getByTestId("session-tab-sess-new").click();
  await project(page, 2, [lifecycle("sess-boot", "ended", 2)]);
  await fixture.settle(200);
  await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
  await expect(selected(page)).toHaveAttribute("data-session-id", "sess-new");
  await expect(page.getByTestId("session-tab-sess-leasing-2")).toContainText(
    "B changed during End",
  );
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("past-sessions-trigger").hover();
  await expect(page.getByTestId("exited-session-sess-boot")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("ended-history-retained.png"),
  });
  expect(fixture.unexpected).toEqual([]);
});

test("an older successful End response cannot dismiss a newer Assistant Resume", async ({
  page,
}) => {
  const fixture = await openStudio(page);
  await project(page, 1, [lifecycle("sess-boot")]);
  await openEnd(page);
  await page.getByTestId("end-session-confirm-btn").click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await project(page, 3, [lifecycle("sess-boot", "open", 3)]);
  await publish(page, {
    type: "session.status",
    session: session("sess-boot", { title: "Resumed Assistant" }),
  });
  await fixture.settle(200);
  await openEnd(page);
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(selected(page)).toHaveAttribute("data-session-id", "sess-boot");
  await expect(page.getByTestId("session-tab-sess-boot")).toContainText(
    "Resumed Assistant",
  );
  await expect(page.locator(".harness-terminal")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});

test("Close on an exited Terminal requires confirmation when its Assistant is open", async ({
  page,
}) => {
  const fixture = await openStudio(page);
  await project(page, 1, [lifecycle("sess-boot")]);
  await publish(page, {
    type: "session.status",
    session: session("sess-boot", { status: "exited", ready: false }),
  });
  await page.getByTestId("dead-session-close").click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Terminal and Assistant work",
  );
  await expect(
    page.getByRole("button", { name: "Keep session", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(selected(page)).toHaveAttribute("data-session-id", "sess-boot");
  expect(fixture.requests).toHaveLength(0);
});

test("Terminal-only End keeps its existing confirmation and sibling selection", async ({
  page,
}) => {
  const fixture = await openStudio(page);
  await publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "host-end",
      authorityRevision: "authority-end",
      revision: 1,
      enabled: false,
      sessions: [],
      lifecycles: [],
    },
  });
  await openEnd(page);
  await expect(page.getByRole("alertdialog")).toContainText(
    "kills the live terminal",
  );
  await expect(page.getByRole("alertdialog")).not.toContainText(
    "Assistant work",
  );
  await page.getByTestId("end-session-confirm-btn").click();
  await fixture.settle(200);
  await expect(selected(page)).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );
  await expect(page.getByTestId("session-tab-sess-boot")).toHaveCount(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
});
