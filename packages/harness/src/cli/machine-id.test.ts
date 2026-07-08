import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tmpDir };
});

import { getOrCreateMachineId } from "./machine-id.js";

describe("getOrCreateMachineId", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-machine-id-"));
  });

  afterEach(async () => {
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
});
