import { expect, test, type Page, type Route } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AssistantHistoryEntry } from "../../src/shared/assistant-history";
import { openCodeTransportFailure } from "../../src/shared/opencode-errors";
import { selectMockSessionFromPalette } from "./mock-navigation";

const sourceId = "sess-leasing";
const childId = "continued-child";
const cwd = "/Users/demo/acme-app";
const date = "2026-09-14T00:00:00.000Z";
const seedText =
  "Recorded brief: continue the saved task. This context may be incomplete.";
const lifecycle = (id: string, revision = 1) => ({
  version: 1,
  harnessSessionId: id,
  revision,
  lifecycle: "open",
  execution: "paused",
  updatedAt: revision,
});
const source = (
  revision = 1,
  scope = "a".repeat(64),
): AssistantHistoryEntry => ({
  kind: "assistant",
  harnessSessionId: sourceId,
  title: "Saved Assistant source",
  cwd,
  createdAt: date,
  updatedAt: date,
  history: "partial",
  nativeResume: "missing",
  recordRevision: revision,
  lifecycle: {
    version: 1,
    harnessSessionId: sourceId,
    revision: 2,
    lifecycle: "ended",
    execution: "paused",
    updatedAt: 2,
  },
  continuationScope: scope,
});
const record = (revision: number) => ({
  schemaVersion: 1,
  reconstructed: true,
  revision,
  binding: { harnessSessionId: sourceId, conversationId: "ses_original", cwd },
  capturedAt: date,
  turnCount: 1,
  messageCount: 1,
  limitations: ["dropped-early-turns"],
  turns: [
    {
      id: "user1",
      incomplete: true,
      messages: [
        {
          id: "user1",
          role: "user",
          parentId: null,
          createdAt: 1,
          completedAt: null,
          parts: [
            {
              id: "part1",
              type: "text",
              text: "Original saved task",
              truncated: false,
            },
          ],
        },
      ],
    },
  ],
});
const publish = (page: Page, message: unknown) =>
  page.evaluate(
    (value) => (window as any).__HARNESS_TEST__.publish(value),
    message,
  );
const project = (
  page: Page,
  revision = 1,
  authorityRevision = "account-a",
  lifecycles: unknown[] = [],
  hostInstanceId = "continue-host",
) =>
  publish(page, {
    type: "assistant.state",
    snapshot: {
      hostInstanceId,
      authorityRevision,
      revision,
      enabled: true,
      sessions: [],
      lifecycles,
    },
  });
const review = async (page: Page) => {
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("past-sessions-trigger").hover();
  await page.getByTestId("assistant-history-" + sourceId).click();
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Original saved task",
  );
};
const button = (page: Page) =>
  page.getByTestId("assistant-continue-action").getByRole("button");
const closes: Array<() => Promise<void>> = [];
test.afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function setup(page: Page) {
  const streams = new Set<ServerResponse>();
  const events = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    if (req.method === "OPTIONS") return void res.end();
    streams.add(res);
    res.on("close", () => streams.delete(res));
    res.write('data: {"type":"server.connected","properties":{}}\n\n');
  });
  await new Promise<void>((resolve) => events.listen(0, "127.0.0.1", resolve));
  closes.push(async () => {
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve) => events.close(() => resolve()));
  });
  const probe = {
    requests: [] as Route[],
    calls: [] as string[],
    revision: 1,
    scope: "a".repeat(64),
    hold: false,
    fail: false,
    missingRecord: false,
    missingNative: false,
    prompts: [] as Route[],
    messages: [] as any[],
  };
  const response = (request: Record<string, any>) => {
    const continuation = {
      operationId: request.operationId,
      sourceSessionId: sourceId,
      sourceRecordRevision: request.expectedRecordRevision,
      capturedAt: date,
      retainedTurns: 1,
      omittedTurns: 3,
      seed: {
        conversationId: "ses_child",
        messageId: "msg_seed",
        partId: "prt_seed",
        text: seedText,
        sha256: createHash("sha256").update(seedText).digest("hex"),
      },
    };
    return {
      session: {
        id: childId,
        cwd,
        title: "Continued Assistant",
        harness: "claude-code",
        agentSessionId: null,
        boundWorkflowPath: null,
        status: "exited",
        ready: false,
        terminalState: "not-started",
        createdAt: date,
        lastActiveAt: date,
        agentMapIdentity: {
          projectId: "project-acme",
          sessionId: childId,
          userId: "user-a",
        },
      },
      attachment: {
        conversationId: "ses_child",
        lease: "11111111-1111-4111-8111-111111111111",
        lifecycle: lifecycle(childId),
        continuation,
      },
      continuation,
    };
  };
  await page.route("**/api/sessions/*/assistant/continue", (route) => {
    probe.requests.push(route);
    if (probe.hold) return;
    return route.fulfill(
      probe.fail
        ? {
            status: 503,
            json: {
              error: openCodeTransportFailure("continuation_unconfirmed"),
            },
          }
        : { json: response(route.request().postDataJSON()) },
    );
  });
  await page.route("**/api/assistant/access", (route) =>
    route.fulfill({ json: { enabled: true, authorityRevision: "account-a" } }),
  );
  await page.route("**/api/sessions/assistant-history?**", (route) =>
    route.fulfill({
      json: {
        entries:
          new URL(route.request().url()).searchParams.get("cwd") === cwd
            ? [source(probe.revision, probe.scope)]
            : [],
      },
    }),
  );
  await page.route("**/api/sessions/*/assistant/record", (route) =>
    route.fulfill(
      probe.missingRecord
        ? { status: 404, json: {} }
        : { json: { record: record(probe.revision) } },
    ),
  );
  await page.route(
    (url) => url.pathname.startsWith("/opencode/"),
    (route) => {
      const path = new URL(route.request().url()).pathname
        .split("/")
        .slice(3)
        .join("/");
      if (probe.missingNative && path === "attach")
        return route.fulfill({
          status: 404,
          json: { error: openCodeTransportFailure("native_history_missing") },
        });
      const attachment = response(
        probe.requests[0]?.request().postDataJSON() ?? {
          operationId: "22222222-2222-4222-8222-222222222222",
          expectedRecordRevision: 1,
        },
      ).attachment;
      if (path === "session/ses_child/prompt_async") {
        probe.prompts.push(route);
        const prompt = route.request().postDataJSON().parts[0].text;
        for (const [role, text] of [
          ["user", prompt],
          ["assistant", "Human task completed."],
        ]) {
          const id = "msg_human_" + role;
          const message = {
            info: {
              id,
              sessionID: "ses_child",
              role,
              agent: "build",
              parentID: role === "assistant" ? "msg_human_user" : undefined,
              finish: "stop",
              time: { created: 3, completed: 4 },
            },
            parts: [
              {
                id: "prt_" + id,
                messageID: id,
                sessionID: "ses_child",
                type: "text",
                text,
              },
            ],
          };
          probe.messages.push(message);
          for (const [type, properties] of [
            ["message.updated", { info: message.info }],
            ["message.part.updated", { part: message.parts[0] }],
          ])
            for (const stream of streams)
              stream.write(
                "data: " + JSON.stringify({ type, properties }) + "\n\n",
              );
        }
        return route.fulfill({
          status: 204,
          headers: { "X-Assistant-Execution": "enabled" },
        });
      }
      if (path === "lifecycle")
        return route.fulfill({
          json: lifecycle(
            new URL(route.request().url()).pathname.split("/")[2]!,
            probe.missingNative ? 3 : 1,
          ),
        });
      if (path === "attach") return route.fulfill({ json: attachment });
      if (path === "event")
        return route.continue({
          url:
            "http://127.0.0.1:" +
            (events.address() as { port: number }).port +
            "/event",
        });
      const native = {
        id: "ses_child",
        title: "Prepared child",
        time: { created: 1, updated: 2 },
      };
      if (path === "session/status")
        return route.fulfill({ json: { ses_child: { type: "idle" } } });
      if (path === "session/ses_child") return route.fulfill({ json: native });
      if (path === "session/ses_child/message")
        return route.fulfill({
          json: [
            {
              info: {
                id: "msg_seed",
                sessionID: "ses_child",
                role: "user",
                time: { created: 1 },
              },
              parts: [
                {
                  id: "prt_seed",
                  messageID: "msg_seed",
                  sessionID: "ses_child",
                  type: "text",
                  text: seedText,
                  synthetic: true,
                  ignored: false,
                  metadata: {
                    sapiomContinuation: {
                      operationId: attachment.continuation.operationId,
                      briefHash: attachment.continuation.seed.sha256,
                    },
                  },
                },
              ],
            },
            ...probe.messages,
          ],
        });
      return route.fulfill({
        json: path === "experimental/session" ? [native] : [],
      });
    },
  );
  page.on("request", (request) => {
    if (
      /^\/opencode\/|\/terminal\/start$/.test(new URL(request.url()).pathname)
    )
      probe.calls.push(request.url());
  });
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await project(page);
  return Object.assign(probe, { response });
}

test("Continue opens a distinct paused child from the displayed record and preserves source history", async ({
  page,
}, info) => {
  const probe = await setup(page);
  probe.hold = true;
  await review(page);
  await expect(button(page)).toHaveText("Continue in new Assistant");
  await expect(page.getByTestId("assistant-continue-action")).toContainText(
    "brief may be incomplete",
  );
  await page.screenshot({ path: info.outputPath("continue-review.png") });
  await button(page).click();
  await expect.poll(() => probe.requests.length).toBe(1);
  const body = probe.requests[0]!.request().postDataJSON();
  expect(body).toEqual({
    expectedRevision: 2,
    expectedRecordRevision: 1,
    operationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  await project(page, 2, "account-a", [lifecycle(childId)]);
  await probe.requests[0]!.fulfill({ json: probe.response(body) });
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    childId,
  );
  await expect(
    page.getByRole("button", { name: "Assistant", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0);
  const brief = page.getByTestId("assistant-continuation-context");
  await expect(brief).toContainText(
    "Recorded context from a previous Assistant session",
  );
  await brief.locator("summary").click();
  await expect(brief).toContainText("3 earlier turns were omitted");
  await expect(brief).toContainText(seedText);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("continued-paused.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(
    probe.calls.filter((url) =>
      /prompt_async|final-response|terminal\/start/.test(url),
    ),
  ).toEqual([]);
  // A real browser reload re-receives the same dormant registry row from the bus.
  await page.reload();
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await publish(page, {
    type: "session.status",
    session: probe.response(body).session,
  });
  await project(page, 1, "account-a", [lifecycle(childId)]);
  await selectMockSessionFromPalette(page, "Continued Assistant");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("assistant-continuation-context"),
  ).toBeVisible();
  expect(
    probe.calls.filter((url) => /prompt_async|final-response/.test(url)),
  ).toEqual([]);
  await page
    .getByRole("textbox", { name: "Message Assistant" })
    .fill("Continue the human task");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Human task completed.", { exact: true }),
  ).toBeVisible();
  expect(probe.prompts).toHaveLength(1);
  expect(probe.prompts[0]!.request().postDataJSON().parts[0].text).toBe(
    "Continue the human task",
  );
  expect(probe.calls.filter((url) => /final-response/.test(url))).toEqual([]);
  await review(page);
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Original saved task",
  );
});

test("lost Continue response survives refresh, host restart and a newer record with the same request tuple", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.fail = true;
  await review(page);
  await button(page).click();
  await expect(page.getByRole("alert")).toContainText("Retry this operation");
  const request = probe.requests[0]!.request().postDataJSON();
  probe.revision = 2;
  await page.reload();
  await project(page, 1, "new-process-authority", [], "restarted-host");
  await review(page);
  await expect(button(page)).toHaveText("Retry Continue");
  await button(page).click();
  await expect.poll(() => probe.requests.length).toBe(2);
  expect(probe.requests[1]!.request().postDataJSON()).toEqual(request);
  const persisted = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) =>
      key.startsWith("studio.assistant-continue."),
    ),
  );
  expect(persisted).toHaveLength(1);
  expect(JSON.parse(persisted[0]![1])).toEqual(request);
});

for (const invalid of ["source", "record", "hash", "child", "lease"]) {
  test(
    "unverified Continue " + invalid + " retains original readable history",
    async ({ page }) => {
      const probe = await setup(page);
      probe.hold = true;
      await review(page);
      await button(page).click();
      await expect.poll(() => probe.requests.length).toBe(1);
      const value = probe.response(probe.requests[0]!.request().postDataJSON());
      if (invalid === "source")
        value.continuation.sourceSessionId = "other-source";
      if (invalid === "record") value.continuation.sourceRecordRevision++;
      if (invalid === "hash") value.continuation.seed.sha256 = "f".repeat(64);
      if (invalid === "child") value.session.id = sourceId;
      if (invalid === "lease") value.attachment.lease = "invalid";
      await probe.requests[0]!.fulfill({ json: value });
      await expect(page.getByRole("alert")).toContainText(
        "prepared continuation could not be verified",
      );
      await expect(page.getByTestId("assistant-transcript")).toContainText(
        "Original saved task",
      );
      expect(probe.calls).toEqual([]);
    },
  );
}

for (const barrier of ["navigation", "account", "lifecycle"]) {
  test(
    "late Continue cannot cross the " + barrier + " barrier",
    async ({ page }) => {
      const probe = await setup(page);
      probe.hold = true;
      await review(page);
      await button(page).click();
      await expect.poll(() => probe.requests.length).toBe(1);
      if (barrier === "navigation")
        await page
          .getByTestId("assistant-history-pane")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      if (barrier === "account") await project(page, 2, "account-b");
      if (barrier === "lifecycle")
        await project(page, 2, "account-a", [
          { ...lifecycle(childId, 2), lifecycle: "ended" },
        ]);
      await probe.requests[0]!.fulfill({
        json: probe.response(probe.requests[0]!.request().postDataJSON()),
      });
      if (barrier === "lifecycle")
        await expect(page.getByRole("alert")).toContainText(
          "selection or session changed",
        );
      else
        await expect(page.getByTestId("assistant-history-pane")).toHaveCount(0);
      await expect(page.getByTestId("session-context")).not.toHaveAttribute(
        "data-session-id",
        childId,
      );
      expect(probe.calls).toEqual([]);
    },
  );
}

test("unavailable storage fails before Continue dispatch", async ({ page }) => {
  const probe = await setup(page);
  await review(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
  });
  await button(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "could not save or verify",
  );
  expect(probe.requests).toHaveLength(0);
});

test("missing stable scope preserves history but disables Continue", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.scope = "not-a-stable-scope";
  await review(page);
  await expect(button(page)).toBeDisabled();
  await expect(page.getByTestId("assistant-continue-action")).toContainText(
    "unavailable for this workspace",
  );
  expect(probe.requests).toHaveLength(0);
});

test("another stable authority cannot inherit an uncertain Continue", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.fail = true;
  await review(page);
  await button(page).click();
  await expect(page.getByRole("alert")).toContainText("Retry this operation");
  probe.scope = "b".repeat(64);
  await page.reload();
  await project(page);
  await review(page);
  await expect(button(page)).toHaveText("Continue in new Assistant");
  await button(page).click();
  await expect.poll(() => probe.requests.length).toBe(2);
  expect(probe.requests[1]!.request().postDataJSON().operationId).not.toEqual(
    probe.requests[0]!.request().postDataJSON().operationId,
  );
});

test("missing saved material cannot prepare a new continuation", async ({
  page,
}) => {
  const probe = await setup(page);
  probe.missingRecord = true;
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("past-sessions-trigger").hover();
  await page.getByTestId("assistant-history-" + sourceId).click();
  await expect(page.getByTestId("assistant-history-pane")).toContainText(
    "No Assistant conversation was recorded",
  );
  await expect(button(page)).toBeDisabled();
  expect(probe.requests).toHaveLength(0);
});

test("missing native history offers the saved record without automatic Continue", async ({
  page,
}, info) => {
  const probe = await setup(page);
  probe.missingNative = true;
  await project(page, 2, "account-a", [lifecycle(sourceId, 3)]);
  await review(page);
  await page
    .getByTestId("assistant-history-pane")
    .getByRole("button", { name: "View Terminal history" })
    .click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const recovery = page.getByRole("button", {
    name: "Review saved Assistant history",
    exact: true,
  });
  await expect(recovery).toBeVisible();
  await page.screenshot({ path: info.outputPath("native-missing-review.png") });
  await recovery.click();
  await expect(page.getByTestId("assistant-transcript")).toContainText(
    "Original saved task",
  );
  await expect(button(page)).toBeEnabled();
  expect(probe.requests).toHaveLength(0);
  expect(
    probe.calls.filter((url) => /prompt_async|final-response/.test(url)),
  ).toEqual([]);
  probe.hold = true;
  await button(page).click();
  await expect.poll(() => probe.requests.length).toBe(1);
  expect(probe.requests[0]!.request().postDataJSON().expectedRevision).toBe(3);
});
