import { readDisclosure } from "./index.js";

// Serving disclosure on raw /v2 non-streaming bodies: `served_class` + `lane`
// are injected top-level by the gateway (SKU vocabulary — never a model or
// provider id, never a provider price); `readDisclosure` camelCases them and
// treats anything missing/malformed as unknown (null) — old-server safe.
describe("llm.readDisclosure", () => {
  it("reads the injected disclosure fields off a /v2 response body", () => {
    const body = {
      type: "message",
      model: "smart", // the echo stays the label
      served_class: "medium",
      lane: "run_now",
    };
    expect(readDisclosure(body)).toEqual({
      servedClass: "medium",
      lane: "run_now",
    });
  });

  it("returns nulls for responses from servers that do not disclose (additive-safe)", () => {
    expect(readDisclosure({ type: "message", model: "smart" })).toEqual({
      servedClass: null,
      lane: null,
    });
    expect(readDisclosure(null)).toEqual({ servedClass: null, lane: null });
    expect(readDisclosure(undefined)).toEqual({ servedClass: null, lane: null });
  });

  it("treats malformed values as unknown, never fabricates", () => {
    expect(readDisclosure({ served_class: "", lane: 42 })).toEqual({
      servedClass: null,
      lane: null,
    });
  });
});
