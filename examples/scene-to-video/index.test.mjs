import assert from "node:assert/strict";
import test from "node:test";

import { agent, normalizeClipDuration, resolveClipInputs } from "./index.ts";

function stitchContext(clips, { create, getDownloadUrl } = {}) {
  const shared = new Map([
    ["scene", "paper boat"],
    ["clips", clips],
  ]);
  return {
    shared: {
      get: (key) => shared.get(key),
      set: (key, value) => shared.set(key, value),
    },
    sapiom: {
      contentGeneration: {
        video: {
          create:
            create ??
            (async () => {
              throw new Error("merge should not run");
            }),
        },
      },
      fileStorage: {
        getDownloadUrl:
          getDownloadUrl ??
          (async (fileId) => ({ downloadUrl: `https://clip/${fileId}` })),
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

test("normalizes clip duration to the nearest supported Kling value", () => {
  assert.equal(normalizeClipDuration(5), 5);
  assert.equal(normalizeClipDuration(6), 5);
  assert.equal(normalizeClipDuration(7.49), 5);
  assert.equal(normalizeClipDuration(7.5), 10);
  assert.equal(normalizeClipDuration(10), 10);
  assert.equal(normalizeClipDuration(undefined), 10);
});

test("keeps each resolved URL paired with its originating clip", async () => {
  const first = { fileId: "first-file" };
  const second = { fileId: "second-file", downloadUrl: "https://clip/second" };

  const resolved = await resolveClipInputs([first, second], async (fileId) => ({
    downloadUrl: `https://clip/${fileId}`,
  }));

  assert.deepEqual(resolved, [
    { clip: first, url: "https://clip/first-file" },
    { clip: second, url: "https://clip/second" },
  ]);
});

test("fails instead of silently truncating a multi-clip scene", async () => {
  await assert.rejects(
    resolveClipInputs(
      [{ fileId: "first-file" }, { fileId: "missing-file" }],
      async (fileId) => ({
        downloadUrl: fileId === "first-file" ? "https://clip/first" : "",
      }),
    ),
    /clip 2 has no usable download URL/,
  );
});

test("rejects an empty clip collection before calling merge", async () => {
  await assert.rejects(
    resolveClipInputs([], async () => ({ downloadUrl: "unused" })),
    /no clips were collected/,
  );
});

test("stitch bypasses merge only for an actual one-clip scene", async () => {
  const directive = await agent.steps.stitch.run(
    {},
    stitchContext([{ fileId: "only-file", downloadUrl: "https://clip/only" }]),
  );

  assert.equal(directive.kind, "continue");
  assert.equal(directive.stepName, "finalize");
  assert.deepEqual(directive.input.outputs, [
    { fileId: "only-file", downloadUrl: "https://clip/only" },
  ]);
});

test("stitch sends every clip in order with a bounded polling fallback", async () => {
  const calls = [];
  const directive = await agent.steps.stitch.run(
    {},
    stitchContext(
      [{ fileId: "first-file" }, { downloadUrl: "https://clip/second" }],
      {
        create: async (input) => {
          calls.push(input);
          return { video: { url: "https://provider/merged" } };
        },
      },
    ),
  );

  assert.deepEqual(calls[0].params.video_urls, [
    "https://clip/first-file",
    "https://clip/second",
  ]);
  assert.equal(calls[0].timeoutMs, 12 * 60_000);
  assert.deepEqual(directive.input.outputs, [
    { downloadUrl: "https://provider/merged" },
  ]);
});
