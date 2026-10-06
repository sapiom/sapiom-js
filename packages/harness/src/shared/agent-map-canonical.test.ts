import { describe, expect, it } from "vitest";

import { canonicalDigest, canonicalJson } from "@sapiom/agent-map/node/canonical";

describe("canonical JSON digests", () => {
  it("orders keys and normalizes line endings so equal values hash equally", () => {
    expect(canonicalJson({ b: "x\r\ny", a: [2, 1] })).toBe('{"a":[2,1],"b":"x\\ny"}');
    expect(canonicalDigest("domain", { a: 1, b: 2 })).toBe(canonicalDigest("domain", { b: 2, a: 1 }));
    expect(canonicalDigest("domain", { a: 1 })).not.toBe(canonicalDigest("other", { a: 1 }));
  });

  it("rejects values that have no canonical form", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/not canonical JSON/u);
    expect(() => canonicalJson(Number.NaN)).toThrow(/not canonical JSON/u);
    expect(() => canonicalJson(new Date(0))).toThrow(/not canonical JSON/u);
  });
});
