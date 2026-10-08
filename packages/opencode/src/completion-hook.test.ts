import { describe, expect, it } from "vitest";
import { createStudioCompletionHooks } from "./completion-hook.js";

const tokenA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tokenB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const contract = (token: string) =>
  `StudioAssistantResult/v2:${token}\nCompletion instructions for ${token}`;
const user = (
  id: string,
  options: {
    sessionID?: string;
    agent?: string;
    system?: unknown;
    continuation?: boolean;
    text?: string;
  } = {},
) => ({
  info: {
    id,
    role: "user",
    sessionID: options.sessionID ?? "ses_current",
    agent: options.agent ?? "build",
    ...(options.system !== undefined ? { system: options.system } : {}),
  },
  parts: [
    {
      type: "text",
      text: options.text ?? "request",
      ...(options.continuation
        ? {
            synthetic: true,
            metadata: { compaction_continue: true },
          }
        : {}),
    },
  ],
});

const compaction = (id: string) => ({
  info: {
    id,
    role: "user",
    sessionID: "ses_current",
    agent: "build",
  },
  parts: [{ type: "compaction" }],
});

type FixtureMessage = ReturnType<typeof user> | ReturnType<typeof compaction>;

async function transform(
  messages: FixtureMessage[],
  history: FixtureMessage[] = messages,
) {
  const hooks = createStudioCompletionHooks(async () => history);
  await hooks["experimental.chat.messages.transform"]({}, { messages });
}

describe("Studio completion transform", () => {
  it("restores the entire nearest same-session completion contract", async () => {
    const continuation = user("continue", { continuation: true });
    const messages = [
      user("old", { system: contract(tokenA) }),
      user("current", { system: contract(tokenB) }),
      compaction("compaction"),
      continuation,
    ];

    await transform(messages);

    expect(continuation.info.system).toBe(contract(tokenB));
  });

  it("loads authoritative history when native filtered messages omit the boundary", async () => {
    const continuation = user("continue", { continuation: true });
    const control = compaction("compaction");
    const source = user("source", { system: contract(tokenA) });

    await transform([control, continuation], [source, control, continuation]);

    expect(continuation.info.system).toBe(contract(tokenA));
  });

  it("preserves an existing system and ordinary or replayed users", async () => {
    const existing = user("continue", {
      continuation: true,
      system: "another-authoritative-system",
    });
    const ordinary = user("ordinary");
    const replay = user("replay", { system: contract(tokenB) });

    await transform([user("source", { system: contract(tokenA) }), existing]);
    await transform([user("source", { system: contract(tokenA) }), ordinary]);
    await transform([user("source", { system: contract(tokenA) }), replay]);

    expect(existing.info.system).toBe("another-authoritative-system");
    expect(ordinary.info.system).toBeUndefined();
    expect(replay.info.system).toBe(contract(tokenB));
  });

  it("does not borrow a contract across sessions or agents", async () => {
    const otherSession = user("continue-session", {
      sessionID: "ses_other",
      continuation: true,
    });
    const otherAgent = user("continue-agent", {
      agent: "sapiom-turn-recovery",
      continuation: true,
    });

    await transform([
      user("source", { system: contract(tokenA) }),
      otherSession,
    ]);
    await transform([user("source", { system: contract(tokenA) }), otherAgent]);

    expect(otherSession.info.system).toBeUndefined();
    expect(otherAgent.info.system).toBeUndefined();
  });

  it("restores the recovery agent's own contract during compaction", async () => {
    const recovery = user("recovery", {
      agent: "sapiom-turn-recovery",
      system: contract(tokenB),
    });
    const continuation = user("continue", {
      agent: "sapiom-turn-recovery",
      continuation: true,
    });

    await transform([
      user("ordinary", { system: contract(tokenA) }),
      recovery,
      continuation,
    ]);

    expect(continuation.info.system).toBe(contract(tokenB));
  });

  it.each([
    user("newer-missing"),
    user("newer-unknown", { system: "unknown contract" }),
    user("newer-agent", {
      agent: "sapiom-turn-recovery",
      system: contract(tokenB),
    }),
  ])("does not cross a newer ordinary user boundary", async (boundary) => {
    const continuation = user("continue", { continuation: true });

    await transform([
      user("older", { system: contract(tokenA) }),
      boundary,
      compaction("compaction"),
      continuation,
    ]);

    expect(continuation.info.system).toBeUndefined();
  });

  it("skips only recognized native compaction-control users", async () => {
    const earlierContinuation = user("earlier-continuation", {
      continuation: true,
      system: contract(tokenA),
    });
    const target = user("target", { continuation: true });

    await transform([
      user("source", { system: contract(tokenA) }),
      compaction("first-compaction"),
      earlierContinuation,
      compaction("second-compaction"),
      target,
    ]);

    expect(target.info.system).toBe(contract(tokenA));
  });

  it.each([
    `StudioAssistantResult/v1:${tokenA}\nold contract`,
    `StudioAssistantResult/v2:not-a-uuid\ninvalid contract`,
    "unrelated system",
  ])("rejects an unsupported system source: %s", async (system) => {
    const continuation = user("continue", {
      continuation: true,
      text: `arbitrary text StudioAssistantResult/v2:${tokenA}`,
    });

    await transform([user("source", { system }), continuation]);

    expect(continuation.info.system).toBeUndefined();
  });

  it("requires the exact native synthetic continuation marker", async () => {
    const falseMetadata = user("false-metadata", { continuation: true });
    falseMetadata.parts[0]!.metadata!.compaction_continue = false;
    const nonSynthetic = user("non-synthetic", { continuation: true });
    nonSynthetic.parts[0]!.synthetic = false;
    const nonText = user("non-text", { continuation: true });
    nonText.parts[0]!.type = "compaction";

    for (const target of [falseMetadata, nonSynthetic, nonText]) {
      await transform([user("source", { system: contract(tokenA) }), target]);
      expect(target.info.system).toBeUndefined();
    }
  });

  it("fails closed when authoritative history cannot resolve the target", async () => {
    const absent = user("absent", { continuation: true });
    await transform([absent], [user("source", { system: contract(tokenA) })]);
    expect(absent.info.system).toBeUndefined();

    const failed = user("failed", { continuation: true });
    const hooks = createStudioCompletionHooks(async () => {
      throw new Error("synthetic loader failure");
    });
    await expect(
      hooks["experimental.chat.messages.transform"](
        {},
        {
          messages: [failed],
        },
      ),
    ).resolves.toBeUndefined();
    expect(failed.info.system).toBeUndefined();
  });
});
