import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import { harnessContextFileExists, writeHarnessContext, type WorkspaceContextSession } from "./workspace-context.js";

const workflow: WorkflowInfo = {
  name: "leasing",
  path: "/Users/demo/acme-app/leasing",
  definitionId: 4821,
  definitionSlug: "leasing",
  source: "scan",
};

const otherWorkflow: WorkflowInfo = {
  name: "billing",
  path: "/Users/demo/acme-app/billing",
  definitionId: 4822,
  definitionSlug: "billing",
  source: "scan",
};

describe("writeHarnessContext", () => {
  let cwd: string;
  let session: WorkspaceContextSession;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-context-test-"));
    session = { id: "sess-1", cwd, harness: "claude-code" };
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function readContext(): Promise<unknown> {
    const raw = await fs.readFile(path.join(cwd, ".sapiom", "harness-context.json"), "utf8");
    return JSON.parse(raw);
  }

  it("creates .sapiom/ and writes a bound workflow", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    const context = await readContext();
    expect(context).toMatchObject({
      boundWorkflow: { name: "leasing", path: "/Users/demo/acme-app/leasing", definitionId: 4821 },
    });
    expect(typeof (context as { updatedAt: string }).updatedAt).toBe("string");
  });

  it("writes boundWorkflow: null for an unbound/never-bound session", async () => {
    await writeHarnessContext(session, null, []);
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: null });
  });

  it("unbind writes null rather than deleting the file (no ENOENT race for a concurrent reader)", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    await writeHarnessContext(session, null, [workflow]);
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: null });
    // The file must still exist (only its content changed).
    await expect(fs.access(path.join(cwd, ".sapiom", "harness-context.json"))).resolves.toBeUndefined();
  });

  it("overwrites cleanly on repeated binds and leaves no leftover tmp files", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    const renamed = { ...workflow, name: "renamed", definitionId: 9999 };
    await writeHarnessContext(session, renamed, [renamed]);
    const context = await readContext();
    expect(context).toMatchObject({ boundWorkflow: { name: "renamed", definitionId: 9999 } });

    const entries = await fs.readdir(path.join(cwd, ".sapiom"));
    expect(entries).toEqual(["harness-context.json"]);
  });

  it("does not throw when the cwd is unwritable (logs and returns)", async () => {
    // mkdir with recursive:true inside writeHarnessContext will actually
    // succeed here (it creates missing dirs) — use a path that collides with
    // a file instead, which mkdir cannot create a directory through.
    const blockedFile = path.join(cwd, "blocked");
    await fs.writeFile(blockedFile, "x");
    await expect(
      writeHarnessContext({ ...session, cwd: blockedFile }, workflow, [workflow]),
    ).resolves.toBeUndefined();
  });

  it("writes the full workflows registry, trimmed to {name, path, definitionId} (no source)", async () => {
    await writeHarnessContext(session, null, [workflow, otherWorkflow]);
    const context = (await readContext()) as { workflows: unknown[] };
    expect(context.workflows).toContainEqual({ name: "leasing", path: workflow.path, definitionId: 4821 });
    expect(context.workflows).toContainEqual({ name: "billing", path: otherWorkflow.path, definitionId: 4822 });
    for (const entry of context.workflows) {
      expect(entry).not.toHaveProperty("source");
    }
  });

  it("sorts the workflows array by path, independent of input order, for cheap diffing across writes", async () => {
    await writeHarnessContext(session, null, [workflow, otherWorkflow]); // leasing, then billing
    const first = (await readContext()) as { workflows: Array<{ path: string }> };

    await writeHarnessContext(session, null, [otherWorkflow, workflow]); // billing, then leasing
    const second = (await readContext()) as { workflows: Array<{ path: string }> };

    expect(first.workflows.map((w) => w.path)).toEqual(second.workflows.map((w) => w.path));
    expect(first.workflows.map((w) => w.path)).toEqual([otherWorkflow.path, workflow.path].sort());
  });

  it("includes workflows even when none of them is the bound one", async () => {
    await writeHarnessContext(session, workflow, [workflow, otherWorkflow]);
    const context = (await readContext()) as { boundWorkflow: { path: string }; workflows: Array<{ path: string }> };
    expect(context.boundWorkflow?.path).toBe(workflow.path);
    expect(context.workflows.map((w) => w.path)).toContain(otherWorkflow.path);
  });

  it("embeds the session's own identity", async () => {
    await writeHarnessContext(session, null, []);
    const context = (await readContext()) as { session: { id: string; cwd: string; harness: string } };
    expect(context.session).toEqual({ id: "sess-1", cwd, harness: "claude-code" });
  });

  it("creates .sapiom/ from scratch for a cwd that has never had any file written to it", async () => {
    await expect(fs.access(path.join(cwd, ".sapiom"))).rejects.toThrow();
    await writeHarnessContext(session, null, []);
    await expect(fs.access(path.join(cwd, ".sapiom", "harness-context.json"))).resolves.toBeUndefined();
  });

  it("handles a burst of concurrent writes to the same destination: no rejections, valid JSON, no leftover tmp files, last call wins", async () => {
    // Regression for a real production ENOENT: concurrent writers to one
    // destination (a workflow scan's rewrite-all-open-sessions step racing
    // a bind, for instance) could previously compute the same Date.now()-based
    // tmp filename within the same millisecond and steal each other's tmp
    // file out from under a pending rename.
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeHarnessContext(session, { ...workflow, definitionId: i }, [workflow]),
    );

    const results = await Promise.allSettled(writes);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const context = (await readContext()) as { boundWorkflow: { definitionId: number } };
    // Serialized in call order, not completion order: the last call
    // enqueued must be the one that's actually on disk at the end,
    // regardless of which write's disk I/O happened to finish first.
    expect(context.boundWorkflow.definitionId).toBe(9);

    const entries = await fs.readdir(path.join(cwd, ".sapiom"));
    expect(entries).toEqual(["harness-context.json"]);
  });

  it("interleaves concurrent writes to two different destinations independently", async () => {
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-context-test-other-"));
    const otherSession: WorkspaceContextSession = { id: "sess-2", cwd: otherCwd, harness: "codex" };

    try {
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => writeHarnessContext(session, { ...workflow, definitionId: i }, [])),
        ...Array.from({ length: 5 }, (_, i) =>
          writeHarnessContext(otherSession, { ...otherWorkflow, definitionId: i + 100 }, []),
        ),
      ]);

      const mine = (await readContext()) as { boundWorkflow: { definitionId: number }; session: { id: string } };
      const theirs = JSON.parse(
        await fs.readFile(path.join(otherCwd, ".sapiom", "harness-context.json"), "utf8"),
      ) as { boundWorkflow: { definitionId: number }; session: { id: string } };

      expect(mine.session.id).toBe("sess-1");
      expect(mine.boundWorkflow.definitionId).toBe(4);
      expect(theirs.session.id).toBe("sess-2");
      expect(theirs.boundWorkflow.definitionId).toBe(104);
    } finally {
      await fs.rm(otherCwd, { recursive: true, force: true });
    }
  });
});

describe("harnessContextFileExists", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harness-context-exists-test-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("is false for a cwd that has never had a context file written", async () => {
    await expect(harnessContextFileExists(cwd)).resolves.toBe(false);
  });

  it("is true once writeHarnessContext has run, regardless of bound/unbound", async () => {
    await writeHarnessContext({ id: "sess-1", cwd, harness: "claude-code" }, null, []);
    await expect(harnessContextFileExists(cwd)).resolves.toBe(true);
  });

  it("is false for a cwd that doesn't exist at all", async () => {
    await expect(harnessContextFileExists(path.join(cwd, "nope"))).resolves.toBe(false);
  });
});
