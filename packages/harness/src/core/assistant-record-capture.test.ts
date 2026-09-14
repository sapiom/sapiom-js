import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AssistantRecordCapture,
  reconcileAssistantRecord,
} from "./assistant-record-capture.js";
import { AssistantRecordStore } from "./assistant-record-store.js";
import { sourceFixture } from "./test-fixtures/assistant-context.js";
import { projectAssistantRecord } from "./assistant-record.js";
import type { HostedOpenCode } from "./opencode-host.js";

let root: string, store: AssistantRecordStore, capture: AssistantRecordCapture;
let abort: AbortController;
const binding = {
  harnessSessionId: "studio-a",
  contextAuthorityScope: "a".repeat(64),
  conversationId: "ses_fixture",
  cwd: "/workspace",
};
const native = (text: string, id = "msg_user", created = 1) => [
  {
    info: { id, sessionID: "ses_fixture", role: "user", time: { created } },
    parts: [
      {
        id: `${id}_text`,
        messageID: id,
        sessionID: "ses_fixture",
        type: "text",
        text,
      },
    ],
  },
];
const fetch = vi.fn();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "assistant-capture-"));
  store = new AssistantRecordStore(root);
  abort = new AbortController();
  const hosted = {
    ...binding,
    signal: abort.signal,
    isCurrent: () => !abort.signal.aborted,
    server: { fetch },
  } as unknown as HostedOpenCode;
  capture = new AssistantRecordCapture(hosted, "ses_fixture", store);
  fetch
    .mockReset()
    .mockImplementation(async () => Response.json(native("Latest")));
});
afterEach(async () => {
  capture.dispose();
  abort.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("coalesces concurrent explicit checkpoints into one active read and one catch-up", async () => {
  let release!: (value: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const first = capture.checkpoint();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  for (let i = 0; i < 100; i++) expect(capture.checkpoint()).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  release(Response.json(native("Earlier")));
  await first;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    (await store.read(binding))?.turns[0]?.messages[0]?.parts[0],
  ).toMatchObject({ text: "Latest" });
});

it("bounds sustained background capture and lets explicit checkpoints flush without a delayed duplicate", async () => {
  vi.spyOn(store, "reserve").mockResolvedValue(1);
  vi.spyOn(store, "read").mockResolvedValue(null);
  const write = vi.spyOn(store, "write").mockResolvedValue(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await capture.checkpoint();
  for (let i = 0; i < 40; i++) {
    capture.invalidate();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(write).toHaveBeenCalledTimes(3);
  capture.invalidate();
  await capture.checkpoint();
  expect(fetch).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(4);
  capture.invalidate();
  abort.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains a previous checkpoint after native failure and refuses a late retired response", async () => {
  await capture.checkpoint();
  const previous = await store.read(binding);
  fetch.mockRejectedValueOnce(new Error("offline"));
  await capture.checkpoint();
  expect(capture.unavailable).toBe(true);
  expect(await store.read(binding)).toEqual(previous);
  let release!: (value: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const pending = capture.checkpoint();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  abort.abort();
  release(Response.json(native("Late")));
  await pending;
  expect(await store.read(binding)).toEqual(previous);
});

it("reserves revisions across stores before IO so old responses cannot overwrite newer runtime records", async () => {
  const old = await store.reserve(binding);
  const replacement = new AssistantRecordStore(root);
  const next = await replacement.reserve(binding);
  await replacement.write(
    projectAssistantRecord(native("New runtime"), binding, next),
  );
  expect(
    await store.write(
      projectAssistantRecord(native("Old runtime"), binding, old),
    ),
  ).toBe(false);
  expect((await store.read(binding))?.revision).toBe(next);
});

it("preserves public content and accepted provenance when native snapshots omit old turns", () => {
  const previous = projectAssistantRecord(native("Original"), binding, 1);
  const {
    context: _context,
    instructionSet: _instructions,
    ...ref
  } = sourceFixture().accepted;
  previous.turns[0]!.acceptedContext = ref;
  const next = projectAssistantRecord(
    native("New task", "msg_next", 2),
    binding,
    2,
  );
  const retained = reconcileAssistantRecord(previous, next);
  expect(retained.turns[0]!.acceptedContext).toEqual(ref);
  expect(retained.turns.map((turn) => turn.id)).toEqual([
    "msg_user",
    "msg_next",
  ]);
  expect(retained.turns[0]!.messages[0]!.parts[0]).toMatchObject({
    text: "Original",
  });
  expect(() =>
    reconcileAssistantRecord(previous, {
      ...next,
      binding: { ...binding, conversationId: "ses_other" },
    }),
  ).toThrow();
});

it("bounds native reads and preserves an earlier checkpoint on oversized history", async () => {
  await capture.checkpoint();
  const previous = await store.read(binding);
  fetch.mockResolvedValueOnce(new Response(" ".repeat(16 * 1024 * 1024 + 1)));
  await capture.checkpoint();
  expect(capture.unavailable).toBe(true);
  expect(await store.read(binding)).toEqual(previous);
});
