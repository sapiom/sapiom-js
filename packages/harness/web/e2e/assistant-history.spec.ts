import { expect, test, type Page, type Route } from "@playwright/test";
import type { AssistantHistoryEntry } from "../../src/shared/assistant-history";
import { openCodeTransportFailure } from "../../src/shared/opencode-errors";
import { createServer, type ServerResponse } from "node:http";

const closeEvents: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  await Promise.all(closeEvents.splice(0).map((close) => close()));
});

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
  const streams = new Set<ServerResponse>();
  const events = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    if (req.method === "OPTIONS") {
      res.end();
      return;
    }
    streams.add(res);
    res.on("close", () => streams.delete(res));
    res.write('data: {"type":"server.connected","properties":{}}\n\n');
  });
  await new Promise<void>((resolve) => events.listen(0, "127.0.0.1", resolve));
  const eventOrigin = `http://127.0.0.1:${(events.address() as { port: number }).port}`;
  closeEvents.push(async () => {
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve) => events.close(() => resolve()));
  });
  const probe = {
    calls: [] as string[],
    holdList: false,
    holdRecord: false,
    lists: [] as Route[],
    records: [] as Route[],
    inspectState: "available" as "available" | "missing" | "unavailable",
    inspections: [] as Route[],
    resumes: [] as Route[],
    holdInspect: false,
    holdResume: false,
    failResume: false,
    resumedRevision: 3,
  };
  const attachment = (id: string) => ({
    conversationId: `ses_${id}`,
    lease: "11111111-1111-4111-8111-111111111111",
    lifecycle: {
      ...entry(id).lifecycle,
      lifecycle: "open",
      revision: probe.resumedRevision,
    },
  });
  const resumed = (id: string) => ({
    session: {
      id,
      cwd,
      title: `Saved ${id}`,
      harness: "claude-code",
      agentSessionId: null,
      boundWorkflowPath: null,
      status: "exited",
      ready: false,
      createdAt: entry(id).createdAt,
      lastActiveAt: entry(id).updatedAt,
    },
    attachment: attachment(id),
  });
  await page.route("**/api/sessions/*/assistant/inspect", (route) => {
    probe.inspections.push(route);
    if (probe.holdInspect) return;
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    return route.fulfill({
      json: {
        entry: {
          ...entry(id),
          nativeResume: probe.inspectState,
          ...(probe.inspectState !== "available"
            ? {
                resumeFailure: openCodeTransportFailure(
                  probe.inspectState === "missing"
                    ? "native_history_missing"
                    : "context_unavailable",
                ),
              }
            : {}),
        },
      },
    });
  });
  await page.route("**/api/sessions/*/assistant/resume", (route) => {
    probe.resumes.push(route);
    if (probe.holdResume) return;
    const id = new URL(route.request().url()).pathname.split("/")[3]!;
    return route.fulfill(
      probe.failResume ? { status: 503, json: {} } : { json: resumed(id) },
    );
  });
  await page.route("**/api/assistant/access", (route) =>
    route.fulfill({ json: { enabled: true, authorityRevision: "account-a" } }),
  );
  await page.route(
    (url) => url.pathname.startsWith("/opencode/"),
    (route) => {
      const [, , id, ...parts] = new URL(route.request().url()).pathname.split(
        "/",
      );
      const path = parts.join("/");
      const native = {
        id: `ses_${id}`,
        title: "Native restored history",
        time: { created: 1, updated: 2 },
      };
      if (path === "lifecycle")
        return route.fulfill({ json: attachment(id!).lifecycle });
      if (path === "attach") return route.fulfill({ json: attachment(id!) });
      if (path === "event")
        return route.continue({ url: `${eventOrigin}/event` });
      if (path === "session/status")
        return route.fulfill({ json: { [native.id]: { type: "idle" } } });
      if (path === `session/${native.id}`)
        return route.fulfill({ json: native });
      if (path === `session/${native.id}/message`)
        return route.fulfill({
          json: [
            {
              info: {
                id: "msg_saved_user",
                sessionID: native.id,
                role: "user",
                time: { created: 1 },
              },
              parts: [
                {
                  id: "prt_saved_user",
                  messageID: "msg_saved_user",
                  sessionID: native.id,
                  type: "text",
                  text: "Prior saved task",
                },
              ],
            },
            {
              info: {
                id: "msg_saved_answer",
                parentID: "msg_saved_user",
                sessionID: native.id,
                role: "assistant",
                agent: "build",
                time: { created: 2, completed: 3 },
                finish: "tool-calls",
              },
              parts: [
                {
                  id: "prt_saved_answer",
                  messageID: "msg_saved_answer",
                  sessionID: native.id,
                  type: "text",
                  text: `Native saved answer ${id}`,
                },
              ],
            },
          ],
        });
      return route.fulfill({
        json: path === "experimental/session" ? [native] : [],
      });
    },
  );
  await page.route("**/api/sessions/assistant-history?**", (route) => {
    if (new URL(route.request().url()).searchParams.get("cwd") !== cwd)
      return route.fulfill({ json: { entries: [] } });
    if (probe.holdList) {
      probe.lists.push(route);
      return;
    }
    return route.fulfill({
      json: {
        entries: [
          entry("assistant-only"),
          entry("sess-leasing"),
          ...(mode === "foreground" ? [entry("sess-boot")] : []),
        ],
      },
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
  return Object.assign(probe, { resumed });
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
    pane.getByRole("button", {
      name: /^(Resume Assistant|Continue|New session)$/,
    }),
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

const review = async (page: Page, id = "assistant-only") => {
  await rows(page);
  await page.getByTestId(`assistant-history-${id}`).click();
  await expect(page.getByTestId("assistant-transcript")).toBeVisible();
};
const checkResume = (page: Page) =>
  page.getByRole("button", { name: "Check Resume availability", exact: true });
const resumeButton = (page: Page) =>
  page.getByRole("button", { name: /^(Resume Assistant|Retry Resume)$/ });

test("Resume verifies availability, preserves identity and opens paused without submitting work", async ({
  page,
}, testInfo) => {
  const probe = await setup(page);
  await review(page);
  await expect(resumeButton(page)).toHaveCount(0);
  expect(probe.inspections).toHaveLength(0);
  probe.holdInspect = true;
  await checkResume(page).click();
  await expect(
    page.getByRole("button", { name: "Checking Resume availability…" }),
  ).toBeDisabled();
  await expect.poll(() => probe.inspections.length).toBe(1);
  await probe.inspections[0]!.fulfill({
    json: { entry: { ...entry("assistant-only"), nativeResume: "available" } },
  });
  await expect(resumeButton(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("resume-verified.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(resumeButton(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("resume-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  probe.holdResume = true;
  await resumeButton(page).click();
  await expect.poll(() => probe.resumes.length).toBe(1);
  await publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "history-host",
      authorityRevision: "account-a",
      revision: 2,
      enabled: true,
      sessions: [],
      lifecycles: [probe.resumed("assistant-only").attachment.lifecycle],
    },
  });
  await probe.resumes[0]!.fulfill({ json: probe.resumed("assistant-only") });
  await expect(
    page.getByRole("button", { name: "Assistant", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Native saved answer assistant-only", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Session ended", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "assistant-only",
  );
  await page.screenshot({ path: testInfo.outputPath("resumed-paused.png") });
  expect(probe.resumes[0]!.request().postDataJSON()).toMatchObject({
    expectedRevision: 2,
    operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(
    probe.calls.filter((url) => /prompt_async|final-response/.test(url)),
  ).toEqual([]);
});

for (const native of ["missing", "unavailable"] as const) {
  test(`${native} native context leaves saved history readable without Resume`, async ({
    page,
  }, testInfo) => {
    const probe = await setup(page);
    probe.inspectState = native;
    await review(page);
    await checkResume(page).click();
    await expect(page.getByTestId("assistant-history-actions")).toContainText(
      "Your saved record remains readable",
    );
    await expect(page.getByTestId("assistant-transcript")).toContainText(
      "Saved answer assistant-only",
    );
    await expect(resumeButton(page)).toHaveCount(0);
    expect(probe.resumes).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath(`resume-${native}.png`),
    });
  });
}

test("uncertain Resume retries the same operation and accepts reconciled later revision", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.failResume = true;
  await review(page, "sess-leasing");
  await checkResume(page).click();
  await resumeButton(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "Retry to check the same operation",
  );
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Saved answer sess-leasing",
  );
  const request = probe.resumes[0]!.request().postDataJSON();
  await page
    .getByTestId("assistant-history-pane")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(
    page.getByRole("button", { name: "Retry Resume", exact: true }),
  ).toBeEnabled();
  probe.failResume = false;
  probe.resumedRevision = 4;
  await resumeButton(page).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  expect(probe.resumes[1]!.request().postDataJSON()).toEqual(request);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
});

for (const barrier of ["navigation", "account", "lifecycle"] as const) {
  test(`late Resume cannot cross the ${barrier} barrier`, async ({ page }) => {
    const probe = await setup(page);
    probe.holdResume = true;
    await review(page);
    await checkResume(page).click();
    await resumeButton(page).click();
    await expect.poll(() => probe.resumes.length).toBe(1);
    if (barrier === "navigation")
      await page
        .getByTestId("assistant-history-pane")
        .getByRole("button", { name: "Close", exact: true })
        .click();
    if (barrier === "account") await authority(page, 2, "account-b");
    if (barrier === "lifecycle")
      await publish(page, {
        type: "assistant.state",
        snapshot: {
          hostInstanceId: "history-host",
          authorityRevision: "account-a",
          revision: 3,
          enabled: true,
          sessions: [],
          lifecycles: [{ ...entry("assistant-only").lifecycle, revision: 4 }],
        },
      });
    await probe.resumes[0]!.fulfill({ json: probe.resumed("assistant-only") });
    if (barrier === "lifecycle") await expect(resumeButton(page)).toBeEnabled();
    else
      await expect(page.getByTestId("assistant-history-pane")).toHaveCount(0);
    await expect(
      page
        .getByRole("button", { name: "Assistant", exact: true })
        .and(page.locator('[aria-pressed="true"]')),
    ).toHaveCount(0);
    expect(probe.calls.filter((url) => /\/opencode\//.test(url))).toEqual([]);
  });
}

for (const invalid of ["studio", "cwd", "lease", "revision"] as const) {
  test(`an invalid Resume ${invalid} cannot activate a conversation`, async ({
    page,
  }) => {
    const probe = await setup(page);
    probe.holdResume = true;
    await review(page);
    await checkResume(page).click();
    await resumeButton(page).click();
    await expect.poll(() => probe.resumes.length).toBe(1);
    const value = probe.resumed("assistant-only");
    if (invalid === "studio") value.session.id = "foreign-studio";
    if (invalid === "cwd") value.session.cwd = "/foreign-project";
    if (invalid === "lease") value.attachment.lease = "not-a-lease";
    if (invalid === "revision") value.attachment.lifecycle.revision = 2;
    await probe.resumes[0]!.fulfill({ json: value });
    await expect(page.getByRole("alert")).toContainText(
      "restored Assistant could not be verified",
    );
    await expect(page.getByTestId("assistant-transcript")).toContainText(
      "Saved answer assistant-only",
    );
    expect(probe.calls.filter((url) => /\/opencode\//.test(url))).toEqual([]);
  });
}

test("late availability and untrusted failure text never authorize Resume", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.holdInspect = true;
  await review(page);
  await checkResume(page).click();
  await expect.poll(() => probe.inspections.length).toBe(1);
  await probe.inspections[0]!.fulfill({
    json: {
      entry: {
        ...entry("assistant-only"),
        nativeResume: "unavailable",
        resumeFailure: {
          ...openCodeTransportFailure("context_unavailable"),
          message: "PRIVATE_RAW_FAILURE",
        },
      },
    },
  });
  await expect(page.getByRole("alert")).toContainText(
    "Resume availability could not be verified",
  );
  await expect(page.getByText("PRIVATE_RAW_FAILURE")).toHaveCount(0);
  await checkResume(page).click();
  await expect.poll(() => probe.inspections.length).toBe(2);
  await page
    .getByTestId("assistant-history-pane")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await probe.inspections[1]!.fulfill({
    json: { entry: { ...entry("assistant-only"), nativeResume: "available" } },
  });
  await expect(resumeButton(page)).toHaveCount(0);
  expect(probe.resumes).toHaveLength(0);
});

test("resumed Assistant yields to newer foreground Terminal work", async ({
  page,
}) => {
  await setup(page, "foreground");
  await review(page, "sess-boot");
  await checkResume(page).click();
  await resumeButton(page).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await publish(page, {
    type: "canvas.reload",
    harnessSessionId: "sess-boot",
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  await page.getByTestId("canvas-chat-toggle").click();
  await page.getByTestId("canvas-freeform-input").fill("Explain this agent");
  await page.getByTestId("canvas-freeform-ask").click();
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".harness-terminal")).toBeVisible();
});

for (const revisit of [false, true]) {
  test(`Resume keeps the original revision after its bus commit and lost ACK${revisit ? " across Close and Back" : ""}`, async ({
    page,
  }, info) => {
    const probe = await setup(page);
    probe.holdResume = true;
    await review(page);
    await checkResume(page).click();
    await resumeButton(page).click();
    await expect.poll(() => probe.resumes.length).toBe(1);
    const original = probe.resumes[0]!.request().postDataJSON();
    await publish(page, {
      type: "assistant.state",
      snapshot: {
        hostInstanceId: "history-host",
        authorityRevision: "account-a",
        revision: 2,
        enabled: true,
        sessions: [],
        lifecycles: [probe.resumed("assistant-only").attachment.lifecycle],
      },
    });
    await probe.resumes[0]!.fulfill({ status: 503, json: {} });
    await expect(page.getByRole("alert")).toContainText(
      "Retry to check the same operation",
    );
    if (!revisit)
      await page.screenshot({
        path: info.outputPath("retry-resume-original-request.png"),
      });
    if (revisit) {
      await page
        .getByTestId("assistant-history-pane")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.getByRole("button", { name: "Go back" }).click();
    }
    await page
      .getByRole("button", { name: "Retry Resume", exact: true })
      .click();
    await expect.poll(() => probe.resumes.length).toBe(2);
    expect(probe.resumes[1]!.request().postDataJSON()).toEqual(original);
    expect(original.expectedRevision).toBe(2);
    expect(probe.inspections).toHaveLength(1);
    probe.resumedRevision = 4;
    await probe.resumes[1]!.fulfill({ json: probe.resumed("assistant-only") });
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  });
}

test("a definite Resume conflict permits a fresh availability check without auto dispatch", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.holdResume = true;
  await review(page);
  await checkResume(page).click();
  await resumeButton(page).click();
  await expect.poll(() => probe.resumes.length).toBe(1);
  await probe.resumes[0]!.fulfill({
    status: 409,
    json: { failure: openCodeTransportFailure("lifecycle_changed") },
  });
  await expect(checkResume(page)).toBeEnabled();
  await expect(resumeButton(page)).toHaveCount(0);
  expect(probe.resumes).toHaveLength(1);
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Saved answer assistant-only",
  );
});

const historyUnavailable = (page: Page) =>
  page.getByText("Assistant history is unavailable. Reopen history to retry.", {
    exact: true,
  });
const refreshDirectory = (page: Page, directory: string) =>
  publish(page, {
    type: "session.status",
    session: {
      id: "sess-boot",
      cwd: directory,
      title: "Directory history check",
      harness: "claude-code",
      agentSessionId: "unlisted-native",
      boundWorkflowPath: null,
      status: "exited",
      ready: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    },
  });
const otherCwd = "/Users/demo/rfq-agent";

test("a successful directory refresh preserves another directory's history failure until that directory succeeds", async ({
  page,
}, info) => {
  await setup(page);
  let failed = true;
  const requests: string[] = [];
  await page.route("**/api/sessions/assistant-history?**", (route) => {
    const directory = new URL(route.request().url()).searchParams.get("cwd")!;
    requests.push(directory);
    return route.fulfill(
      directory === cwd && failed
        ? { status: 503, json: {} }
        : { json: { entries: directory === cwd ? [entry("recovered")] : [] } },
    );
  });
  await rows(page);
  await expect(historyUnavailable(page)).toBeVisible();
  const before = requests.filter((dir) => dir === otherCwd).length;
  await refreshDirectory(page, otherCwd);
  await expect
    .poll(() => requests.filter((dir) => dir === otherCwd).length)
    .toBeGreaterThan(before);
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await expect(historyUnavailable(page)).toBeVisible();
  await historyUnavailable(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("history-directory-unavailable.png"),
  });
  failed = false;
  await refreshDirectory(page, cwd);
  await expect(page.getByTestId("assistant-history-recovered")).toBeVisible();
  await expect(historyUnavailable(page)).toHaveCount(0);
  await page
    .getByTestId("assistant-history-recovered")
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("history-directory-recovered.png"),
  });
});

for (const oldResult of ["failure", "old metadata"] as const) {
  test(`a slow multi-directory batch cannot restore ${oldResult} over a newer directory result`, async ({
    page,
  }) => {
    await setup(page);
    // Make Terminal discovery immediate; this test holds only the Assistant
    // directory fan-out and must allow its first cwd request to settle.
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .find(
          (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
        )!.name;
      const { MockApi } = await import(url);
      MockApi.prototype.sessionHistory = async () => [];
    });
    const firstResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/sessions/assistant-history" &&
        new URL(response.url()).searchParams.get("cwd") === cwd,
    );
    let acmeRequests = 0;
    let held: Route | null = null;
    await page.route("**/api/sessions/assistant-history?**", (route) => {
      const directory = new URL(route.request().url()).searchParams.get("cwd");
      if (directory === otherCwd && held === null) {
        held = route;
        return;
      }
      if (directory !== cwd) return route.fulfill({ json: { entries: [] } });
      acmeRequests++;
      return route.fulfill(
        acmeRequests === 1 && oldResult === "failure"
          ? { status: 503, json: {} }
          : {
              json: {
                entries: [
                  {
                    ...entry("ordered"),
                    title:
                      acmeRequests === 1
                        ? "Old saved history"
                        : "Fresh saved history",
                  },
                ],
              },
            },
      );
    });
    await rows(page);
    await expect.poll(() => held !== null && acmeRequests === 1).toBe(true);
    await (await firstResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await refreshDirectory(page, cwd);
    await expect(page.getByTestId("assistant-history-ordered")).toContainText(
      "Fresh saved history",
    );
    await held!.fulfill({ json: { entries: [] } });
    await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("assistant-history-ordered")).toContainText(
      "Fresh saved history",
    );
    await expect(historyUnavailable(page)).toHaveCount(0);
  });
}

test("a mixed Assistant row retains its transcript-only Terminal record without starting either engine", async ({
  page,
}, info) => {
  const probe = await setup(page);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
      )!.name;
    const { MockApi } = await import(url);
    const history = MockApi.prototype.sessionHistory,
      record = MockApi.prototype.sessionRecord;
    MockApi.prototype.sessionHistory = async function (cwd: string) {
      const rows = await history.call(this, cwd);
      return cwd === "/Users/demo/acme-app"
        ? [
            ...rows,
            {
              harnessSessionId: "assistant-only",
              agentSessionId: "retained-terminal-native",
              harness: "claude-code",
              cwd,
              title: "Retained Terminal record",
              lastActiveAt: "2026-09-14T00:00:00.000Z",
              source: "transcript",
              resumeMode: "agent-resume",
            },
          ]
        : rows;
    };
    MockApi.prototype.sessionRecord = async function (id: string) {
      if (id !== "assistant-only") return record.call(this, id);
      return {
        ...(await record.call(this, "2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33")),
        harnessSessionId: id,
        mergedSessionIds: [id],
        agentSessionId: "retained-terminal-native",
      };
    };
  });
  await rows(page);
  await expect(
    page.getByTestId("assistant-history-assistant-only"),
  ).toContainText("Terminal + Assistant");
  await expect(
    page.getByTestId("history-retained-terminal-native"),
  ).toHaveCount(0);
  await page.getByTestId("assistant-history-assistant-only").click();
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Saved answer assistant-only",
  );
  await page.screenshot({
    path: info.outputPath("mixed-assistant-record.png"),
  });
  await page
    .getByRole("button", { name: "View Terminal history", exact: true })
    .click();
  await expect(page.getByTestId("past-session-pane")).toContainText(
    "Retained Terminal record",
  );
  await expect(page.getByTestId("session-transcript")).toContainText(
    "Wire the screening webhook",
  );
  expect(probe.calls).toEqual([]);
  await page.screenshot({ path: info.outputPath("mixed-terminal-record.png") });
});

test("Open Terminal from history outranks an earlier Assistant Resume focus", async ({
  page,
}) => {
  const probe = await setup(page);
  await review(page);
  await checkResume(page).click();
  await resumeButton(page).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await review(page);
  await page
    .getByRole("button", { name: "View Terminal history", exact: true })
    .click();
  await page.getByRole("button", { name: "Terminal", exact: true }).waitFor();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("dead-session-pane")).toBeVisible();
  expect(probe.resumes).toHaveLength(1);
});

test("a resumed dormant Terminal is not labelled as an ended Studio before its lifecycle bus arrives", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.holdResume = true;
  await review(page);
  await checkResume(page).click();
  await resumeButton(page).click();
  await expect.poll(() => probe.resumes.length).toBe(1);
  const value = probe.resumed("assistant-only");
  await probe.resumes[0]!.fulfill({
    json: {
      ...value,
      session: { ...value.session, terminalState: "not-started" },
    },
  });
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByText("Session ended", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Nothing generated yet", { exact: true }),
  ).toBeVisible();
  await publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId: "history-host",
      authorityRevision: "account-a",
      revision: 2,
      enabled: true,
      sessions: [],
      lifecycles: [{ ...entry("assistant-only").lifecycle, revision: 4 }],
    },
  });
  await expect(page.getByText("Session ended", { exact: true })).toBeVisible();
});

test("a Terminal summary in another directory remains separate from an Assistant with the same Studio ID", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .find(
        (entry) => new URL(entry.name).pathname === "/src/lib/api.ts",
      )!.name;
    const { MockApi } = await import(url);
    const history = MockApi.prototype.sessionHistory;
    MockApi.prototype.sessionHistory = async function (cwd: string) {
      const rows = await history.call(this, cwd);
      return cwd === "/Users/demo/rfq-agent"
        ? [
            ...rows,
            {
              harnessSessionId: "assistant-only",
              agentSessionId: "different-directory-native",
              harness: "codex",
              cwd,
              title: "Other directory Terminal",
              lastActiveAt: "2026-09-14T00:00:00.000Z",
              source: "transcript",
              resumeMode: "agent-resume",
            },
          ]
        : rows;
    };
  });
  await rows(page);
  await expect(
    page.getByTestId("assistant-history-assistant-only"),
  ).not.toContainText("Terminal + Assistant");
  await expect(
    page.getByTestId("history-different-directory-native"),
  ).toBeVisible();
  await page.getByTestId("assistant-history-assistant-only").click();
  await expect(
    page.getByRole("button", { name: "View Terminal history", exact: true }),
  ).toHaveCount(0);
});
