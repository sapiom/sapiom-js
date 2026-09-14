import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRecordStore } from "./assistant-record-store.js";
import { projectAssistantRecord } from "./assistant-record.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
let root: string, store: AssistantRecordStore;
const binding = {
  harnessSessionId: "studio-a",
  contextAuthorityScope: "a".repeat(64),
  conversationId: "ses_original",
  cwd: "/workspace",
};
const record = (revision: number) =>
  projectAssistantRecord(
    [
      {
        info: {
          id: "msg_user",
          sessionID: binding.conversationId,
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part_text",
            messageID: "msg_user",
            sessionID: binding.conversationId,
            type: "text",
            text: "Retain me",
          },
        ],
      },
    ],
    binding,
    revision,
  );
const directory = () =>
  join(
    root,
    "assistant-sessions",
    binding.harnessSessionId,
    "bindings",
    binding.contextAuthorityScope,
  );
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "assistant-record-"));
  store = new AssistantRecordStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it("reads absence separately from damaged or mismatched retained history", async () => {
  expect(await store.read(binding)).toBeNull();
  await fs.writeFile(join(directory(), "record.json"), "malformed");
  await expect(store.read(binding)).rejects.toMatchObject({
    code: "record_unavailable",
  });
  await fs.writeFile(
    join(directory(), "record.json"),
    JSON.stringify({ ...record(1), revision: "bad" }),
  );
  await expect(store.read(binding)).rejects.toMatchObject({
    code: "corrupt_record",
  });
  await fs.writeFile(
    join(directory(), "record.json"),
    JSON.stringify(record(1)),
  );
  await expect(
    store.read({ ...binding, conversationId: "ses_another" }),
  ).rejects.toMatchObject({ code: "corrupt_record" });
  await expect(
    store.read({ ...binding, cwd: "/another" }),
  ).rejects.toMatchObject({ code: "corrupt_record" });
});

it("keeps the greatest revision across concurrent store instances and delayed results", async () => {
  const other = new AssistantRecordStore(root);
  await Promise.all([
    store.write(record(3)),
    other.write(record(2)),
    store.write(record(5)),
    other.write(record(4)),
  ]);
  expect((await store.read(binding))!.revision).toBe(5);
  expect(await store.write(record(5))).toBe(false);
  expect(await other.write(record(1))).toBe(false);
  expect((await other.read(binding))!.revision).toBe(5);
  const retained = await other.capture([], binding, 6);
  expect(retained.revision).toBe(5);
  expect(retained.turns).toHaveLength(1);
});

it("preserves the previous record after failed publication and survives native-root deletion", async () => {
  await store.write(record(1));
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error("disk write failure"));
  await expect(store.write(record(2))).rejects.toMatchObject({
    code: "record_unavailable",
  });
  expect((await store.read(binding))!.revision).toBe(1);
  expect(await fs.readdir(directory())).toEqual(["record.json"]);
  const nativeRoot = join(root, "opencode", "disposable");
  await fs.mkdir(nativeRoot, { recursive: true });
  await fs.writeFile(join(nativeRoot, "association.json"), "native state");
  await fs.rm(nativeRoot, { recursive: true });
  expect(
    (await new AssistantRecordStore(root).read(binding))!.turns[0]!.messages[0]!
      .parts[0],
  ).toMatchObject({ text: "Retain me" });
});

it("rejects unsafe paths, symlinks, oversized files, and mutated caller-owned records", async () => {
  await expect(
    store.read({ ...binding, harnessSessionId: "../other" }),
  ).rejects.toMatchObject({ code: "invalid_history" });
  await store.read(binding);
  const external = join(root, "external.json");
  await fs.writeFile(external, JSON.stringify(record(1)));
  await fs.symlink(external, join(directory(), "record.json"));
  await expect(store.read(binding)).rejects.toMatchObject({
    code: "record_unavailable",
  });
  await fs.rm(join(directory(), "record.json"));
  await fs.writeFile(join(directory(), "record.json"), " ".repeat(65537));
  await expect(store.read(binding)).rejects.toMatchObject({
    code: "record_unavailable",
  });
  await fs.rm(join(directory(), "record.json"));
  const input = record(1),
    write = store.write(input);
  input.binding.cwd = "/changed-after-call";
  await write;
  expect((await store.read(binding))!.binding.cwd).toBe(binding.cwd);
});

it.each([
  "missing-proof",
  "wrong-message",
  "stale-proof",
  "public-work",
  "dropped-history",
])("preserves nonempty history when seed exclusion has %s", async (kind) => {
  const prior = record(1);
  if (kind !== "public-work") prior.turns[0]!.messages[0]!.parts = [];
  if (kind === "dropped-history") {
    prior.turnCount = 2;
    prior.messageCount = 2;
    prior.limitations.push("dropped-early-turns");
  }
  await store.write(prior);
  if (kind === "stale-proof")
    await new AssistantRecordStore(root).write({ ...prior, revision: 2 });
  const empty = projectAssistantRecord([], binding, 3);
  expect(
    await store.write(
      empty,
      kind === "missing-proof"
        ? undefined
        : {
            messageId: kind === "wrong-message" ? "msg_other" : "msg_user",
            previousRevision: 1,
          },
    ),
  ).toBe(false);
  expect(await store.read(binding)).toEqual({
    ...prior,
    revision: kind === "stale-proof" ? 2 : 1,
  });
});
