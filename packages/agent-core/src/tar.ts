/**
 * Minimal tar+gzip writer for source uploads (AGENT-289).
 *
 * WHY HAND-ROLLED rather than a dependency: this is a published SDK, so every
 * dependency is installed by every consumer of `@sapiom/cli` and
 * `@sapiom/harness`. Writing a ustar archive of regular files is a small,
 * well-specified job — and only the WRITE side is needed here, because the
 * server reads archives with a vetted library. Shelling out to the `tar` binary
 * was the other option and was rejected: it does not exist on a default Windows
 * install, which would make `sapiom deploy` platform-dependent.
 *
 * Scope is deliberately narrow: regular files, no symlinks, no directory
 * entries, no device nodes. That mirrors what the server accepts — it rejects
 * every one of those — so an archive this writer can produce is an archive the
 * server can ingest.
 */
import { gzipSync } from "node:zlib";

/** One file in the archive. `path` is a relative POSIX path. */
export interface TarFile {
  path: string;
  content: string;
}

const BLOCK_SIZE = 512;
/** ustar `name` field width. Longer paths use the `prefix` field. */
const NAME_FIELD = 100;
/** ustar `prefix` field width — with `name`, allows 255 characters total. */
const PREFIX_FIELD = 155;

/**
 * Build a gzipped tar containing `files`.
 *
 * `mtime` is fixed rather than read from the clock so the archive is
 * REPRODUCIBLE: identical source must produce an identical digest, or
 * content-addressing buys nothing and every deploy re-uploads and rebuilds
 * source that has not changed.
 */
export function createTarGz(files: readonly TarFile[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const content = Buffer.from(file.content, "utf8");
    blocks.push(header(file.path, content.length), content, padding(content.length));
  }
  // Two zero blocks mark end-of-archive.
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** Zero-fill so each file's data ends on a 512-byte boundary. */
function padding(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

/**
 * Split an over-long path across ustar `prefix` + `name`.
 *
 * The split must fall on a `/`, because the reader rejoins them with one. A path
 * that cannot be split that way is refused rather than silently truncated — a
 * truncated path would deploy a file to the wrong place.
 */
function splitPath(filePath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(filePath, "utf8") <= NAME_FIELD) {
    return { name: filePath, prefix: "" };
  }
  for (let i = filePath.length - NAME_FIELD; i < filePath.length; i++) {
    if (filePath[i] !== "/") continue;
    const prefix = filePath.slice(0, i);
    const name = filePath.slice(i + 1);
    if (
      Buffer.byteLength(name, "utf8") <= NAME_FIELD &&
      Buffer.byteLength(prefix, "utf8") <= PREFIX_FIELD
    ) {
      return { name, prefix };
    }
  }
  throw new Error(
    `Path too long for a tar archive (max ${NAME_FIELD + PREFIX_FIELD} characters, split on a '/'): ${filePath}`,
  );
}

function header(filePath: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitPath(filePath);

  block.write(name, 0, NAME_FIELD, "utf8");
  block.write("000644 \0", 100, 8, "utf8"); // mode: rw-r--r--
  block.write("000000 \0", 108, 8, "utf8"); // uid
  block.write("000000 \0", 116, 8, "utf8"); // gid
  block.write(octal(size, 11) + "\0", 124, 12, "utf8");
  block.write(octal(0, 11) + "\0", 136, 12, "utf8"); // mtime — fixed, see createTarGz
  // chksum is spaces while the checksum is computed over the header.
  block.write("        ", 148, 8, "utf8");
  block.write("0", 156, 1, "utf8"); // typeflag: regular file
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");
  if (prefix) block.write(prefix, 345, PREFIX_FIELD, "utf8");

  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(octal(checksum, 6) + "\0 ", 148, 8, "utf8");

  return block;
}

/** Zero-padded octal, as every numeric tar field is encoded. */
function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}
