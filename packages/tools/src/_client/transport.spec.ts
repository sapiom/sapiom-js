import { Transport } from "./index.js";

describe("Transport.fetch() caller headers", () => {
  it.each([
    ["a Headers instance", () => new Headers({ "x-custom": "ok" })],
    ["a tuple array", () => [["x-custom", "ok"]] as [string, string][]],
    ["a plain object", () => ({ "x-custom": "ok" })],
  ])("keeps headers given as %s", async (_label, build) => {
    let sent: Record<string, string> = {};
    const transport = new Transport({
      apiKey: "test-key",
      fetch: ((_input: unknown, init: RequestInit = {}) => {
        sent = init.headers as Record<string, string>;
        return Promise.resolve(new Response("{}"));
      }) as typeof globalThis.fetch,
    });

    await transport.fetch("https://api.sapiom.ai/v1/memory", {
      headers: build(),
    });

    expect(sent["x-custom"]).toBe("ok");
    expect(sent["x-sapiom-api-key"]).toBe("test-key");
  });
});
