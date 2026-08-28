/**
 * Tests for the hand-rolled tar writer.
 *
 * The claim that matters is INTEROP, not internal consistency: this archive is
 * read by the real `tar` binary and by the server's `tar-stream` reader, so
 * asserting my writer agrees with itself would prove nothing. Every test here
 * therefore extracts with the system `tar`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTarGz } from "./tar";

/** Extract with the SYSTEM tar and return path → content. */
function extract(archive: Buffer): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-tar-spec-"));
  try {
    const archivePath = path.join(dir, "a.tar.gz");
    writeFileSync(archivePath, archive);
    const out = path.join(dir, "out");
    execFileSync("mkdir", ["-p", out]);
    execFileSync("tar", ["-xzf", archivePath, "-C", out], { stdio: "pipe" });
    const listed = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const files: Record<string, string> = {};
    for (const name of listed) files[name] = readFileSync(path.join(out, name), "utf8");
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("createTarGz", () => {
  it("produces an archive the system tar can extract", () => {
    const files = extract(
      createTarGz([
        { path: "index.ts", content: "export const a = 1;\n" },
        { path: "kit/helper.ts", content: "export const b = 2;\n" },
      ]),
    );
    expect(files).toEqual({
      "index.ts": "export const a = 1;\n",
      "kit/helper.ts": "export const b = 2;\n",
    });
  });

  it("round-trips content that is not 512-byte aligned", () => {
    // Every realistic file lands mid-block, so the data padding is exercised by
    // practically every archive — a broken pad shifts every later header.
    for (const size of [0, 1, 511, 512, 513, 1024, 1025]) {
      const content = "x".repeat(size);
      expect(extract(createTarGz([{ path: "f.ts", content }]))["f.ts"]).toBe(content);
    }
  });

  it("round-trips multi-byte characters by byte length, not character count", () => {
    // The size field is BYTES. Using string length would truncate any non-ASCII
    // file and corrupt the archive from that header onward.
    const content = "const gruß = 'héllo κόσμε';\n";
    expect(extract(createTarGz([{ path: "u.ts", content }]))["u.ts"]).toBe(content);
  });

  it("is reproducible — identical input yields identical bytes", () => {
    // Content-addressing depends on this. A clock-derived mtime would make every
    // deploy a new digest, so unchanged source would re-upload and rebuild.
    const files = [{ path: "index.ts", content: "export const a = 1;\n" }];
    expect(createTarGz(files).equals(createTarGz(files))).toBe(true);
  });

  it("is order-independent — the same set in any order yields identical bytes", () => {
    const a = createTarGz([
      { path: "b.ts", content: "b" },
      { path: "a.ts", content: "a" },
    ]);
    const b = createTarGz([
      { path: "a.ts", content: "a" },
      { path: "b.ts", content: "b" },
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it("handles a path longer than the 100-character name field", () => {
    const deep = `${"nested/".repeat(15)}file.ts`;
    expect(deep.length).toBeGreaterThan(100);
    expect(extract(createTarGz([{ path: deep, content: "deep" }]))[deep]).toBe("deep");
  });

  it("refuses a path it cannot split rather than truncating it", () => {
    // A truncated path would deploy the file somewhere else entirely, so this
    // fails loudly instead.
    const unsplittable = `${"a".repeat(120)}.ts`;
    expect(() => createTarGz([{ path: unsplittable, content: "x" }])).toThrow(/too long/i);
  });
});
