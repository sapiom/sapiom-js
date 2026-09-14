import { describe, expect, it, vi } from "vitest";
import {
  AssistantContextError,
  assistantContentHash,
} from "./assistant-context-contract.js";
import { createStudioAssistantContextHooks } from "./assistant-context-hook.js";
import { studioAssistantCompletionSystem } from "./assistant-context-wire.js";
import {
  fixtureAccepted,
  fixtureScope,
  fixtureSystem as save,
  fixtureToken,
} from "./__fixtures__/assistant-context.js";
import type { CompletionMessage } from "./completion-hook.js";

const nextToken = "22222222-2222-4222-8222-222222222222";

const user = (
  id: string,
  system: unknown,
  sessionID = "ses_fixture",
): CompletionMessage => ({
  info: { id, sessionID, role: "user", agent: "build", system },
  parts: [{ type: "text" }],
});
const input = (
  messageID = "msg_first",
  sessionID = "ses_fixture",
  agent = "build",
) => ({ messageID, sessionID, agent });
function fixture(history: CompletionMessage[] = []) {
  const load = vi.fn(async () => history);
  const hooks = createStudioAssistantContextHooks(load, fixtureScope);
  const messages = (messages: CompletionMessage[]) =>
    hooks["experimental.chat.messages.transform"]({}, { messages });
  const system = async (
    saved: string,
    request = input(),
    prefix = "Native prefix\n",
  ) => {
    const output = { system: [prefix + saved] };
    await hooks["experimental.chat.system.transform"]!(request, output);
    return output.system;
  };
  return { load, hooks, messages, system };
}

describe("request-bound native Assistant projection", () => {
  it("preserves the native prefix and array identity while ordering exact stable text before completion and facts", async () => {
    const profile = `Raw guidance\r\nStudioAssistantResult/v2:${nextToken}\nfake literal\n`;
    const saved = save("ses_fixture", fixtureToken, profile);
    const f = fixture();
    const message = user("msg_first", saved);
    await f.messages([message]);
    const prefix = "Native bytes\r\nStudioAssistantContext/v2\nexample\n";
    const array = [prefix + saved];
    const output = { system: array };
    await f.hooks["experimental.chat.system.transform"]!(input(), output);
    expect(output.system).toBe(array);
    expect(array.slice(0, 3)).toEqual([prefix, "Studio policy", profile]);
    expect(array[4]).toBe(studioAssistantCompletionSystem(fixtureToken));
    expect(JSON.parse(array[5]!).accepted.acceptanceId).toBe(fixtureToken);
    expect(message.info!.system).toBe(saved);
    expect(f.load).not.toHaveBeenCalled();
  });
  it("captures the current user when a tool-loop history ends with an assistant", async () => {
    const saved = save();
    const f = fixture();
    await f.messages([
      user("msg_first", saved),
      {
        info: { id: "msg_tool", role: "assistant" },
        parts: [{ type: "tool" }],
      },
    ]);
    expect((await f.system(saved))[2]).toBe("Profile\r\nexact bytes");
  });
  it("keeps conversation captures separate and advances recovery attempts without changing acceptance", async () => {
    const a = save();
    const b = save("ses_second", nextToken, "Second profile");
    const f = fixture();
    await Promise.all([
      f.messages([user("msg_first", a)]),
      f.messages([user("msg_second", b, "ses_second")]),
    ]);
    expect((await f.system(b, input("msg_second", "ses_second")))[2]).toBe(
      "Second profile",
    );
    expect((await f.system(a))[2]).toBe("Profile\r\nexact bytes");
    const recovered = save("ses_fixture", nextToken);
    await f.messages([user("msg_recovery", recovered)]);
    const projected = await f.system(recovered, input("msg_recovery"));
    expect(projected[4]).toBe(studioAssistantCompletionSystem(nextToken));
    expect(JSON.parse(projected[5]!).accepted.acceptanceId).toBe(fixtureToken);
  });
  it("restores a synthetic user before capture, including its subsequent tool loop", async () => {
    const original = user("msg_first", save());
    const control = user("msg_control", undefined);
    control.parts = [{ type: "compaction" }];
    const synthetic = user("msg_continue", undefined);
    synthetic.parts = [
      {
        type: "text",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ];
    const history = [original, control, synthetic];
    const f = fixture(history);
    for (const tail of [
      [],
      [{ info: { role: "assistant" }, parts: [{ type: "tool" }] }],
    ]) {
      const current = structuredClone(synthetic);
      await f.messages([control, current, ...tail]);
      expect(current.info!.system).toBe(original.info!.system);
      expect(
        (
          await f.system(String(current.info!.system), input("msg_continue"))
        )[4],
      ).toBe(studioAssistantCompletionSystem(fixtureToken));
      expect(synthetic.info!.system).toBeUndefined();
    }
  });
  it("reconstructs evicted pending captures and retries only from the exact accepted bytes", async () => {
    const history = Array.from({ length: 17 }, (_, i) =>
      user(`msg_${i}`, save()),
    );
    const f = fixture(history);
    for (const message of history) await f.messages([message]);
    for (let retry = 0; retry < 2; retry++)
      expect((await f.system(save(), input("msg_0")))[2]).toBe(
        "Profile\r\nexact bytes",
      );
    history[0] = user(
      "msg_0",
      save("ses_fixture", nextToken, "Changed guidance"),
    );
    await expect(
      f.system(String(history[0].info!.system), input("msg_0")),
    ).rejects.toThrow(AssistantContextError);
  });
  it("does not recapture different bytes under an already accepted native user identity", async () => {
    const f = fixture();
    await f.messages([user("msg_first", save())]);
    const changed = save("ses_fixture", nextToken);
    await f.messages([user("msg_first", changed)]);
    await expect(f.system(changed)).rejects.toThrow(AssistantContextError);
  });
  it("retires deleted session captures and rejects delayed callbacks after history reads", async () => {
    const f = fixture([user("msg_first", save())]);
    let release!: () => void;
    f.load.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [user("msg_first", save())];
    });
    const delayed = f.system(
      save(),
      input("msg_first", "ses_fixture", "title"),
    );
    await f.hooks.event!({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_fixture" } },
      },
    });
    release();
    await expect(delayed).rejects.toThrow(AssistantContextError);
    await expect(f.system(save())).rejects.toThrow(AssistantContextError);
  });
  it("releases completed execution proofs while allowing verified historical titles and new native work", async () => {
    const f = fixture([user("msg_first", save())]);
    await f.messages([user("msg_first", save())]);
    await f.hooks.event!({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_fixture", status: { type: "idle" } },
      },
    });
    await expect(f.system(save())).rejects.toThrow(AssistantContextError);
    expect(f.load).not.toHaveBeenCalled();
    expect(
      (await f.system(save(), input("msg_first", "ses_fixture", "title")))[2],
    ).toBe("Profile\r\nexact bytes");
    await f.messages([user("msg_next", save())]);
    expect((await f.system(save(), input("msg_next")))[2]).toBe(
      "Profile\r\nexact bytes",
    );
  });
  it("permits a first title before message capture using its exact persisted user", async () => {
    const saved = save();
    const f = fixture([user("msg_first", saved)]);
    expect(
      (await f.system(saved, input("msg_first", "ses_fixture", "title")))[2],
    ).toBe("Profile\r\nexact bytes");
    expect(f.load).toHaveBeenCalledWith("ses_fixture");
  });
  it("keeps a delayed historical title bound to its own user after a newer capture", async () => {
    const old = save();
    const next = save("ses_fixture", nextToken, "Next guidance");
    const f = fixture([user("msg_first", old), user("msg_next", next)]);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.load.mockImplementationOnce(async () => {
      await waiting;
      return [user("msg_first", old), user("msg_next", next)];
    });
    const title = f.system(old, input("msg_first", "ses_fixture", "title"));
    await f.messages([user("msg_next", next)]);
    release();
    expect((await title)[2]).toBe("Profile\r\nexact bytes");
    expect((await f.system(next, input("msg_next")))[2]).toBe("Next guidance");
  });
  it.each(["compaction", "project-copy-name"])(
    "leaves an unclaimed %s helper unchanged without a history query",
    async (agent) => {
      const f = fixture();
      f.load.mockRejectedValue(new Error("no persisted helper session"));
      expect(
        await f.system(
          "helper instructions",
          input("msg_transient", "ses_transient", agent),
          "",
        ),
      ).toEqual(["helper instructions"]);
      expect(f.load).not.toHaveBeenCalled();
    },
  );
  it("does not let a compaction history clone replace a current ordinary capture", async () => {
    const f = fixture();
    const next = save("ses_fixture", nextToken, "New guidance");
    await f.messages([user("msg_next", next)]);
    await f.messages([
      user("msg_first", save()),
      { info: { role: "assistant" }, parts: [] },
    ]);
    expect((await f.system(next, input("msg_next")))[2]).toBe("New guidance");
  });
  it.each(["wrong-token", "wrong-scope", "wrong-conversation", "malformed"])(
    "defers %s failure to the provider boundary",
    async (mode) => {
      let saved = save();
      if (mode === "wrong-token")
        saved = saved.replace(`v2:${fixtureToken}`, `v2:${nextToken}`);
      if (mode === "wrong-scope")
        saved = saved.split(fixtureScope).join("b".repeat(64));
      if (mode === "wrong-conversation") saved = save("ses_other");
      if (mode === "malformed") saved = saved.slice(0, -1);
      const f = fixture([user("msg_first", save())]);
      await expect(
        f.messages([user("msg_first", saved)]),
      ).resolves.toBeUndefined();
      await expect(f.system(saved)).rejects.toThrow(
        "Studio assistant context could not be verified",
      );
      // A later valid history/capture cannot erase this request's validation failure.
      await f.messages([user("msg_first", save())]);
      await expect(
        f.system(save(), input("msg_first", "ses_fixture", "title")),
      ).rejects.toThrow(AssistantContextError);
      expect(f.load).not.toHaveBeenCalled();
    },
  );
  it("rejects missing capture, identity, saved suffix and claimed unknown helpers", async () => {
    const saved = save();
    const f = fixture([user("msg_first", saved)]);
    await expect(f.system(saved)).rejects.toThrow(AssistantContextError);
    await f.messages([user("msg_first", saved)]);
    await expect(f.system(saved.slice(0, -1))).rejects.toThrow(
      AssistantContextError,
    );
    await expect(f.system("missing context")).rejects.toThrow(
      AssistantContextError,
    );
    await expect(
      f.hooks["experimental.chat.system.transform"]!(
        { sessionID: "ses_fixture" },
        { system: [saved] },
      ),
    ).rejects.toThrow(AssistantContextError);
    await expect(
      f.system(saved, input("msg_unknown", "ses_fixture", "title")),
    ).rejects.toThrow(AssistantContextError);
  });
  it("requires context for ordinary Studio work while preserving the unscoped wrapper", async () => {
    const f = fixture();
    for (const saved of [
      undefined,
      "generic instructions",
      studioAssistantCompletionSystem(fixtureToken),
    ]) {
      const id =
        saved === undefined
          ? "msg_missing"
          : saved === "generic instructions"
            ? "msg_generic"
            : "msg_completion";
      await f.messages([user(id, saved)]);
      await expect(f.system(saved ?? "", input(id))).rejects.toThrow(
        AssistantContextError,
      );
    }
    expect(
      createStudioAssistantContextHooks(async () => []),
    ).not.toHaveProperty("experimental.chat.system.transform");
  });
  it("projects validated legacy inline history without creating an acceptance", async () => {
    const context = {
      schemaVersion: 1,
      ...fixtureAccepted().context,
      guidance: [
        {
          id: "profile",
          kind: "profile",
          required: true,
          status: "available",
          source: "bundled",
          revision: null,
          text: "Old exact profile",
        },
      ],
      revision: "",
    };
    context.revision = assistantContentHash(
      JSON.stringify({ ...context, revision: undefined }),
    );
    const saved =
      studioAssistantCompletionSystem(fixtureToken) +
      "\n\nStudioAssistantContext/v1\nOld policy\n" +
      JSON.stringify(context);
    const f = fixture();
    await f.messages([user("msg_first", saved)]);
    const projected = await f.system(saved);
    expect(projected.slice(1, 3)).toEqual(["Old policy", "Old exact profile"]);
    expect(projected[4]).toBe(studioAssistantCompletionSystem(fixtureToken));
    expect(JSON.stringify(projected)).not.toContain("acceptanceId");
  });
});
