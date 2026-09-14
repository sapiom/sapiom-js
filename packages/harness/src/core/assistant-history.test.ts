import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  root = await mkdtemp(join(tmpdir(), "assistant-discovery-"));
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
