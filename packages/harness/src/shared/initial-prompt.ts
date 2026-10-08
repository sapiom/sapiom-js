/** Paths are context, never shell commands. Match native terminal drop quoting. */
export function quotePathForTerminal(path: string): string {
  if (/^[A-Za-z0-9_\-./~:\\]+$/.test(path)) return path;
  if (/^[A-Za-z]:[\\/]/.test(path)) return `"${path}"`;
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface FirstPromptParts {
  /** The user's idea, verbatim. */
  idea: string;
  /** Files materialized for the session, in the user's order. */
  attachments?: readonly { path: string; name?: string }[];
  /** Links the user listed as sources. Handed over by URL, never fetched here. */
  sources?: readonly string[];
  /** Session setup (the planning instructions), after everything the user gave. */
  setup?: string;
}

/**
 * THE FIRST PROMPT, in one order everywhere (flow-creation.md §4.4 step 3):
 * the idea, then the attached files, then the linked sources, then the
 * session setup. The user's words lead and the harness's instructions follow,
 * so what the coding agent reads first is what the user typed. Empty parts
 * are omitted; a prompt with nothing in it is `undefined`, not an empty turn.
 */
export function buildFirstPrompt(parts: FirstPromptParts): string | undefined {
  const blocks: string[] = [];
  const idea = parts.idea.trim();
  if (idea) blocks.push(idea);
  if (parts.attachments && parts.attachments.length > 0) {
    blocks.push(
      "Attached files (read each as context):\n" +
        parts.attachments.map(({ path }) => quotePathForTerminal(path)).join("\n"),
    );
  }
  const sources = (parts.sources ?? []).map((url) => url.trim()).filter(Boolean);
  if (sources.length > 0) {
    blocks.push("Linked sources (read each as context):\n" + sources.join("\n"));
  }
  const setup = parts.setup?.trim();
  if (setup) blocks.push(setup);
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/** The idea plus its files: the two-part form every earlier caller used. */
export function buildIdeaWithAttachments(
  idea: string,
  attachments: readonly { path: string; name?: string }[],
): string | undefined {
  return buildFirstPrompt({ idea, attachments });
}
