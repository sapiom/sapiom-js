/**
 * resolveResourceHandle — the seam a step reads its chosen resource handle from.
 * The injected entry-input value wins when present and non-empty; otherwise the
 * code-side fallback (the runtime guarantee) is used. It never throws.
 */

import { resolveResourceHandle } from "./index.js";

const FALLBACK = "meeting-notes-crm";

describe("resolveResourceHandle", () => {
  it("returns the fallback when the input carries no handle", () => {
    expect(resolveResourceHandle({}, { fallback: FALLBACK })).toBe(FALLBACK);
    expect(resolveResourceHandle({ other: "x" }, { fallback: FALLBACK })).toBe(
      FALLBACK,
    );
  });

  it("returns the injected handle when present and non-empty", () => {
    expect(
      resolveResourceHandle({ dbHandle: "my-own-db" }, { fallback: FALLBACK }),
    ).toBe("my-own-db");
  });

  it("trims surrounding whitespace on the injected handle", () => {
    expect(
      resolveResourceHandle(
        { dbHandle: "  my-own-db  " },
        { fallback: FALLBACK },
      ),
    ).toBe("my-own-db");
  });

  it("falls back when the injected handle is blank / whitespace-only", () => {
    expect(
      resolveResourceHandle({ dbHandle: "   " }, { fallback: FALLBACK }),
    ).toBe(FALLBACK);
    expect(
      resolveResourceHandle({ dbHandle: "" }, { fallback: FALLBACK }),
    ).toBe(FALLBACK);
  });

  it("reads a custom key when given", () => {
    expect(
      resolveResourceHandle(
        { targetDb: "picked" },
        { fallback: FALLBACK, key: "targetDb" },
      ),
    ).toBe("picked");
    // The default key is ignored when a custom key is supplied.
    expect(
      resolveResourceHandle(
        { dbHandle: "ignored" },
        { fallback: FALLBACK, key: "targetDb" },
      ),
    ).toBe(FALLBACK);
  });

  it("falls back on non-string or non-object inputs without throwing", () => {
    expect(
      resolveResourceHandle({ dbHandle: 123 }, { fallback: FALLBACK }),
    ).toBe(FALLBACK);
    expect(
      resolveResourceHandle({ dbHandle: null }, { fallback: FALLBACK }),
    ).toBe(FALLBACK);
    expect(resolveResourceHandle(undefined, { fallback: FALLBACK })).toBe(
      FALLBACK,
    );
    expect(resolveResourceHandle(null, { fallback: FALLBACK })).toBe(FALLBACK);
    expect(resolveResourceHandle("a string", { fallback: FALLBACK })).toBe(
      FALLBACK,
    );
  });
});
