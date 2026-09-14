import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenCodeFinalResponse } from "./opencode-final-response.js";
import {
  OpenCodeTransportError,
  type HostedOpenCode,
} from "./opencode-host.js";
import { openCodeCompletionPrompt } from "../shared/opencode-completion.js";
import type { OpenCodeTurnMessage } from "../shared/opencode-turn.js";
import { openCodeTransportFailure } from "../shared/opencode-errors.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const actualFs = await vi.importActual<typeof fs>("node:fs/promises");

let hosted: HostedOpenCode;
let messages: OpenCodeTurnMessage[];
let state: string;
let permission: unknown[];
let abort: AbortController;
let original: string;
const dispatch = vi.fn();
const user = (id: string, system: string): OpenCodeTurnMessage => ({
  info: { id, role: "user", agent: "build", system, time: {} },
  parts: [],
});
const prepared = (system = "accepted attempt") => ({
  init: { method: "POST", body: JSON.stringify({ system, parts: [] }) },
  expectedSystem: system,
});
beforeEach(async () => {
  vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
  original = openCodeCompletionPrompt().system;
  messages = [
    user("msg_original", original),
    {
      info: {
        id: "msg_missing",
        role: "assistant",
        parentID: "msg_original",
        agent: "build",
        finish: "stop",
        time: { completed: 1 },
      },
      parts: [],
    },
  ];
  state = "idle";
  permission = [];
  abort = new AbortController();
  dispatch
    .mockReset()
    .mockImplementation(async () => new Response(null, { status: 204 }));
  hosted = {
    stateRoot: await mkdtemp(join(tmpdir(), "accepted-admission-")),
    signal: abort.signal,
    model: { providerID: "sapiom", modelID: "gpt-luna" },
    server: {
      fetch: dispatch,
      fetchJson: vi.fn(async (path: string) => {
        if (path.endsWith("/message")) return structuredClone(messages);
        if (path === "/session/status") return { ses_test: { type: state } };
        return { permission };
      }),
    },
  } as unknown as HostedOpenCode;
});
afterEach(async () => {
  abort.abort();
  await rm(hosted.stateRoot, { recursive: true, force: true });
});

it("waits for the exact accepted system on a new ordinary user before releasing admission", async () => {
  const delivery = new OpenCodeFinalResponse();
  const sending = delivery.send(hosted, "ses_test", async () => prepared());
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  const unrelated = user("msg_unrelated", "other accepted attempt");
  const synthetic = {
    ...user("msg_synthetic", "accepted attempt"),
    parts: [{ type: "text", synthetic: true }],
  };
  const compaction = {
    ...user("msg_compaction", "accepted attempt"),
    parts: [{ type: "compaction" }],
  };
  // Even changing an old message to the expected system is not a new acknowledgement.
  messages[0]!.info!.system = "accepted attempt";
  messages.push(unrelated, synthetic, compaction);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(delivery.isRunning(hosted)).toBe(true);
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toThrow("reconciled");
  messages.push(user("msg_accepted", "accepted attempt"));
  expect((await sending).status).toBe(204);
  expect(delivery.isRunning(hosted)).toBe(false);
});

it("reconciles lost-dispatch uncertainty before resolving another context", async () => {
  const delivery = new OpenCodeFinalResponse();
  dispatch.mockRejectedValueOnce(new Error("reply lost"));
  await expect(
    delivery.send(hosted, "ses_test", async () => prepared()),
  ).rejects.toThrow("reply lost");
  const resolve = vi.fn(async () => prepared("next attempt"));
  await expect(delivery.send(hosted, "ses_test", resolve)).rejects.toThrow(
    "reconciled",
  );
  expect(resolve).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledOnce();
  messages.push(user("msg_accepted", "accepted attempt"));
  state = "busy";
  await expect(delivery.send(hosted, "ses_test", resolve)).rejects.toThrow(
    "still running",
  );
  expect(resolve).not.toHaveBeenCalled();
  state = "idle";
  dispatch.mockImplementation(async () => {
    messages.push(user("msg_next", "next attempt"));
    return new Response(null, { status: 204 });
  });
  await delivery.send(hosted, "ses_test", resolve);
  expect(resolve).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it.each([400, 401, 404])(
  "allows recovery after native pre-dispatch rejection %s",
  async (status) => {
    const delivery = new OpenCodeFinalResponse({
      recoverPrompt: async () => ({ system: "retained recovery" }),
    });
    dispatch.mockResolvedValueOnce(new Response(null, { status }));
    expect(
      (await delivery.send(hosted, "ses_test", async () => prepared())).status,
    ).toBe(status);
    await delivery.recover(hosted, "ses_test", "msg_missing");
    expect(dispatch).toHaveBeenCalledTimes(2);
  },
);

it("retains exact acknowledgement uncertainty after an unclassified HTTP failure", async () => {
  const delivery = new OpenCodeFinalResponse();
  dispatch.mockResolvedValueOnce(new Response(null, { status: 500 }));
  expect(
    (await delivery.send(hosted, "ses_test", async () => prepared())).status,
  ).toBe(500);
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toThrow("reconciled");
  const resolve = vi.fn(async () => prepared("next attempt"));
  await expect(delivery.send(hosted, "ses_test", resolve)).rejects.toThrow(
    "reconciled",
  );
  expect(resolve).not.toHaveBeenCalled();
  messages.push(user("msg_accepted", "accepted attempt"));
  dispatch.mockImplementation(async () => {
    messages.push(user("msg_next", "next attempt"));
    return new Response(null, { status: 204 });
  });
  await delivery.send(hosted, "ses_test", resolve);
  expect(resolve).toHaveBeenCalledOnce();
});

it("does not prepare context after a native history failure", async () => {
  const resolve = vi.fn(async () => prepared());
  const failure = new OpenCodeTransportError(
    openCodeTransportFailure("native_history_missing"),
  );
  vi.mocked(hosted.server.fetchJson).mockRejectedValue(failure);
  await expect(
    new OpenCodeFinalResponse().send(hosted, "ses_test", resolve),
  ).rejects.toBe(failure);
  expect(resolve).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

it("passes admission cancellation into preparation and checks it again before POST", async () => {
  const caller = new AbortController();
  let finish!: () => void;
  let received!: AbortSignal;
  const delivery = new OpenCodeFinalResponse();
  const sending = delivery.send(
    hosted,
    "ses_test",
    async (signal) => {
      received = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return prepared();
    },
    caller.signal,
  );
  const rejection = expect(sending).rejects.toThrow();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  caller.abort();
  expect(received.aborted).toBe(true);
  finish();
  await rejection;
  expect(dispatch).not.toHaveBeenCalled();
  expect(delivery.isRunning(hosted)).toBe(false);
});

it("keeps mismatched acknowledgement uncertain after cancellation without replay", async () => {
  const caller = new AbortController();
  const delivery = new OpenCodeFinalResponse();
  const sending = delivery.send(
    hosted,
    "ses_test",
    async () => prepared(),
    caller.signal,
  );
  const rejection = expect(sending).rejects.toThrow();
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  messages.push(user("msg_foreign", "foreign context"));
  caller.abort();
  await rejection;
  expect(delivery.isRunning(hosted)).toBe(false);
  const resolve = vi.fn(async () => prepared());
  await expect(delivery.send(hosted, "ses_test", resolve)).rejects.toThrow(
    "reconciled",
  );
  expect(resolve).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledOnce();
});

it.each(["send", "recover"] as const)(
  "rechecks current authority before %s dispatch",
  async (kind) => {
    const failure = new OpenCodeTransportError(
      openCodeTransportFailure("access_expired"),
    );
    const assertCurrent = vi.fn(async () => {
      throw failure;
    });
    const recoverPrompt = vi.fn(async () => ({ system: "retained recovery" }));
    const delivery = new OpenCodeFinalResponse({
      assertCurrent,
      recoverPrompt,
    });
    await expect(
      kind === "send"
        ? delivery.send(hosted, "ses_test", async () => prepared())
        : delivery.recover(hosted, "ses_test", "msg_missing"),
    ).rejects.toBe(failure);
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readdir(hosted.stateRoot)).toEqual([]);
  },
);

it("prepares recovery from the original saved system before consuming its dispatch fence", async () => {
  const failure = new Error("retained source unavailable");
  const recoverPrompt = vi
    .fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ system: "retained recovery" });
  const assertCurrent = vi.fn(async () => {});
  const delivery = new OpenCodeFinalResponse({ recoverPrompt, assertCurrent });
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toBe(failure);
  expect(await readdir(hosted.stateRoot)).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
  await delivery.recover(hosted, "ses_test", "msg_missing");
  expect(recoverPrompt).toHaveBeenLastCalledWith(
    hosted,
    "ses_test",
    original,
    expect.any(AbortSignal),
  );
  expect(assertCurrent).toHaveBeenCalledOnce();
  expect(JSON.parse(dispatch.mock.calls[0]![1].body)).toMatchObject({
    system: "retained recovery",
    model: hosted.model,
    agent: "sapiom-turn-recovery",
  });
  expect(await readdir(hosted.stateRoot)).toEqual([
    "final-response-ses_test-msg_missing.json",
  ]);
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledOnce();
});

it("does not consume a recovery fence when preparation finishes after revocation", async () => {
  const delivery = new OpenCodeFinalResponse({
    recoverPrompt: async () => {
      abort.abort();
      return { system: "retained recovery" };
    },
  });
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await readdir(hosted.stateRoot)).toEqual([]);
});

it("takes the legacy acknowledgement baseline after asynchronous preparation", async () => {
  const delivery = new OpenCodeFinalResponse();
  const sending = delivery.send(hosted, "ses_test", async () => {
    messages.push(user("msg_during_preparation", "unrelated"));
    return prepared().init;
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stillAdmitting = delivery.isRunning(hosted);
  messages.push(user("msg_after_dispatch", "accepted attempt"));
  await sending;
  expect(stillAdmitting).toBe(true);
});

it.each(["busy", "new-user", "answered", "permissions", "changed-system"])(
  "rejects recovery when %s changes during preparation",
  async (change) => {
    const delivery = new OpenCodeFinalResponse({
      recoverPrompt: async () => {
        if (change === "busy") state = "busy";
        if (change === "new-user") messages.push(user("msg_new", "new work"));
        if (change === "answered")
          messages[1]!.parts = [
            {
              type: "text",
              text: `<!-- studio-result:${original.split("\n")[0]!.split(":")[1]}:finished -->\nAlready complete`,
            },
          ];
        if (change === "permissions")
          permission.push({ permission: "*", action: "allow" });
        if (change === "changed-system")
          messages[0]!.info!.system = openCodeCompletionPrompt().system;
        return { system: "retained recovery" };
      },
    });
    await expect(
      delivery.recover(hosted, "ses_test", "msg_missing"),
    ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readdir(hosted.stateRoot)).toEqual([]);
  },
);

it("removes its own fence when cancelled during fence creation before attempting POST", async () => {
  vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
    await actualFs.writeFile(...args);
    abort.abort();
  });
  const delivery = new OpenCodeFinalResponse({
    recoverPrompt: async () => ({ system: "retained recovery" }),
  });
  await expect(
    delivery.recover(hosted, "ses_test", "msg_missing"),
  ).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await readdir(hosted.stateRoot)).toEqual([]);
  hosted = { ...hosted, signal: new AbortController().signal };
  await delivery.recover(hosted, "ses_test", "msg_missing");
  expect(dispatch).toHaveBeenCalledOnce();
});
