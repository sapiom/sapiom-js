/**
 * Tests for source packing.
 *
 * These run REAL esbuild over real temp projects rather than mocking it, because
 * the thing being tested is exactly what esbuild reports: which files the entry
 * reaches. A mocked metafile would only assert that the mock was read back.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { AgentOperationError } from "./errors";
import { packSource } from "./pack-source";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sapiom-pack-spec-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * Walk the raw tar headers and return path → content.
 *
 * Deliberately a hand-written reader rather than the writer's own code: reading
 * the archive back with the module under test would only prove it is
 * self-consistent. (The engine's independent reader is exercised by a committed
 * fixture on that side.)
 */
function archived(archive: Buffer): Record<string, string> {
  const raw = gunzipSync(archive);
  const files: Record<string, string> = {};
  for (let offset = 0; offset + 512 <= raw.length; ) {
    const name = raw.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
    if (!name) break;
    const size = parseInt(raw.toString("utf8", offset + 124, offset + 135).trim(), 8) || 0;
    files[name] = raw.toString("utf8", offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe("packSource", () => {
  it("archives the entry and a generated package.json", async () => {
    write("index.ts", "export default { name: 'a' };\n");
    const packed = await packSource(root);

    expect(packed.files).toEqual(["index.ts", "package.json"]);
    expect(Object.keys(archived(packed.archive)).sort()).toEqual(["index.ts", "package.json"]);
  });

  it("includes files the entry reaches, and excludes files it does not", async () => {
    // A directory sweep would archive `scratch.ts`. The metafile knows better —
    // it lists what the entry actually imports.
    write("index.ts", "import { helper } from './kit/helper.js';\nexport default helper;\n");
    write("kit/helper.ts", "export const helper = 1;\n");
    write("scratch.ts", "export const unused = 'not imported';\n");

    const packed = await packSource(root);
    expect(packed.files).toEqual(["index.ts", "kit/helper.ts", "package.json"]);
    expect(packed.files).not.toContain("scratch.ts");
  });

  it("pins dependency versions from the installed tree rather than shipping ranges", async () => {
    // The property inherited from the push path: the server's install must resolve
    // exactly what the author developed against, so a caret range in the author's
    // own package.json must not decide the build.
    write("index.ts", "import { z } from 'zod';\nexport default z;\n");
    write("node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "3.24.1" }));
    write("node_modules/zod/index.js", "export const z = 1;\n");

    const packed = await packSource(root);
    expect(packed.dependencies).toEqual({ zod: "3.24.1" });

    // And the pin travels inside the archive, not just in the return value.
    const manifest = JSON.parse(archived(packed.archive)["package.json"]) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ zod: "3.24.1" });
  });

  it("never archives node_modules", async () => {
    write("index.ts", "export default 1;\n");
    write("node_modules/pkg/index.js", "module.exports = 1;\n");

    const packed = await packSource(root);
    expect(packed.files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("refuses source that escapes the project directory instead of silently dropping it", async () => {
    // esbuild INLINED these for the push path, so the old transport handled them.
    // A raw archive cannot: relative imports must still resolve after extraction,
    // and the server looks for the entry at the archive root. Failing loudly beats
    // building an agent whose shared code is missing.
    const shared = path.join(root, "..", `shared-${path.basename(root)}`);
    mkdirSync(shared, { recursive: true });
    try {
      writeFileSync(path.join(shared, "util.ts"), "export const util = 1;\n");
      write("agent/index.ts", `import { util } from '${path.join(shared, "util.js")}';\nexport default util;\n`);

      await expect(packSource(path.join(root, "agent"))).rejects.toMatchObject({
        code: "UNSUPPORTED_LAYOUT",
      });
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("reports a missing entry as NO_ENTRY", async () => {
    await expect(packSource(root)).rejects.toBeInstanceOf(AgentOperationError);
    await expect(packSource(root)).rejects.toMatchObject({ code: "NO_ENTRY" });
  });

  it("is reproducible — the same source packs to identical bytes", async () => {
    write("index.ts", "export default 1;\n");
    const a = await packSource(root);
    const b = await packSource(root);
    // Content-addressing depends on this: otherwise every deploy of unchanged
    // source uploads again and pays for another build.
    expect(a.archive.equals(b.archive)).toBe(true);
  });
});
