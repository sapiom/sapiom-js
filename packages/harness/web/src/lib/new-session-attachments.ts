/**
 * Ephemeral files queued on the create-new screen. Disk-backed files stay as
 * paths; clipboard-only files gain their project-local path later through the
 * attachment endpoint. Keeping the union here stops the component and App
 * from inventing parallel queue shapes as the remaining slices land.
 */
import type { AttachFileRequest, AttachFileResponse } from "@shared/types";
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
} from "@shared/types";


export type NewSessionAttachment =
  | {
      id: string;
      kind: "path";
      name: string;
      path: string;
    }
  | {
      id: string;
      kind: "inline";
      name: string;
      mediaType: string;
      bytes: number;
      dataUrl: string;
      /** SHA-256 of the bytes, used to deduplicate repeated clipboard files. */
      fingerprint: string;
    };

export interface ResolvedNewSessionAttachment {
  name: string;
  path: string;
}

export interface QueueFilesResult {
  attachments: NewSessionAttachment[];
  errors: string[];
}

function attachmentName(file: File): string {
  return file.name || "pasted-file";
}

function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return `data:${mediaType};base64,${btoa(chunks.join(""))}`;
}

async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Convert browser files without copying disk-backed files. Files that Electron
 * cannot map to disk (for example pasted screenshots) become bounded inline
 * entries that the server can materialize after the session exists.
 */
export async function filesToAttachments(
  files: readonly File[],
  pathForFile?: (file: File) => string,
  inlineBudgetBytes = MAX_INLINE_ATTACHMENTS_TOTAL_BYTES,
): Promise<QueueFilesResult> {
  const attachments: NewSessionAttachment[] = [];
  const errors: string[] = [];
  let inlineBytes = 0;

  for (const file of files) {
    const name = attachmentName(file);
    let path = "";
    try {
      path = pathForFile?.(file) ?? "";
    } catch {
      // A bridge lookup failure is equivalent to a pathless browser File.
    }

    if (path) {
      attachments.push({
        id: crypto.randomUUID(),
        kind: "path",
        name,
        path,
      });
      continue;
    }

    if (file.size > MAX_INLINE_ATTACHMENT_BYTES) {
      errors.push(
        `${name} is too large to paste (${file.size} bytes; limit ${MAX_INLINE_ATTACHMENT_BYTES} bytes).`,
      );
      continue;
    }
    if (inlineBytes + file.size > inlineBudgetBytes) {
      errors.push(
        `${name} would exceed the ${MAX_INLINE_ATTACHMENTS_TOTAL_BYTES}-byte pasted-file limit for one session.`,
      );
      continue;
    }

    try {
      const mediaType = file.type || "application/octet-stream";
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
        errors.push(
          `${name} is too large to paste (${bytes.byteLength} bytes; limit ${MAX_INLINE_ATTACHMENT_BYTES} bytes).`,
        );
        continue;
      }
      attachments.push({
        id: crypto.randomUUID(),
        kind: "inline",
        name,
        mediaType,
        bytes: bytes.byteLength,
        dataUrl: bytesToDataUrl(bytes, mediaType),
        fingerprint: await fingerprint(bytes),
      });
      inlineBytes += bytes.byteLength;
    } catch {
      errors.push(`Couldn't read ${name}.`);
    }
  }

  return { attachments, errors };
}

function attachmentKey(attachment: NewSessionAttachment): string {
  return attachment.kind === "path"
    ? `path:${attachment.path}`
    : `inline:${attachment.fingerprint}`;
}

/** Add unique files in user-selected order; re-picking one path is a no-op. */
export function mergeAttachments(
  current: readonly NewSessionAttachment[],
  incoming: readonly NewSessionAttachment[],
): NewSessionAttachment[] {
  const seen = new Set(current.map(attachmentKey));
  const merged = [...current];
  for (const attachment of incoming) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}

/** Resolve inline entries in order while passing native paths through. */
export async function materializeAttachments(
  sessionId: string,
  attachments: readonly NewSessionAttachment[],
  upload: (
    sessionId: string,
    request: AttachFileRequest,
  ) => Promise<AttachFileResponse>,
): Promise<ResolvedNewSessionAttachment[]> {
  const resolved: ResolvedNewSessionAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "path") {
      resolved.push({ name: attachment.name, path: attachment.path });
      continue;
    }

    try {
      const response = await upload(sessionId, {
        dataUrl: attachment.dataUrl,
        filename: attachment.name,
      });
      resolved.push({ name: attachment.name, path: response.path });
    } catch (error) {
      const reason = (error as Error).message;
      throw new Error(
        `Couldn't attach ${attachment.name}${reason ? `: ${reason}` : "."}`,
        { cause: error },
      );
    }
  }
  return resolved;
}

export { buildIdeaWithAttachments } from "@shared/initial-prompt";
