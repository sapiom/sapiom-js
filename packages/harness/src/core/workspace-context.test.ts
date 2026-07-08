import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import { writeHarnessContext } from "./workspace-context.js";

const workflow: WorkflowInfo = {
  name: "leasing",
  path: "/Users/demo/acme-app/leasing",
  definitionId: 4821,
  source: "scan",
};

describe("writeHarnessContext", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-context-test-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function readContext(): Promise<unknown> {
    const raw = await fs.readFile(path.join(cwd, ".sapiom", "harness-context.json"), "utf8");
    return JSON.parse(raw);
  }

  it("creates .sapiom/ and writes a bound workflow", async () => {
    await writeHarnessContext(cwd, workflow);
    const context = await readContext();
    expect(context).toMatchObject({
      boundWorkflow: { name: "leasing", path: "/Users/demo/acme-app/leasing", definitionId: 4821 },
    });
    expect(typeof (context as { updatedAt: string }).updatedAt).toBe("string");
  });

  it("writes boundWorkflow: null for an unbound/never-bound session", async () => {
    await writeHarnessContext(cwd, null);
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: null });
  });

  it("unbind writes null rather than deleting the file (no ENOENT race for a concurrent reader)", async () => {
    await writeHarnessContext(cwd, workflow);
    await writeHarnessContext(cwd, null);
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: null });
    // The file must still exist (only its content changed).
    await expect(fs.access(path.join(cwd, ".sapiom", "harness-context.json"))).resolves.toBeUndefined();
  });

  it("overwrites cleanly on repeated binds and leaves no leftover tmp files", async () => {
    await writeHarnessContext(cwd, workflow);
    await writeHarnessContext(cwd, { ...workflow, name: "renamed", definitionId: 9999 });
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: { name: "renamed", definitionId: 9999 } });

    const entries = await fs.readdir(path.join(cwd, ".sapiom"));
    expect(entries).toEqual(["harness-context.json"]);
  });

  it("does not throw when the cwd is unwritable (logs and returns)", async () => {
    const unwritable = path.join(cwd, "does", "not", "exist", "deeply");
    // mkdir with recursive:true inside writeHarnessContext will actually
    // succeed here (it creates missing dirs) — use a path that collides with
    // a file instead, which mkdir cannot create a directory through.
    const blockedFile = path.join(cwd, "blocked");
    await fs.writeFile(blockedFile, "x");
    await expect(writeHarnessContext(blockedFile, workflow)).resolves.toBeUndefined();
  });
});
