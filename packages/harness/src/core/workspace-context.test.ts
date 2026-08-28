import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WorkflowInfo } from "../shared/types.js";
import {
  prepareHarnessContextForResume,
  stageHarnessContextForPublication,
  writeHarnessContext,
  writeHarnessContextForLaunch,
  type WorkspaceContextSession,
} from "./workspace-context.js";

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
    const raw = await fs.readFile(
      path.join(cwd, ".sapiom", "harness-context.json"),
      "utf8",
    );
    return JSON.parse(raw);
  }

  it("creates .sapiom/ and writes a bound agent without legacy keys", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    const context = await readContext();
    expect(context).toMatchObject({
      boundAgent: {
        name: "leasing",
        path: "/Users/demo/acme-app/leasing",
        definitionId: 4821,
      },
    });
    expect(context).not.toHaveProperty("boundWorkflow");
    expect(context).not.toHaveProperty("workflows");
    expect(typeof (context as { updatedAt: string }).updatedAt).toBe("string");
  });

  it("writes boundAgent: null for an unbound/never-bound session", async () => {
    await writeHarnessContext(session, null, []);
    const context = await readContext();
    expect(context).toMatchObject({ boundAgent: null });
  });

  it("unbind writes null rather than deleting the file (no ENOENT race for a concurrent reader)", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    await writeHarnessContext(session, null, [workflow]);
    const context = await readContext();
    expect(context).toMatchObject({ boundAgent: null });
    // The file must still exist (only its content changed).
    await expect(
      fs.access(path.join(cwd, ".sapiom", "harness-context.json")),
    ).resolves.toBeUndefined();
  });

  it("overwrites cleanly on repeated binds and leaves no leftover tmp files", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    const renamed = { ...workflow, name: "renamed", definitionId: 9999 };
    await writeHarnessContext(session, renamed, [renamed]);
    const context = await readContext();
    expect(context).toMatchObject({
      boundAgent: { name: "renamed", definitionId: 9999 },
    });

    const entries = await fs.readdir(path.join(cwd, ".sapiom"));
    expect(entries).toEqual(["harness-context.json"]);
  });

  it("keeps staged publication invisible until synchronous commit and discards superseded stages", async () => {
    await writeHarnessContext(session, workflow, [workflow]);
    const staged = await stageHarnessContextForPublication(
      session,
      otherWorkflow,
      [otherWorkflow],
      () => true,
    );
    expect(staged).not.toBeNull();
    expect((await readContext()) as object).toMatchObject({
      boundAgent: { name: "leasing" },
    });

    staged!.commit();
    expect((await readContext()) as object).toMatchObject({
      boundAgent: { name: "billing" },
    });

    const discarded = await stageHarnessContextForPublication(
      session,
      workflow,
      [workflow],
      () => true,
    );
    discarded!.discard();
    expect((await readContext()) as object).toMatchObject({
      boundAgent: { name: "billing" },
    });
    expect(await fs.readdir(path.join(cwd, ".sapiom"))).toEqual([
      "harness-context.json",
    ]);
  });

  it("does not throw when the cwd is unwritable (logs and returns)", async () => {
    // mkdir with recursive:true inside writeHarnessContext will actually
    // succeed here (it creates missing dirs) — use a path that collides with
    // a file instead, which mkdir cannot create a directory through.
    const blockedFile = path.join(cwd, "blocked");
    await fs.writeFile(blockedFile, "x");
    await expect(
      writeHarnessContext({ ...session, cwd: blockedFile }, workflow, [
        workflow,
      ]),
    ).resolves.toBeUndefined();
  });

  it("strict launch writes reject instead of spawning with a stale context contract", async () => {
    const blockedFile = path.join(cwd, "blocked-launch");
    await fs.writeFile(blockedFile, "x");

    await expect(
      writeHarnessContextForLaunch({ ...session, cwd: blockedFile }, workflow, [
        workflow,
      ]),
    ).rejects.toThrow();
  });

  it("writes the full agents registry, trimmed to {name, path, definitionId} (no source)", async () => {
    await writeHarnessContext(session, null, [workflow, otherWorkflow]);
    const context = (await readContext()) as { agents: unknown[] };
    expect(context.agents).toContainEqual({
      name: "leasing",
      path: workflow.path,
      definitionId: 4821,
    });
    expect(context.agents).toContainEqual({
      name: "billing",
      path: otherWorkflow.path,
      definitionId: 4822,
    });
    for (const entry of context.agents) {
      expect(entry).not.toHaveProperty("source");
    }
  });

  it("sorts the agents array by path, independent of input order, for cheap diffing across writes", async () => {
    await writeHarnessContext(session, null, [workflow, otherWorkflow]); // leasing, then billing
    const first = (await readContext()) as { agents: Array<{ path: string }> };

    await writeHarnessContext(session, null, [otherWorkflow, workflow]); // billing, then leasing
    const second = (await readContext()) as { agents: Array<{ path: string }> };

    expect(first.agents.map((w) => w.path)).toEqual(
      second.agents.map((w) => w.path),
    );
    expect(first.agents.map((w) => w.path)).toEqual(
      [otherWorkflow.path, workflow.path].sort(),
    );
  });

  it("includes agents even when none of them is the bound one", async () => {
    await writeHarnessContext(session, workflow, [workflow, otherWorkflow]);
    const context = (await readContext()) as {
      boundAgent: { path: string };
      agents: Array<{ path: string }>;
    };
    expect(context.boundAgent?.path).toBe(workflow.path);
    expect(context.agents.map((w) => w.path)).toContain(otherWorkflow.path);
  });

  it("embeds the session's own identity", async () => {
    await writeHarnessContext(session, null, []);
    const context = (await readContext()) as {
      session: { id: string; cwd: string; harness: string };
    };
    expect(context.session).toEqual({
      id: "sess-1",
      cwd,
      harness: "claude-code",
    });
  });

  it("creates .sapiom/ from scratch for a cwd that has never had any file written to it", async () => {
    await expect(fs.access(path.join(cwd, ".sapiom"))).rejects.toThrow();
    await writeHarnessContext(session, null, []);
    await expect(
      fs.access(path.join(cwd, ".sapiom", "harness-context.json")),
    ).resolves.toBeUndefined();
  });

  it("handles a burst of concurrent writes to the same destination: no rejections, valid JSON, no leftover tmp files, last call wins", async () => {
    // Regression for a real production ENOENT: concurrent writers to one
    // destination (a workflow scan's rewrite-all-open-sessions step racing
    // a bind, for instance) could previously compute the same Date.now()-based
    // tmp filename within the same millisecond and steal each other's tmp
    // file out from under a pending rename.
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeHarnessContext(session, { ...workflow, definitionId: i }, [
        workflow,
      ]),
    );

    const results = await Promise.allSettled(writes);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const context = (await readContext()) as {
      boundAgent: { definitionId: number };
    };
    // Serialized in call order, not completion order: the last call
    // enqueued must be the one that's actually on disk at the end,
    // regardless of which write's disk I/O happened to finish first.
    expect(context.boundAgent.definitionId).toBe(9);

    const entries = await fs.readdir(path.join(cwd, ".sapiom"));
    expect(entries).toEqual(["harness-context.json"]);
  });

  it("interleaves concurrent writes to two different destinations independently", async () => {
    const otherCwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-context-test-other-"),
    );
    const otherSession: WorkspaceContextSession = {
      id: "sess-2",
      cwd: otherCwd,
      harness: "codex",
    };

    try {
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          writeHarnessContext(session, { ...workflow, definitionId: i }, []),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          writeHarnessContext(
            otherSession,
            { ...otherWorkflow, definitionId: i + 100 },
            [],
          ),
        ),
      ]);

      const mine = (await readContext()) as {
        boundAgent: { definitionId: number };
        session: { id: string };
      };
      const theirs = JSON.parse(
        await fs.readFile(
          path.join(otherCwd, ".sapiom", "harness-context.json"),
          "utf8",
        ),
      ) as { boundAgent: { definitionId: number }; session: { id: string } };

      expect(mine.session.id).toBe("sess-1");
      expect(mine.boundAgent.definitionId).toBe(4);
      expect(theirs.session.id).toBe("sess-2");
      expect(theirs.boundAgent.definitionId).toBe(104);
    } finally {
      await fs.rm(otherCwd, { recursive: true, force: true });
    }
  });
});

describe("prepareHarnessContextForResume", () => {
  let cwd: string;
  let session: WorkspaceContextSession;
  let contextPath: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "harness-context-resume-test-"),
    );
    session = { id: "current-session", cwd, harness: "claude-code" };
    contextPath = path.join(cwd, ".sapiom", "harness-context.json");
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function writeRaw(raw: string): Promise<void> {
    await fs.mkdir(path.dirname(contextPath), { recursive: true });
    await fs.writeFile(contextPath, raw, "utf8");
  }

  async function readParsed(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(contextPath, "utf8")) as Record<
      string,
      unknown
    >;
  }

  it("leaves an already-current schema byte-for-byte untouched", async () => {
    const raw = JSON.stringify({
      boundAgent: { name: "saved", path: "/saved", definitionId: 7 },
      agents: [{ name: "saved", path: "/saved", definitionId: 7 }],
      session: { id: "saved-session", cwd: "/saved", harness: "codex" },
      updatedAt: "2025-01-02T03:04:05.000Z",
    });
    await writeRaw(raw);

    await expect(
      prepareHarnessContextForResume(session, workflow, [workflow]),
    ).resolves.toBe("current");
    await expect(fs.readFile(contextPath, "utf8")).resolves.toBe(raw);
  });

  it("translates a valid legacy schema while preserving all saved values", async () => {
    const legacy = {
      boundWorkflow: { name: "saved", path: "/saved", definitionId: 7 },
      workflows: [{ name: "other", path: "/other", definitionId: null }],
      session: { id: "saved-session", cwd: "/saved", harness: "codex" },
      updatedAt: "2025-01-02T03:04:05.000Z",
    };
    await writeRaw(JSON.stringify(legacy));

    await expect(
      prepareHarnessContextForResume(session, workflow, [workflow]),
    ).resolves.toBe("migrated");
    const migrated = await readParsed();
    expect(migrated).toEqual({
      boundAgent: legacy.boundWorkflow,
      agents: legacy.workflows,
      session: legacy.session,
      updatedAt: legacy.updatedAt,
    });
    expect(migrated).not.toHaveProperty("boundWorkflow");
    expect(migrated).not.toHaveProperty("workflows");
  });

  it("rebuilds a missing file from the current session, binding, and registry", async () => {
    await expect(
      prepareHarnessContextForResume(session, workflow, [
        otherWorkflow,
        workflow,
      ]),
    ).resolves.toBe("rewritten");

    expect(await readParsed()).toMatchObject({
      boundAgent: {
        name: workflow.name,
        path: workflow.path,
        definitionId: workflow.definitionId,
      },
      agents: [
        {
          name: otherWorkflow.name,
          path: otherWorkflow.path,
          definitionId: otherWorkflow.definitionId,
        },
        {
          name: workflow.name,
          path: workflow.path,
          definitionId: workflow.definitionId,
        },
      ],
      session: { id: "current-session", cwd, harness: "claude-code" },
    });
  });

  it("rebuilds malformed JSON from the current state", async () => {
    await writeRaw("{ nope");

    await expect(
      prepareHarnessContextForResume(session, null, [workflow]),
    ).resolves.toBe("rewritten");
    expect(await readParsed()).toMatchObject({
      boundAgent: null,
      agents: [
        {
          name: workflow.name,
          path: workflow.path,
          definitionId: workflow.definitionId,
        },
      ],
      session: { id: "current-session", cwd, harness: "claude-code" },
    });
  });

  it.each([
    ["incomplete", { boundAgent: null, agents: [] }],
    [
      "mixed legacy/current",
      {
        boundAgent: null,
        agents: [],
        boundWorkflow: null,
        workflows: [],
        session: { id: "old", cwd: "/old", harness: "codex" },
        updatedAt: "old",
      },
    ],
    [
      "invalid current value",
      {
        boundAgent: { name: "bad", path: 42, definitionId: null },
        agents: [],
        session: { id: "old", cwd: "/old", harness: "codex" },
        updatedAt: "old",
      },
    ],
  ])("rebuilds a %s schema instead of exposing it", async (_label, saved) => {
    await writeRaw(JSON.stringify(saved));

    await expect(
      prepareHarnessContextForResume(session, workflow, [workflow]),
    ).resolves.toBe("rewritten");
    const rewritten = await readParsed();
    expect(rewritten).toMatchObject({
      boundAgent: { name: workflow.name, path: workflow.path },
      agents: [{ name: workflow.name, path: workflow.path }],
      session: { id: "current-session", cwd, harness: "claude-code" },
    });
    expect(rewritten).not.toHaveProperty("boundWorkflow");
    expect(rewritten).not.toHaveProperty("workflows");
  });

  it("rejects resume when an existing path cannot be read as a file", async () => {
    await fs.mkdir(contextPath, { recursive: true });

    await expect(
      prepareHarnessContextForResume(session, workflow, [workflow]),
    ).rejects.toThrow();
  });
});
