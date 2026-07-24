import type { Sapiom } from "@sapiom/tools";

/** Upload bytes to Sapiom file storage with public visibility; returns the fileId. */
export async function uploadPublicFile(
  sapiom: Sapiom,
  opts: { fileName: string; contentType: string; bytes: Uint8Array },
): Promise<string> {
  const res = await sapiom.fileStorage.upload({
    contentType: opts.contentType,
    fileName: opts.fileName,
    visibility: "public",
    fileSize: opts.bytes.byteLength,
  });
  const put = await fetch(res.uploadUrl, {
    method: "PUT",
    headers: res.requiredHeaders,
    body: opts.bytes as unknown as BodyInit,
  });
  if (!put.ok) throw new Error(`upload PUT for ${opts.fileName} failed: ${put.status}`);
  return res.fileId;
}

/** All non-deleted files whose fileName starts with prefix, newest per fileName. */
export async function listFilesByPrefix(
  sapiom: Sapiom,
  prefix: string,
): Promise<Array<{ fileId: string; fileName: string }>> {
  const newest = new Map<string, { fileId: string; fileName: string; createdAt: string }>();
  let offset = 0;
  for (;;) {
    const page = await sapiom.fileStorage.list({ limit: 100, offset });
    for (const f of page.files) {
      if (!f.fileName?.startsWith(prefix) || f.status === "deleted") continue;
      const prev = newest.get(f.fileName);
      if (!prev || f.createdAt > prev.createdAt) {
        newest.set(f.fileName, { fileId: f.fileId, fileName: f.fileName, createdAt: f.createdAt });
      }
    }
    if (!page.hasMore || page.files.length === 0) break;
    offset += page.limit;
  }
  return [...newest.values()].map(({ fileId, fileName }) => ({ fileId, fileName }));
}

/** Download a stored file's bytes via a fresh presigned URL. */
export async function downloadFileBytes(sapiom: Sapiom, fileId: string): Promise<Uint8Array> {
  const { downloadUrl } = await sapiom.fileStorage.getDownloadUrl(fileId);
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`download GET for ${fileId} failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
