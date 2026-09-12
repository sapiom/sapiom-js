import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostedOpenCode } from "./opencode-host.js";
import { OpenCodeFinalResponse } from "./opencode-final-response.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";
import type { OpenCodeTurnMessage } from "../shared/opencode-turn.js";

let hosted: HostedOpenCode;
let permission: unknown[];
let state: string;
let agent: string;
let text: string;
let system: string | undefined;
let abort: AbortController;
const dispatch = vi.fn();
beforeEach(async () => {
  permission = [];
  state = "idle";
  agent = "build";
  text = "";
  system =
    openCodeCompletionPrompt().system +
    "\n\nStudioAssistantContext/v1\nSAVED_CONTEXT_REVISION";
  abort = new AbortController();
  dispatch.mockReset().mockResolvedValue(new Response("{}"));
  hosted = {
    stateRoot: await mkdtemp(join(tmpdir(), "opencode-final-")),
    signal: abort.signal,
    server: {
      fetch: dispatch,
      fetchJson: vi.fn(async (path: string) => {
        if (path === "/session/status") return { ses_test: { type: state } };
        if (path.endsWith("/message"))
          return [
            {
              info: {
                id: "msg_user",
                role: "user",
                agent: "build",
                system,
                time: {},
              },
              parts: [],
            },
            {
              info: {
                id: "msg_empty",
                role: "assistant",
                parentID: "msg_user",
                agent,
                finish: "stop",
                time: { completed: 1 },
              },
              parts: [{ type: "text", text }],
            },
          ];
        return { permission };
      }),
    },
  } as unknown as HostedOpenCode;
});
afterEach(async () => {
  await rm(hosted.stateRoot, { recursive: true, force: true });
});

it.each([
  ["ses_nested/path", "msg_empty"],
  ["ses_test", "msg_nested/path"],
  ["ses_test", "msg_nested\\path"],
  ["ses_test", "msg_%2foutside"],
  ["ses_test", "msg_"],
  ["ses_test", `msg_${"a".repeat(129)}`],
  ["ses_test", ["msg_empty"]],
])(
  "rejects invalid recovery IDs before storage or native requests: %j / %j",
  async (sessionId, messageId) => {
    await expect(
      new OpenCodeFinalResponse().recover(
        hosted,
        sessionId as string,
        messageId as string,
      ),
    ).rejects.toThrow("Invalid Assistant recovery identifiers");
    expect(await readdir(hosted.stateRoot)).toEqual([]);
    expect(hosted.server.fetchJson).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("coalesces recovery and never resends it after a host restart", async () => {
  const recovery = new OpenCodeFinalResponse();
  await Promise.all([
    recovery.recover(hosted, "ses_test", "msg_empty"),
    recovery.recover(hosted, "ses_test", "msg_empty"),
  ]);
  expect(dispatch).toHaveBeenCalledOnce();
  const [path, init] = dispatch.mock.calls[0]!;
  expect(path).toBe("/session/ses_test/message");
  expect(JSON.parse(init.body)).toMatchObject({
    agent: "sapiom-turn-recovery",
    system: expect.stringContaining("StudioAssistantResult/v2:"),
  });
  expect(JSON.parse(init.body)).not.toHaveProperty("tools");
  expect(JSON.parse(init.body).system).toContain("SAVED_CONTEXT_REVISION");
  await expect(
    new OpenCodeFinalResponse().recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();
});

it("preserves old history but refuses to recover without its original context", async () => {
  system = undefined;
  await expect(
    new OpenCodeFinalResponse().recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow("context");
  expect(dispatch).not.toHaveBeenCalled();
  expect(await readdir(hosted.stateRoot)).toEqual([]);
});

it("recovers the accepted context across native compaction control messages", async () => {
  const original = await hosted.server.fetchJson<OpenCodeTurnMessage[]>(
    "/session/ses_test/message",
  );
  const messages: OpenCodeTurnMessage[] = [
    original[0]!,
    {
      info: { id: "msg_compact", role: "user", agent: "build", time: {} },
      parts: [{ type: "compaction" }],
    },
    {
      info: {
        id: "msg_summary",
        role: "assistant",
        parentID: "msg_compact",
        summary: true,
        time: { completed: 1 },
      },
      parts: [{ type: "text", text: "Recorded task context" }],
    },
    {
      info: { id: "msg_continue", role: "user", agent: "build", time: {} },
      parts: [
        {
          type: "text",
          text: "Continue",
          synthetic: true,
          metadata: { compaction_continue: true },
        },
      ],
    },
    {
      ...original[1]!,
      info: { ...original[1]!.info!, parentID: "msg_continue" },
    },
  ];
  vi.mocked(hosted.server.fetchJson).mockImplementation(async (path) => {
    if (path.endsWith("/message")) return messages;
    if (path === "/session/status") return { ses_test: { type: "idle" } };
    return { permission: [] };
  });
  await new OpenCodeFinalResponse().recover(hosted, "ses_test", "msg_empty");
  expect(JSON.parse(dispatch.mock.calls[0]![1].body).system).toContain(
    "SAVED_CONTEXT_REVISION",
  );
});

it("holds admission while resolving context and releases it without dispatch on a missing source", async () => {
  const recovery = new OpenCodeFinalResponse();
  let reject!: (error: Error) => void;
  const sending = recovery.send(
    hosted,
    "ses_test",
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await expect(recovery.send(hosted, "ses_test", {})).rejects.toThrow(
    "admitted",
  );
  await expect(
    recovery.recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow("reconciled");
  expect(dispatch).not.toHaveBeenCalled();
  reject(new Error("Required context missing"));
  await expect(sending).rejects.toThrow("Required context missing");
  expect(recovery.isRunning(hosted)).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});

it("never dispatches for busy, answered, stale, or already recovered turns", async () => {
  for (const scenario of [
    "busy",
    "answered",
    "stale",
    "recovered",
    "continued",
    "plan",
  ]) {
    state = scenario === "busy" ? "busy" : "idle";
    text =
      scenario === "answered"
        ? `<!-- studio-result:${system!.split("\n")[0]!.split(":")[1]}:finished -->\nFinal answer`
        : "";
    agent =
      scenario === "recovered"
        ? "sapiom-final-response"
        : scenario === "continued"
          ? "sapiom-turn-recovery"
          : scenario === "plan"
            ? "plan"
            : "build";
    await expect(
      new OpenCodeFinalResponse().recover(
        hosted,
        "ses_test",
        scenario === "stale" ? "msg_old" : "msg_empty",
      ),
    ).rejects.toThrow();
  }
  expect(dispatch).not.toHaveBeenCalled();
});

it("fails closed for session overrides or failed status reads", async () => {
  permission = [{ permission: "*", pattern: "*", action: "allow" }];
  await expect(
    new OpenCodeFinalResponse().recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  permission = [];
  vi.mocked(hosted.server.fetchJson).mockRejectedValue(new Error("offline"));
  await expect(
    new OpenCodeFinalResponse().recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
});

it("does not replay an uncertain failed dispatch and rejects new prompts during recovery", async () => {
  let reject!: (error: Error) => void;
  dispatch.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const recovery = new OpenCodeFinalResponse();
  const pending = recovery.recover(hosted, "ses_test", "msg_empty");
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect(recovery.isRunning(hosted)).toBe(true);
  reject(new Error("connection lost"));
  await expect(pending).rejects.toThrow();
  expect(hosted.server.fetchJson).toHaveBeenCalledWith(
    "/session/ses_test/abort",
    expect.objectContaining({ method: "POST" }),
  );
  expect(recovery.isRunning(hosted)).toBe(false);
  await expect(
    recovery.recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();
});

it("fences recovery until an already submitted user message is persisted", async () => {
  let acknowledge!: (response: Response) => void;
  dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const recovery = new OpenCodeFinalResponse();
  const sending = recovery.send(hosted, "ses_test", {
    method: "POST",
    body: "{}",
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  await expect(
    recovery.recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  acknowledge(new Response(null, { status: 204 }));
  await expect(
    recovery.recover(hosted, "ses_test", "msg_empty"),
  ).rejects.toThrow();
  vi.mocked(hosted.server.fetchJson).mockResolvedValue([
    { info: { id: "msg_new", role: "user", time: {} }, parts: [] },
  ]);
  expect((await sending).status).toBe(204);
  expect(recovery.isRunning(hosted)).toBe(false);
  expect(dispatch).toHaveBeenCalledOnce();
});
