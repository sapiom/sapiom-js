import { describe, expect, it } from "vitest";

import type { MacroDef } from "@shared/types";
import { directActionKind, macroNeedsReadySession } from "./macro-actions";

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

describe("macroNeedsReadySession", () => {
  function macro(id: string, action: MacroDef["action"]): Pick<MacroDef, "id" | "action"> {
    return { id, action };
  }

  it.each(["deploy", "prod_run", "run_local"])(
    "does not readiness-gate the direct %s action despite its legacy inject shape",
    (id) => {
      expect(macroNeedsReadySession(macro(id, { kind: "inject", text: "legacy command" }))).toBe(
        false,
      );
    },
  );

  it("readiness-gates coding-agent prompt injection", () => {
    expect(
      macroNeedsReadySession(macro("debug", { kind: "inject", text: "Debug this agent" })),
    ).toBe(true);
    expect(
      macroNeedsReadySession(macro("explain", { kind: "inject", text: "Explain this step" })),
    ).toBe(true);
  });

  it("does not readiness-gate deterministic canvas rendering or links", () => {
    expect(macroNeedsReadySession(macro("visualize", { kind: "render-canvas" }))).toBe(false);
    expect(
      macroNeedsReadySession(
        macro("open_prod", { kind: "open-url", url: "https://app.sapiom.ai" }),
      ),
    ).toBe(false);
  });
});
