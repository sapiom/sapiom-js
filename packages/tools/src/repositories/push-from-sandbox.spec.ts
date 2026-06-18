/**
 * pushFromSandbox() — request shape + result passthrough.
 *
 * Injects a fake fetch (no real network) to assert it POSTs the sandbox name and
 * options, and returns the `{ pushed, sha, branch }` response verbatim.
 */
import { createClient } from "../index.js";

interface Captured {
  url?: string;
  method?: string;
  body?: Record<string, unknown>;
}

function fakeFetch(
  capture: Captured,
  response: unknown = { pushed: true, sha: "abc1234", branch: "main" },
): typeof globalThis.fetch {
  return (async (url: string, init: RequestInit = {}) => {
    capture.url = url;
    capture.method = init.method;
    capture.body = init.body ? JSON.parse(init.body as string) : undefined;
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe("repositories.pushFromSandbox", () => {
  it("POSTs the sandbox name as executionEnvironmentId and returns the gateway result", async () => {
    const capture: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    const repo = sapiom.repositories.attach("my-app", "https://git/x/my-app");
    const sandbox = sapiom.sandboxes.attach("coding-abc");

    const result = await repo.pushFromSandbox(sandbox, { message: "build: page" });

    expect(capture.method).toBe("POST");
    expect(capture.url).toContain("/v1/git/repositories/my-app/push-from-sandbox");
    expect(capture.body).toEqual({
      executionEnvironmentId: "coding-abc",
      message: "build: page",
    });
    expect(result).toEqual({ pushed: true, sha: "abc1234", branch: "main" });
  });

  it("omits message/workingDirectory when not provided", async () => {
    const capture: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    const repo = sapiom.repositories.attach("my-app", "https://git/x/my-app");
    const sandbox = sapiom.sandboxes.attach("coding-abc");

    await repo.pushFromSandbox(sandbox);

    expect(capture.body).toEqual({ executionEnvironmentId: "coding-abc" });
  });

  it("forwards an explicit workingDirectory", async () => {
    const capture: Captured = {};
    const sapiom = createClient({ apiKey: "k", fetch: fakeFetch(capture) });
    const repo = sapiom.repositories.attach("my-app", "https://git/x/my-app");
    const sandbox = sapiom.sandboxes.attach("coding-abc");

    await repo.pushFromSandbox(sandbox, { workingDirectory: "/workspace/sub" });

    expect(capture.body).toEqual({
      executionEnvironmentId: "coding-abc",
      workingDirectory: "/workspace/sub",
    });
  });
});
