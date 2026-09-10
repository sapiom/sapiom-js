interface CompletionMessage {
  info?: {
    id?: unknown;
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

type LoadSessionMessages = (
  sessionID: string,
) => Promise<readonly CompletionMessage[]>;

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
export function createStudioCompletionHooks(
  loadSessionMessages: LoadSessionMessages,
): {
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
        typeof target.info.id !== "string" ||
        typeof target.info.sessionID !== "string" ||
        typeof target.info.agent !== "string" ||
        !isSyntheticContinuation(target)
      )
        return;
      const targetID = target.info.id;
      const sessionID = target.info.sessionID;
      const agent = target.info.agent;

      let messages: readonly CompletionMessage[];
      try {
        messages = await loadSessionMessages(sessionID);
      } catch {
        return;
      }
      let targetIndex = -1;
      for (let index = messages.length - 1; index >= 0; index--)
        if (
          messages[index]?.info?.id === targetID &&
          messages[index]?.info?.sessionID === sessionID
        ) {
          targetIndex = index;
          break;
        }
      if (targetIndex === -1) return;

      for (let index = targetIndex - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.info?.role !== "user") continue;
        if (isCompactionControl(message)) continue;
        const candidate = message.info;
        if (
          candidate.sessionID === sessionID &&
          candidate.agent === agent &&
          typeof candidate.system === "string" &&
          completionSystem.test(candidate.system)
        )
          target.info.system = candidate.system;
        return;
      }
    },
  };
}
