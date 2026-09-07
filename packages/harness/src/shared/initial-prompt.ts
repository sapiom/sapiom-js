/** Paths are context, never shell commands. Match native terminal drop quoting. */
export function quotePathForTerminal(path: string): string {
  if (/^[A-Za-z0-9_\-./~:\\]+$/.test(path)) return path;
  if (/^[A-Za-z]:[\\/]/.test(path)) return `"${path}"`;
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildIdeaWithAttachments(
  idea: string,
  attachments: readonly { path: string; name?: string }[],
): string | undefined {
  const trimmed = idea.trim();
  if (attachments.length === 0) return trimmed || undefined;
  const context =
    "Attached files (read each as context):\n" +
    attachments.map(({ path }) => quotePathForTerminal(path)).join("\n");
  return trimmed ? `${trimmed}\n\n${context}` : context;
}
