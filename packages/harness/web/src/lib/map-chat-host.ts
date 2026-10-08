/**
 * The project's map chat as the browser reaches it (design-map-chat.md §1,
 * §4.4): its OpenCode host key, the hand-off tool's shape, and the transcript
 * Open in session hands to a terminal session.
 *
 * The server half is `src/core/opencode-host.ts` (`mapChatHostKey`) and the
 * generated plugin's `handoff` tool (`packages/opencode/src/server.ts`). The
 * key is repeated here because the web bundle cannot import server code; the
 * prefix is the contract.
 */
import {
  finalResponseAgent,
  turnRecoveryAgent,
  type OpenCodeTurnMessage,
} from "../../../src/shared/opencode-turn";
import { parseAskPrompt, askChipLabel } from "./map-ask";

/** The OpenCode host that is a project's map chat: never a Studio session. */
export const mapChatHostKey = (projectId: string): string => `map:${projectId}`;

/** The hand-off tool's name, as the model calls it and the part carries it. */
export const HANDOFF_TOOL = "handoff";

/** The hand-off tool's arguments, once both are there (design §4.4 step 1). */
export interface HandoffArgs {
  title: string;
  prompt: string;
}

export function handoffArgs(value: unknown): HandoffArgs | null {
  if (!value || typeof value !== "object") return null;
  const { title, prompt } = value as { title?: unknown; prompt?: unknown };
  return typeof title === "string" &&
    title.trim() &&
    typeof prompt === "string" &&
    prompt.trim()
    ? { title: title.trim(), prompt: prompt.trim() }
    : null;
}

const isHandoffPart = (part: OpenCodeTurnMessage["parts"][number]): boolean =>
  part.type === "tool" &&
  part.tool === HANDOFF_TOOL &&
  part.state?.status !== "error" &&
  handoffArgs(part.state?.input) != null;

/**
 * Whether the LATEST turn offered a hand-off. On such a turn the model often
 * declares itself failed, because the work was not done in the chat (P2's real
 * check, 2026-10-04). The card is the outcome, so the chat must not show that
 * turn as failed, nor ask the model to "finish" it.
 */
export function latestTurnOffersHandoff(
  messages: readonly OpenCodeTurnMessage[],
): boolean {
  const users = messages.filter(
    (message) =>
      message.info?.role === "user" &&
      message.info.agent !== finalResponseAgent &&
      message.info.agent !== turnRecoveryAgent,
  );
  const user = users.at(-1);
  if (!user?.info) return false;
  const start = messages.indexOf(user);
  return messages
    .slice(start + 1)
    .some(
      (message) =>
        message.info?.role === "assistant" && message.parts.some(isHandoffPart),
    );
}

const RESULT_LINE = /<!-- studio-result:[^\n]*?-->\s*/g;

/**
 * The map chat as Markdown, for the file Open in session attaches (4.3.7): the
 * selection, then every visible turn in order. Recovery turns and the result
 * bookkeeping lines are Studio's, not the conversation's, so they are left out.
 */
export function mapChatTranscript({
  projectLabel,
  projectRoot,
  selection,
  messages,
}: {
  projectLabel: string;
  projectRoot: string;
  selection: { name: string; kind: string; path: string };
  messages: readonly OpenCodeTurnMessage[];
}): string {
  const lines = [
    `# Map chat: ${projectLabel}`,
    "",
    `Project root: ${projectRoot}`,
    `Selection: ${askChipLabel(selection)}, at ${selection.path}`,
    "",
  ];
  for (const message of messages) {
    const role = message.info?.role;
    if (
      message.info?.agent === finalResponseAgent ||
      message.info?.agent === turnRecoveryAgent
    )
      continue;
    const text = message.parts
      .filter((part) => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => part.text ?? "")
      .join("")
      .replace(RESULT_LINE, "")
      .trim();
    if (role === "user") {
      const { subject, question } = parseAskPrompt(text);
      lines.push("## You", "");
      if (subject) lines.push(`_${askChipLabel(subject)}, at ${subject.path}_`, "");
      lines.push(question, "");
    } else if (role === "assistant") {
      const handoffs = message.parts
        .filter(isHandoffPart)
        .map((part) => handoffArgs(part.state?.input)!);
      if (!text && handoffs.length === 0) continue;
      lines.push("## Map chat", "");
      if (text) lines.push(text, "");
      for (const handoff of handoffs)
        lines.push(`Offered a session: **${handoff.title}**`, "", "```", handoff.prompt, "```", "");
    }
  }
  return lines.join("\n");
}

/** The first message of the session Open in session makes (4.3.7). */
export function openInSessionPrompt(selection: {
  name: string;
  kind: string;
  path: string;
}): string {
  return `Continue from the project's map chat in Studio. The attached file holds its transcript. ${askChipLabel(selection)}, at ${selection.path}. Read the transcript first, then ask me what to do next if it is not clear.`;
}
