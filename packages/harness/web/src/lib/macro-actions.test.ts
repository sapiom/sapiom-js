import { describe, expect, it } from "vitest";

import { directActionKind } from "./macro-actions";

describe("directActionKind", () => {
  it("maps the three direct-action macros to their kind", () => {
    // These three no longer inject into the pty — they hit the direct routes.
    expect(directActionKind("deploy")).toBe("deploy");
    expect(directActionKind("prod_run")).toBe("prod-run");
    expect(directActionKind("run_local")).toBe("run-local");
  });

  it("returns null for macros that keep their existing behaviour", () => {
    // open-url and render-canvas macros are untouched by the direct-route work.
    expect(directActionKind("open_prod")).toBeNull();
    expect(directActionKind("visualize")).toBeNull();
  });

  it("returns null for Debug / Explain / free-form inject macros", () => {
    // The prompt-inject surfaces (composer library + any future inject macro)
    // must never be re-routed to a direct action — they still type into the pty.
    expect(directActionKind("debug")).toBeNull();
    expect(directActionKind("explain")).toBeNull();
    expect(directActionKind("some_free_form_macro")).toBeNull();
    expect(directActionKind("")).toBeNull();
  });

  it("does not treat a lookalike id as a direct action (exact match only)", () => {
    // Guards against a prototype-chain or prefix match sneaking a non-direct
    // macro onto the direct path.
    expect(directActionKind("toString")).toBeNull();
    expect(directActionKind("deploy_v2")).toBeNull();
    expect(directActionKind("run_local_dry")).toBeNull();
  });
});
