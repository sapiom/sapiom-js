/**
 * Stub events.emit: the run_local default (unmatched, no network) and the
 * `events.emit` override, both recorded in the calls sink.
 */
import { createStubClient, type StubCallRecord } from "./index.js";

describe("stub events.emit", () => {
  it("resolves an unmatched receipt by default and records the call", async () => {
    const calls: StubCallRecord[] = [];
    const client = createStubClient({ calls });
    const spec = { type: "lead.created", payload: { a: 1 } };

    const res = await client.events.emit(spec);

    expect(res).toEqual({
      receiptId: expect.stringMatching(/^stub-receipt-\d+$/),
      outcome: "unmatched",
      duplicate: false,
      fireIds: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].capability).toBe("events.emit");
    expect(calls[0].args).toEqual([spec]);
  });

  it("returns an events.emit override and records it", async () => {
    const calls: StubCallRecord[] = [];
    const matched = {
      receiptId: "rcpt-1",
      outcome: "matched" as const,
      duplicate: false,
      fireIds: ["fire-1"],
    };
    const client = createStubClient({
      overrides: { "events.emit": matched },
      calls,
    });

    await expect(
      client.events.emit({ type: "lead.created", payload: {} }),
    ).resolves.toEqual(matched);
    expect(calls[0].result).toEqual(matched);
  });

  it("rejects when an events.emit override throws", async () => {
    const client = createStubClient({
      overrides: {
        "events.emit": () => {
          throw new Error("emit boom");
        },
      },
    });

    await expect(
      client.events.emit({ type: "lead.created", payload: {} }),
    ).rejects.toThrow("emit boom");
  });
});
