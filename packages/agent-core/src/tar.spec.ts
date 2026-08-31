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

import { createTarGz, readTarGz } from "./tar";

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

// ---------------------------------------------------------------------------
// Reader
//
// Same interop standard as the writer: the archives read here are produced by
// the SYSTEM tar, not by createTarGz, so a shared misunderstanding of the format
// cannot make these pass. The round-trip case is the exception, and it is there
// to pin the pair together.
// ---------------------------------------------------------------------------

/** Build an archive with the SYSTEM tar from a file map. */
function packWithSystemTar(files: Record<string, string>, extraArgs: string[] = []): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "sapiom-tar-read-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(dir, relative);
      execFileSync("mkdir", ["-p", path.dirname(target)]);
      writeFileSync(target, content);
    }
    const archivePath = path.join(tmpdir(), `read-${path.basename(dir)}.tar.gz`);
    execFileSync("tar", ["-czf", archivePath, "-C", dir, ...extraArgs, "."], { stdio: "pipe" });
    const bytes = readFileSync(archivePath);
    rmSync(archivePath, { force: true });
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function asMap(files: { path: string; content: string }[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path.replace(/^\.\//, ""), f.content]));
}

describe("readTarGz", () => {
  it("reads an archive the system tar produced, including nested paths", () => {
    const archive = packWithSystemTar({
      "index.ts": "export default 1;\n",
      "shared/util.ts": "export const util = 2;\n",
      ".sapiom-source.json": '{"entry":"index.ts"}\n',
    });

    expect(asMap(readTarGz(archive))).toEqual({
      "index.ts": "export default 1;\n",
      "shared/util.ts": "export const util = 2;\n",
      ".sapiom-source.json": '{"entry":"index.ts"}\n',
    });
  });

  it("round-trips whatever the writer produced", () => {
    // `clone` reads what `deploy` wrote, so this pair has to agree exactly —
    // including the long-path prefix split the writer performs.
    const files = [
      { path: "index.ts", content: "export default 1;\n" },
      { path: `${"nested/".repeat(15)}deep.ts`, content: "export const deep = true;\n" },
      { path: "kit/helper.ts", content: "export const help = () => 1;\n" },
    ];

    expect(asMap(readTarGz(createTarGz(files)))).toEqual({
      "index.ts": "export default 1;\n",
      [`${"nested/".repeat(15)}deep.ts`]: "export const deep = true;\n",
      "kit/helper.ts": "export const help = () => 1;\n",
    });
  });

  it("refuses a path that escapes the archive root", () => {
    // This output is written to a developer's filesystem, so a traversal must not
    // be extracted. `-P` stops tar sanitising the path it stores.
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-tar-evil-"));
    try {
      writeFileSync(path.join(dir, "ok.ts"), "export default 1;\n");
      const archivePath = path.join(dir, "evil.tar.gz");
      execFileSync(
        "tar",
        ["-czf", archivePath, "-P", "-C", dir, "--transform=s|^\\./ok.ts|../escaped.ts|", "./ok.ts"],
        { stdio: "pipe" },
      );
      expect(() => readTarGz(readFileSync(archivePath))).toThrow(/escapes the archive root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a symlink rather than silently skipping it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sapiom-tar-link-"));
    try {
      writeFileSync(path.join(dir, "real.ts"), "export default 1;\n");
      execFileSync("ln", ["-s", "real.ts", path.join(dir, "link.ts")]);
      // Outside `dir`: writing it inside means tar archives its own output and
      // aborts with "file changed as we read it".
      const archivePath = path.join(tmpdir(), `link-${path.basename(dir)}.tar.gz`);
      try {
        execFileSync("tar", ["-czf", archivePath, "-C", dir, "."], { stdio: "pipe" });
        expect(() => readTarGz(readFileSync(archivePath))).toThrow(/not a regular file/);
      } finally {
        rmSync(archivePath, { force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
