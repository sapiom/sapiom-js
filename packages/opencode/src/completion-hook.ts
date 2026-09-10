interface CompletionMessage {
  info?: {
    role?: unknown;
    sessionID?: unknown;
    agent?: unknown;
    system?: unknown;
  };
  parts?: readonly {
    type?: unknown;
    synthetic?: unknown;
    metadata?: { compaction_continue?: unknown };
  }[];
}

interface CompletionTransformOutput {
  messages: CompletionMessage[];
}

const completionSystem =
  /^StudioAssistantResult\/v2:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n/;

function isSyntheticContinuation(message: CompletionMessage): boolean {
  return (
    message.info?.role === "user" &&
    !!message.parts?.some(
      (part) =>
        part.type === "text" &&
        part.synthetic === true &&
        part.metadata?.compaction_continue === true,
    )
  );
}

function isCompactionControl(message: CompletionMessage): boolean {
  return (
    isSyntheticContinuation(message) ||
    (message.info?.role === "user" &&
      !!message.parts?.some((part) => part.type === "compaction"))
  );
}

/** Restore Studio's turn contract on OpenCode's system-less auto-continue. */
export function createStudioCompletionHooks(): {
  "experimental.chat.messages.transform": (
    input: Record<string, never>,
    output: CompletionTransformOutput,
  ) => Promise<void>;
} {
  return {
    async "experimental.chat.messages.transform"(_input, output) {
      const target = output.messages.at(-1);
      if (
        target?.info?.role !== "user" ||
        target.info.system !== undefined ||
        typeof target.info.sessionID !== "string" ||
        typeof target.info.agent !== "string" ||
        !isSyntheticContinuation(target)
      )
        return;

      for (let index = output.messages.length - 2; index >= 0; index--) {
        const message = output.messages[index];
        if (message?.info?.role !== "user") continue;
        if (isCompactionControl(message)) continue;
        const candidate = message.info;
        if (
          candidate.sessionID === target.info.sessionID &&
          candidate.agent === target.info.agent &&
          typeof candidate.system === "string" &&
          completionSystem.test(candidate.system)
        )
          target.info.system = candidate.system;
        return;
      }
    },
  };
}
