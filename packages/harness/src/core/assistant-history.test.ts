import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantHistory } from "./assistant-history.js";
import { AssistantRecordStore } from "./assistant-record-store.js";
import {
  AssistantSessionStore,
  type AssistantAssociation,
} from "./assistant-session-store.js";
import { OpenCodeAccessError } from "./opencode-host.js";
import type { HarnessSession } from "../shared/types.js";
import type { AssistantRecord } from "../shared/assistant-record.js";

let root: string,
  cwd: string,
  records: AssistantRecordStore,
  sessions: HarnessSession[],
  store: AssistantSessionStore,
  history: AssistantHistory;
let bindings: Map<string, AssistantAssociation>;
const authorize = vi.fn();
const record = (binding: AssistantAssociation): AssistantRecord => ({
  schemaVersion: 1,
  binding: {
    harnessSessionId: binding.harnessSessionId,
    conversationId: binding.conversationId,
    contextAuthorityScope: binding.contextAuthorityScope,
    cwd: binding.cwd,
  },
  revision: 1,
  capturedAt: "2026-09-14T10:00:00.000Z",
  reconstructed: true,
  turns: [],
  turnCount: 0,
  messageCount: 0,
  limitations: [],
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "assistant-discovery-")));
  cwd = join(root, "project");
  await mkdir(cwd);
  store = new AssistantSessionStore(root);
  records = new AssistantRecordStore(root);
  bindings = new Map();
  sessions = [];
  for (const [index, id] of [
    "studio-a",
    "studio-b",
    "terminal-only",
  ].entries()) {
    sessions.push({
      id,
      cwd,
      harness: "claude-code",
      title: id,
      status: "exited",
      ready: false,
      agentSessionId: null,
      boundWorkflowPath: null,
      terminalState: "not-started",
      createdAt: "2026-09-14T09:00:00.000Z",
      lastActiveAt: "2026-09-14T09:00:00.000Z",
    });
    if (index === 2) continue;
    const binding = await store.associate(
      {
        harnessSessionId: id,
        cwd,
        contextAuthorityScope: String(index + 1).repeat(64),
      },
      String(index + 3).repeat(64),
      async () => `ses_${index}`,
    );
    bindings.set(id, binding!);
    await store.transition(id, 0, { lifecycle: "ended", execution: "paused" });
    await records.write(record(binding!));
  }
  authorize
    .mockReset()
    .mockImplementation(async (id) => bindings.get(id) ?? null);
  history = new AssistantHistory({
    sessions: {
      list: () => sessions,
      get: (id) => sessions.find((s) => s.id === id),
    },
    authorize,
    records,
    lifecycle: { describe: async (id) => (await store.lifecycle(id))! },
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("discovers distinct same-folder Assistant identities with no Terminal vendor or native runtime", async () => {
  const result = await history.list(cwd);
  expect(result.map((entry) => entry.harnessSessionId)).toEqual([
    "studio-a",
    "studio-b",
  ]);
  expect(result[0]).toMatchObject({
    kind: "assistant",
    history: "available",
    nativeResume: "unchecked",
    recordRevision: 1,
    lifecycle: { lifecycle: "ended" },
  });
  expect(JSON.stringify(result)).not.toContain("contextAuthorityScope");
  expect(JSON.stringify(result)).not.toContain("conversationId");
  const other = join(root, "other");
  await mkdir(other);
  expect(await history.list(other)).toEqual([]);
});

it("provides stable opaque Continue retry scope only for an authorized project identity", async () => {
  const session = sessions[0]!;
  expect((await history.entry(session.id))?.continuationScope).toBeUndefined();
  session.agentMapIdentity = {
    sessionId: session.id,
    projectId: "project-a",
    userId: "user-a",
  };
  const before = (await history.entry(session.id))!.continuationScope!;
  expect(before).toMatch(/^[a-f\d]{64}$/);
  expect((await history.entry(session.id))?.continuationScope).toBe(before);
  for (const update of [
    () => Object.assign(session.agentMapIdentity!, { projectId: "project-b" }),
    () => Object.assign(session.agentMapIdentity!, { userId: "user-b" }),
    () => Object.assign(session, { harness: "codex" }),
    () =>
      Object.assign(bindings.get(session.id)!, { conversationId: "ses_new" }),
    () =>
      Object.assign(bindings.get(session.id)!, {
        contextAuthorityScope: "9".repeat(64),
      }),
  ]) {
    const previous = (await history.entry(session.id))!.continuationScope;
    update();
    expect((await history.entry(session.id))!.continuationScope).not.toBe(
      previous,
    );
  }
});

it("rejects a project rebind during retained history IO", async () => {
  const session = sessions[0]!;
  session.agentMapIdentity = {
    sessionId: session.id,
    projectId: "project-a",
    userId: "user-a",
  };
  const read = records.read.bind(records);
  vi.spyOn(records, "read").mockImplementationOnce(async (binding) => {
    const value = await read(binding);
    Object.assign(session.agentMapIdentity!, { projectId: "project-b" });
    return value;
  });
  await expect(history.entry(session.id)).rejects.toThrow(OpenCodeAccessError);
});

it("distinguishes missing, partial and failed retained records", async () => {
  const first = bindings.get("studio-a")!;
  await records.write({
    ...record(first),
    revision: 2,
    limitations: ["private-parts-omitted"],
  });
  expect((await history.entry("studio-a"))?.history).toBe("partial");
  const directory = join(
    root,
    "assistant-sessions",
    "studio-a",
    "bindings",
    first.contextAuthorityScope,
  );
  await rm(join(directory, "record.json"));
  await rm(join(directory, "record.json.previous"), { force: true });
  expect((await history.entry("studio-a"))?.history).toBe("missing");
  await writeFile(join(directory, "record.json"), "invalid");
  expect((await history.entry("studio-a"))?.history).toBe("unavailable");
});

it("retains discovery after native data disappears", async () => {
  await rm(join(root, "opencode"), { recursive: true, force: true });
  expect((await history.list(cwd)).map((entry) => entry.history)).toEqual([
    "available",
    "available",
  ]);
});

it("proves a real query alias and each current launch spelling against the saved canonical binding", async () => {
  const query = join(root, "query-alias"),
    launch = join(root, "launch-alias");
  await symlink(cwd, query, "junction");
  await symlink(cwd, launch, "junction");
  sessions[0]!.cwd = launch;
  const result = await history.listWithWorkspace(query);
  expect(result.workspace).toEqual({ cwd: query, canonicalCwd: cwd });
  expect(result.entries).toHaveLength(2);
  expect(result.entries[0]).toMatchObject({
    cwd,
    workspace: { cwd: launch, canonicalCwd: cwd },
    history: "available",
  });
  expect(result.entries[1]!.workspace).toEqual({ cwd, canonicalCwd: cwd });
  await rm(query);
  await mkdir(query);
  expect(await history.listWithWorkspace(query)).toEqual({
    workspace: { cwd: query, canonicalCwd: query },
    entries: [],
  });
});

it.each(["raw rebind", "launch retarget", "query retarget"])(
  "fences %s during retained history IO",
  async (change) => {
    const alias = join(root, "alias"),
      other = join(root, "other");
    await symlink(cwd, alias, "junction");
    await mkdir(other);
    if (change !== "query retarget") sessions[0]!.cwd = alias;
    const read = records.read.bind(records);
    vi.spyOn(records, "read").mockImplementationOnce(async (binding) => {
      const value = await read(binding);
      if (change === "raw rebind") sessions[0]!.cwd = cwd;
      else {
        await rm(alias);
        await symlink(other, alias, "junction");
      }
      return value;
    });
    await expect(
      change === "query retarget"
        ? history.listWithWorkspace(alias)
        : history.entry("studio-a"),
    ).rejects.toThrow(OpenCodeAccessError);
  },
);

it("rechecks earlier entries' raw spelling after the rest of the list", async () => {
  const alias = join(root, "alias");
  await symlink(cwd, alias, "junction");
  const original = authorize.getMockImplementation()!;
  let calls = 0;
  authorize.mockImplementation(async (id) => {
    if (id === "studio-a" && ++calls === 3) sessions[0]!.cwd = alias;
    return original(id);
  });
  await expect(history.listWithWorkspace(cwd)).rejects.toThrow(
    OpenCodeAccessError,
  );
});

it.each(["raw", "target"])(
  "fences an earlier entry's %s change during final authorization of its sibling",
  async (change) => {
    const alias = join(root, "alias"),
      other = join(root, "other");
    await symlink(cwd, alias, "junction");
    await mkdir(other);
    sessions[0]!.cwd = alias;
    let calls = 0;
    authorize.mockImplementation(async (id) => {
      if (id === "studio-b" && ++calls === 3) {
        if (change === "raw") sessions[0]!.cwd = cwd;
        else {
          await rm(alias);
          await symlink(other, alias, "junction");
        }
      }
      return bindings.get(id) ?? null;
    });
    await expect(history.listWithWorkspace(cwd)).rejects.toThrow(
      OpenCodeAccessError,
    );
  },
);

it("discards a read whose binding changes before it returns", async () => {
  authorize
    .mockResolvedValueOnce(bindings.get("studio-a"))
    .mockResolvedValueOnce({
      ...bindings.get("studio-a"),
      contextAuthorityScope: "f".repeat(64),
    });
  await expect(history.entry("studio-a")).rejects.toBeInstanceOf(
    OpenCodeAccessError,
  );
});

it("checks earlier entries again after reading the rest of a history list", async () => {
  let calls = 0;
  authorize.mockImplementation(async (id) => {
    const binding = bindings.get(id) ?? null;
    if (id !== "studio-a") return binding;
    calls++;
    return calls < 3
      ? binding
      : { ...binding, contextAuthorityScope: "f".repeat(64) };
  });
  await expect(history.list(cwd)).rejects.toBeInstanceOf(OpenCodeAccessError);
});

it("omits unauthorized entries and surfaces corrupt lifecycle metadata", async () => {
  authorize.mockRejectedValue(new OpenCodeAccessError("expired"));
  expect(await history.list(cwd)).toEqual([]);
  authorize.mockImplementation(async (id) => bindings.get(id) ?? null);
  await writeFile(
    join(root, "assistant-sessions", "studio-a", "lifecycle.json"),
    "corrupt",
  );
  await expect(history.list(cwd)).rejects.toThrow();
});
