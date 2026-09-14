import {
  AssistantContextError,
  assistantContentHash,
  contextCheck,
} from "./assistant-context-contract.js";
import {
  parseStudioAssistantSystem,
  projectStudioAssistantSystem,
} from "./assistant-context-wire.js";
import {
  createStudioCompletionHooks,
  isCompactionControl,
  isSyntheticContinuation,
  type CompletionMessage,
  type CompletionTransformOutput,
  type LoadSessionMessages,
} from "./completion-hook.js";

interface CapturedUser {
  messageID: string;
  system: unknown;
  failed: boolean;
}
/** The owned native runtime supplies the actual LLM request identity, including helpers. */
export interface AssistantSystemTransformInput {
  sessionID?: string;
  messageID?: string;
  agent?: string;
}
interface StudioAssistantContextHooks {
  event?: (input: {
    event: { type: string; properties?: { info?: { id?: unknown } } };
  }) => Promise<void>;
  "experimental.chat.messages.transform": (
    input: Record<string, never>,
    output: CompletionTransformOutput,
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: AssistantSystemTransformInput,
    output: { system: string[] },
  ) => Promise<void>;
}
const claimed = (system: unknown) =>
  typeof system === "string" &&
  /(?:^|\n)StudioAssistant(?:Result|Context)\//.test(system);

/** Project verified saved instructions at the native provider boundary.
 * Callers without an authority scope retain the generic completion-only wrapper.
 * Required failures are thrown only in system.transform: native persists/emits a
 * safe error there, whereas messages.transform defects can expose native stacks. */
export function createStudioAssistantContextHooks(
  loadSessionMessages: LoadSessionMessages,
  authorityScope?: string,
): StudioAssistantContextHooks {
  const completion = createStudioCompletionHooks(loadSessionMessages);
  if (authorityScope === undefined) return completion;
  contextCheck(/^[a-f0-9]{64}$/.test(authorityScope));
  const scope = authorityScope;
  const captured = new Map<string, CapturedUser>();
  const failures = new Set<string>();
  const deleted = new Set<string>();
  // Keep compact capture proofs beyond the bounded full-text cache. Provider
  // retries can reconstruct the same user without another messages transform.
  const fingerprints = new Map<string, string>();
  const fingerprint = (system: unknown) =>
    assistantContentHash(
      system === undefined ? "undefined" : `string:${String(system)}`,
    );
  const keyOf = (sessionID: string, messageID: string) =>
    `${sessionID}:${messageID}`;
  const parse = (system: unknown, sessionID: string) =>
    parseStudioAssistantSystem(system, {
      authorityScope: scope,
      conversationId: sessionID,
    });

  function capture(message: CompletionMessage): void {
    const info = message.info;
    if (
      info?.role !== "user" ||
      typeof info.id !== "string" ||
      typeof info.sessionID !== "string" ||
      deleted.has(info.sessionID)
    )
      return;
    let failed = false;
    try {
      // A failed completion restoration must not turn required continuation into generic work.
      if (isSyntheticContinuation(message) && info.system === undefined)
        throw new AssistantContextError();
      parse(info.system, info.sessionID);
      const key = keyOf(info.sessionID, info.id);
      const digest = fingerprint(info.system);
      contextCheck(!fingerprints.has(key) || fingerprints.get(key) === digest);
      fingerprints.set(key, digest);
    } catch {
      failed = true;
    }
    const key = keyOf(info.sessionID, info.id);
    if (failed) failures.add(key);
    captured.delete(key);
    captured.set(key, {
      messageID: info.id,
      system: info.system,
      failed,
    });
    // The native history is authoritative; bound this acceleration cache independently.
    if (captured.size > 16) captured.delete(captured.keys().next().value!);
  }

  async function savedUser(
    sessionID: string,
    messageID: string,
  ): Promise<CapturedUser | undefined> {
    const active = captured.get(keyOf(sessionID, messageID));
    if (active?.messageID === messageID) return active;
    // Title generation can precede messages.transform, or finish after a newer turn.
    // The native request ID selects its own saved user, never the latest capture.
    const messages = await loadSessionMessages(sessionID);
    const matches = messages.filter(
      (message) =>
        message.info?.role === "user" &&
        message.info.id === messageID &&
        message.info.sessionID === sessionID,
    );
    contextCheck(matches.length <= 1);
    const target = matches[0];
    if (!target) return;
    let system = target.info?.system;
    if (system === undefined && isSyntheticContinuation(target)) {
      const index = messages.indexOf(target);
      for (let previous = index - 1; previous >= 0; previous--) {
        const candidate = messages[previous]!;
        if (candidate.info?.role !== "user" || isCompactionControl(candidate))
          continue;
        contextCheck(
          candidate.info.sessionID === sessionID &&
            candidate.info.agent === target.info?.agent,
        );
        system = candidate.info.system;
        break;
      }
      contextCheck(system !== undefined);
    }
    return { messageID, system, failed: false };
  }

  return {
    async event({ event }) {
      const id = event.properties?.info?.id;
      if (event.type !== "session.deleted" || typeof id !== "string") return;
      deleted.add(id);
      for (const keys of [captured, fingerprints, failures])
        for (const key of keys.keys())
          if (key.startsWith(`${id}:`)) keys.delete(key);
    },
    async "experimental.chat.messages.transform"(
      input: Record<string, never>,
      output: CompletionTransformOutput,
    ): Promise<void> {
      // Preserve the existing awaited synthetic-continuation restoration first.
      await completion["experimental.chat.messages.transform"](input, output);
      for (let index = output.messages.length - 1; index >= 0; index--) {
        const target = output.messages[index]!;
        if (target.info?.role === "user") {
          capture(target);
          break;
        }
      }
    },
    async "experimental.chat.system.transform"(
      input: AssistantSystemTransformInput,
      output: { system: string[] },
    ): Promise<void> {
      try {
        if (!input.sessionID || !input.messageID || !input.agent) {
          contextCheck(!output.system.some(claimed));
          return;
        }
        contextCheck(
          /^ses_[A-Za-z0-9_-]{1,128}$/.test(input.sessionID) &&
            /^msg_[A-Za-z0-9_-]{1,128}$/.test(input.messageID),
        );
        const key = keyOf(input.sessionID, input.messageID);
        contextCheck(!deleted.has(input.sessionID) && !failures.has(key));
        const helper = ["title", "compaction", "project-copy-name"].includes(
          input.agent,
        );
        if (!captured.has(key)) {
          if (helper && !output.system.some(claimed)) return;
          contextCheck(helper || fingerprints.has(key));
        }
        const saved = await savedUser(input.sessionID, input.messageID);
        contextCheck(!deleted.has(input.sessionID) && !failures.has(key));
        if (!saved) {
          contextCheck(!output.system.some(claimed));
          return;
        }
        contextCheck(!saved.failed);
        contextCheck(
          !fingerprints.has(key) ||
            fingerprints.get(key) === fingerprint(saved.system),
        );
        const parsed = parse(saved.system, input.sessionID);
        if (parsed.kind === "generic") return;
        const last = output.system.length - 1;
        const trailing = output.system[last];
        contextCheck(
          typeof trailing === "string" && trailing.endsWith(parsed.savedSystem),
        );
        const prefix = trailing.slice(0, -parsed.savedSystem.length);
        contextCheck(!prefix || prefix.endsWith("\n"));
        if (parsed.kind === "legacy-v2") return;
        // Replace only the exact saved suffix. Native/provider prefixes can contain
        // marker-shaped text and remain byte-for-byte intact, with array identity.
        output.system.splice(
          last,
          1,
          ...(prefix ? [prefix] : []),
          ...projectStudioAssistantSystem(parsed),
        );
      } catch {
        throw new AssistantContextError();
      }
    },
  };
}
