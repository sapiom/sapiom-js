/**
 * Asking about the map (flow-map-chat-overlay.md 4.1 to 4.3, Q4): what the
 * card's composer invites, what a message's chip says, and the context line
 * the map chat receives ahead of the question.
 *
 * Ported from the mock (design-eng `agent-studio-v2/src/lib/map-ask.ts`). The
 * harness adds `parseAskPrompt`: the map chat's history is OpenCode's, so the
 * chip is read back from the stored prompt rather than kept beside it, and it
 * survives a reload with the conversation (design Q2).
 */

/** What a question on the map is about: the project, or one node on it. */
export interface AskSubject {
  name: string;
  /** "project", "agent", "resource", "step" or "group". */
  kind: string;
  path: string;
}

/** The kind a picked map node is asked about as. An agent is any node that
 *  resolves to a registered workflow; everything else keeps the map's word
 *  for it, so a shared database never reads as an agent. */
export function askKindForNode(nodeKind: string, isAgent: boolean): string {
  if (isAgent) return "agent";
  if (nodeKind === "resource") return "resource";
  if (nodeKind === "phase" || nodeKind === "group") return "group";
  return "step";
}

/** The composer's invitation (4.1.2, 4.2.1). */
export function askPlaceholder(subject: AskSubject): string {
  return subject.kind === "project"
    ? "Ask about this project"
    : `Ask about ${subject.name}`;
}

/** The chip on the message that carried the selection (Q4). */
export function askChipLabel(subject: Pick<AskSubject, "name" | "kind">): string {
  return `Asking about ${subject.name} · ${subject.kind}`;
}

/**
 * The prompt the map chat receives: the subject's kind, name and path ahead of
 * the question, as canonical StepAskCard prepends a step's context (Q4). The
 * user's words stay last and verbatim, so the feed can show them alone.
 */
export function askPrompt(question: string, subject: AskSubject | null): string {
  const text = question.trim();
  if (!subject) return text;
  return `Context: ${subject.kind} ${JSON.stringify(subject.name)} at ${subject.path}\n\n${text}`;
}

const CONTEXT_LINE = /^Context: ([a-z]+) ("(?:[^"\\]|\\.)*") at ([^\n]+)\n\n/;

/**
 * The inverse of `askPrompt`, for a stored user message: its subject and the
 * user's own words, or no subject when the text carries no context line (a
 * message sent before this format, or typed with no selection).
 */
export function parseAskPrompt(prompt: string): {
  subject: AskSubject | null;
  question: string;
} {
  const match = CONTEXT_LINE.exec(prompt);
  if (!match) return { subject: null, question: prompt };
  let name: string;
  try {
    name = JSON.parse(match[2]!) as string;
  } catch {
    return { subject: null, question: prompt };
  }
  return {
    subject: { kind: match[1]!, name, path: match[3]! },
    question: prompt.slice(match[0].length),
  };
}
