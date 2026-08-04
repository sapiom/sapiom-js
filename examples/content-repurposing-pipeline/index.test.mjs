import assert from "node:assert/strict";
import test from "node:test";

import { agent, isReservedAddress } from "./index.ts";

test("flags RFC 2606 reserved domains as undeliverable", () => {
  assert.equal(isReservedAddress("ada@example.com"), true);
  assert.equal(isReservedAddress("ADA@Example.NET"), true);
  assert.equal(isReservedAddress("ada@example.org"), true);
  assert.equal(isReservedAddress("ada@sub.example"), true);
  assert.equal(isReservedAddress("ada@sub.invalid"), true);
  assert.equal(isReservedAddress("ada@sub.test"), true);
});

test("leaves a real address alone", () => {
  assert.equal(isReservedAddress("ada@sapiom.ai"), false);
  assert.equal(isReservedAddress("ada@example.com.co"), false);
});

/** Build a minimal `deliver`-step context with a fake email + file-storage surface. */
function deliverContext(shared, { send } = {}) {
  const store = new Map(Object.entries(shared));
  const sentTo = [];
  return {
    context: {
      shared: {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
      },
      sapiom: {
        email: {
          inboxes: {
            list: async () => ({ inboxes: [{ inboxId: "inbox_1" }] }),
            create: async () => ({ inboxId: "inbox_1" }),
          },
          messages: {
            send:
              send ??
              (async (inboxId, msg) => {
                sentTo.push(msg.to);
                return { messageId: `msg_${sentTo.length}` };
              }),
          },
        },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    sentTo,
  };
}

const basePack = {
  tweetThread: ["one", "two"],
  linkedInPost: "post",
  newsletter: "## news",
  quoteGraphics: [{ quote: "q1", imagePrompt: "p1" }],
  videoScript: "script",
};

test("deliver returns the pack inline and names the gap when no recipients are set", async () => {
  const { context } = deliverContext({
    title: "Test",
    schedule: "0 9 * * 1",
    pack: basePack,
    graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
    clip: null,
    deliverTo: [],
  });

  const directive = await agent.steps.deliver.run(
    { markdown: "# pack" },
    context,
  );

  assert.equal(directive.kind, "terminate");
  assert.equal(directive.output.delivered, 0);
  assert.deepEqual(directive.output.recipients, []);
  assert.deepEqual(directive.output.unmet, ["deliverTo"]);
  assert.match(directive.output.note, /no `deliverTo` recipient/);
});

test("deliver fans out one send per recipient and reduces to a delivered count", async () => {
  const { context, sentTo } = deliverContext({
    title: "Test",
    schedule: "0 9 * * 1",
    pack: basePack,
    graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
    clip: { fileId: "clip_1", downloadUrl: "https://files/clip.mp4" },
    deliverTo: ["a@sapiom.ai", "b@sapiom.ai"],
  });

  const directive = await agent.steps.deliver.run(
    { markdown: "# pack" },
    context,
  );

  assert.deepEqual(sentTo, ["a@sapiom.ai", "b@sapiom.ai"]);
  assert.equal(directive.output.delivered, 2);
  assert.equal(directive.output.recipients.length, 2);
  assert.equal(directive.output.note, undefined);
});

test("deliver skips a reserved placeholder recipient without sinking the batch", async () => {
  const { context, sentTo } = deliverContext({
    title: "Test",
    schedule: "0 9 * * 1",
    pack: basePack,
    graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
    clip: null,
    deliverTo: ["real@sapiom.ai", "placeholder@example.com"],
  });

  const directive = await agent.steps.deliver.run(
    { markdown: "# pack" },
    context,
  );

  assert.deepEqual(sentTo, ["real@sapiom.ai"]);
  assert.equal(directive.output.delivered, 1);
  assert.equal(directive.output.recipients.length, 2);
  assert.equal(
    directive.output.recipients.find((r) => r.to === "placeholder@example.com")
      .skipped,
    "reserved-address",
  );
  assert.match(directive.output.note, /1 of 2 recipient\(s\) were delivered/);
});

test("a failed send is reported per-recipient rather than failing the run", async () => {
  const { context } = deliverContext(
    {
      title: "Test",
      schedule: "0 9 * * 1",
      pack: basePack,
      graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
      clip: null,
      deliverTo: ["ok@sapiom.ai", "broken@sapiom.ai"],
    },
    {
      send: async (_inboxId, msg) => {
        if (msg.to === "broken@sapiom.ai") throw new Error("send failed");
        return { messageId: "msg_ok" };
      },
    },
  );

  const directive = await agent.steps.deliver.run(
    { markdown: "# pack" },
    context,
  );

  assert.equal(directive.output.delivered, 1);
  assert.equal(
    directive.output.recipients.find((r) => r.to === "broken@sapiom.ai")
      .messageId,
    undefined,
  );
});
