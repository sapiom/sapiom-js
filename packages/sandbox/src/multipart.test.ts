import {
  MAX_PARTS,
  planParts,
  runWithConcurrency,
  toBlob,
} from "./multipart";

describe("toBlob", () => {
  it("returns the same Blob when given a Blob", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    expect(toBlob(blob)).toBe(blob);
  });

  it("wraps a Uint8Array in a Blob", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const blob = toBlob(bytes);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(5);
    const roundtrip = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(roundtrip)).toEqual([9, 8, 7, 6, 5]);
  });

  it("UTF-8 encodes strings", async () => {
    const blob = toBlob("héllo");
    // 'h' 'é' (2 bytes) 'l' 'l' 'o' = 6 bytes
    expect(blob.size).toBe(6);
    const text = await blob.text();
    expect(text).toBe("héllo");
  });
});

describe("planParts", () => {
  it("emits a single part for zero-byte input", () => {
    const plans = planParts(0, 1024);
    expect(plans).toEqual([{ partNumber: 1, start: 0, end: 0 }]);
  });

  it("emits one part when totalBytes < partSize", () => {
    expect(planParts(500, 1024)).toEqual([{ partNumber: 1, start: 0, end: 500 }]);
  });

  it("emits a final short part when totalBytes is not a multiple of partSize", () => {
    expect(planParts(2500, 1024)).toEqual([
      { partNumber: 1, start: 0, end: 1024 },
      { partNumber: 2, start: 1024, end: 2048 },
      { partNumber: 3, start: 2048, end: 2500 },
    ]);
  });

  it("emits exact parts when totalBytes is a multiple of partSize", () => {
    expect(planParts(3072, 1024)).toEqual([
      { partNumber: 1, start: 0, end: 1024 },
      { partNumber: 2, start: 1024, end: 2048 },
      { partNumber: 3, start: 2048, end: 3072 },
    ]);
  });

  it("rejects non-positive partSize", () => {
    expect(() => planParts(100, 0)).toThrow(/partSize must be a positive integer/);
    expect(() => planParts(100, -1)).toThrow(/partSize must be a positive integer/);
  });

  it("rejects files that would exceed MAX_PARTS and suggests a larger partSize", () => {
    const huge = MAX_PARTS * 5 + 1; // would need > MAX_PARTS at partSize 5
    expect(() => planParts(huge, 5)).toThrow(
      /Increase partSize to at least \d+/,
    );
  });
});

describe("runWithConcurrency", () => {
  it("processes every item and preserves result order", async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await runWithConcurrency(items, 2, async (n) => n * 2);
    expect(result).toEqual([20, 40, 60, 80, 100]);
  });

  it("runs at most `concurrency` workers simultaneously", async () => {
    const items = Array.from({ length: 8 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency(items, 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  it("rejects with the first error and stops scheduling new work", async () => {
    const started: number[] = [];
    await expect(
      runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 5));
        return n;
      }),
    ).rejects.toThrow("boom");
    // At most the initial two items should have been kicked off before failure
    // halts scheduling; allow a couple more for the race window.
    expect(started.length).toBeLessThanOrEqual(4);
  });

  it("handles empty input", async () => {
    const result = await runWithConcurrency([], 3, async () => "x");
    expect(result).toEqual([]);
  });

  it("rejects concurrency < 1", async () => {
    await expect(
      runWithConcurrency([1], 0, async (n) => n),
    ).rejects.toThrow(/concurrency must be >= 1/);
  });
});
