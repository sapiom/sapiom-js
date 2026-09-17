/**
 * The streaming exec path polls the process status AFTER the log stream closes,
 * through a nested helper that a sweep over `if (!res.ok)` sites is easy to miss.
 * A failure there has to carry the same facts as every other Sapiom call.
 */
import { Transport } from "../_client/index.js";
import { readSapiomCall } from "../_client/sapiom-call.js";
import { Sandbox } from "./index.js";

const RUNNING = { pid: "p1", status: "running" };

function transportServing(handler: (url: string) => Response): Transport {
  return new Transport({
    apiKey: "test-key",
    fetch: ((input: unknown) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
  });
}

async function drain(box: Sandbox): Promise<unknown> {
  try {
    const { output } = await box.execStream("echo hi");
    for await (const _line of output) {
      // drain
    }
    return null;
  } catch (error: unknown) {
    return error;
  }
}

describe("Sandbox.execStream()", () => {
  it("records the facts when the post-stream status read fails", async () => {
    const transport = transportServing((url) => {
      if (url.endsWith("/logs/stream")) {
        return new Response('{"stream":"stdout","data":"hi"}\n', {
          status: 200,
        });
      }
      if (url.endsWith("/process")) {
        return new Response(JSON.stringify(RUNNING), { status: 200 });
      }
      // The post-stream status poll.
      return new Response("gateway down", {
        status: 503,
        headers: { "Retry-After": "4" },
      });
    });

    const error = await drain(Sandbox.attach("demo", {}, transport));

    expect((error as Error).message).toBe(
      "Failed to get final status for process p1: 503 gateway down",
    );
    expect(readSapiomCall(error)).toEqual({
      version: 1,
      capability: "sandboxes",
      status: 503,
      retryAfterMs: 4000,
    });
  });
});
