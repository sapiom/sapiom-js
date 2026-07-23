/**
 * Unit tests for the stub client's `calls` sink — the per-step capability call
 * recorder the local runner uses to populate StepView.calls.
 *
 * Every test asserts the mutation-quality facts that matter to the inspector:
 * capability id (dotted, provider-agnostic), stubUsed flag, args, and result.
 */
import { createStubClient, type StubCallRecord } from "./index.js";

describe("stub calls sink — basic recording", () => {
  it("records a simple capability call with capability, args, result, and stubUsed", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.search.webSearch({ query: "otters" });

    expect(calls).toHaveLength(1);
    expect(calls[0].capability).toBe("search.webSearch");
    expect(calls[0].stubUsed).toBe(true);
    expect(calls[0].args).toEqual([{ query: "otters" }]);
    expect(calls[0].result).toMatchObject({ query: "otters" });
  });

  it("records calls with a custom override value as the result", async () => {
    const calls: StubCallRecord[] = [];
    const customResult = { answer: "custom answer", results: [] };
    const client = createStubClient({
      overrides: { "search.webSearch": customResult },
      calls,
    });

    await client.search.webSearch({ query: "birds" });

    expect(calls[0].result).toEqual(customResult);
    expect(calls[0].capability).toBe("search.webSearch");
  });

  it("records multiple calls in call order", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.memory.append({ content: "hello", namespace: "ns" });
    await client.memory.recall({ query: "hello", namespace: "ns" });
    await client.search.scrape({ url: "https://example.com" });

    expect(calls).toHaveLength(3);
    expect(calls[0].capability).toBe("memory.append");
    expect(calls[1].capability).toBe("memory.recall");
    expect(calls[2].capability).toBe("search.scrape");
  });

  it("records no calls when no capabilities are invoked", () => {
    const calls: StubCallRecord[] = [];
    createStubClient({ calls });
    expect(calls).toHaveLength(0);
  });

  it("does not push to any sink when calls option is omitted (no side effect)", async () => {
    // Guard: creating a client without a sink must not throw or set a global.
    const client = createStubClient();
    await expect(client.search.webSearch({ query: "test" })).resolves.toBeDefined();
  });
});

describe("stub calls sink — args fidelity", () => {
  it("records the exact args passed to the capability", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.search.webSearch({ query: "specific query", intent: "links" });

    expect(calls[0].args).toEqual([{ query: "specific query", intent: "links" }]);
  });

  it("records multi-arg calls (e.g. email.messages.send) with both args", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.email.messages.send("inbox@example.com", {
      to: ["dest@example.com"],
      subject: "Hi",
      text: "body",
    });

    expect(calls[0].capability).toBe("email.messages.send");
    expect(calls[0].args).toHaveLength(2);
    expect(calls[0].args[0]).toBe("inbox@example.com");
  });
});

describe("stub calls sink — result fidelity", () => {
  it("records a null result honestly (null is a valid stub return)", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({
      overrides: { "vault.get": null },
      calls,
    });

    await client.vault.get("ref", "key");

    expect(calls[0]).toHaveProperty("result");
    expect(calls[0].result).toBeNull();
  });

  it("records a false result honestly (false is a valid stub return)", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({
      overrides: { "repositories.delete": false as unknown },
      calls,
    });

    await client.repositories.delete("my-repo");

    expect(calls[0]).toHaveProperty("result");
    expect(calls[0].result).toBe(false);
  });
});

describe("stub calls sink — capability ids are dotted and provider-agnostic", () => {
  it("uses the dotted capability path, not a provider or model name", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.contentGeneration.images.create({ prompt: "a cat" });

    expect(calls[0].capability).toBe("contentGeneration.images.create");
    // Must not contain a provider or model name.
    expect(calls[0].capability).not.toMatch(/fal|openai|anthropic|model/i);
  });

  it("uses dotted path for database.create", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });

    await client.database.create({ duration: "1h", region: "us-east-1" });

    expect(calls[0].capability).toBe("database.create");
  });
});

describe("stub calls sink — per-step isolation", () => {
  it("separate sinks for separate clients do not cross-pollute", async () => {
    const callsA: StubCallRecord[] = [];
    const callsB: StubCallRecord[] = [];

    const clientA = createStubClient({ calls: callsA });
    const clientB = createStubClient({ calls: callsB });

    await clientA.search.webSearch({ query: "A" });
    await clientB.search.scrape({ url: "https://b.test" });

    expect(callsA).toHaveLength(1);
    expect(callsA[0].capability).toBe("search.webSearch");
    expect(callsB).toHaveLength(1);
    expect(callsB[0].capability).toBe("search.scrape");
  });
});
