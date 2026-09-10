import { expect, test, type Page } from "@playwright/test";
import express, { type Response } from "express";
import type { Server } from "node:http";
import { openCodeCompletionPrompt } from "../../src/shared/opencode-completion";
import { openCodeTransportFailure } from "../../src/shared/opencode-errors";

// Exercise the pinned adapter over actual incremental HTTP SSE, without a model.
test.describe.configure({ mode: "serial" });
type Conversation = {
  id: string;
  turns: Array<{
    info: Record<string, any>;
    parts: Array<Record<string, any>>;
  }>;
  streams: Set<Response>;
  prompts: string[];
};
let server: Server;
let origin: string;
let enabled: boolean;
let accessAuthorityRevision: string;
let failAttach: boolean;
let attachError: unknown | null;
let failMetadata: boolean;
let metadataError: unknown | null;
let holdHistory: boolean;
let failEvents: boolean;
let failPrompt: boolean;
let failAccess: boolean;
let finalResponseError: unknown | null;
let accessCalls: number;
let recoveryReply: ((text: string, agent?: string) => void) | undefined;
const historyReplies: Array<() => void> = [];
let routeCalls: number;
const conversations = new Map<string, Conversation>();
const emit = (c: Conversation, type: string, properties: object) => {
  for (const stream of c.streams)
    stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
};
function finish(id: string, suffix: string) {
  const c = conversations.get(id)!;
  const turn = c.turns.at(-1)!;
  turn.parts[0].text += suffix;
  turn.info.time.completed = Date.now();
  turn.info.finish = "stop";
  emit(c, "message.part.delta", {
    sessionID: id,
    messageID: turn.info.id,
    partID: turn.parts[0].id,
    field: "text",
    delta: suffix,
  });
  emit(c, "message.updated", { info: turn.info });
  emit(c, "session.status", { sessionID: id, status: { type: "idle" } });
}
test.beforeEach(async ({ page }) => {
  conversations.clear();
  enabled = true;
  accessAuthorityRevision = "authority-a";
  failAttach = false;
  attachError = null;
  failMetadata = false;
  metadataError = null;
  holdHistory = false;
  failEvents = false;
  failPrompt = false;
  failAccess = false;
  finalResponseError = null;
  accessCalls = 0;
  recoveryReply = undefined;
  historyReplies.length = 0;
  routeCalls = 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    if (req.method === "OPTIONS") {
      res.end();
      return;
    }
    next();
  });
  app.all("/opencode/:studioId/*", (req, res) => {
    routeCalls++;
    if (req.header("X-Harness-Token") !== "chat-test-boot") {
      res.status(401).end();
      return;
    }
    const id = `ses_${req.params.studioId.replaceAll("-", "_")}`;
    let c = conversations.get(id);
    if (!c) {
      c = { id, turns: [], streams: new Set(), prompts: [] };
      conversations.set(id, c);
    }
    const path = req.params[0];
    const session = {
      id,
      title: "Studio conversation",
      time: { created: 1, updated: 1 },
    };
    if (path === "attach") {
      if (attachError) {
        res.status(503).json(attachError);
        return;
      }
      res.status(failAttach ? 502 : 200).json({ conversationId: id });
      return;
    }
    if (path === "experimental/session") {
      res.json([session]);
      return;
    }
    if (path === `session/${id}`) {
      if (metadataError) {
        res.status(403).json(metadataError);
        return;
      }
      res.status(failMetadata ? 503 : 200).json(session);
      return;
    }
    if (path === `session/${id}/message`) {
      if (holdHistory) historyReplies.push(() => res.json(c!.turns));
      else res.json(c.turns);
      return;
    }
    if (path === "permission" || path === "question") {
      res.json([]);
      return;
    }
    if (path === "session/status") {
      res.json({ [id]: { type: "idle" } });
      return;
    }
    if (path === "event") {
      if (failEvents) {
        res.status(503).end();
        return;
      }
      res.type("text/event-stream").flushHeaders();
      c.streams.add(res);
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      res.once("close", () => c!.streams.delete(res));
      return;
    }
    if (path === `session/${id}/final-response`) {
      c.recoveries.push(req.body.messageId);
      if (finalResponseError) {
        res.status(410).json(finalResponseError);
        return;
      }
      emit(c, "session.status", { sessionID: id, status: { type: "busy" } });
      recoveryReply = (text, agent = "sapiom-turn-recovery") => {
        const previous = c!.turns.at(-1)!;
        const messageId = `${previous.info.id}_recovered`;
        const user = {
          info: {
            id: `${messageId}_user`,
            sessionID: id,
            role: "user",
            agent,
            time: { created: Date.now() },
          },
          parts: [
            {
              id: `prt_${messageId}_user`,
              sessionID: id,
              messageID: `${messageId}_user`,
              type: "text",
              text: "Internal recovery instruction",
            },
          ],
        };
        const answer = {
          info: {
            ...previous.info,
            id: messageId,
            agent,
            parentID: user.info.id,
          },
          parts: [
            {
              id: `prt_${messageId}`,
              sessionID: id,
              messageID: messageId,
              type: "text",
              text,
            },
          ],
        };
        c!.turns.push(user, answer);
        emit(c!, "message.updated", { info: user.info });
        emit(c!, "message.part.updated", { part: user.parts[0] });
        emit(c!, "message.updated", { info: answer.info });
        emit(c!, "message.part.updated", { part: answer.parts[0] });
        emit(c!, "session.status", { sessionID: id, status: { type: "idle" } });
        res.status(204).end();
      };
      return;
    }
    if (path === `session/${id}/prompt_async`) {
      if (failPrompt) {
        res.status(502).json({ error: "Controlled send failure" });
        return;
      }
      c.prompts.push(req.body.parts[0].text);
      const userId = `msg_user_${c.prompts.length}`,
        assistantId = `msg_assistant_${c.prompts.length}`;
      const user = {
        info: {
          id: userId,
          sessionID: id,
          role: "user",
          time: { created: Date.now() },
        },
        parts: [
          {
            id: `prt_${userId}`,
            sessionID: id,
            messageID: userId,
            type: "text",
            text: req.body.parts[0].text,
          },
        ],
      };
      const assistant = {
        info: {
          id: assistantId,
          sessionID: id,
          role: "assistant",
          parentID: userId,
          time: { created: Date.now() },
          modelID: "smart",
          providerID: "sapiom",
        },
        parts: [
          {
            id: `prt_${assistantId}`,
            sessionID: id,
            messageID: assistantId,
            type: "text",
            text: "",
          },
        ],
      };
      c.turns.push(user, assistant);
      res.status(204).end();
      emit(c, "session.status", { sessionID: id, status: { type: "busy" } });
      for (const turn of [user, assistant]) {
        emit(c, "message.updated", { info: turn.info });
        emit(c, "message.part.updated", { part: turn.parts[0] });
      }
      assistant.parts[0].text = "First chunk";
      emit(c, "message.part.delta", {
        sessionID: id,
        messageID: assistantId,
        partID: assistant.parts[0].id,
        field: "text",
        delta: "First chunk",
      });
      return;
    }
    res.status(404).end();
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.addInitScript(() => {
    (window as any).__HARNESS__ = { token: "chat-test-boot" };
  });
  await page.route("**/api/assistant/access", (route) => {
    accessCalls++;
    return route.fulfill({
      status: failAccess ? 503 : 200,
      json: { enabled, authorityRevision: accessAuthorityRevision },
    });
  });
  await page.route("**/opencode/**", (route) =>
    route.continue({
      url: `${origin}${new URL(route.request().url()).pathname}${new URL(route.request().url()).search}`,
    }),
  );
});
test.afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function openAssistant(page: Page) {
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeEnabled();
}

test("defaults to Terminal and keeps Assistant unavailable when access is off", async ({
  page,
}) => {
  enabled = false;
  await page.goto("/?seed=0");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Conversation view" }),
  ).toHaveCount(0);
  expect(routeCalls).toBe(0);
});

test("streams, disposes the old tab's connection, restores history, and sends a follow-up", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("First request");
  await input.press("Enter");
  await expect(
    page.locator(".studio-chat-assistant").filter({ hasText: "First chunk" }),
  ).toContainText("First chunk");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await tabs.nth(1).click();
  await expect
    .poll(() => conversations.get("ses_sess_boot")!.streams.size)
    .toBe(0);
  finish("ses_sess_boot", " finished in background");
  await expect(page.locator(".studio-chat-assistant")).toHaveCount(0);
  await tabs.nth(0).click();
  await expect(page.locator(".studio-chat-assistant")).toContainText(
    "finished in background",
  );
  await input.fill("Follow-up");
  await input.press("Enter");
  await expect
    .poll(() => conversations.get("ses_sess_boot")!.prompts.length)
    .toBe(2);
  finish("ses_sess_boot", " completed follow-up");
  await expect(page.locator(".studio-chat-assistant").last()).toContainText(
    "completed follow-up",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
});

test("keeps principal-scoped session drafts across centre-pane routes and exited-session remounts", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("First session draft");

  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await tabs.nth(1).click();
  await input.fill("Second session draft");

  // The create-new destination unmounts the whole conversation branch.
  await page.getByTestId("rail-create-new").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await page.getByTestId("composer-back").click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("Second session draft");

  // A transcript-only review is another centre-pane owner. Closing it returns
  // to the same live Studio session without making the review adopt/resume.
  await page.getByTestId("history-trigger").click();
  await page.getByTestId("past-sessions-trigger").hover();
  await page
    .getByTestId("history-2b6d9e10-7711-4c2a-8b0a-9e4f2d1c5a33")
    .click();
  await expect(page.getByTestId("past-session-pane")).toBeVisible();
  await page.getByTestId("past-session-close").click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("Second session draft");

  await tabs.nth(0).click();
  await expect(input).toHaveValue("First session draft");

  // Natural Terminal exit swaps the live workbench for the dead-session pane.
  // The remounted Assistant still owns the same session-keyed draft.
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
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
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("First session draft");

  // Closing an exited session is the deletion boundary for its draft. If a
  // later server event reuses that Studio session id, no deleted text returns.
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByTestId("dead-session-close").click();
  await expect(page.getByTestId("session-context")).toHaveAttribute(
    "data-session-id",
    "sess-leasing-2",
  );
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "session.status",
      session: {
        id: "sess-boot",
        agentSessionId: null,
        boundWorkflowPath: "/Users/demo/acme-app/leasing",
        harness: "claude-code",
        cwd: "/Users/demo/acme-app",
        title: "acme-app",
        status: "running",
        ready: true,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
    }),
  );
  await page.getByTestId("session-tab-sess-boot").click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("");
  await page.getByTestId("session-tab-sess-leasing-2").click();
  await expect(input).toHaveValue("Second session draft");

  // An auth barrier replaces the whole store. A newly verified principal can
  // use Assistant, but never inherits either prior principal's unsent text.
  enabled = false;
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "auth.changed",
      authenticated: false,
      organizationName: null,
    }),
  );
  await expect(
    page.getByRole("group", { name: "Conversation view" }),
  ).toHaveCount(0);
  enabled = true;
  await page.evaluate(() =>
    (window as any).__HARNESS_TEST__.publish({
      type: "auth.changed",
      authenticated: true,
      organizationName: "Another organization",
    }),
  );
  await expect(
    page.getByRole("button", { name: "Assistant", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("");
});

test("waits for the associated history before enabling the composer", async ({
  page,
}) => {
  holdHistory = true;
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect.poll(() => historyReplies.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  holdHistory = false;
  for (const reply of historyReplies) reply();
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeEnabled();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("surfaces initial metadata failures and retries the same association", async ({
  page,
}) => {
  failMetadata = true;
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load or send");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  failMetadata = false;
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeEnabled();
  expect(conversations.size).toBe(1);
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("keeps a native run error visible when idle immediately follows it", async ({
  page,
}) => {
  await openAssistant(page);
  const c = conversations.get("ses_sess_boot")!;
  emit(c, "session.error", {
    sessionID: c.id,
    error: { name: "UnknownError", data: { message: "controlled failure" } },
  });
  emit(c, "session.status", { sessionID: c.id, status: { type: "idle" } });
  await expect(page.getByRole("alert")).toContainText(
    "Assistant could not finish",
  );
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeEnabled();
  expect(c.prompts).toEqual([]);
});

test("shows startup failure and reconnects without sending a prompt", async ({
  page,
}) => {
  failAttach = true;
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Assistant could not open",
  );
  failAttach = false;
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Assistant" }),
  ).toBeEnabled();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("renders a permanent startup repair action from the strict shared contract", async ({
  page,
}) => {
  attachError = {
    error: openCodeTransportFailure(
      "runtime_start_failed",
      "executable-not-found",
    ),
  };
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("OpenCode runtime is missing");
  await expect(alert.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  await alert.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("keeps confirmed missing native history honest and opens the existing session", async ({
  page,
}) => {
  attachError = {
    error: openCodeTransportFailure("native_history_missing"),
  };
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "saved Assistant conversation is unavailable",
  );
  await expect(alert.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  await alert.getByRole("button", { name: "Open Terminal" }).click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("passes a typed adapter read denial to account settings without trusting wire copy", async ({
  page,
}) => {
  metadataError = {
    error: openCodeTransportFailure("access_denied"),
  };
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "Assistant access is not available for this account",
  );
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await alert.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByTestId("settings-popover")).toBeVisible();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);

  // A server-controlled string that does not match the shared table is not a
  // typed error. The adapter falls back without rendering the diagnostic.
  metadataError = {
    error: {
      ...openCodeTransportFailure("access_denied"),
      message: "credential=must-not-render",
    },
  };
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-popover")).toBeHidden();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load or send");
  await expect(page.getByText("credential=must-not-render")).toHaveCount(0);
});

test("offers the existing sign-in flow only for authentication_required", async ({
  page,
}) => {
  attachError = {
    error: openCodeTransportFailure("authentication_required"),
  };
  await page.goto("/?seed=0");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Sign in to Studio to use Assistant");
  await alert.getByRole("button", { name: "Sign in" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__HARNESS_TEST__?.lastAuthStart ?? null,
      ),
    )
    .not.toBeNull();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("drops unscoped native errors and stops continuation on a scoped terminal error", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("One accepted request");
  await input.press("Enter");
  const c = conversations.get("ses_sess_boot")!;
  await expect.poll(() => c.prompts).toEqual(["One accepted request"]);

  // Neither an unscoped native session error nor a native-spoofed Studio event
  // may reach the pinned adapter as a terminal failure.
  emit(c, "session.error", {
    error: { name: "UnknownError", data: { message: "unscoped" } },
  });
  emit(c, "studio.error", {
    ...openCodeTransportFailure("authentication_required"),
    sessionID: "ses_spoofed",
  });
  await expect(page.getByRole("alert")).toHaveCount(0);

  emit(c, "studio.error", openCodeTransportFailure("runtime_exited"));
  await expect(page.getByRole("alert")).toContainText("Assistant stopped");
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();

  // Even if idle/missing-turn evidence follows, the terminal error suppresses
  // the bounded final-response request and never repeats the accepted prompt.
  endWithoutAnswer(c);
  for (const stream of c.streams) stream.end();
  await expect.poll(() => c.recoveries).toEqual([]);
  expect(c.prompts).toEqual(["One accepted request"]);
});

test("keeps an incomplete turn blocked when final-response returns a typed terminal error", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("One request with incomplete native history");
  await input.press("Enter");
  const c = conversations.get("ses_sess_boot")!;
  await expect
    .poll(() => c.prompts)
    .toEqual(["One request with incomplete native history"]);
  await expect(page.getByText("First chunk", { exact: true })).toBeVisible();

  finalResponseError = {
    error: openCodeTransportFailure("native_history_missing"),
  };
  endWithoutAnswer(c);

  await expect.poll(() => c.recoveries).toEqual(["msg_empty"]);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(
    "saved Assistant conversation is unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(alert.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
  expect(c.prompts).toEqual(["One request with incomplete native history"]);

  await alert.getByRole("button", { name: "Open Terminal" }).click();
  await expect(page.locator(".harness-terminal")).toBeVisible();
});

test("shows stream loss and reconnects without replaying an accepted prompt", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("A single request");
  await input.press("Enter");
  const c = conversations.get("ses_sess_boot")!;
  await expect.poll(() => c.prompts.length).toBe(1);
  await input.fill("An unsent follow-up");
  failEvents = true;
  for (const stream of c.streams) stream.end();
  await expect(page.getByRole("alert")).toContainText("Connection lost");
  finish(c.id, " recovered");
  failEvents = false;
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.locator(".studio-chat-assistant")).toContainText(
    "First chunk recovered",
  );
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("An unsent follow-up");
  expect(c.prompts).toEqual(["A single request"]);
});

test("surfaces a rejected prompt POST and reconnects without replaying it", async ({
  page,
}) => {
  await openAssistant(page);
  failPrompt = true;
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("A rejected request");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Could not load or send");
  await expect(input).toBeDisabled();
  failPrompt = false;
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(input).toBeEnabled();
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("retains the draft across stable and failed access polls but clears it at a disabled authority barrier", async ({
  page,
}) => {
  await page.clock.install();
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("An unsent draft");

  const beforeStablePoll = accessCalls;
  await page.clock.fastForward(16000);
  await expect.poll(() => accessCalls).toBeGreaterThan(beforeStablePoll);
  await expect(input).toHaveValue("An unsent draft");

  const before = accessCalls;
  failAccess = true;
  await page.clock.fastForward(16000);
  await expect.poll(() => accessCalls).toBeGreaterThan(before);
  await expect(input).toHaveValue("An unsent draft");
  expect(conversations.get("ses_sess_boot")!.streams.size).toBe(1);
  failAccess = false;
  enabled = false;
  accessAuthorityRevision = "authority-retired";
  await page.clock.fastForward(16000);
  await expect(
    page.getByRole("group", { name: "Conversation view" }),
  ).toHaveCount(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();

  // Repeated disabled observations retain the same barrier. Readmission uses
  // a new authority epoch, and neither can recover the retired draft.
  const beforeDisabledPoll = accessCalls;
  await page.clock.fastForward(16000);
  await expect.poll(() => accessCalls).toBeGreaterThan(beforeDisabledPoll);
  enabled = true;
  accessAuthorityRevision = "authority-readmitted";
  await page.clock.fastForward(16000);
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(input).toHaveValue("");
});

test("clears a draft on a direct enabled authority crossover without an auth event", async ({
  page,
}) => {
  await page.clock.install();
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("Principal A private draft");

  const before = accessCalls;
  accessAuthorityRevision = "authority-b";
  await page.clock.fastForward(16000);
  await expect.poll(() => accessCalls).toBeGreaterThan(before);

  // authRevision is deliberately unchanged: the access epoch alone must swap
  // the App-owned store before the enabled Principal B chat can mount.
  await expect(input).toHaveValue("");
  expect(conversations.get("ses_sess_boot")!.prompts).toEqual([]);
});

test("expires the cached UI capability after sixty seconds without a successful poll", async ({
  page,
}) => {
  await page.clock.install();
  await openAssistant(page);
  failAccess = true;
  await page.clock.fastForward(61000);
  await expect(
    page.getByRole("group", { name: "Conversation view" }),
  ).toHaveCount(0);
  await expect
    .poll(() => conversations.get("ses_sess_boot")!.streams.size)
    .toBe(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();
});

test("reveals foreground Terminal input and preserves Assistant for background actions", async ({
  page,
}) => {
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("Keep this unsent draft");
  await page.evaluate(() => {
    (window as any).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("canvas-describe-ai").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__HARNESS_TEST__?.lastMacroRun?.id),
    )
    .toBe("describe");
  const assistant = page.getByRole("button", {
    name: "Assistant",
    exact: true,
  });
  await expect(assistant).toHaveAttribute("aria-pressed", "true");
  expect(conversations.get("ses_sess_boot")!.streams.size).toBe(1);
  await page.getByTestId("canvas-chat-toggle").click();
  await page.getByTestId("canvas-freeform-input").fill("Explain this agent");
  await expect(assistant).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("canvas-freeform-ask").click();
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".harness-terminal")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__HARNESS_TEST__?.lastInjectInput?.req.text ?? "",
      ),
    )
    .toContain("Explain this agent");
  await expect
    .poll(() => conversations.get("ses_sess_boot")!.streams.size)
    .toBe(0);
  await assistant.click();
  await expect(input).toHaveValue("Keep this unsent draft");
  const tabs = page.getByRole("tablist", { name: "Sessions" }).getByRole("tab");
  await tabs.nth(1).click();
  await expect(input).toHaveValue("");
  await input.fill("A different tab's draft");
  await tabs.nth(0).click();
  await expect(assistant).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("Keep this unsent draft");
  await input.press("Enter");
  await expect
    .poll(() => conversations.get("ses_sess_boot")!.prompts)
    .toEqual(["Keep this unsent draft"]);
  finish("ses_sess_boot", " complete");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await assistant.click();
  await expect(input).toHaveValue("");
});

test("shows a rejected inspector command without leaving Assistant or losing its draft", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openAssistant(page);
  await page.evaluate(() => {
    (window as any).__HARNESS_TEST__.publish({
      type: "canvas.reload",
      harnessSessionId: "sess-boot",
    });
  });
  await expect(page.locator(".canvas-frame-wrap")).toHaveAttribute(
    "data-view",
    "board",
  );
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("Keep this draft after failure");
  await page.getByTestId("canvas-chat-toggle").click();
  await page.getByTestId("canvas-freeform-input").fill("Explain this agent");
  await page.evaluate(() => {
    (window as any).__MOCK_INJECT_FAIL_ONCE__ = true;
  });
  await page.getByTestId("canvas-freeform-ask").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Session is still initialising",
  );
  await expect(input).toHaveValue("Keep this draft after failure");
  await expect(
    page.getByRole("button", { name: "Assistant", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(conversations.get("ses_sess_boot")!.streams.size).toBe(1);
  expect(errors).toEqual([]);
});
