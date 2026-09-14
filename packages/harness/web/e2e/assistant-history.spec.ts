import { expect, test, type Page, type Route } from "@playwright/test";
import type { AssistantHistoryEntry } from "../../src/shared/assistant-history";

const cwd = "/Users/demo/acme-app";
const entry = (id: string): AssistantHistoryEntry => ({
  kind: "assistant",
  harnessSessionId: id,
  title: `Saved ${id}`,
  cwd,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  lifecycle: {
    version: 1,
    harnessSessionId: id,
    revision: 2,
    lifecycle: "ended",
    execution: "paused",
    updatedAt: 2,
  },
  history: "partial",
  nativeResume: "unchecked",
  recordRevision: 1,
});
const record = (id: string) => ({
  schemaVersion: 1,
  reconstructed: true,
  revision: 1,
  binding: {
    harnessSessionId: id,
    cwd,
    conversationId: `ses_${id}`,
    contextAuthorityScope: "PRIVATE_SCOPE",
  },
  capturedAt: "2026-09-14T00:00:00.000Z",
  turnCount: 1,
  messageCount: 2,
  limitations: ["field-truncation", "attachment-content-omitted"],
  turns: [
    {
      id: "user1",
      incomplete: true,
      acceptedContext: { hidden: "PRIVATE_CONTEXT" },
      messages: [
        {
          id: "user1",
          role: "user",
          parentId: null,
          createdAt: 1,
          completedAt: null,
          parts: [
            {
              id: "p1",
              type: "text",
              text: "Read the README",
              truncated: false,
            },
          ],
        },
        {
          id: "answer1",
          role: "assistant",
          parentId: "user1",
          createdAt: 2,
          completedAt: 3,
          parts: [
            {
              id: "p2",
              type: "text",
              text: `Saved answer ${id}`,
              truncated: false,
            },
            {
              id: "p3",
              type: "tool",
              callId: "call1",
              name: "read",
              status: "completed",
              input: "README.md",
              output: "A recorded excerpt",
              error: null,
              startedAt: 2,
              completedAt: 3,
              truncated: true,
            },
          ],
        },
      ],
    },
  ],
});
const publish = (page: Page, message: unknown) =>
  page.evaluate(
    (message) => (window as any).__HARNESS_TEST__.publish(message),
    message,
  );
const authority = (page: Page, revision: number, key = "account-a") =>
  publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "history-host",
      authorityRevision: key,
      revision,
      enabled: true,
      sessions: [],
      lifecycles: [],
    },
  });
const rows = async (page: Page) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("past-sessions-trigger").hover();
};
async function setup(page: Page, mode = "valid") {
  const probe = {
    calls: [] as string[],
    holdList: false,
    holdRecord: false,
    lists: [] as Route[],
    records: [] as Route[],
  };
  await page.route("**/api/sessions/assistant-history?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("cwd") !== cwd)
      return route.fulfill({ json: { entries: [] } });
    if (probe.holdList) {
      probe.lists.push(route);
      return;
    }
    return route.fulfill({
      json: { entries: [entry("assistant-only"), entry("sess-leasing")] },
    });
  });
  await page.route("**/api/sessions/*/assistant/record", (route) => {
    if (probe.holdRecord) {
      probe.records.push(route);
      return;
    }
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    return route.fulfill({
      status: mode === "missing" ? 404 : 200,
      json: { record: record(mode === "foreign" ? "another-studio" : id) },
    });
  });
  page.on("request", (request) => {
    if (
      /^\/opencode\/|\/assistant\/(inspect|resume|continue)$/.test(
        new URL(request.url()).pathname,
      )
    )
      probe.calls.push(request.url());
  });
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await authority(page, 1);
  return probe;
}

test("groups mixed records by Studio ID and reads pure Assistant history without native work", async ({
  page,
}, testInfo) => {
  const probe = await setup(page);
  await rows(page);
  await expect(
    page.getByTestId("assistant-history-sess-leasing"),
  ).toContainText("Terminal + Assistant");
  await expect(page.getByTestId("exited-session-sess-leasing")).toHaveCount(0);
  await expect(page.getByTestId("exited-session-sess-pricing")).toBeVisible();
  await page.getByTestId("assistant-history-assistant-only").click();
  const pane = page.getByTestId("assistant-history-pane");
  await expect(pane).toHaveAttribute("data-session-id", "assistant-only");
  await expect(pane).toContainText("Saved answer assistant-only");
  await expect(pane).toContainText("Reconstructed");
  await expect(pane).toContainText("Attachment contents are not saved");
  await expect(pane).toContainText("Turn incomplete when recorded");
  await pane.locator("summary").click();
  await expect(pane).toContainText("A recorded excerpt");
  await expect(pane).not.toContainText("PRIVATE_");
  await expect(
    pane.getByRole("button", { name: /Resume|Continue|New session/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("assistant-record.png") });
  await pane.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(pane).toContainText("Saved answer assistant-only");
  expect(probe.calls).toEqual([]);
});

for (const mode of ["missing", "foreign"]) {
  test(`${mode} saved record never becomes a fabricated conversation`, async ({
    page,
  }) => {
    const probe = await setup(page, mode);
    await rows(page);
    await page.getByTestId("assistant-history-assistant-only").click();
    await expect(page.getByTestId("assistant-history-pane")).toContainText(
      mode === "missing"
        ? "No Assistant conversation was recorded"
        : "Assistant history is unavailable",
    );
    await expect(page.getByText("Saved answer another-studio")).toHaveCount(0);
    expect(probe.calls).toEqual([]);
  });
}

test("late history and record reads cannot cross account or navigation barriers", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.holdList = true;
  await rows(page);
  await expect.poll(() => probe.lists.length).toBe(1);
  await authority(page, 2, "account-b");
  await probe.lists[0]!.fulfill({ json: { entries: [entry("old-account")] } });
  await expect(
    page
      .getByTestId("past-sessions-card")
      .getByText("Loading…", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Saved old-account", { exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  probe.holdList = false;
  probe.holdRecord = true;
  await rows(page);
  await page.getByTestId("assistant-history-assistant-only").click();
  await expect.poll(() => probe.records.length).toBeGreaterThan(0);
  await page
    .getByTestId("assistant-history-pane")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await Promise.all(
    probe.records.map((route) =>
      route.fulfill({ json: { record: record("assistant-only") } }),
    ),
  );
  await expect(page.getByTestId("assistant-history-pane")).toHaveCount(0);
  await expect(page.getByText("Saved answer assistant-only")).toHaveCount(0);
  expect(probe.calls).toEqual([]);
});
