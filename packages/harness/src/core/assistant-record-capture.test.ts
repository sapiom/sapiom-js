import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  AssistantRecordCapture,
  reconcileAssistantRecord,
} from "./assistant-record-capture.js";
import { AssistantRecordStore } from "./assistant-record-store.js";
import { sourceFixture } from "./test-fixtures/assistant-context.js";
import { projectAssistantRecord } from "./assistant-record.js";
import type { HostedOpenCode } from "./opencode-host.js";
import type { AssistantContinuationView } from "../shared/assistant-continuation.js";

let root: string, store: AssistantRecordStore, capture: AssistantRecordCapture;
let abort: AbortController;
let hosted: HostedOpenCode;
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
  hosted = {
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

const seedText = "Recorded context from the completed parent task.";
const continuation: AssistantContinuationView = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceSessionId: "parent",
  sourceRecordRevision: 1,
  capturedAt: "2026-09-14T00:00:00.000Z",
  retainedTurns: 1,
  omittedTurns: 0,
  seed: {
    conversationId: binding.conversationId,
    messageId: "msg_seed",
    partId: "prt_seed",
    text: seedText,
    sha256: createHash("sha256").update(seedText).digest("hex"),
  },
};
function seed() {
  const message = native(seedText, "msg_seed")[0]!;
  Object.assign(message.parts[0]!, {
    id: "prt_seed",
    synthetic: true,
    ignored: false,
    metadata: {
      sapiomContinuation: {
        operationId: continuation.operationId,
        briefHash: continuation.seed.sha256,
      },
    },
  });
  return message;
}
function captureWithAttestation() {
  let attestation: AssistantContinuationView | null = null;
  capture.dispose();
  capture = new AssistantRecordCapture(
    hosted,
    binding.conversationId,
    store,
    async () => attestation,
  );
  return () => {
    attestation = continuation;
  };
}

it("removes a previously captured seed only after exact attestation and corrects its counts", async () => {
  const attest = captureWithAttestation();
  fetch.mockImplementation(async () => Response.json([seed()]));
  await capture.checkpoint();
  expect(await store.read(binding)).toMatchObject({
    turnCount: 1,
    messageCount: 1,
  });
  attest();
  await capture.checkpoint();
  expect(await store.read(binding)).toMatchObject({
    turns: [],
    turnCount: 0,
    messageCount: 0,
  });
  await capture.checkpoint();
  expect(await store.read(binding)).toMatchObject({
    turns: [],
    turnCount: 0,
    messageCount: 0,
  });
});

it("keeps compacted ordinary history while removing the newly attested seed", async () => {
  const attest = captureWithAttestation();
  fetch.mockResolvedValueOnce(
    Response.json([seed(), ...native("Archived task", "msg_old", 2)]),
  );
  await capture.checkpoint();
  attest();
  fetch.mockImplementation(async () =>
    Response.json([seed(), ...native("Next task", "msg_new", 3)]),
  );
  await capture.checkpoint();
  const record = await store.read(binding);
  expect(record).toMatchObject({ turnCount: 2, messageCount: 2 });
  expect(record?.turns.map((turn) => turn.id)).toEqual(["msg_old", "msg_new"]);
});

it("retains real replies to a seed even when the current native snapshot omits them", async () => {
  const attest = captureWithAttestation();
  const answer = native("Real work", "msg_answer", 2)[0]!;
  Object.assign(answer.info, {
    role: "assistant",
    parentID: "msg_seed",
    finish: "stop",
    time: { created: 2, completed: 3 },
  });
  fetch.mockResolvedValueOnce(Response.json([seed(), answer]));
  await capture.checkpoint();
  attest();
  fetch.mockImplementation(async () => Response.json([seed()]));
  await capture.checkpoint();
  const record = await store.read(binding);
  expect(record).toMatchObject({ turnCount: 1, messageCount: 2 });
  expect(record?.turns[0]?.messages[1]?.parts[0]).toMatchObject({
    text: "Real work",
  });
});

it.each(["absent", "changed-marker", "ordinary"])(
  "does not remove a prior seed from %s native input",
  async (kind) => {
    const attest = captureWithAttestation();
    fetch.mockResolvedValueOnce(Response.json([seed()]));
    await capture.checkpoint();
    attest();
    const current = seed();
    if (kind === "changed-marker")
      Object.assign(current.parts[0]!, { metadata: {} });
    if (kind === "ordinary")
      Object.assign(current.parts[0]!, {
        synthetic: false,
        text: "Human task",
      });
    fetch.mockImplementation(async () =>
      Response.json(kind === "absent" ? [] : [current]),
    );
    await capture.checkpoint();
    expect(await store.read(binding)).toMatchObject({
      turnCount: 1,
      messageCount: 1,
    });
  },
);
