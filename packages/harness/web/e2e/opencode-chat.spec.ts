import { expect, test, type Page } from "@playwright/test";
import express, { type Response } from "express";
import type { Server } from "node:http";

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
let failAttach: boolean;
let failMetadata: boolean;
let holdHistory: boolean;
let failEvents: boolean;
let failPrompt: boolean;
let failAccess: boolean;
let accessCalls: number;
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
  failAttach = false;
  failMetadata = false;
  holdHistory = false;
  failEvents = false;
  failPrompt = false;
  failAccess = false;
  accessCalls = 0;
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
      res.status(failAttach ? 502 : 200).json({ conversationId: id });
      return;
    }
    if (path === "experimental/session") {
      res.json([session]);
      return;
    }
    if (path === `session/${id}`) {
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
    return route.fulfill({ status: failAccess ? 503 : 200, json: { enabled } });
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

test("retains the draft during a failed access poll but applies explicit revocation", async ({
  page,
}) => {
  await page.clock.install();
  await openAssistant(page);
  const input = page.getByRole("textbox", { name: "Message Assistant" });
  await input.fill("An unsent draft");
  const before = accessCalls;
  failAccess = true;
  await page.clock.fastForward(16000);
  await expect.poll(() => accessCalls).toBeGreaterThan(before);
  await expect(input).toHaveValue("An unsent draft");
  expect(conversations.get("ses_sess_boot")!.streams.size).toBe(1);
  failAccess = false;
  enabled = false;
  await page.clock.fastForward(16000);
  await expect(
    page.getByRole("group", { name: "Conversation view" }),
  ).toHaveCount(0);
  await expect(page.locator(".harness-terminal")).toBeVisible();
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
