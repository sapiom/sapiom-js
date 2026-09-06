import * as fs from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
  type CreateSessionRequest,
} from "../shared/types.js";
import { buildIdeaWithAttachments } from "../shared/initial-prompt.js";
import {
  AttachmentError,
  validateAttachment,
  writeAttachment,
} from "./attachments.js";
import { scaffoldAgentProject, type AgentScaffoldDeps } from "./scaffold.js";

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

/** Prepare files before the CLI exists; there is no synthetic PTY Enter. */
export async function prepareFirstRequest(
  request: CreateSessionRequest,
  scaffoldDeps: AgentScaffoldDeps,
): Promise<string | undefined> {
  validateInitialAttachments(request.initialAttachments);
  if (request.scaffold) {
    await scaffoldAgentProject(scaffoldDeps, {
      root: dirname(request.cwd),
      name: basename(request.cwd),
      template: request.scaffold.template,
    });
  }
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
    return buildIdeaWithAttachments(request.initialPrompt ?? "", resolved);
  } catch (error) {
    // Only our UUID-named uploads are disposable. Keep a completed scaffold
    // (and all pre-existing files); no coding session has started yet.
    await Promise.all(uploaded.map((file) => fs.unlink(file).catch(() => {})));
    throw error;
  }
}
