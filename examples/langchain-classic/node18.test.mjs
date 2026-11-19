import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const anthropicReply = JSON.stringify({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});

test("npm start completes without the global crypto, as on Node 18", async () => {
  // Answers the model calls. Sapiom calls get a 404, and the SDK then runs
  // the agent without tracking.
  const server = createServer((req, res) => {
    req.resume();
    if (req.url !== "/v1/messages") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(anthropicReply);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    const { stdout } = await promisify(execFile)("npm", ["start"], {
      cwd: new URL(".", import.meta.url),
      timeout: 60_000,
      env: {
        // Drops any LangSmith tracing set in the caller's shell, so every
        // request stays on the local stub.
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !/^LANG(CHAIN|SMITH)_/.test(key),
          ),
        ),
        // Node 20+ defines the global `crypto`, so delete it before anything
        // loads. On Node 18 this changes nothing.
        NODE_OPTIONS:
          "--import data:text/javascript,delete%20globalThis.crypto",
        SAPIOM_API_KEY: "test",
        SAPIOM_API_URL: url,
        ANTHROPIC_API_KEY: "test",
        ANTHROPIC_BASE_URL: url,
      },
    });
    assert.match(stdout, /Demo Complete/);
  } finally {
    server.close();
  }
});
