import * as fs from "node:fs/promises";
import {
  MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
  type CreateSessionRequest,
} from "../shared/types.js";
import { buildFirstPrompt } from "../shared/initial-prompt.js";
import {
  AttachmentError,
  validateAttachment,
  writeAttachment,
} from "./attachments.js";

export function validateInitialAttachments(
  attachments: CreateSessionRequest["initialAttachments"],
): void {
  let bytes = 0;
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "inline") continue;
    bytes += validateAttachment(attachment).bytes;
    if (bytes > MAX_INLINE_ATTACHMENTS_TOTAL_BYTES) {
      throw new AttachmentError(
        413,
        "Pasted files exceed the per-session attachment limit",
      );
    }
  }
}

/**
 * Prepare the first turn before the CLI exists; there is no synthetic PTY
 * Enter. Files are materialized into the session's cwd, then the prompt is
 * composed in one order (`buildFirstPrompt`): the idea, the files, the
 * linked sources, the session setup.
 *
 * Creating the agent is NOT this function's job any more: the session-side
 * `scaffold` option is gone (flow-creation.md §4.4 step 4). The harness
 * scaffolds through `POST /api/agents/scaffold` before any session opens, so
 * a session request always names a folder that already exists.
 */
export async function prepareFirstRequest(
  request: CreateSessionRequest,
): Promise<string | undefined> {
  validateInitialAttachments(request.initialAttachments);
  const resolved: { path: string }[] = [];
  const uploaded: string[] = [];
  try {
    for (const attachment of request.initialAttachments ?? []) {
      if (attachment.kind === "path") {
        resolved.push({ path: attachment.path });
      } else {
        try {
          const file = await writeAttachment(request.cwd, attachment);
          uploaded.push(file.path);
          resolved.push(file);
        } catch (error) {
          throw new AttachmentError(
            error instanceof AttachmentError ? error.status : 500,
            `Couldn't attach ${attachment.filename}: ${(error as Error).message}`,
          );
        }
      }
    }
    return buildFirstPrompt({
      idea: request.initialPrompt ?? "",
      attachments: resolved,
      sources: request.initialSources,
      setup: request.initialSetup,
    });
  } catch (error) {
    // Only our UUID-named uploads are disposable; pre-existing files stay.
    // No coding session has started yet.
    await Promise.all(uploaded.map((file) => fs.unlink(file).catch(() => {})));
    throw error;
  }
}
