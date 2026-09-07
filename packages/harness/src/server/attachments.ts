import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWithinRoot } from "../core/path-safety.js";
import {
  HARNESS_UPLOADS_DIR,
  MAX_INLINE_ATTACHMENT_BYTES,
  type AttachFileRequest,
  type AttachFileResponse,
} from "../shared/types.js";

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Validate standard padded base64 in one pass and return decoded size. */
function decodedBase64Size(encoded: string): number | null {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const contentLength = encoded.length - padding;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    const isDataCharacter =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (index < contentLength ? !isDataCharacter : code !== 61) return null;
  }
  return (encoded.length / 4) * 3 - padding;
}

/** Validate size before allocating decoded bytes or creating any files. */
export function validateAttachment(request: AttachFileRequest): {
  mediaType: string;
  encoded: string;
  bytes: number;
} {
  const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(
    request.dataUrl,
  );
  if (!match)
    throw new AttachmentError(400, "dataUrl must be a base64 data: URL");
  const encoded = match[2]!;
  const bytes = decodedBase64Size(encoded);
  if (bytes === null)
    throw new AttachmentError(400, "attachment payload is not valid base64");
  if (bytes === 0)
    throw new AttachmentError(400, "attachment payload is empty");
  if (bytes > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      413,
      `Attachment is ${bytes} bytes; the limit is ${MAX_INLINE_ATTACHMENT_BYTES} bytes`,
    );
  }
  return { mediaType: match[1]!.toLowerCase(), encoded, bytes };
}

/** Both first-turn and later uploads use the same containment/filename rules. */
export async function writeAttachment(
  cwd: string,
  request: AttachFileRequest,
): Promise<AttachFileResponse> {
  const { mediaType, encoded, bytes } = validateAttachment(request);
  const uploadsDir = resolveWithinRoot(cwd, HARNESS_UPLOADS_DIR);
  if (!uploadsDir)
    throw new AttachmentError(500, "could not resolve the uploads directory");
  await fs.mkdir(uploadsDir, { recursive: true });
  const [realCwd, realUploadsDir] = await Promise.all([
    fs.realpath(cwd),
    fs.realpath(uploadsDir),
  ]);
  if (!resolveWithinRoot(realCwd, realUploadsDir)) {
    throw new AttachmentError(400, "uploads directory escapes the session cwd");
  }
  const requestedExtension = path.extname(path.basename(request.filename));
  const extension = /^\.[a-z0-9]{1,12}$/i.test(requestedExtension)
    ? requestedExtension.toLowerCase()
    : ".bin";
  const filePath = path.join(realUploadsDir, `${randomUUID()}${extension}`);
  await fs.writeFile(filePath, Buffer.from(encoded, "base64"), { flag: "wx" });
  return { path: filePath, mediaType, bytes };
}
