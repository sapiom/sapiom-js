import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
/** Lets a single test point `os.homedir()` somewhere unwritable without
 *  disturbing `tmpDir` itself, which `afterEach` always cleans up. */
let homeOverride: string | null = null;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => homeOverride ?? tmpDir };
});

import { getOrCreateMachineId } from "./machine-id.js";

describe("getOrCreateMachineId", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-machine-id-"));
    homeOverride = null;
  });

  afterEach(async () => {
    homeOverride = null;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a uuid on first run", async () => {
    const id = await getOrCreateMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const onDisk = await fs.readFile(
      path.join(tmpDir, ".sapiom", "harness", "machine-id"),
      "utf-8",
    );
    expect(onDisk.trim()).toBe(id);
  });

  it("returns the same id on subsequent calls", async () => {
    const first = await getOrCreateMachineId();
    const second = await getOrCreateMachineId();
    expect(second).toBe(first);
  });

  const idFilePath = () => path.join(tmpDir, ".sapiom", "harness", "machine-id");

  it("creates the file with mode 0600", async () => {
    await getOrCreateMachineId();
    const stat = await fs.stat(idFilePath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("hardens a pre-existing, loosely-permissioned file to 0600 without changing its id", async () => {
    const first = await getOrCreateMachineId();
    await fs.chmod(idFilePath(), 0o644);
    expect((await fs.stat(idFilePath())).mode & 0o777).toBe(0o644);

    const second = await getOrCreateMachineId();
    expect(second).toBe(first);
    expect((await fs.stat(idFilePath())).mode & 0o777).toBe(0o600);
  });

  it("silently regenerates a corrupt (non-uuid) file", async () => {
    await fs.mkdir(path.dirname(idFilePath()), { recursive: true });
    await fs.writeFile(idFilePath(), "not-a-uuid-at-all {{{");

    const id = await getOrCreateMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fs.readFile(idFilePath(), "utf-8")).trim()).toBe(id);
  });

  it("silently regenerates an empty file", async () => {
    await fs.mkdir(path.dirname(idFilePath()), { recursive: true });
    await fs.writeFile(idFilePath(), "");

    const id = await getOrCreateMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("degrades gracefully (still returns a usable id, never rejects) when HOME is unwritable", async () => {
    // Point homedir() below a regular file so mkdir must fail — same
    // technique as analytics-core's identity.test.ts unwritable-HOME case.
    // Uses homeOverride, not tmpDir itself, so afterEach still cleans up
    // the real temp dir this test ran in.
    const blocker = path.join(tmpDir, "blocker");
    await fs.writeFile(blocker, "i am a file");
    homeOverride = path.join(blocker, "nested");

    const id = await getOrCreateMachineId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Not persisted (there was nowhere to persist it to) — a second call in
    // the same broken environment gets a *different* id, since there's no
    // stable location to read one back from. Still never throws.
    const second = await getOrCreateMachineId();
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
  });
});
