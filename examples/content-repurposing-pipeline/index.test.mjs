import assert from "node:assert/strict";
import test from "node:test";

import {
  agent,
  buildClipPrompt,
  buildGraphicPrompt,
  isNarrationScript,
  isReservedAddress,
} from "./index.ts";

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

// ── SAP-2781: the quote graphic must contain the quote ──────────────────────

test("buildGraphicPrompt always renders the quote text into the prompt", () => {
  const prompt = buildGraphicPrompt({
    quote: "Coordination cost is the hidden tax on delivery.",
    imagePrompt: "Solid deep-navy background, modern sans-serif.",
  });
  assert.match(
    prompt,
    /"Coordination cost is the hidden tax on delivery\."/,
    "the exact quote must appear in the launch prompt",
  );
  assert.match(prompt, /Render this exact text/i);
  assert.match(prompt, /Solid deep-navy background/);
});

test("buildGraphicPrompt leads with the text directive even when the LLM's art direction is a background-only ask", () => {
  // The SAP-2781 failure shape: the LLM asked for a text-free background.
  const prompt = buildGraphicPrompt({
    quote: "Small teams ship faster.",
    imagePrompt:
      "Plenty of clean negative space in the center for text overlay, no text in the image.",
  });
  assert.ok(
    prompt.indexOf('"Small teams ship faster."') <
      prompt.indexOf("negative space"),
    "the render-the-quote directive must come before the art direction",
  );
});

test("buildGraphicPrompt falls back to default art direction when the LLM gave none", () => {
  const prompt = buildGraphicPrompt({ quote: "Ship it.", imagePrompt: "  " });
  assert.match(prompt, /"Ship it\."/);
  assert.match(prompt, /solid dark background/i);
});

// ── SAP-2781: the clip prompt must be a short visual, never the narration script ──

const NARRATION_SCRIPT =
  "HOOK (0-5s): Ever wonder why small teams outship big ones?\n" +
  "PROBLEM (5-20s): Every extra person adds coordination overhead...\n" +
  "SOLUTION (20-40s): Keep the team small enough to see the whole system.\n" +
  "CTA (40-45s): Read the full post.";

test("isNarrationScript flags a sectioned narration script (the SAP-2781 shape)", () => {
  assert.equal(isNarrationScript(NARRATION_SCRIPT), true);
});

test("isNarrationScript accepts a short single-shot visual prompt", () => {
  assert.equal(
    isNarrationScript(
      "Slow push-in on a bold pull-quote over a deep-navy background, subtle light sweep.",
    ),
    false,
  );
});

test("buildClipPrompt replaces a narration script with a purpose-written visual prompt", () => {
  const prompt = buildClipPrompt({
    ...basePack,
    videoScript: NARRATION_SCRIPT,
  });
  assert.ok(!prompt.includes("HOOK"), "narration script must not be used");
  // Deliberately decorative: a general video model renders on-screen text
  // illegibly, so the quote stays in the graphics and the teaser asks for none.
  assert.match(prompt, /no text/i);
  assert.ok(
    !prompt.includes('"q1"'),
    "no quote text handed to the video model",
  );
  assert.ok(prompt.length <= 300);
});

test("buildClipPrompt keeps a genuinely short visual videoScript", () => {
  const script = "Slow push-in over a bright gradient, no text, 16:9.";
  const prompt = buildClipPrompt({ ...basePack, videoScript: script });
  assert.equal(prompt, script);
});

/** Build a media-step context: fake shared state + capturing launch fakes. */
function mediaContext(shared) {
  const store = new Map(Object.entries(shared));
  const launches = { image: [], video: [] };
  const handle = {
    dispatch: { resultSignal: "sig", correlationId: "corr" },
  };
  return {
    context: {
      shared: {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
      },
      sapiom: {
        contentGeneration: {
          images: {
            launch: async (input) => {
              launches.image.push(input);
              return handle;
            },
          },
          video: {
            launch: async (input) => {
              launches.video.push(input);
              return handle;
            },
          },
        },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    launches,
  };
}

test("graphics launches a typography-capable cataloged model with the quote in the prompt and the shared aspect ratio", async () => {
  const { context, launches } = mediaContext({
    pack: basePack,
    graphicIndex: 0,
    aspectRatio: "16:9",
  });

  const directive = await agent.steps.graphics.run({}, context);

  assert.equal(launches.image.length, 1);
  const launch = launches.image[0];
  assert.equal(launch.model, "ideogram-v3");
  assert.equal(launch.aspectRatio, "16:9");
  assert.match(launch.prompt, /"q1"/, "the quote must be in the image prompt");
  assert.equal(launch.storage.visibility, "public");
  assert.equal(directive.kind, "pause_until_signal");
});

test("clip launches a cataloged semantic alias with neutral params and a short visual prompt", async () => {
  const { context, launches } = mediaContext({
    pack: { ...basePack, videoScript: NARRATION_SCRIPT },
    graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
    aspectRatio: "16:9",
  });

  const directive = await agent.steps.clip.run({}, context);

  assert.equal(launches.video.length, 1);
  const launch = launches.video[0];
  // A cataloged alias, never a raw provider id — the allowlist (SAP-2582/E8)
  // rejects uncataloged ids, and only cataloged models normalize neutral params.
  assert.equal(launch.model, "kling-standard");
  assert.ok(!launch.model.includes("fal-ai/"));
  assert.equal(launch.aspectRatio, "16:9");
  assert.equal(launch.duration, 5);
  assert.equal(launch.passthrough, undefined);
  assert.ok(
    !launch.prompt.includes("HOOK"),
    "the narration script must never reach the video model",
  );
  assert.equal(directive.kind, "pause_until_signal");
});

test("clip honors a caller-supplied semantic alias", async () => {
  const { context, launches } = mediaContext({
    pack: basePack,
    graphics: [],
    aspectRatio: "16:9",
    model: "veo3-fast",
  });

  await agent.steps.clip.run({}, context);

  assert.equal(launches.video[0].model, "veo3-fast");
  // Duration vocabularies differ per alias (veo3-fast has no 5s) and an
  // unsupported value is a 400, so a custom alias keeps its catalog default.
  assert.equal(launches.video[0].duration, undefined);
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

test("deliver sends an HTML body that embeds the quote graphics", async () => {
  const messages = [];
  const { context } = deliverContext(
    {
      title: "Test",
      schedule: "0 9 * * 1",
      pack: basePack,
      graphics: [{ quote: "q1", downloadUrl: "https://files/q1.png" }],
      clip: { fileId: "clip_1", downloadUrl: "https://files/clip.mp4" },
      packDownloadUrl: "https://files/pack.md",
      deliverTo: ["a@sapiom.ai"],
    },
    {
      send: async (_inboxId, msg) => {
        messages.push(msg);
        return { messageId: "msg_1" };
      },
    },
  );

  await agent.steps.deliver.run({ markdown: "# pack" }, context);

  assert.equal(messages.length, 1);
  const msg = messages[0];
  assert.equal(msg.text, "# pack", "markdown stays as the text/plain fallback");
  assert.match(
    msg.html,
    /<img src="https:\/\/files\/q1\.png"/,
    "graphics must render inline in the inbox",
  );
  assert.match(msg.html, /href="https:\/\/files\/clip\.mp4"/);
  assert.match(msg.html, /href="https:\/\/files\/pack\.md"/);
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
