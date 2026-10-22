/** Sandbox methods throw `SandboxHttpError`, so a failure carries its status. */
import { Transport } from "../_client/index.js";
import { Sandbox, SandboxHttpError } from "./index.js";

const RUNNING = { pid: "p1", status: "running" };

function transportServing(handler: (url: string) => Response): Transport {
  return new Transport({
    apiKey: "test-key",
    fetch: ((input: unknown) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
  });
}

const rejection = (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => null).catch((e: unknown) => e);

describe("Sandbox non-2xx", () => {
  it("throws SandboxHttpError from a plain method", async () => {
    const box = Sandbox.attach(
      "demo",
      {},
      transportServing(() => new Response("gone", { status: 503 })),
    );

    const err = await rejection(box.destroy());

    expect(err).toBeInstanceOf(SandboxHttpError);
    expect((err as SandboxHttpError).status).toBe(503);
    expect((err as Error).message).toBe("Failed to destroy sandbox: 503 gone");
  });

  it("throws SandboxHttpError from the post-stream status poll", async () => {
    const transport = transportServing((url) => {
      if (url.endsWith("/logs/stream")) {
        return new Response('{"stream":"stdout","data":"hi"}\n', {
          status: 200,
        });
      }
      if (url.endsWith("/process")) {
        return new Response(JSON.stringify(RUNNING), { status: 200 });
      }
      return new Response("gateway down", {
        status: 503,
        headers: { "Retry-After": "4" },
      });
    });
    const box = Sandbox.attach("demo", {}, transport);

    const err = await rejection(
      (async () => {
        const { output } = await box.execStream("echo hi");
        for await (const _line of output) {
          // drain
        }
      })(),
    );

    expect(err).toBeInstanceOf(SandboxHttpError);
    expect((err as SandboxHttpError).status).toBe(503);
    expect((err as SandboxHttpError).retryAfterMs).toBe(4000);
    expect((err as Error).message).toBe(
      "Failed to get final status for process p1: 503 gateway down",
    );
  });
});
